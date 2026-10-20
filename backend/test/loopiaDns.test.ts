import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';

/**
 * Tests for the Loopia XML-RPC writer.
 *
 * A real HTTP server stands in for `api.loopia.se/RPCSERV`; the service is driven through
 * `LOOPIA_API_BASE`-equivalent options, so the XML-RPC encoder, the value parser, the record
 * classification and the remove-then-add replacement path are all exercised. No test reaches
 * the network and no test needs Loopia credentials.
 *
 * The stub records every mutation: the safety property under test is that Loopia has no update
 * call, so a replacement must remove exactly the identified record id and add one value - never
 * a second record at that name.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-loopia-'));
const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.DATABASE_URL = `file:${join(tempDir, 'loopia-test.db')}`;
process.env.NODE_ENV = 'test';
// The instance running these tests may have real credentials in its environment; the test
// must decide for itself which provider it uses.
delete process.env.LOOPIA_API_USER;
delete process.env.LOOPIA_API_PASS;
delete process.env.CLOUDFLARE_API_TOKEN;

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

// ---------------------------------------------------------------- XML-RPC stub

interface StubRecord {
  record_id: number;
  type: string;
  ttl: number;
  priority: number;
  rdata: string;
}

const state = {
  domains: ['example.com', 'xcds.net'],
  subdomains: new Map<string, Set<string>>(),
  records: new Map<string, StubRecord[]>(),
  nextId: 1000,
  calls: [] as Array<{ method: string; params: any[] }>,
  faultOnce: null as null | { code: number; message: string },
};

function keyOf(zone: string, sub: string): string {
  return `${zone.toLowerCase()}|${sub.toLowerCase()}`;
}

function ensureKey(zone: string, sub: string): StubRecord[] {
  const key = keyOf(zone, sub);
  let rows = state.records.get(key);
  if (!rows) {
    rows = [];
    state.records.set(key, rows);
  }
  return rows;
}

function seedRecord(zone: string, sub: string, record: Omit<StubRecord, 'record_id'>): StubRecord {
  state.nextId += 1;
  const row = { record_id: state.nextId, ...record };
  ensureKey(zone, sub).push(row);
  return row;
}

function resetStub(): void {
  state.domains = ['example.com', 'xcds.net'];
  state.subdomains = new Map([
    ['example.com', new Set(['www'])],
    ['xcds.net', new Set(['home'])],
  ]);
  state.records = new Map();
  state.nextId = 1000;
  state.calls = [];
  state.faultOnce = null;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function valueXml(value: unknown): string {
  if (typeof value === 'string') {
    return `<value><string>${escapeXml(value)}</string></value>`;
  }
  if (typeof value === 'number') {
    return `<value><int>${Math.trunc(value)}</int></value>`;
  }
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? '1' : '0'}</boolean></value>`;
  }
  if (value === null || value === undefined) {
    return '<value><nil/></value>';
  }
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(valueXml).join('')}</data></array></value>`;
  }
  const members = Object.entries(value as Record<string, unknown>)
    .map(([name, entry]) => `<member><name>${escapeXml(name)}</name>${valueXml(entry)}</member>`)
    .join('');
  return `<value><struct>${members}</struct></value>`;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extracts the content of the first `<value>`, respecting nested values (struct members). */
function innerValue(xml: string): string {
  const start = xml.indexOf('<value>');
  if (start === -1) {
    return '';
  }
  let depth = 0;
  for (let index = start; index < xml.length; ) {
    if (xml.startsWith('<value>', index)) {
      depth += 1;
      index += '<value>'.length;
      continue;
    }
    if (xml.startsWith('</value>', index)) {
      depth -= 1;
      if (depth === 0) {
        return xml.slice(start + '<value>'.length, index);
      }
      index += '</value>'.length;
      continue;
    }
    index += 1;
  }
  return '';
}

