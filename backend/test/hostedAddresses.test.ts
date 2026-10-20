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
 * One-click hosted addresses: plus addressing on an existing mailbox, routing by recipient,
 * organisation scope, and the pre-save credential test helpers.
 *
 * No IMAP and no real DNS provider: the address is a routing row, and the "fetch active hosts"
 * test uses a local Cloudflare stub.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-hosted-'));
const databaseFile = join(tempDir, 'hosted.db');
const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.NODE_ENV = 'test';
delete process.env.IMAP_HOST;
delete process.env.IMAP_USER;
delete process.env.IMAP_PASSWORD;

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

const cf = {
  zones: ['example.com', 'example.org'],
  token: 'cf-test-token',
};

function buildCfStub(): express.Application {
  const app = express();
  app.get('/zones', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cf.token}`) {
      res.status(403).json({ success: false, errors: [{ message: 'Invalid token' }] });
      return;
    }
    res.json({
      success: true,
      errors: [],
      result: cf.zones.map((name, index) => ({ id: `z-${index}`, name })),
    });
  });
  return app;
}

// ---------------------------------------------------------------- app

let base = '';
let prisma: typeof import('../src/db/prisma.js').prisma;
let hostedService: typeof import('../src/services/hostedAddresses.js');
let orgA = '';
let orgB = '';
let mailboxA = '';
let cookieA = '';
let cookieB = '';

interface CallResult {
  status: number;
  body: any;
  cookie: string | null;
}

async function call(
  method: string,
  path: string,
  options: { cookie?: string; orgId?: string; body?: unknown } = {},
): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.orgId ? { 'X-Org-Id': options.orgId } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
  return { status: response.status, body, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function login(email: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', {
    body: { email, password: 'correct-horse-battery-staple' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.cookie!;
}

try {
  // Env must be set before config/env is imported.
  process.env.CLOUDFLARE_API_TOKEN = cf.token;

  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const cfServer = buildCfStub().listen(0);
  await new Promise<void>((resolve) => cfServer.once('listening', resolve));
  process.env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${(cfServer.address() as AddressInfo).port}`;

  const app = await import('../src/app.js');
  ({ prisma } = await import('../src/db/prisma.js'));
  hostedService = await import('../src/services/hostedAddresses.js');
  const auth = await import('../src/services/auth.js');

  const a = await prisma.organization.create({ data: { name: 'Alpha', slug: 'alpha' } });
  const b = await prisma.organization.create({ data: { name: 'Beta', slug: 'beta' } });
  orgA = a.id;
  orgB = b.id;

  const adminA = await prisma.user.create({
    data: {
      email: 'a@test.local',
      name: 'A',
      passwordHash: auth.hashPassword('correct-horse-battery-staple'),
      role: 'user',
    },
  });
  const adminB = await prisma.user.create({
    data: {
      email: 'b@test.local',
      name: 'B',
      passwordHash: auth.hashPassword('correct-horse-battery-staple'),
      role: 'user',
    },
  });
  await prisma.membership.createMany({
    data: [
      { userId: adminA.id, orgId: orgA, role: 'admin' },
      { userId: adminB.id, orgId: orgB, role: 'admin' },
    ],
  });

  const mailbox = await prisma.orgMailbox.create({
    data: {
      orgId: orgA,
      label: 'Primary',
      host: 'imap.example.com',
      port: 993,
      user: 'dmarc@example.com',
      password: 'secret',
      verifyTls: true,
      enabled: true,
    },
  });
  mailboxA = mailbox.id;

  const server = app.createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookieA = await login('a@test.local');
  cookieB = await login('b@test.local');

  // ---------------------------------------------------------------- create/list

  console.log('\nHosted addresses');

  await test('create derives a plus address from the base mailbox user', async () => {
    const result = await call('POST', `/api/organizations/${orgA}/hosted-addresses`, {
      cookie: cookieA,
      body: { label: 'Reports' },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const row = result.body.hostedAddress;
    assert.match(row.address, /^dmarc\+[a-f0-9]{16}@example\.com$/);
    assert.equal(row.baseMailbox?.id, mailboxA);
    assert.equal(row.enabled, true);
    assert.equal(row.lastReportAt, null);
  });

  await test('the address is returned by the list and token routing matches it', async () => {
    const list = await call('GET', `/api/organizations/${orgA}/hosted-addresses`, { cookie: cookieA });
    assert.equal(list.status, 200);
    const row = list.body.data[0];
    assert.ok(row);

    const byToken = hostedService.tokenMap([row as any]);
    const matched = hostedService.matchHostedAddress(
      ['postmaster@example.com', `DMARC+${row.token}@example.COM`],
      byToken,
    );
    assert.equal(matched?.id, row.id);
    assert.equal(hostedService.hostedTokenFromAddress('dmarc@example.com'), null);
    assert.equal(hostedService.hostedTokenFromAddress('dmarc+short@example.com'), null);
  });

  await test('a foreign organisation cannot list or create hosted addresses', async () => {
    const list = await call('GET', `/api/organizations/${orgA}/hosted-addresses`, {
      cookie: cookieB,
    });
    assert.equal(list.status, 404);

    const create = await call('POST', `/api/organizations/${orgA}/hosted-addresses`, {
      cookie: cookieB,
      body: { label: 'Nope' },
    });
    assert.equal(create.status, 404);
  });

  await test('an organisation with no mailbox gets a clear 409', async () => {
    const result = await call('POST', `/api/organizations/${orgB}/hosted-addresses`, {
      cookie: cookieB,
      body: { label: 'No mailbox' },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'NO_BASE_MAILBOX');
  });

  await test('an address can be disabled and deleted', async () => {
    const created = await call('POST', `/api/organizations/${orgA}/hosted-addresses`, {
      cookie: cookieA,
      body: { label: 'Temporary' },
    });
    const id = created.body.hostedAddress.id;

    const patched = await call('PATCH', `/api/organizations/${orgA}/hosted-addresses/${id}`, {
      cookie: cookieA,
      body: { enabled: false },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.hostedAddress.enabled, false);

    const removed = await call('DELETE', `/api/organizations/${orgA}/hosted-addresses/${id}`, {
      cookie: cookieA,
    });
    assert.equal(removed.status, 200);
    assert.equal((await prisma.hostedAddress.findUnique({ where: { id } })), null);
  });

  // ---------------------------------------------------------------- pre-save credential tests

  console.log('\nCredential tests');

  await test('DNS credentials can be tested and list the active hosts before saving', async () => {
    const result = await call('POST', `/api/organizations/${orgA}/dns-accounts/test`, {
      cookie: cookieA,
      body: { provider: 'cloudflare', credentials: { token: cf.token } },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.visible, cf.zones);
  });

  await test('a rejected credential returns ok:false with the provider message', async () => {
    const result = await call('POST', `/api/organizations/${orgA}/dns-accounts/test`, {
      cookie: cookieA,
      body: { provider: 'cloudflare', credentials: { token: 'wrong' } },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.match(result.body.message, /Invalid token/);
  });

  await test('the mailbox test endpoint validates required fields before connecting', async () => {
    const missing = await call('POST', `/api/organizations/${orgA}/mailboxes/test`, {
      cookie: cookieA,
      body: { host: 'imap.example.com' },
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message, /host, user and password/);
  });

  // ---------------------------------------------------------------- rua validation

  await test('a hosted address of another organisation cannot be published as rua', async () => {
    await prisma.domain.create({ data: { name: 'a.test', orgId: orgA } });
    const hostile = await call('POST', '/api/domains/a.test/dmarc/rua', {
      cookie: cookieA,
      body: { address: 'someone@elsewhere.test' },
    });
    assert.equal(hostile.status, 400);
    assert.equal(hostile.body.error.code, 'INVALID_RUA_ADDRESS');
  });

  server.close();
  cfServer.close();
} catch (error) {
  console.error('❌ Hosted address test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

rmSync(tempDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
