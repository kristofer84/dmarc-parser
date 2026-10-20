import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

/**
 * Tests for the DNS-apply slice.
 *
 * A real HTTP server stands in for the Cloudflare API and the service is driven against it
 * through CLOUDFLARE_API_BASE, so what is exercised is the actual client: URL building, the
 * envelope/error handling, the classification and the DMARC merge. The token is injected and
 * the domain context is passed in, which keeps the settings table and the database out of it
 * (DATABASE_URL is only set because config/env.ts insists on it at import time).
 *
 * The stub also records every mutation, which is what makes the safety rules testable: no
 * DELETE is ever sent, and an overwrite touches exactly one record id.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-dnsapply-'));
process.env.DATABASE_URL = `file:${join(tempDir, 'dns-apply-test.db')}`;
process.env.NODE_ENV = 'test';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`  ❌ ${name}\n     ${message}`);
  }
}

// ---------------------------------------------------------------- Cloudflare stub

interface StubRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
}

const state = {
  zones: [{ id: 'zone-1', name: 'example.com' }],
  records: [] as StubRecord[],
  nextId: 0,
  calls: [] as Array<{ method: string; path: string; body: any }>,
  deleted: [] as string[],
  /** Answers the next request with this instead of the route, once. */
  failOnce: null as null | { status: number; body: unknown },
};

function seedRecord(name: string, type: string, content: string): StubRecord {
  state.nextId += 1;
  const record: StubRecord = { id: `rec-${state.nextId}`, name, type, content, ttl: 3600 };
  state.records.push(record);
  return record;
}

function resetStub(): void {
  state.records = [];
  state.nextId = 0;
  state.calls = [];
  state.deleted = [];
  state.failOnce = null;
}

function buildStub(): express.Application {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    if (state.failOnce) {
      const failure = state.failOnce;
      state.failOnce = null;
      res.status(failure.status).json(failure.body);
      return;
    }
    next();
  });

  app.use((req, _res, next) => {
    state.calls.push({ method: req.method, path: req.path, body: req.body ?? null });
    next();
  });

  app.get('/zones', (req, res) => {
    const name = String(req.query.name ?? '').toLowerCase();
    const active = String(req.query.status ?? 'active') === 'active';
    res.json({
      success: true,
      errors: [],
      result: active ? state.zones.filter((zone) => zone.name === name) : [],
    });
  });

  app.get('/zones/:zoneId/dns_records', (req, res) => {
    const name = String(req.query.name ?? '').toLowerCase();
    res.json({
      success: true,
      errors: [],
      result: state.records.filter((record) => record.name.toLowerCase() === name),
      result_info: { page: 1, per_page: 100, count: state.records.length, total_count: state.records.length },
    });
  });

  app.post('/zones/:zoneId/dns_records', (req, res) => {
    const body = req.body ?? {};
    state.nextId += 1;
    const record: StubRecord = {
      id: `rec-${state.nextId}`,
      name: String(body.name ?? ''),
      type: String(body.type ?? ''),
      content: String(body.content ?? ''),
      ttl: Number(body.ttl ?? 1),
    };
    state.records.push(record);
    res.json({ success: true, errors: [], result: record });
  });

  app.patch('/zones/:zoneId/dns_records/:recordId', (req, res) => {
    const record = state.records.find((candidate) => candidate.id === req.params.recordId);
    if (!record) {
      res.status(404).json({ success: false, errors: [{ code: 81044, message: 'Record does not exist.' }] });
      return;
    }
    const body = req.body ?? {};
    if (typeof body.content === 'string') {
      record.content = body.content;
    }
    res.json({ success: true, errors: [], result: record });
  });

  // Present so that an accidental delete is refused by the test rather than succeeding.
  app.delete('/zones/:zoneId/dns_records/:recordId', (req, res) => {
    state.deleted.push(req.params.recordId);
    state.records = state.records.filter((record) => record.id !== req.params.recordId);
    res.json({ success: true, errors: [], result: { id: req.params.recordId } });
  });

  return app;
}

/**
 * dnsApply also hands its fetch to the record generator, whose DNSSEC lookup is a
 * DNS-over-HTTPS call to a public resolver. Refusing anything that is not the stub keeps the
 * suite offline instead of quietly depending on cloudflare-dns.com.
 */
let stubBase = '';

const offlineFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(stubBase)) {
    return fetch(url, init);
  }
  return Promise.reject(new Error(`no outbound network in tests: ${url}`));
};

