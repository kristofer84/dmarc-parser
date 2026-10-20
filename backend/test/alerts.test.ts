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
 * Tests for the alert scan and the /api/alerts routes.
 *
 * The reports are seeded directly rather than ingested: what is under test is the 24 h window,
 * the dedup keys and the webhook delivery, and driving the IMAP/XML path would only add ways
 * for the test to fail for reasons that have nothing to do with alerting.
 *
 * The webhook is a real local HTTP server, because the interesting part is the HTTP contract
 * (`deliveredAt` on 2xx, no throw on 5xx), not the JSON body alone.
 *
 * Environment must be set before the application modules are imported - config/env.ts reads it
 * at import time - hence the dynamic imports below.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = dirname(here);

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // alerts.cooldownHours default

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-alerts-'));
const databaseFile = join(tempDir, 'alerts-test.db');

process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.NODE_ENV = 'test';
process.env.ENABLE_SCHEDULED_EMAIL_PROCESSING = 'false';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ ${name}\n     ${message}`);
  }
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function daysAgo(days: number): Date {
  return hoursAgo(days * 24);
}

// ---------------------------------------------------------------- webhook stub

const hook = { received: [] as Array<Record<string, any>>, failures: 0 };

function buildHookServer(): express.Application {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.post('/hook', (req, res) => {
    hook.received.push(req.body);
    res.status(204).end();
  });

  // A receiver that is up but unhappy: the alert must survive, undelivered, without a throw.
  app.post('/fail', (_req, res) => {
    hook.failures += 1;
    res.status(500).json({ error: 'nope' });
  });

  return app;
}

// ---------------------------------------------------------------- app wiring

/** Minimal stack: session resolution, the audit middleware and the routers under test. */
async function buildApi(): Promise<{ base: string; close: () => void }> {
  const middleware = await import('../src/middleware/auth.js');
  const audit = await import('../src/middleware/audit.js');
  const authRouter = (await import('../src/routes/auth.js')).default;
  const alertsRouter = (await import('../src/routes/alerts.js')).default;

  const app = express();
  app.use(express.json());
  app.use(middleware.attachUser);
  app.use(audit.auditRequests);
  app.use('/api/auth', authRouter);
  app.use('/api/alerts', alertsRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

interface CallResult {
  status: number;
  body: any;
  cookie: string | null;
}

let base = '';

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const setCookie = response.headers.get('set-cookie');

  return {
    status: response.status,
    body,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

async function login(email: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', { body: { email, password: ADMIN_PASSWORD } });
  assert.equal(result.status, 200, `login failed: ${JSON.stringify(result.body)}`);
  assert.ok(result.cookie, 'a successful login must set a session cookie');
  return result.cookie!;
}

/** Waits for the audit middleware's `finish` handler, which writes after the response is sent. */
async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 3000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------- run

let prisma: typeof import('../src/db/prisma.js').prisma;
let evaluateAlerts: typeof import('../src/services/alerts.js').evaluateAlerts;
let invalidateSettingsCache: () => void;
let closeApi: () => void;

let adminCookie = '';
let scopedCookie = '';
let hookBase = '';

try {
  const hookServer = buildHookServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => hookServer.once('listening', resolve));
  hookBase = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;

  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  ({ prisma } = await import('../src/db/prisma.js'));
  ({ evaluateAlerts } = await import('../src/services/alerts.js'));
  const settings = await import('../src/services/settings.js');
  invalidateSettingsCache = settings.invalidateSettingsCache;
  const auth = await import('../src/services/auth.js');

  const api = await buildApi();
  base = api.base;
  closeApi = api.close;

  await prisma.user.create({
    data: {
      email: 'admin@test.local',
      name: 'Administrator',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      isActive: true,
    },
  });
  const scoped = await prisma.user.create({
    data: {
      email: 'scoped@test.local',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'user',
      isActive: true,
      domains: { create: [{ domain: 'spike.test' }] },
    },
  });
  assert.ok(scoped);

  await prisma.setting.create({ data: { key: 'alerts.webhookUrl', value: `${hookBase}/hook` } });
  invalidateSettingsCache();

  // ------------------------------------------------------------ seed

  // A domain with history: two senders known before the window, one brand-new sender inside it.
  await prisma.report.create({
    data: {
      domain: 'example.com',
      reportId: 'example-old',
      orgName: 'Old Reporter',
      email: 'dmarc@example.com',
      startDate: daysAgo(4),
      endDate: daysAgo(3),
      records: {
        create: [
          { sourceIp: '198.51.100.1', count: 10, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'example.com' },
          { sourceIp: '203.0.113.5', count: 12, disposition: 'none', dkim: 'pass', spf: 'fail', headerFrom: 'example.com' },
        ],
      },
    },
  });
  await prisma.report.create({
    data: {
      domain: 'example.com',
      reportId: 'example-new',
      orgName: 'New Reporter',
      email: 'dmarc@example.com',
      startDate: hoursAgo(20),
      endDate: hoursAgo(2),
      records: {
        create: [
          { sourceIp: '203.0.113.9', count: 3, disposition: 'none', dkim: 'fail', spf: 'fail', headerFrom: 'example.com' },
          { sourceIp: '203.0.113.5', count: 40, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'example.com' },
        ],
      },
    },
  });

  // Failure-heavy, but its only report is inside the window: no history, so no new_source.
  await prisma.report.create({
    data: {
      domain: 'spike.test',
      reportId: 'spike-only',
      orgName: 'Spike Reporter',
      email: 'dmarc@spike.test',
      startDate: hoursAgo(2),
      endDate: hoursAgo(1),
      records: {
        create: [
          { sourceIp: '192.0.2.10', count: 60, disposition: 'reject', dkim: 'fail', spf: 'fail', headerFrom: 'spike.test' },
          { sourceIp: '192.0.2.11', count: 40, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'spike.test' },
        ],
      },
    },
  });

  // Below the volume floor: 100% failing, but only 10 messages.
  await prisma.report.create({
    data: {
      domain: 'small.test',
      reportId: 'small-only',
      orgName: 'Small Reporter',
      email: 'dmarc@small.test',
      startDate: hoursAgo(2),
      endDate: hoursAgo(1),
      records: {
        create: [
          { sourceIp: '192.0.2.20', count: 10, disposition: 'reject', dkim: 'fail', spf: 'fail', headerFrom: 'small.test' },
        ],
      },
    },
  });

  // Above the floor, below the threshold.
  await prisma.report.create({
    data: {
      domain: 'calm.test',
      reportId: 'calm-only',
      orgName: 'Calm Reporter',
      email: 'dmarc@calm.test',
      startDate: hoursAgo(2),
      endDate: hoursAgo(1),
      records: {
        create: [
          { sourceIp: '192.0.2.30', count: 90, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'calm.test' },
          { sourceIp: '192.0.2.31', count: 10, disposition: 'none', dkim: 'fail', spf: 'fail', headerFrom: 'calm.test' },
        ],
      },
    },
  });

  // A first import of a domain's whole history: one report, inside the window, one sender.
  // Nothing may be reported as a "new source" here.
  await prisma.report.create({
    data: {
      domain: 'fresh.test',
      reportId: 'fresh-first',
      orgName: 'Fresh Reporter',
      email: 'dmarc@fresh.test',
      startDate: hoursAgo(3),
      endDate: hoursAgo(1),
      records: {
        create: [
          { sourceIp: '198.51.100.77', count: 5, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'fresh.test' },
        ],
      },
    },
  });
} catch (error) {
  console.error('❌ Alert test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------- scan

console.log('\nAlert scan');

await test('the first run records one new_source and one failure_spike', async () => {
  const result = await evaluateAlerts();
  assert.deepEqual(result, { created: 2, delivered: 2, errors: 0 }, JSON.stringify(result));

  const rows = await prisma.alert.findMany({ orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 2, `unexpected alerts: ${rows.map((row) => row.dedupKey).join(', ')}`);

  const newSource = rows.find((row) => row.kind === 'new_source');
  assert.ok(newSource, 'the brand-new sender must be reported');
  assert.equal(newSource!.dedupKey, 'new_source:example.com:203.0.113.9');
  assert.equal(newSource!.severity, 'info');
  assert.equal(newSource!.domain, 'example.com');
  assert.equal(newSource!.sourceIp, '203.0.113.9');
  const newSourceDetail = JSON.parse(newSource!.detail ?? '{}');
  assert.equal(newSourceDetail.sourceIp, '203.0.113.9');
  assert.equal(newSourceDetail.messages, 3, 'detail must carry the message count behind the finding');
  assert.equal(newSourceDetail.organization, 'New Reporter');

  const spike = rows.find((row) => row.kind === 'failure_spike');
  assert.ok(spike, 'the failure-heavy domain must be reported');
  assert.equal(spike!.domain, 'spike.test');
  const match = /^failure_spike:spike\.test:(\d+)$/.exec(spike!.dedupKey);
  assert.ok(match, `unexpected dedup key ${spike!.dedupKey}`);
  // Coarsened by the cooldown, so the same 24 h window always maps to the same key.
  const windowIndex = Number(match![1]);
  assert.ok(
    Math.abs(windowIndex - Math.floor(Date.now() / COOLDOWN_MS)) <= 1,
    'the dedup key must carry the cooldown window, not a raw timestamp',
  );
  assert.equal(spike!.severity, 'critical', '60% failures is over half the traffic');
  const spikeDetail = JSON.parse(spike!.detail ?? '{}');
  assert.equal(spikeDetail.messages, 100);
  assert.equal(spikeDetail.failures, 60);
  assert.equal(spikeDetail.failurePercent, 60);
});

await test('a second run creates nothing: both dedup keys already exist', async () => {
  const result = await evaluateAlerts();
  assert.deepEqual(result, { created: 0, delivered: 0, errors: 0 }, JSON.stringify(result));
  assert.equal(await prisma.alert.count(), 2, 'idempotence is the whole point of the dedup key');
});

await test('the webhook received both alerts, with an object detail and a delivery marker', async () => {
  assert.equal(hook.received.length, 2, `expected 2 webhook calls, got ${hook.received.length}`);
  const kinds = hook.received.map((body) => body.kind).sort();
  assert.deepEqual(kinds, ['failure_spike', 'new_source']);
  for (const body of hook.received) {
    assert.ok(body.title, 'the webhook payload must be readable on its own');
    assert.ok(body.domain);
    assert.ok(body.createdAt);
    assert.equal(typeof body.detail, 'object', 'detail must be sent parsed, not as JSON text');
  }

  const rows = await prisma.alert.findMany();
  for (const row of rows) {
    assert.ok(row.deliveredAt, `alert ${row.dedupKey} should be marked delivered on a 2xx`);
  }
});

await test('the initial import of a domain history produces no new_source alert', async () => {
  const freshAlerts = await prisma.alert.findMany({ where: { domain: 'fresh.test' } });
  assert.equal(freshAlerts.length, 0, 'a first import must not flood the list with historical senders');
  const small = await prisma.alert.findMany({ where: { domain: 'small.test' } });
  assert.equal(small.length, 0, 'below the volume floor there is no spike');
  const calm = await prisma.alert.findMany({ where: { domain: 'calm.test' } });
  assert.equal(calm.length, 0, '10% failures is below the threshold');
  const knownSender = await prisma.alert.findMany({
    where: { kind: 'new_source', sourceIp: '203.0.113.5' },
  });
  assert.equal(knownSender.length, 0, 'a sender seen before the window is not new');
});

await test('a failing webhook does not throw, leaves deliveredAt null, and is still idempotent', async () => {
  // The stub's /fail endpoint rather than a dead port: the case that matters is a receiver
  // that answers 500, and only that case can be asserted on afterwards.
  await prisma.setting.update({
    where: { key: 'alerts.webhookUrl' },
    data: { value: `${hookBase}/fail` },
  });
  invalidateSettingsCache();

  // A fresh finding is needed to attempt delivery at all.
  await prisma.report.create({
    data: {
      domain: 'hook.test',
      reportId: 'hook-old',
      orgName: 'Hook Reporter',
      email: 'dmarc@hook.test',
      startDate: daysAgo(3),
      endDate: daysAgo(2),
      records: {
        create: [
          { sourceIp: '198.51.100.200', count: 20, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'hook.test' },
        ],
      },
    },
  });
  await prisma.report.create({
    data: {
      domain: 'hook.test',
      reportId: 'hook-new',
      orgName: 'Hook Reporter',
      email: 'dmarc@hook.test',
      startDate: hoursAgo(20),
      endDate: hoursAgo(2),
      records: {
        create: [
          { sourceIp: '198.51.100.201', count: 4, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'hook.test' },
        ],
      },
    },
  });

  const result = await evaluateAlerts();
  assert.deepEqual(result, { created: 1, delivered: 0, errors: 1 }, JSON.stringify(result));
  assert.equal(hook.failures, 1, 'the stub must have been called once');

  const created = await prisma.alert.findUnique({
    where: { dedupKey: 'new_source:hook.test:198.51.100.201' },
  });
  assert.ok(created, 'the in-app alert must exist regardless of delivery');
  assert.equal(created!.deliveredAt, null, 'a failed delivery must not be recorded as delivered');

  const again = await evaluateAlerts();
  assert.equal(again.created, 0, 'the failed delivery must not re-create the alert on the next run');
});

// ---------------------------------------------------------------- HTTP

console.log('\nGET and POST /api/alerts');

adminCookie = await login('admin@test.local');
scopedCookie = await login('scoped@test.local');

let newSourceId = '';

await test('GET returns newest first with detail parsed to an object', async () => {
  const result = await call('GET', '/api/alerts?status=all', { cookie: adminCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.length, result.body.total);
  assert.equal(result.body.total, 3);

  const times = result.body.data.map((row: any) => Date.parse(row.createdAt));
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted, 'newest first');

  for (const row of result.body.data) {
    assert.equal(typeof row.detail, 'object', 'detail must be parsed, not a JSON string');
    assert.notEqual(row.detail, null);
  }

  const row = result.body.data.find(
    (entry: any) => entry.kind === 'new_source' && entry.domain === 'example.com',
  );
  newSourceId = row.id;
  assert.equal(row.detail.sourceIp, '203.0.113.9');
  assert.equal(row.acknowledgedAt, null);
});

await test('limit caps the page but total counts every match', async () => {
  const result = await call('GET', '/api/alerts?status=all&limit=1', { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.total, 3);
});

await test('an assigned user only sees their own domains', async () => {
  const result = await call('GET', '/api/alerts?status=all', { cookie: scopedCookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.data[0].domain, 'spike.test');
});

await test('acknowledging marks the row, keeps the first timestamp, and is audited', async () => {
  const first = await call('POST', `/api/alerts/${newSourceId}/ack`, { cookie: adminCookie });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.acknowledgedAt, 'acknowledgedAt must be set');
  assert.equal(first.body.acknowledgedBy, 'admin@test.local');

  const second = await call('POST', `/api/alerts/${newSourceId}/ack`, { cookie: adminCookie });
  assert.equal(second.status, 200);
  assert.equal(second.body.acknowledgedAt, first.body.acknowledgedAt, 'a repeat ack must not move the marker');

  const auditRow = await waitFor(() =>
    prisma.auditEvent.findFirst({ where: { action: 'alert.acknowledge', target: newSourceId } }),
  );
  assert.ok(auditRow, 'the acknowledgement must be audited');
  assert.equal(auditRow!.actor, 'admin@test.local');
  assert.equal(auditRow!.outcome, 'success');
});

await test('status filters separate open from acknowledged', async () => {
  const open = await call('GET', '/api/alerts?status=open', { cookie: adminCookie });
  assert.equal(open.status, 200);
  assert.equal(open.body.total, 2);
  assert.ok(open.body.data.every((row: any) => row.acknowledgedAt === null));

  const acknowledged = await call('GET', '/api/alerts?status=acknowledged', { cookie: adminCookie });
  assert.equal(acknowledged.body.total, 1);
  assert.equal(acknowledged.body.data[0].id, newSourceId);
});

await test('range filters on createdAt, and all is unbounded', async () => {
  // Backdate one alert so the 30d window has something to exclude.
  const old = await prisma.alert.findFirst({ where: { kind: 'failure_spike' } });
  await prisma.alert.update({ where: { id: old!.id }, data: { createdAt: daysAgo(40) } });

  const thirty = await call('GET', '/api/alerts?status=all&range=30d', { cookie: adminCookie });
  assert.equal(thirty.status, 200);
  assert.equal(thirty.body.total, 2, 'the 40-day-old alert must be outside 30d');

  const all = await call('GET', '/api/alerts?status=all&range=all', { cookie: adminCookie });
  assert.equal(all.body.total, 3);

  const week = await call('GET', '/api/alerts?status=all&range=7d', { cookie: adminCookie });
  assert.equal(week.body.total, 2);
});

await test('acknowledging needs an administrator; a scoped user is refused', async () => {
  // Writes are administrator-only here, like every other write in this app, so a non-admin is
  // stopped by the middleware (403) before the scope check runs. The 404 below is the other
  // half of the contract: an id that does not exist must not be confirmable.
  const scoped = await call('POST', `/api/alerts/${newSourceId}/ack`, { cookie: scopedCookie });
  assert.equal(scoped.status, 403);
  assert.equal(scoped.body.error.code, 'FORBIDDEN');

  const missing = await call('POST', '/api/alerts/does-not-exist/ack', { cookie: adminCookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const unchanged = await prisma.alert.findUnique({ where: { id: newSourceId } });
  assert.equal(unchanged!.acknowledgedBy, 'admin@test.local', 'the refused call must not re-ack');
});

await test('an unauthenticated read is refused, and alerts.enabled=false stops the scan', async () => {
  const anonymous = await call('GET', '/api/alerts?status=all');
  assert.equal(anonymous.status, 401);

  await prisma.setting.create({ data: { key: 'alerts.enabled', value: 'false' } });
  invalidateSettingsCache();
  const result = await evaluateAlerts();
  assert.deepEqual(result, { created: 0, delivered: 0, errors: 0 });
});

// ---------------------------------------------------------------- done

closeApi();
await prisma.$disconnect();
rmSync(tempDir, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`, () => resolve());
});
// Explicit: the rate limiter's sweeper interval keeps the event loop alive.
process.exit(failed > 0 ? 1 : 0);