/** Only the value shapes the client sends: string, int, struct of those. */
function parseValue(xml: string): any {
  const text = innerValue(xml).trim();
  const string = /^<string>([\s\S]*)<\/string>$/.exec(text);
  if (string) {
    return decodeXml(string[1]);
  }
  const int = /^<int>(-?\d+)<\/int>$/.exec(text);
  if (int) {
    return Number(int[1]);
  }
  if (text.startsWith('<struct>')) {
    const result: Record<string, unknown> = {};
    for (const match of text.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
      const name = /<name>([\s\S]*?)<\/name>/.exec(match[1])?.[1] ?? '';
      result[decodeXml(name)] = parseValue(match[1]);
    }
    return result;
  }
  if (text.startsWith('<array>')) {
    return [...text.matchAll(/<value>([\s\S]*?)<\/value>/g)].map((match) => parseValue(match[0]));
  }
  return text;
}

function parseParams(xml: string): any[] {
  return [...xml.matchAll(/<param>([\s\S]*?)<\/param>/g)].map((match) => parseValue(match[1]));
}

function buildStub(): express.Application {
  const app = express();
  app.use(express.text({ type: '*/*' }));

  app.post('/', (req, res) => {
    const body = String(req.body ?? '');
    const method = /<methodName>([\s\S]*?)<\/methodName>/.exec(body)?.[1] ?? '';
    const params = parseParams(body);
    state.calls.push({ method, params });

    if (state.faultOnce) {
      const fault = state.faultOnce;
      state.faultOnce = null;
      res.type('text/xml').send(
        `<?xml version="1.0"?><methodResponse><fault>${valueXml({
          faultCode: fault.code,
          faultString: fault.message,
        })}</fault></methodResponse>`,
      );
      return;
    }

    const respond = (result: unknown): void => {
      res.type('text/xml').send(
        `<?xml version="1.0"?><methodResponse><params><param>${valueXml(result)}</param></params></methodResponse>`,
      );
    };
    const fault = (code: number, message: string): void => {
      res.type('text/xml').send(
        `<?xml version="1.0"?><methodResponse><fault>${valueXml({
          faultCode: code,
          faultString: message,
        })}</fault></methodResponse>`,
      );
    };

    // Arguments are [user, password, ...].
    const [, , first, second, third] = params;

    switch (method) {
      case 'getDomains':
        respond(state.domains.map((domain) => ({ domain })));
        return;
      case 'getSubdomains':
        respond([...(state.subdomains.get(String(first)) ?? new Set<string>())]);
        return;
      case 'addSubdomain': {
        const zone = String(first);
        const sub = String(second);
        const set = state.subdomains.get(zone) ?? new Set<string>();
        set.add(sub);
        state.subdomains.set(zone, set);
        respond(true);
        return;
      }
      case 'getZoneRecords':
        respond(ensureKey(String(first), String(second)));
        return;
      case 'addZoneRecord': {
        const zone = String(first);
        const sub = String(second);
        const record = third as Omit<StubRecord, 'record_id'>;
        if (typeof record?.rdata !== 'string' || record.rdata.trim().length === 0) {
          fault(404, 'invalid rdata');
          return;
        }
        state.nextId += 1;
        const row: StubRecord = {
          record_id: state.nextId,
          type: String(record.type),
          ttl: Number(record.ttl ?? 300),
          priority: Number(record.priority ?? 0),
          rdata: record.rdata,
        };
        ensureKey(zone, sub).push(row);
        respond(row.record_id);
        return;
      }
      case 'removeZoneRecord': {
        const zone = String(first);
        const sub = String(second);
        const id = Number(third);
        const rows = ensureKey(zone, sub);
        const index = rows.findIndex((row) => row.record_id === id);
        if (index === -1) {
          fault(208, 'record not found');
          return;
        }
        rows.splice(index, 1);
        respond(true);
        return;
      }
      default:
        fault(1, `unknown method ${method}`);
    }
  });

  return app;
}

// ---------------------------------------------------------------- app under test

let base = '';
let dnsApply: typeof import('../src/services/dnsApply.js');

const LOOPIA = {
  user: 'pi@loopiaapi',
  password: 'test-password',
  retryDelaysMs: [0, 0],
};

function options(overrides: Record<string, unknown> = {}): any {
  return {
    provider: 'loopia',
    loopia: { ...LOOPIA, baseUrl: base },
    context: { current: [], mxHosts: ['mail.example.com'], mailboxAddress: 'dmarc@example.com' },
    // Keep the generator deterministic: no provider discovery, no DNS lookups.
    providers: [],
    ...overrides,
  };
}