/** Nothing is published: every lookup answers "no such record" instead of touching DNS. */
const emptyResolver = {
  async resolveMx() {
    return [];
  },
  async resolveTxt() {
    return [];
  },
  async resolve4() {
    return [];
  },
  async resolveCname() {
    return [];
  },
  async resolveCaa() {
    return [];
  },
};

const CONTEXT = { current: [], mxHosts: [], mailboxAddress: 'dmarc@example.com' };

const OPTIONS = {
  token: 'stub-token-value',
  fetchImpl: offlineFetch,
  resolver: emptyResolver,
  context: CONTEXT,
};

function planRecord(plan: { records: Array<{ key: string }> }, key: string) {
  const found = plan.records.find((record) => record.key === key);
  assert.ok(found, `the plan must contain a record for key ${key}; got ${plan.records.map((r) => r.key).join(', ')}`);
  return found as any;
}

let dns: typeof import('../src/services/dnsApply.js');

try {
  const stubServer = buildStub().listen(0);
  await new Promise<void>((resolve) => stubServer.once('listening', resolve));
  stubBase = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
  // The service reads the base URL from the environment when the caller does not pass one.
  process.env.CLOUDFLARE_API_BASE = stubBase;
  delete process.env.CLOUDFLARE_API_TOKEN;

  dns = await import('../src/services/dnsApply.js');

  const server = stubServer;
  (globalThis as any).__stubServer = server;
} catch (error) {
  console.error('❌ dnsApply test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------- plan

console.log('\nPlan classification');

const DMARC_UNCHANGED =
  'v=DMARC1; p=none; rua=mailto:dmarc@example.com; ruf=mailto:dmarc@example.com!10m; sp=none; adkim=s; aspf=s; pct=100';

await test('a plan reports provider, zone and one entry per generated record', async () => {
  resetStub();
  seedRecord('example.com', 'TXT', 'v=spf1 include:_spf.google.com ~all');
  seedRecord('_dmarc.example.com', 'TXT', DMARC_UNCHANGED);

  const plan = await dns.buildDnsPlan('example.com', OPTIONS);

  assert.equal(plan.provider, 'cloudflare');
  assert.deepEqual(plan.zone, { id: 'zone-1', name: 'example.com' });
  assert.ok(plan.records.length >= 6, 'the plan should cover the generated record set');
  for (const record of plan.records) {
    for (const field of ['key', 'label', 'type', 'name', 'value', 'current', 'action']) {
      assert.ok(field in record, `every plan record needs ${field}`);
    }
  }
});

await test('actions: update for a changed SPF, unchanged for an identical DMARC, create for a missing TLS-RPT', async () => {
  resetStub();
  seedRecord('example.com', 'TXT', 'v=spf1 include:_spf.google.com ~all');
  seedRecord('_dmarc.example.com', 'TXT', DMARC_UNCHANGED);

  const plan = await dns.buildDnsPlan('example.com', OPTIONS);

  const spf = planRecord(plan, 'spf');
  assert.equal(spf.action, 'update');
  assert.equal(spf.type, 'TXT');
  assert.equal(spf.name, 'example.com');
  // The published includes are preserved: an apply regenerates, it does not start from empty.
  assert.match(spf.value, /include:_spf\.google\.com/);
  assert.deepEqual(spf.current, ['v=spf1 include:_spf.google.com ~all']);
  assert.match(String(spf.reason), /~all/);

  const dmarc = planRecord(plan, 'dmarc');
  assert.equal(dmarc.action, 'unchanged');
  assert.equal(dmarc.name, '_dmarc.example.com');

  const tlsRpt = planRecord(plan, 'tls-rpt');
  assert.equal(tlsRpt.action, 'create');
  assert.equal(tlsRpt.name, '_smtp._tls.example.com');
  assert.deepEqual(tlsRpt.current, []);
});

await test('records that are not DNS-applicable are unsupported, with a reason', async () => {
  resetStub();
  const plan = await dns.buildDnsPlan('example.com', OPTIONS);

  for (const key of ['dkim', 'mta-sts', 'caa', 'dnssec']) {
    const record = planRecord(plan, key);
    assert.equal(record.action, 'unsupported', `${key} must never be applied`);
    assert.ok(typeof record.reason === 'string' && record.reason!.length > 0, `${key} needs a reason`);
  }
});

await test('a domain with no Cloudflare zone is all-unsupported with a warning, not an error', async () => {
  resetStub();
  const plan = await dns.buildDnsPlan('not-in-cloudflare.test', OPTIONS);

  assert.equal(plan.zone, null);
  assert.ok(plan.warnings.some((warning) => /no active cloudflare zone/i.test(warning)));
  assert.ok(plan.records.length > 0);
  assert.ok(plan.records.every((record) => record.action === 'unsupported'));
});

await test('a subdomain uses the parent zone', async () => {
  resetStub();
  const plan = await dns.buildDnsPlan('mail.example.com', OPTIONS);

  assert.deepEqual(plan.zone, { id: 'zone-1', name: 'example.com' });
  assert.ok(plan.warnings.some((warning) => /parent zone example\.com/.test(warning)));
});

// ---------------------------------------------------------------- apply

console.log('\nApply');

await test('overwrite:false creates what is missing and reports an existing record as skipped', async () => {
  resetStub();
  const published = seedRecord('example.com', 'TXT', 'v=spf1 include:_spf.google.com ~all');
  const before = JSON.stringify(state.records);

  const result = await dns.applyDnsPlan(
    'example.com',
    { keys: ['spf', 'tls-rpt'], overwrite: false },
    OPTIONS,
  );

  assert.deepEqual(result.applied.map((entry) => [entry.key, entry.action]), [['tls-rpt', 'create']]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].key, 'spf');
  assert.equal(result.skipped[0].reason, 'exists');
  assert.deepEqual(result.skipped[0].current, ['v=spf1 include:_spf.google.com ~all']);

  // The published SPF record is byte-identical, and no PATCH was sent at all.
  assert.equal(
    state.records.find((record) => record.id === published.id)!.content,
    'v=spf1 include:_spf.google.com ~all',
  );
  assert.ok(!state.calls.some((call) => call.method === 'PATCH'));
  assert.ok(JSON.stringify(state.records).includes('v=TLSRPTv1'));
  assert.notEqual(JSON.stringify(state.records), before);
});

await test('overwrite:true replaces exactly the matched record and deletes nothing', async () => {
  resetStub();
  const spf = seedRecord('example.com', 'TXT', 'v=spf1 include:_spf.google.com ~all');
  const verification = seedRecord('example.com', 'TXT', 'google-site-verification=abc123');
  const mail = seedRecord('example.com', 'A', '203.0.113.10');

  const result = await dns.applyDnsPlan('example.com', { keys: ['spf'], overwrite: true }, OPTIONS);

  assert.deepEqual(result.applied, [{ key: 'spf', action: 'update', recordId: spf.id }]);
  assert.deepEqual(result.skipped, []);

  const updated = state.records.find((record) => record.id === spf.id)!;
  assert.match(updated.content, /^v=spf1 .*-all$/);
  // Unrelated records at the same name - and anything else in the zone - are untouched.
  assert.equal(state.records.find((record) => record.id === verification.id)!.content, 'google-site-verification=abc123');
  assert.equal(state.records.find((record) => record.id === mail.id)!.content, '203.0.113.10');
  assert.equal(state.records.length, 3);
  assert.deepEqual(state.deleted, []);
  assert.ok(!state.calls.some((call) => call.method === 'DELETE'));
  // Only the content is patched: the operator's TTL stays theirs.
  const patch = state.calls.find((call) => call.method === 'PATCH')!;
  assert.deepEqual(Object.keys(patch.body), ['content']);
});

await test('an overwrite refuses to touch a same-name record it cannot identify', async () => {
  resetStub();
  // Only a verification TXT at the apex: there is no SPF record to replace, and the
  // verification record must not become the target just because it shares the name and type.
  const verification = seedRecord('example.com', 'TXT', 'google-site-verification=abc123');

  const result = await dns.applyDnsPlan('example.com', { keys: ['spf'], overwrite: true }, OPTIONS);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [{ key: 'spf', reason: 'missing', current: [] }]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].id, verification.id);
  assert.equal(state.records[0].content, 'google-site-verification=abc123');
  assert.ok(!state.calls.some((call) => call.method === 'PATCH'));
});

