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
 * Org-owned DNS accounts (phase 4) and their integration into the plan/apply path.
 *
 * Three things are exercised here:
 *
 *  1. the CRUD routes under /api/organizations/:orgId/dns-accounts - secrets never returned,
 *     provider immutable, cross-organisation answers 404;
 *  2. the account resolution in `services/dnsApply.ts` - an assigned account wins, an
 *     unassigned domain auto-selects the organisation's enabled accounts (Cloudflare first,
 *     then label), an assigned-but-disabled account is an error and not a silent fallthrough,
 *     another organisation's account is never used, and the Default organisation keeps the
 *     legacy environment/settings credentials;
 *  3. the DMARC `rua` address, which comes from the domain organisation's mailbox.
 *
 * A real HTTP server stands in for Cloudflare (the Loopia writer is only constructed, never
 * called), so the credentials read from the account row are the ones actually sent. No test
 * reaches the network.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-dns-accounts-'));
const databaseFile = join(tempDir, 'dns-accounts.db');
const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.NODE_ENV = 'test';
// The instance running these tests may have real credentials in its environment; the test
// decides for itself which account answers.
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.LOOPIA_API_USER;
delete process.env.LOOPIA_API_PASS;
// The legacy (pre-tenancy) mailbox: used for the Default organisation only.
process.env.IMAP_HOST = 'imap.legacy.test';
process.env.IMAP_PORT = '993';
process.env.IMAP_USER = 'legacy@legacy.test';
process.env.IMAP_PASSWORD = 'legacy-password';

const PASSWORD = 'correct-horse-battery-staple';

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
  zones: [
    { id: 'zone-a', name: 'a.test' },
    { id: 'zone-d', name: 'd.test' },
    { id: 'zone-u', name: 'untracked.test' },
  ],
  records: [] as StubRecord[],
  nextId: 0,
  calls: [] as Array<{ method: string; path: string; token: string; body: any }>,
};

/** Tokens the stub accepts; anything else is answered like Cloudflare answers a bad token. */
const ACCEPTED_TOKENS = new Set([
  'token-alpha',
  'token-zulu',
  'token-rotated',
  'token-delete',
  'token-verify',
  'legacy-token',
]);

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
}

function buildCloudflareStub(): express.Application {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const header = String(req.headers.authorization ?? '');
    const token = header.replace(/^Bearer\s+/i, '').trim();
    state.calls.push({ method: req.method, path: req.path, token, body: req.body ?? null });
    if (!ACCEPTED_TOKENS.has(token)) {
      res.status(403).json({ success: false, result: null, errors: [{ code: 9109, message: 'Invalid access token.' }] });
      return;
    }
    next();
  });

  app.get('/zones', (req, res) => {
    const name = String(req.query.name ?? '').toLowerCase();
    const zones = name
      ? state.zones.filter((zone) => zone.name === name)
      : state.zones;
    res.json({ success: true, errors: [], result: zones });
  });

  app.get('/zones/:zoneId/dns_records', (req, res) => {
    const name = String(req.query.name ?? '').toLowerCase();
    res.json({
      success: true,
      errors: [],
      result: state.records.filter((record) => record.name.toLowerCase() === name),
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
    if (typeof req.body?.content === 'string') {
      record.content = req.body.content;
    }
    res.json({ success: true, errors: [], result: record });
  });

  return app;
}

// ---------------------------------------------------------------- Loopia stub

let loopiaCalls = 0;

function buildLoopiaStub(): express.Application {
  const app = express();
  app.use(express.text({ type: '*/*' }));
  app.post('/', (_req, res) => {
    loopiaCalls += 1;
    // `getDomains` returning an empty list keeps this account from matching any zone, so the
    // Cloudflare writers are the ones that answer (and the test never writes through Loopia).
    res.type('text/xml').send(
      '<?xml version="1.0"?><methodResponse><params><param><value><array><data></data></array></value></param></params></methodResponse>',
    );
  });
  return app;
}

// ---------------------------------------------------------------- offline fetch

let cfBase = '';
let loopiaBase = '';

const offlineFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(cfBase) || url.startsWith(loopiaBase)) {
    return fetch(url, init);
  }
  return Promise.reject(new Error(`no outbound network in tests: ${url}`));
};

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

// ---------------------------------------------------------------- harness

interface CallResult {
  status: number;
  body: any;
  cookie: string | null;
}

let base = '';
let prisma: typeof import('../src/db/prisma.js').prisma;
let dnsApply: typeof import('../src/services/dnsApply.js');
let organizations: typeof import('../src/services/organizations.js');

