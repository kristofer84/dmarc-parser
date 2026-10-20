import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Tenancy: organisations, memberships, active-organisation scoping and domain ownership.
 *
 * The test is deliberately end-to-end over HTTP for the scoping rules, because that is where a
 * missing `orgId` becomes a data leak rather than a type error. The migration case is seeded
 * first, before any organisation exists, then `ensureDefaultOrganization()` is run against it.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-tenancy-'));
const databaseFile = join(tempDir, 'tenancy.db');
const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.DATABASE_URL = `file:${databaseFile}`;
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

const PASSWORD = 'correct-horse-battery-staple';

interface CallResult {
  status: number;
  body: any;
  cookie: string | null;
}

let base = '';
let prisma: typeof import('../src/db/prisma.js').prisma;
let organizations: typeof import('../src/services/organizations.js');

let superCookie = '';
let aliceCookie = '';
let bobCookie = '';
let carolCookie = '';
let legacyCookie = '';
let daveCookie = '';

let orgA = '';
let orgB = '';
let defaultOrg = '';

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
  return {
    status: response.status,
    body,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

async function login(email: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.cookie);
  return result.cookie!;
}

async function createUser(
  email: string,
  role: 'admin' | 'user',
  displayName: string,
): Promise<{ id: string }> {
  const auth = await import('../src/services/auth.js');
  return prisma.user.create({
    data: {
      email,
      name: displayName,
      passwordHash: auth.hashPassword(PASSWORD),
      role,
      isActive: true,
    },
    select: { id: true },
  });
}

async function seedReport(reportId: string, domain: string, orgId: string | null, sourceIp: string) {
  return prisma.report.create({
    data: {
      reportId,
      domain,
      orgId,
      orgName: `Reporter ${domain}`,
      email: `noreply@${domain}`,
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() - 3_600_000),
      records: {
        create: [
          {
            sourceIp,
            count: 10,
            disposition: 'none',
            dkim: 'pass',
            spf: 'pass',
            headerFrom: domain,
          },
        ],
      },
    },
  });
}