await test('an unchanged record is skipped instead of rewritten', async () => {
  resetStub();
  seedRecord('_dmarc.example.com', 'TXT', DMARC_UNCHANGED);

  const result = await dns.applyDnsPlan('example.com', { keys: ['dmarc'], overwrite: true }, OPTIONS);

  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped[0].reason, 'unchanged');
  assert.ok(!state.calls.some((call) => call.method === 'PATCH'));
});

await test('an unsupported key is skipped even when an admin asks for it', async () => {
  resetStub();
  const result = await dns.applyDnsPlan('example.com', { keys: ['mta-sts', 'dnssec'] }, OPTIONS);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['unsupported', 'unsupported']);
});

await test('an unknown key is a 400 and writes nothing', async () => {
  resetStub();
  await assert.rejects(
    () => dns.applyDnsPlan('example.com', { keys: ['does-not-exist'] }, OPTIONS),
    (error: any) => error.statusCode === 400 && error.code === 'VALIDATION_ERROR',
  );
  assert.deepEqual(state.records, []);
  // Reading the zone is unavoidable (keys are checked against a fresh plan); writing is not.
  assert.ok(!state.calls.some((call) => call.method !== 'GET'), 'no request may mutate the zone');
});

// ---------------------------------------------------------------- DMARC rua