let superCookie = '';
let aliceCookie = '';
let bobCookie = '';
let carolCookie = '';

let orgA = '';
let orgB = '';
let defaultOrg = '';

let alphaCf = '';
let zuluCf = '';
let loopiaAccount = '';
let disabledCf = '';

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
  const result = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.cookie);
  return result.cookie!;
}

async function createUser(email: string, role: 'admin' | 'user', name: string): Promise<{ id: string }> {
  const auth = await import('../src/services/auth.js');
  return prisma.user.create({
    data: { email, name, passwordHash: auth.hashPassword(PASSWORD), role, isActive: true },
    select: { id: true },
  });
}

async function createAccount(
  orgId: string,
  label: string,
  provider: 'cloudflare' | 'loopia',
  credentials: Record<string, unknown>,
  enabled = true,
): Promise<string> {
  const row = await prisma.dnsAccount.create({
    data: { orgId, label, provider, enabled, credentials: JSON.stringify(credentials) },
    select: { id: true },
  });
  return row.id;
}

/** The plan/apply options for the service-level tests: no settings reads, no DNS-over-HTTPS. */
const SERVICE_OPTIONS = () => ({
  baseUrl: cfBase,
  loopia: { baseUrl: loopiaBase },
  fetchImpl: offlineFetch,
  resolver: emptyResolver,
  providers: [] as string[],
});

function authTokens(method: string): string[] {
  return state.calls.filter((entry) => entry.method === method).map((entry) => entry.token);
}