try {
  const stubServer = buildStub().listen(0);
  await new Promise<void>((resolve) => stubServer.once('listening', resolve));
  base = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}/`;

  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${join(tempDir, 'loopia-test.db')}` },
  });

  dnsApply = await import('../src/services/dnsApply.js');
} catch (error) {
  console.error('❌ Loopia test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------- plan

console.log('\nLoopia plan');

await test('the plan names Loopia and classifies create/update/unchanged', async () => {
  resetStub();
  seedRecord('example.com', '@', { type: 'TXT', ttl: 300, priority: 0, rdata: 'v=spf1 -all' });
  seedRecord('example.com', '_dmarc', {
    type: 'TXT',
    ttl: 300,
    priority: 0,
    rdata: 'v=DMARC1; p=none; rua=mailto:old@example.com',
  });

  const plan = await dnsApply.buildDnsPlan('example.com', options());
  assert.equal(plan.provider, 'loopia');
  assert.equal(plan.zone?.name, 'example.com');

  const byKey = new Map(plan.records.map((record) => [record.key, record]));
  assert.equal(byKey.get('spf')?.action, 'unchanged');
  assert.equal(byKey.get('dmarc')?.action, 'update');
  assert.equal(byKey.get('tls-rpt')?.action, 'create');
  assert.equal(byKey.get('dkim')?.action, 'unsupported');
  assert.equal(byKey.get('mta-sts')?.action, 'unsupported');
});

await test('a subdomain resolves to its parent zone and says so', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('mail.example.com', options());
  assert.equal(plan.zone?.name, 'example.com');
  assert.ok(plan.warnings.some((warning) => warning.includes('parent zone example.com')));
});

await test('a domain outside the Loopia account is a warning, not an exception', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('not-here.test', options());
  assert.equal(plan.zone, null);
  assert.ok(plan.warnings.some((warning) => warning.includes('not in the Loopia account')));
  assert.equal(plan.records.every((record) => record.action === 'unsupported'), true);
});

// ---------------------------------------------------------------- apply

console.log('\nLoopia apply');

await test('create adds the subdomain first, then the record', async () => {
  resetStub();
  const result = await dnsApply.applyDnsPlan('example.com', { keys: ['tls-rpt'] }, options());
  assert.deepEqual(result.applied.map((row) => row.key), ['tls-rpt']);

  const subCalls = state.calls.filter((call) => call.method === 'addSubdomain');
  // params are [user, password, zone, sub].
  assert.deepEqual(subCalls.map((call) => call.params[3]), ['_smtp._tls']);

  const rows = ensureKey('example.com', '_smtp._tls');
  assert.equal(rows.length, 1);
  assert.match(rows[0].rdata, /^v=TLSRPTv1;/);
});

await test('overwrite:false skips an existing record and writes nothing', async () => {
  resetStub();
  const existing = seedRecord('example.com', '_dmarc', {
    type: 'TXT',
    ttl: 300,
    priority: 0,
    rdata: 'v=DMARC1; p=none; rua=mailto:old@example.com',
  });

  const result = await dnsApply.applyDnsPlan('example.com', { keys: ['dmarc'] }, options());
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, 'exists');
  assert.equal(state.calls.some((call) => call.method === 'removeZoneRecord'), false);
  assert.equal(ensureKey('example.com', '_dmarc')[0].record_id, existing.record_id);
});

await test('overwrite:true removes exactly the identified record and adds its replacement', async () => {
  resetStub();
  const dmarc = seedRecord('example.com', '_dmarc', {
    type: 'TXT',
    ttl: 300,
    priority: 0,
    rdata: 'v=DMARC1; p=none; rua=mailto:old@example.com',
  });
  const unrelated = seedRecord('example.com', '_dmarc', {
    type: 'TXT',
    ttl: 300,
    priority: 0,
    rdata: 'google-site-verification=abc',
  });

  const result = await dnsApply.applyDnsPlan(
    'example.com',
    { keys: ['dmarc'], overwrite: true },
    options(),
  );
  assert.deepEqual(result.applied.map((row) => row.action), ['update']);

  const removals = state.calls.filter((call) => call.method === 'removeZoneRecord');
  // params are [user, password, zone, sub, record_id].
  assert.deepEqual(removals.map((call) => call.params[4]), [dmarc.record_id]);

  const rows = ensureKey('example.com', '_dmarc');
  assert.equal(rows.some((row) => row.record_id === dmarc.record_id), false);
  assert.equal(rows.some((row) => row.record_id === unrelated.record_id), true);
  assert.match(rows.find((row) => row.rdata.startsWith('v=DMARC1'))?.rdata ?? '', /^v=DMARC1;/);
});