console.log('\nDMARC rua merge');

await test('rua is appended to a multi-tag record, keeping every other tag and target', async () => {
  resetStub();
  const existing = seedRecord(
    '_dmarc.example.com',
    'TXT',
    'v=DMARC1; p=reject; rua=mailto:old@example.com,mailto:other@example.org; adkim=s; pct=50',
  );

  const result = await dns.addDmarcRua('example.com', 'dmarc@example.com', OPTIONS);

  assert.equal(result.recordId, existing.id);
  assert.equal(
    result.previous,
    'v=DMARC1; p=reject; rua=mailto:old@example.com,mailto:other@example.org; adkim=s; pct=50',
  );
  assert.equal(
    result.value,
    'v=DMARC1; p=reject; rua=mailto:old@example.com, mailto:other@example.org, mailto:dmarc@example.com; adkim=s; pct=50',
  );
  assert.equal(state.records.length, 1, 'the existing record is updated, not duplicated');
  assert.equal(state.records[0].content, result.value);
});

await test('an address already in the rua list is not added twice', async () => {
  resetStub();
  seedRecord('_dmarc.example.com', 'TXT', 'v=DMARC1; p=none; rua=mailto:dmarc@example.com');

  const result = await dns.addDmarcRua('example.com', 'dmarc@example.com', OPTIONS);

  assert.equal(result.value, 'v=DMARC1; p=none; rua=mailto:dmarc@example.com');
  assert.ok(!state.calls.some((call) => call.method === 'PATCH'), 'nothing needs writing');
});

await test('with no DMARC record a minimal p=none one is created', async () => {
  resetStub();
  const result = await dns.addDmarcRua('example.com', 'dmarc@example.com', OPTIONS);

  assert.equal(result.previous, null);
  assert.equal(result.value, 'v=DMARC1; p=none; rua=mailto:dmarc@example.com');
  assert.ok(result.recordId.length > 0);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].name, '_dmarc.example.com');
  assert.equal(state.records[0].content, result.value);
});

await test('a bare address is turned into a mailto: uri and a missing mailbox is refused', async () => {
  assert.equal(
    dns.mergeDmarcRua('v=DMARC1; p=none', 'dmarc@example.com'),
    'v=DMARC1; p=none; rua=mailto:dmarc@example.com',
  );
  await assert.rejects(
    () => dns.addDmarcRua('example.com', '   ', OPTIONS),
    (error: any) => error.statusCode === 409 && error.code === 'MAILBOX_NOT_CONFIGURED',
  );
});

// ---------------------------------------------------------------- errors

console.log('\nCloudflare errors');

await test('the first Cloudflare error message is surfaced and the token never appears in it', async () => {
  resetStub();
  state.failOnce = {
    status: 403,
    body: {
      success: false,
      result: null,
      errors: [
        { code: 9109, message: 'Invalid access token.' },
        { code: 9000, message: 'Second error that must not be used.' },
      ],
    },
  };

  await assert.rejects(
    () => dns.buildDnsPlan('example.com', OPTIONS),
    (error: any) => {
      assert.equal(error.message, 'Invalid access token.');
      assert.equal(error.code, 'CLOUDFLARE_ERROR');
      assert.equal(error.statusCode, 502);
      assert.ok(!error.message.includes('stub-token-value'));
      return true;
    },
  );
});

await test('a token that cannot see any zone yields an all-unsupported plan, not a failure', async () => {
  resetStub();
  state.zones = [];
  try {
    const plan = await dns.buildDnsPlan('example.com', OPTIONS);
    assert.equal(plan.zone, null);
    assert.ok(plan.records.every((record) => record.action === 'unsupported'));
  } finally {
    state.zones = [{ id: 'zone-1', name: 'example.com' }];
  }
});

// ---------------------------------------------------------------- done

(globalThis as any).__stubServer.close();
rmSync(tempDir, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`, () => resolve());
});
// The rate limiter's sweeper interval in middleware/validation.ts keeps the loop alive.
process.exit(failed > 0 ? 1 : 0);