async function auditRows(action: string): Promise<any[]> {
  // The middleware writes on `finish`, i.e. just after the response the client already has.
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await prisma.auditEvent.findMany({ where: { action }, orderBy: { createdAt: 'desc' } });
    if (rows.length > 0) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

// ---------------------------------------------------------------- setup

try {
  const cfServer = buildCloudflareStub().listen(0);
  const loopiaServer = buildLoopiaStub().listen(0);
  await Promise.all([
    new Promise<void>((resolve) => cfServer.once('listening', resolve)),
    new Promise<void>((resolve) => loopiaServer.once('listening', resolve)),
  ]);
  cfBase = `http://127.0.0.1:${(cfServer.address() as AddressInfo).port}`;
  loopiaBase = `http://127.0.0.1:${(loopiaServer.address() as AddressInfo).port}/`;
  // The routes build their options from the environment; the stub is what they reach.
  process.env.CLOUDFLARE_API_BASE = cfBase;

  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const { default: dnsAccountsRouter } = await import('../src/routes/dnsAccounts.js');
  const { default: dnsRouter } = await import('../src/routes/dns.js');
  const { default: authRouter } = await import('../src/routes/auth.js');
  const { attachUser, attachOrganization } = await import('../src/middleware/auth.js');
  const { auditRequests } = await import('../src/middleware/audit.js');
  ({ prisma } = await import('../src/db/prisma.js'));
  organizations = await import('../src/services/organizations.js');
  dnsApply = await import('../src/services/dnsApply.js');

  // --- users, organisations, domains --------------------------------------------------------
  // The Default organisation is created before the tenant accounts, so nobody has a membership
  // in it but the superadmin: a regular user's only membership decides their active org.
  const superUser = await createUser('super@test.local', 'admin', 'Super');
  assert.ok(superUser.id);

  const migration = await organizations.ensureDefaultOrganization();
  defaultOrg = migration.orgId!;
  assert.equal(migration.created, true);

  const a = await prisma.organization.create({ data: { name: 'Alpha', slug: 'alpha' } });
  const b = await prisma.organization.create({ data: { name: 'Beta', slug: 'beta' } });
  orgA = a.id;
  orgB = b.id;

  const alice = await createUser('alice@test.local', 'user', 'Alice');
  const bob = await createUser('bob@test.local', 'user', 'Bob');
  const carol = await createUser('carol@test.local', 'user', 'Carol');

  await prisma.membership.createMany({
    data: [
      { userId: alice.id, orgId: orgA, role: 'admin' },
      { userId: carol.id, orgId: orgA, role: 'viewer' },
      { userId: bob.id, orgId: orgB, role: 'admin' },
    ],
  });

  await prisma.domain.createMany({
    data: [
      { name: 'a.test', orgId: orgA },
      { name: 'disabled.test', orgId: orgA },
      { name: 'deletable.test', orgId: orgA },
      { name: 'b.test', orgId: orgB },
      { name: 'd.test', orgId: defaultOrg },
    ],
  });

  alphaCf = await createAccount(orgA, 'Alpha Cloudflare', 'cloudflare', { token: 'token-alpha' });
  zuluCf = await createAccount(orgA, 'Zulu Cloudflare', 'cloudflare', { token: 'token-zulu' });
  loopiaAccount = await createAccount(orgA, 'Loopia account', 'loopia', {
    username: 'pi@loopiaapi',
    password: 'loopia-password',
  });
  disabledCf = await createAccount(orgA, 'Disabled Cloudflare', 'cloudflare', { token: 'token-zulu' }, false);

  // The coordinator mounts both routers in app.ts (the DNS-accounts router under
  // /api/organizations *before* the organisations router, the DNS routes under /api/domains
  // before the domains router). Their own app is assembled here from the same middleware so
  // the test does not depend on that edit and never exercises an unrelated view.
  const expressApp = express();
  expressApp.set('trust proxy', true);
  expressApp.use(express.json());
  expressApp.use(attachUser);
  expressApp.use(attachOrganization);
  expressApp.use(auditRequests);
  expressApp.use('/api/auth', authRouter);
  expressApp.use('/api/domains', dnsRouter);
  expressApp.use('/api/organizations', dnsAccountsRouter);
  const server = expressApp.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as any).__servers = [cfServer, loopiaServer, server];

  superCookie = await login('super@test.local');
  aliceCookie = await login('alice@test.local');
  bobCookie = await login('bob@test.local');
  carolCookie = await login('carol@test.local');
} catch (error) {
  console.error('❌ dnsAccounts test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------- account resolution

console.log('\nAccount resolution');

await test('an unassigned domain auto-selects the org\u2019s enabled Cloudflare account, ordered by label', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('a.test', SERVICE_OPTIONS());

  assert.equal(plan.provider, 'cloudflare');
  assert.deepEqual(plan.account, { id: alphaCf, label: 'Alpha Cloudflare', provider: 'cloudflare' });
  assert.deepEqual(plan.zone, { id: 'zone-a', name: 'a.test' });
  // The credentials really came from that row, not from the environment.
  assert.deepEqual([...new Set(authTokens('GET'))], ['token-alpha']);
});

await test('an assigned account wins over auto selection', async () => {
  resetStub();
  await prisma.domain.update({ where: { name: 'a.test' }, data: { dnsAccountId: zuluCf } });

  try {
    const plan = await dnsApply.buildDnsPlan('a.test', SERVICE_OPTIONS());
    assert.equal(plan.account?.id, zuluCf);
    assert.equal(plan.account?.label, 'Zulu Cloudflare');
    assert.deepEqual([...new Set(authTokens('GET'))], ['token-zulu']);
  } finally {
    await prisma.domain.update({ where: { name: 'a.test' }, data: { dnsAccountId: null } });
  }
});

await test('an assigned but disabled account is a 409, never a fallthrough', async () => {
  resetStub();
  await prisma.domain.update({ where: { name: 'disabled.test' }, data: { dnsAccountId: disabledCf } });

  await assert.rejects(
    () => dnsApply.buildDnsPlan('disabled.test', SERVICE_OPTIONS()),
    (error: any) => error.statusCode === 409 && error.code === 'DNS_ACCOUNT_DISABLED',
  );
  // Nothing was asked of any provider: picking a different account would have written records
  // through credentials the operator did not choose.
  assert.deepEqual(state.calls, []);
  await prisma.domain.update({ where: { name: 'disabled.test' }, data: { dnsAccountId: null } });
});

await test('an org with no accounts does not fall back to the instance credentials', async () => {
  resetStub();
  await assert.rejects(
    () => dnsApply.buildDnsPlan('b.test', { ...SERVICE_OPTIONS(), token: 'legacy-token' }),
    (error: any) => error.statusCode === 409 && error.code === 'DNS_NOT_CONFIGURED',
  );
  assert.deepEqual(state.calls, []);
});

await test('the Default organisation keeps the legacy env/settings credentials', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('d.test', { ...SERVICE_OPTIONS(), token: 'legacy-token' });

  assert.equal(plan.account, null);
  assert.equal(plan.provider, 'cloudflare');
  assert.deepEqual([...new Set(authTokens('GET'))], ['legacy-token']);
});

await test('an untracked domain name still uses the legacy path', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('untracked.test', { ...SERVICE_OPTIONS(), token: 'legacy-token' });
  assert.equal(plan.account, null);
  assert.equal(plan.zone?.name, 'untracked.test');
});