// ---------------------------------------------------------------- DMARC rua

console.log('\nLoopia DMARC rua');

await test('rua is merged into the existing record, preserving tags and other targets', async () => {
  resetStub();
  seedRecord('example.com', '_dmarc', {
    type: 'TXT',
    ttl: 300,
    priority: 0,
    rdata: 'v=DMARC1; p=reject; rua=mailto:reports@example.net; adkim=s',
  });

  const result = await dnsApply.addDmarcRua('example.com', 'dmarc@example.com', options());
  assert.match(result.value, /p=reject/);
  assert.match(result.value, /adkim=s/);
  assert.match(result.value, /mailto:reports@example\.net/);
  assert.match(result.value, /mailto:dmarc@example\.com/);
  assert.equal(result.previous, 'v=DMARC1; p=reject; rua=mailto:reports@example.net; adkim=s');

  const rows = ensureKey('example.com', '_dmarc');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rdata, result.value);
});

await test('a missing DMARC record is created with p=none', async () => {
  resetStub();
  const result = await dnsApply.addDmarcRua('example.com', 'dmarc@example.com', options());
  assert.equal(result.previous, null);
  assert.equal(result.value, 'v=DMARC1; p=none; rua=mailto:dmarc@example.com');
  assert.equal(ensureKey('example.com', '_dmarc').length, 1);
});

// ---------------------------------------------------------------- errors and limits

console.log('\nLoopia errors');

await test('a rate-limit fault is retried once and then succeeds', async () => {
  resetStub();
  state.faultOnce = { code: 429, message: 'rate limited' };
  const plan = await dnsApply.buildDnsPlan('example.com', options());
  assert.equal(plan.zone?.name, 'example.com');
  assert.equal(state.calls.filter((call) => call.method === 'getDomains').length, 2);
});

await test('a persistent rate limit surfaces as 503, not a hang', async () => {
  resetStub();
  state.faultOnce = { code: 429, message: 'rate limited' };
  const client = new (await import('../src/services/loopia.js')).LoopiaClient({
    ...LOOPIA,
    baseUrl: base,
    retryDelaysMs: [],
  });
  // getDomains is the first call; a persistent 429 must not be retried forever.
  await assert.rejects(
    () => client.getDomains(),
    (error: any) => error.code === 'LOOPIA_RATE_LIMITED' && error.statusCode === 503,
  );
});

await test('an API fault is surfaced without credentials in the message', async () => {
  resetStub();
  state.faultOnce = { code: 42, message: 'bad rdata' };
  const client = new (await import('../src/services/loopia.js')).LoopiaClient({
    ...LOOPIA,
    baseUrl: base,
    retryDelaysMs: [],
  });
  await assert.rejects(
    () => client.getDomains(),
    (error: any) =>
      error.code === 'LOOPIA_ERROR' &&
      error.message.includes('bad rdata') &&
      !error.message.includes(LOOPIA.password),
  );
});

await test('no Loopia credentials is a 409 with a useful message', async () => {
  await assert.rejects(
    () =>
      dnsApply.buildDnsPlan('example.com', {
        provider: 'loopia',
        loopia: { baseUrl: base },
      }),
    (error: any) => error.code === 'LOOPIA_NOT_CONFIGURED' && error.statusCode === 409,
  );
});

await test('auto picks Loopia when only Loopia credentials are configured', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('example.com', {
    loopia: { ...LOOPIA, baseUrl: base },
    context: { current: [], mxHosts: [], mailboxAddress: 'dmarc@example.com' },
    providers: [],
  });
  assert.equal(plan.provider, 'loopia');
});

// ---------------------------------------------------------------- done

rmSync(tempDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