try {
  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const app = await import('../src/app.js');
  ({ prisma } = await import('../src/db/prisma.js'));
  organizations = await import('../src/services/organizations.js');

  // --- Migration fixture: legacy data exists before any organisation -----------------------
  const legacy = await createUser('legacy@test.local', 'user', 'Legacy User');
  await prisma.domain.create({
    data: { name: 'legacy.test', monitored: true },
  });
  await seedReport('legacy-report', 'legacy.test', null, '198.51.100.10');

  const migration = await organizations.ensureDefaultOrganization();
  assert.equal(migration.created, true);
  defaultOrg = migration.orgId!;

  const defaultMembership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: legacy.id, orgId: defaultOrg } },
  });
  assert.equal(defaultMembership?.role, 'viewer');
  assert.equal(
    (await prisma.domain.findUnique({ where: { name: 'legacy.test' } }))?.orgId,
    defaultOrg,
  );
  assert.equal(
    (await prisma.report.findUnique({ where: { reportId: 'legacy-report' } }))?.orgId,
    defaultOrg,
  );

  // Idempotent.
  assert.deepEqual(await organizations.ensureDefaultOrganization(), {
    created: false,
    orgId: defaultOrg,
  });

  // --- Two real organisations --------------------------------------------------------------
  const a = await prisma.organization.create({ data: { name: 'Alpha', slug: 'alpha' } });
  const b = await prisma.organization.create({ data: { name: 'Beta', slug: 'beta' } });
  orgA = a.id;
  orgB = b.id;

  const superUser = await createUser('super@test.local', 'admin', 'Super');
  const alice = await createUser('alice@test.local', 'user', 'Alice');
  const bob = await createUser('bob@test.local', 'user', 'Bob');
  const carol = await createUser('carol@test.local', 'user', 'Carol');
  const dave = await createUser('dave@test.local', 'user', 'Dave');

  await prisma.membership.createMany({
    data: [
      { userId: alice.id, orgId: orgA, role: 'admin' },
      { userId: carol.id, orgId: orgA, role: 'viewer' },
      { userId: bob.id, orgId: orgB, role: 'viewer' },
      { userId: dave.id, orgId: orgB, role: 'admin' },
    ],
  });

  await prisma.domain.create({ data: { name: 'a.test', orgId: orgA } });
  await prisma.domain.create({ data: { name: 'b.test', orgId: orgB } });
  await prisma.domain.create({ data: { name: 'unowned.test', orgId: null } });

  await seedReport('report-a', 'a.test', orgA, '203.0.113.10');
  await seedReport('report-b', 'b.test', orgB, '203.0.113.20');

  await prisma.alert.createMany({
    data: [
      {
        kind: 'new_source',
        severity: 'info',
        domain: 'a.test',
        orgId: orgA,
        title: 'A alert',
        dedupKey: 'a-alert',
      },
      {
        kind: 'new_source',
        severity: 'info',
        domain: 'b.test',
        orgId: orgB,
        title: 'B alert',
        dedupKey: 'b-alert',
      },
    ],
  });

  const server = app.createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  superCookie = await login('super@test.local');
  aliceCookie = await login('alice@test.local');
  bobCookie = await login('bob@test.local');
  daveCookie = await login('dave@test.local');
  carolCookie = await login('carol@test.local');
  legacyCookie = await login('legacy@test.local');

  // --- Session shape -----------------------------------------------------------------------
  console.log('\nSession and organisations');

  await test('/auth/me returns memberships, the active org and the org role', async () => {
    const me = await call('GET', '/api/auth/me', { cookie: aliceCookie });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.activeOrganizationId, orgA);
    assert.equal(me.body.orgRole, 'admin');
    assert.equal(me.body.isSuperAdmin, false);
    assert.deepEqual(
      me.body.organizations.map((org: any) => org.name).sort(),
      ['Alpha'],
    );
    assert.deepEqual(me.body.domains, ['a.test']);
  });

  await test('a superadmin has no active org and sees every organisation', async () => {
    const me = await call('GET', '/api/auth/me', { cookie: superCookie });
    assert.equal(me.body.isSuperAdmin, true);
    assert.equal(me.body.activeOrganizationId, null);
    assert.ok(me.body.organizations.some((org: any) => org.name === 'Beta'));
    // All-domain scope is materialised as a list for the SPA.
    assert.ok(me.body.domains.includes('a.test'));
    assert.ok(me.body.domains.includes('b.test'));
  });

  // --- Read isolation ----------------------------------------------------------------------
  console.log('\nRead isolation');

  await test('reports, summary, sources and domains only show the active org', async () => {
    const reports = await call('GET', '/api/reports', { cookie: aliceCookie });
    assert.equal(reports.status, 200);
    assert.deepEqual(reports.body.data.map((row: any) => row.domain), ['a.test']);

    const summary = await call('GET', '/api/summary?range=all', { cookie: aliceCookie });
    assert.equal(summary.body.totalReports, 1);

    const sources = await call('GET', '/api/sources?range=all', { cookie: aliceCookie });
    assert.deepEqual(sources.body.sources.map((row: any) => row.sourceIp), ['203.0.113.10']);

    const domains = await call('GET', '/api/domains', { cookie: aliceCookie });
    assert.deepEqual(domains.body.data.map((row: any) => row.name), ['a.test']);

    const alerts = await call('GET', '/api/alerts', { cookie: aliceCookie });
    assert.deepEqual(alerts.body.data.map((row: any) => row.title), ['A alert']);
  });

  await test('a viewer sees their org but cannot select another one', async () => {
    const reports = await call('GET', '/api/reports', { cookie: bobCookie });
    assert.deepEqual(reports.body.data.map((row: any) => row.domain), ['b.test']);

    const forbidden = await call('GET', '/api/reports', { cookie: bobCookie, orgId: orgA });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'ORG_FORBIDDEN');
  });

  await test('a superadmin can select one org or browse all', async () => {
    const all = await call('GET', '/api/reports', { cookie: superCookie });
    assert.equal(all.body.data.length, 3); // a, b and the legacy report

    const alpha = await call('GET', '/api/reports', { cookie: superCookie, orgId: orgA });
    assert.deepEqual(alpha.body.data.map((row: any) => row.domain), ['a.test']);
  });

  await test('the legacy user sees only the Default organisation after migration', async () => {
    const me = await call('GET', '/api/auth/me', { cookie: legacyCookie });
    assert.equal(me.body.activeOrganizationId, defaultOrg);
    assert.deepEqual(me.body.domains, ['legacy.test']);

    const reports = await call('GET', '/api/reports', { cookie: legacyCookie });
    assert.deepEqual(reports.body.data.map((row: any) => row.domain), ['legacy.test']);
  });

  // --- Write permissions -------------------------------------------------------------------
  console.log('\nWrite permissions');

  await test('an org admin edits its own domain, not another org’s', async () => {
    const own = await call('PATCH', `/api/domains/${(await prisma.domain.findUnique({ where: { name: 'a.test' } }))!.id}`, {
      cookie: aliceCookie,
      body: { notes: 'Alpha note' },
    });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.domain.notes, 'Alpha note');

    const otherId = (await prisma.domain.findUnique({ where: { name: 'b.test' } }))!.id;
    const other = await call('PATCH', `/api/domains/${otherId}`, {
      cookie: aliceCookie,
      body: { notes: 'should fail' },
    });
    assert.equal(other.status, 404);
  });

  await test('a viewer cannot create or edit domains', async () => {
    const create = await call('POST', '/api/domains', {
      cookie: carolCookie,
      body: { name: 'viewer-new.test' },
    });
    assert.equal(create.status, 403);
  });

  // --- Domain claim ------------------------------------------------------------------------
  console.log('\nDomain claim');

  await test('a new domain is owned by the creating org; a second claim is refused', async () => {
    const created = await call('POST', '/api/domains', {
      cookie: aliceCookie,
      body: { name: 'new-alpha.test' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.domain.organization?.id, orgA);

    const stolen = await call('POST', '/api/domains', {
      cookie: daveCookie,
      body: { name: 'new-alpha.test' },
    });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error.code, 'DOMAIN_OWNED');
  });

  await test('an unowned domain can be claimed once', async () => {
    const first = await call('POST', '/api/domains', {
      cookie: daveCookie,
      body: { name: 'unowned.test' },
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.domain.organization?.id, orgB);

    const second = await call('POST', '/api/domains', {
      cookie: aliceCookie,
      body: { name: 'unowned.test' },
    });
    assert.equal(second.status, 409);
  });

  // --- Members -----------------------------------------------------------------------------
  console.log('\nMembers');

  await test('an org admin lists and adds members; a viewer cannot', async () => {
    const list = await call('GET', `/api/organizations/${orgA}/members`, { cookie: aliceCookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((row: any) => row.email).sort(), [
      'alice@test.local',
      'carol@test.local',
    ]);

    const viewerList = await call('GET', `/api/organizations/${orgA}/members`, {
      cookie: carolCookie,
    });
    assert.equal(viewerList.status, 404);

    const added = await call('POST', `/api/organizations/${orgA}/members`, {
      cookie: aliceCookie,
      body: { email: 'bob@test.local', role: 'viewer' },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.member.role, 'viewer');
    assert.equal(
      (await prisma.membership.findUnique({
        where: { userId_orgId: { userId: (await prisma.user.findUnique({ where: { email: 'bob@test.local' } }))!.id, orgId: orgA } },
      }))?.role,
      'viewer',
    );
  });

  await test('the last admin cannot be demoted or removed', async () => {
    const aliceId = (await prisma.user.findUnique({ where: { email: 'alice@test.local' } }))!.id;
    const demote = await call('PATCH', `/api/organizations/${orgA}/members/${aliceId}`, {
      cookie: aliceCookie,
      body: { role: 'viewer' },
    });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error.code, 'LAST_ADMIN');

    const remove = await call('DELETE', `/api/organizations/${orgA}/members/${aliceId}`, {
      cookie: aliceCookie,
    });
    assert.equal(remove.status, 409);
  });

  // --- Alerts acknowledgement by an org admin ---------------------------------------------
  await test('an org admin can acknowledge an org alert, not another org’s', async () => {
    const aAlert = await prisma.alert.findFirst({ where: { orgId: orgA } });
    const bAlert = await prisma.alert.findFirst({ where: { orgId: orgB } });

    const own = await call('POST', `/api/alerts/${aAlert!.id}/ack`, { cookie: aliceCookie });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.ok(own.body.acknowledgedAt);

    const other = await call('POST', `/api/alerts/${bAlert!.id}/ack`, { cookie: aliceCookie });
    assert.equal(other.status, 404);
  });

  await test('a superadmin can create an organisation through the API', async () => {
    const created = await call('POST', '/api/organizations', {
      cookie: superCookie,
      body: { name: 'Gamma' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.organization.name, 'Gamma');

    const listed = await call('GET', '/api/organizations', { cookie: superCookie });
    assert.ok(listed.body.data.some((org: any) => org.name === 'Gamma'));
  });

  // Keep the listener alive until here.
  server.close();
  void superUser;
} catch (error) {
  console.error('❌ Tenancy test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

rmSync(tempDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