await test('injected accounts are used instead of the database (test injection)', async () => {
  resetStub();
  const plan = await dnsApply.buildDnsPlan('a.test', {
    ...SERVICE_OPTIONS(),
    dnsAccounts: [
      { id: 'injected-cf', label: 'Injected', provider: 'cloudflare', credentials: { token: 'token-alpha' } },
    ],
  });
  assert.deepEqual(plan.account, { id: 'injected-cf', label: 'Injected', provider: 'cloudflare' });
});

await test('apply reuses the account the plan resolved', async () => {
  resetStub();
  await prisma.domain.update({ where: { name: 'a.test' }, data: { dnsAccountId: zuluCf } });

  try {
    const result = await dnsApply.applyDnsPlan('a.test', { keys: ['tls-rpt'] }, SERVICE_OPTIONS());
    assert.deepEqual(result.applied.map((entry) => [entry.key, entry.action]), [['tls-rpt', 'create']]);
    assert.deepEqual([...new Set(authTokens('POST'))], ['token-zulu']);
  } finally {
    await prisma.domain.update({ where: { name: 'a.test' }, data: { dnsAccountId: null } });
  }
});

await test('addDmarcRua uses the same account resolution', async () => {
  resetStub();
  await prisma.domain.update({ where: { name: 'a.test' }, data: { dnsAccountId: zuluCf } });

  try {
    const result = await dnsApply.addDmarcRua('a.test', 'dmarc@alpha.test', SERVICE_OPTIONS());
    assert.equal(result.value, 'v=DMARC1; p=none; rua=mailto:dmarc@alpha.test');
    const writes = state.calls.filter((entry) => entry.method !== 'GET');
    assert.ok(writes.length > 0);
    assert.deepEqual([...new Set(writes.map((entry) => entry.token))], ['token-zulu']);
  } finally {
    await prisma.domain.update({ where: { name: 'a.test' }, data: { dnsAccountId: null } });
  }
});

await test('the Loopia writer is built from the row, not from the environment', async () => {
  resetStub();
  // Pin Loopia: the org has one Loopia account, so its writer is the only candidate and it is
  // asked (the stub answers with no domains, which is a warning rather than a failure).
  const before = loopiaCalls;
  const plan = await dnsApply.buildDnsPlan('a.test', { ...SERVICE_OPTIONS(), provider: 'loopia' });
  assert.equal(plan.provider, 'loopia');
  assert.equal(plan.account?.id, loopiaAccount);
  assert.equal(plan.zone, null);
  assert.ok(loopiaCalls > before, 'the Loopia API must have been called');
});

// ---------------------------------------------------------------- mailbox

console.log('\nDMARC rua address');

await test('the org mailbox user wins over the legacy mailbox', async () => {
  await prisma.orgMailbox.create({
    data: {
      orgId: orgA,
      label: 'Disabled first',
      host: 'imap.alpha.test',
      port: 993,
      user: 'off@alpha.test',
      password: 'secret',
      enabled: false,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    },
  });
  await prisma.orgMailbox.create({
    data: {
      orgId: orgA,
      label: 'Reports',
      host: 'imap.alpha.test',
      port: 993,
      user: 'reports@alpha.test',
      password: 'secret',
      enabled: true,
    },
  });

  assert.equal(await dnsApply.resolveDmarcMailboxAddress('a.test'), 'reports@alpha.test');
});

await test('an org without a mailbox gets no rua address (no legacy fallthrough)', async () => {
  assert.equal(await dnsApply.resolveDmarcMailboxAddress('b.test'), null);
});

await test('the Default organisation falls back to the legacy mailbox', async () => {
  assert.equal(await dnsApply.resolveDmarcMailboxAddress('d.test'), 'legacy@legacy.test');
  assert.equal(await dnsApply.resolveDmarcMailboxAddress('untracked.test'), 'legacy@legacy.test');
});

// ---------------------------------------------------------------- CRUD over HTTP

console.log('\nDNS account routes');

await test('list returns the serialized accounts without any credential', async () => {
  const result = await call('GET', `/api/organizations/${orgA}/dns-accounts`, { cookie: aliceCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.length, 4);

  const alpha = result.body.data.find((row: any) => row.id === alphaCf);
  assert.deepEqual(Object.keys(alpha).sort(), [
    'createdAt',
    'credentialSet',
    'domainCount',
    'enabled',
    'id',
    'label',
    'provider',
    'updatedAt',
  ]);
  assert.equal(alpha.credentialSet, true);
  assert.equal(alpha.provider, 'cloudflare');
  assert.equal(alpha.domainCount, 0);
  assert.ok(!JSON.stringify(result.body).includes('token-alpha'));

  // Cloudflare first, then label.
  assert.deepEqual(
    result.body.data.map((row: any) => row.label),
    ['Alpha Cloudflare', 'Disabled Cloudflare', 'Zulu Cloudflare', 'Loopia account'],
  );
});

await test('cross-organisation, viewer and unknown organisations answer 404', async () => {
  const foreign = await call('GET', `/api/organizations/${orgA}/dns-accounts`, { cookie: bobCookie });
  assert.equal(foreign.status, 404);

  const viewer = await call('GET', `/api/organizations/${orgA}/dns-accounts`, { cookie: carolCookie });
  assert.equal(viewer.status, 404);

  const unknown = await call('GET', '/api/organizations/does-not-exist/dns-accounts', { cookie: aliceCookie });
  assert.equal(unknown.status, 404);

  // A superadmin reaches every organisation.
  const asSuper = await call('GET', `/api/organizations/${orgB}/dns-accounts`, { cookie: superCookie });
  assert.equal(asSuper.status, 200);
  assert.deepEqual(asSuper.body.data, []);
});

await test('create stores the credentials and never returns them', async () => {
  const result = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'Created', provider: 'cloudflare', credentials: { token: 'token-rotated' } },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.label, 'Created');
  assert.equal(result.body.data.enabled, true);
  assert.equal(result.body.data.credentialSet, true);
  assert.ok(!JSON.stringify(result.body).includes('token-rotated'));

  const stored = await prisma.dnsAccount.findUnique({ where: { id: result.body.data.id } });
  assert.deepEqual(JSON.parse(stored!.credentials), { token: 'token-rotated' });

  const rows = await auditRows('dnsAccount.create');
  const row = rows.find((entry) => entry.target === 'Created');
  assert.ok(row, 'the create must be audited');
  assert.equal(row.orgId, orgA);
  assert.ok(!String(row.detail).includes('token-rotated'));

  const duplicate = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'Created', provider: 'cloudflare', credentials: { token: 'token-rotated' } },
  });
  assert.equal(duplicate.status, 409);

  const missingToken = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'No credentials', provider: 'cloudflare', credentials: {} },
  });
  assert.equal(missingToken.status, 400);
});

await test('patch keeps the provider and blank credentials keep the stored secret', async () => {
  const created = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'Patching', provider: 'cloudflare', credentials: { token: 'token-rotated' } },
  });
  const id = created.body.data.id;
  const before = (await prisma.dnsAccount.findUnique({ where: { id } }))!.credentials;

  const result = await call('PATCH', `/api/organizations/${orgA}/dns-accounts/${id}`, {
    cookie: aliceCookie,
    body: { label: 'Patched', provider: 'loopia', credentials: {} },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.label, 'Patched');
  assert.equal(result.body.data.provider, 'cloudflare', 'the provider is immutable');
  assert.equal((await prisma.dnsAccount.findUnique({ where: { id } }))!.credentials, before);

  const rotated = await call('PATCH', `/api/organizations/${orgA}/dns-accounts/${id}`, {
    cookie: aliceCookie,
    body: { enabled: false, credentials: { token: 'token-verify' } },
  });
  assert.equal(rotated.body.data.enabled, false);
  assert.deepEqual(
    JSON.parse((await prisma.dnsAccount.findUnique({ where: { id } }))!.credentials),
    { token: 'token-verify' },
  );

  const rows = await auditRows('dnsAccount.update');
  const row = rows.find((entry) => entry.target === 'Patched');
  assert.ok(row);
  assert.equal(row.orgId, orgA);
  assert.ok(!String(row.detail).includes('token-verify'));
});

await test('verify performs one read-only call and reports what the token can see', async () => {
  const created = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'Verifiable', provider: 'cloudflare', credentials: { token: 'token-verify' } },
  });
  const id = created.body.data.id;

  resetStub();
  const ok = await call('POST', `/api/organizations/${orgA}/dns-accounts/${id}/verify`, { cookie: aliceCookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.deepEqual(ok.body.visible.sort(), ['a.test', 'd.test', 'untracked.test']);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].method, 'GET');

  const bogus = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'Bogus', provider: 'cloudflare', credentials: { token: 'bogus-token' } },
  });
  const failed = await call('POST', `/api/organizations/${orgA}/dns-accounts/${bogus.body.data.id}/verify`, {
    cookie: aliceCookie,
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.message, 'Invalid access token.');

  const rows = await auditRows('dnsAccount.verify');
  assert.ok(rows.some((row) => row.orgId === orgA));
});

await test('delete removes the account and leaves the domain unassigned', async () => {
  const created = await call('POST', `/api/organizations/${orgA}/dns-accounts`, {
    cookie: aliceCookie,
    body: { label: 'Deletable', provider: 'cloudflare', credentials: { token: 'token-delete' } },
  });
  const id = created.body.data.id;
  await prisma.domain.update({ where: { name: 'deletable.test' }, data: { dnsAccountId: id } });

  const result = await call('DELETE', `/api/organizations/${orgA}/dns-accounts/${id}`, { cookie: aliceCookie });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(await prisma.dnsAccount.findUnique({ where: { id } }), null);
  assert.equal(
    (await prisma.domain.findUnique({ where: { name: 'deletable.test' } }))?.dnsAccountId,
    null,
  );

  const again = await call('DELETE', `/api/organizations/${orgA}/dns-accounts/${id}`, { cookie: aliceCookie });
  assert.equal(again.status, 404);

  const rows = await auditRows('dnsAccount.delete');
  const row = rows.find((entry) => entry.target === 'Deletable');
  assert.ok(row);
  assert.equal(row.orgId, orgA);
});

await test('another org admin cannot patch or delete the account', async () => {
  const patch = await call('PATCH', `/api/organizations/${orgA}/dns-accounts/${alphaCf}`, {
    cookie: bobCookie,
    body: { label: 'Hijacked' },
  });
  assert.equal(patch.status, 404);

  const remove = await call('DELETE', `/api/organizations/${orgA}/dns-accounts/${alphaCf}`, { cookie: bobCookie });
  assert.equal(remove.status, 404);

  assert.equal((await prisma.dnsAccount.findUnique({ where: { id: alphaCf } }))?.label, 'Alpha Cloudflare');
});

// ---------------------------------------------------------------- DNS routes

console.log('\nDomain DNS routes');

await test('a non-superadmin may act only on a domain their organisation owns (404 otherwise)', async () => {
  resetStub();
  const foreignPlan = await call('GET', '/api/domains/b.test/dns/plan', { cookie: aliceCookie });
  assert.equal(foreignPlan.status, 404);
  assert.equal(foreignPlan.body.error.code, 'NOT_FOUND');

  const foreignApply = await call('POST', '/api/domains/b.test/dns/apply', {
    cookie: aliceCookie,
    body: { keys: ['spf'] },
  });
  assert.equal(foreignApply.status, 404);

  const untracked = await call('GET', '/api/domains/untracked.test/dns/plan', { cookie: aliceCookie });
  assert.equal(untracked.status, 404);

  // A viewer of the same organisation fails the org-admin guard itself (403): the domain is
  // theirs, so there is nothing to hide; cross-organisation answers 404 above.
  const viewer = await call('GET', '/api/domains/a.test/dns/plan', { cookie: carolCookie });
  assert.equal(viewer.status, 403);
  assert.equal(viewer.body.error.code, 'FORBIDDEN');

  const reversePlan = await call('GET', '/api/domains/a.test/dns/plan', { cookie: bobCookie });
  assert.equal(reversePlan.status, 404);

  assert.deepEqual(state.calls, [], 'a refused request must not reach a provider');
});

await test('rua on the domain adds the organisation mailbox to the published record', async () => {
  resetStub();
  const existing = seedRecord('_dmarc.a.test', 'TXT', 'v=DMARC1; p=none; rua=mailto:old@a.test');

  const result = await call('POST', '/api/domains/a.test/dmarc/rua', { cookie: aliceCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body).sort(), ['previous', 'recordId', 'value']);
  assert.equal(result.body.recordId, existing.id);
  assert.equal(
    result.body.value,
    'v=DMARC1; p=none; rua=mailto:old@a.test, mailto:reports@alpha.test',
  );
  assert.equal(state.records.length, 1);
});

// ---------------------------------------------------------------- done

const servers = (globalThis as any).__servers as Array<import('node:http').Server>;
for (const server of servers) {
  server.close();
}
rmSync(tempDir, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`, () => resolve());
});
// The rate limiter's sweeper interval keeps the loop alive.
process.exit(failed > 0 ? 1 : 0);
