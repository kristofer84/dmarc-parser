import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Phase 3 ingestion: per-organisation mailboxes, the ingest context, domain claim/quarantine and
 * the processing-log tenant filter.
 *
 * No IMAP server is involved. The mailbox HTTP tests mount routes/orgMailboxes.ts on a minimal
 * express app (the coordinator mounts it in app.ts at /api/organizations, before the existing
 * organizations router); the parser/write path is driven directly with `processMessage` and
 * `storeReport`, which is where the orgId/mailboxId stamping and the quarantine decision live.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-ingestion-'));
const databaseFile = join(tempDir, 'ingestion.db');
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
const MAILBOX_SECRET = 'imap-secret-not-for-the-api';

interface CallResult {
  status: number;
  body: any;
}

let base = '';
let server: import('node:http').Server;
let prisma: typeof import('../src/db/prisma.js').prisma;
let auth: typeof import('../src/services/auth.js');
let organizations: typeof import('../src/services/organizations.js');
let orgMailboxes: typeof import('../src/services/orgMailboxes.js');
let ownership: typeof import('../src/services/domainOwnership.js');

let superId = '';
let aliceId = '';
let bobId = '';
let carolId = '';

let superCookie = '';
let aliceCookie = '';
let bobCookie = '';
let carolCookie = '';

let defaultOrgId = '';
let orgA = '';
let orgB = '';

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
  return { status: response.status, body };
}

function aggregateXml(domain: string, reportId: string): string {
  const end = Math.floor(Date.now() / 1000) - 3600;
  const begin = end - 86_400;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <version>1.0</version>
  <report_metadata>
    <org_name>Ingest Fixture Reporter</org_name>
    <email>noreply-dmarc@fixture-reporter.test</email>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>${begin}</begin>
      <end>${end}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>s</adkim>
    <aspf>r</aspf>
    <p>reject</p>
    <sp>reject</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.77</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${domain}</header_from>
    </identifiers>
  </record>
</feedback>`;
}

/** A message shaped like ImapClient's output, without needing an IMAP server. */
function aggregateMessage(domain: string, reportId: string, uid = 1) {
  return {
    uid,
    subject: `Report Domain: ${domain}`,
    from: 'reporter@fixture-reporter.test',
    date: new Date(),
    messageId: `<${reportId}@fixture-reporter.test>`,
    authenticationResults: null,
    attachments: [
      {
        filename: `${reportId}.xml`,
        contentType: 'text/xml',
        content: Buffer.from(aggregateXml(domain, reportId), 'utf8'),
        kind: 'aggregate' as const,
      },
    ],
  };
}

function emptyResult() {
  return {
    processed: 0,
    forensic: 0,
    tlsRpt: 0,
    errors: 0,
    skipped: 0,
    quarantined: 0,
    details: [] as Array<{ status: string; message: string }>,
  };
}

try {
  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const express = (await import('express')).default;
  ({ prisma } = await import('../src/db/prisma.js'));
  auth = await import('../src/services/auth.js');
  organizations = await import('../src/services/organizations.js');
  orgMailboxes = await import('../src/services/orgMailboxes.js');
  ownership = await import('../src/services/domainOwnership.js');
  const { attachOrganization, attachUser } = await import('../src/middleware/auth.js');
  const { auditRequests } = await import('../src/middleware/audit.js');
  const orgMailboxesRouter = (await import('../src/routes/orgMailboxes.js')).default;
  const processingLogsRouter = (await import('../src/routes/processingLogs.js')).default;

  // --- fixtures ---------------------------------------------------------------------------
  async function createUser(email: string, role: 'admin' | 'user', name: string) {
    return prisma.user.create({
      data: {
        email,
        name,
        passwordHash: auth.hashPassword(PASSWORD),
        role,
        isActive: true,
      },
      select: { id: true },
    });
  }

  superId = (await createUser('root@test.local', 'admin', 'Root')).id;
  aliceId = (await createUser('alice@test.local', 'user', 'Alice')).id;
  bobId = (await createUser('bob@test.local', 'user', 'Bob')).id;
  carolId = (await createUser('carol@test.local', 'user', 'Carol')).id;

  defaultOrgId = (await organizations.ensureDefaultOrganization()).orgId!;
  assert.ok(defaultOrgId);

  orgA = (await prisma.organization.create({ data: { name: 'Alpha', slug: 'alpha' } })).id;
  orgB = (await prisma.organization.create({ data: { name: 'Beta', slug: 'beta' } })).id;

  await prisma.membership.createMany({
    data: [
      { userId: aliceId, orgId: orgA, role: 'admin' },
      { userId: bobId, orgId: orgB, role: 'admin' },
      { userId: carolId, orgId: orgA, role: 'viewer' },
    ],
  });

  await prisma.domain.create({
    data: { name: 'owned-alpha.test', orgId: orgA, claimedAt: new Date(), claimSource: 'manual' },
  });

  async function cookieFor(userId: string): Promise<string> {
    const session = await auth.createSession(userId);
    return `${auth.SESSION_COOKIE}=${session.token}`;
  }

  superCookie = await cookieFor(superId);
  aliceCookie = await cookieFor(aliceId);
  bobCookie = await cookieFor(bobId);
  carolCookie = await cookieFor(carolId);

  // Minimal app: app.ts is the coordinator's file, so the router is mounted here exactly where
  // it will be mounted there (before the organizations router, at /api/organizations).
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use(attachOrganization);
  app.use(auditRequests);
  app.use('/api/organizations', orgMailboxesRouter);
  app.use('/api/processing-logs', processingLogsRouter);
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // --- domain ownership --------------------------------------------------------------------
  console.log('\nDomain ownership');

  await test('a new domain is created for the ingesting organisation and marked as a report claim', async () => {
    const claim = await ownership.claimOrCheckDomain(orgA, 'brand-new.test');
    assert.equal(claim.ok, true);
    assert.ok(claim.ok);
    assert.equal(claim.claimed, true);
    assert.equal(claim.ownerOrgId, orgA);

    const row = await prisma.domain.findUnique({ where: { name: 'brand-new.test' } });
    assert.equal(row?.orgId, orgA);
    assert.equal(row?.claimSource, 'report');
    assert.ok(row?.claimedAt);
  });

  await test('an unowned domain is claimed atomically; the loser of a race is told who won', async () => {
    await prisma.domain.create({ data: { name: 'unowned.test', orgId: null } });

    const first = await ownership.claimOrCheckDomain(orgA, 'unowned.test');
    assert.equal(first.ok, true);
    assert.ok(first.ok);
    assert.equal(first.claimed, true);

    const second = await ownership.claimOrCheckDomain(orgB, 'unowned.test');
    assert.equal(second.ok, false);
    assert.ok(!second.ok);
    assert.equal(second.reason, 'owned_by_other');
    assert.equal(second.ownerOrgId, orgA);
    // The loser must not have overwritten the winner.
    assert.equal((await prisma.domain.findUnique({ where: { name: 'unowned.test' } }))?.orgId, orgA);
  });

  await test('the owning organisation passes; another organisation is refused', async () => {
    const same = await ownership.claimOrCheckDomain(orgA, 'OWNED-ALPHA.test.');
    assert.equal(same.ok, true);
    assert.ok(same.ok);
    assert.equal(same.claimed, false);
    assert.equal(same.domain, 'owned-alpha.test');

    const other = await ownership.claimOrCheckDomain(orgB, 'owned-alpha.test');
    assert.equal(other.ok, false);
    assert.ok(!other.ok);
    assert.equal(other.reason, 'owned_by_other');
    assert.equal(other.ownerOrgId, orgA);
  });

  // --- ingest context ----------------------------------------------------------------------
  console.log('\nIngest context');

  const { EmailProcessor } = await import('../src/services/emailProcessor.js');
  const mailboxA = await prisma.orgMailbox.create({
    data: {
      orgId: orgA,
      label: 'Alpha reports',
      host: '127.0.0.1',
      port: 1,
      user: 'dmarc@alpha.test',
      password: 'alpha-imap-secret',
      verifyTls: false,
    },
  });

  await test('storeReport stamps the run context on the report row', async () => {
    const { DmarcParser } = await import('../src/services/dmarcParser.js');
    const parsed = await new DmarcParser().parseAndValidate(
      Buffer.from(aggregateXml('owned-alpha.test', 'ctx-report-1')),
    );

    const processor = new EmailProcessor();
    const saved = await processor.storeReport(parsed.reportData, parsed.records, {
      orgId: orgA,
      mailboxId: mailboxA.id,
      label: 'test',
    });

    const row = await prisma.report.findUnique({ where: { id: saved.id } });
    assert.equal(row?.orgId, orgA);
    assert.equal(row?.mailboxId, mailboxA.id);

    // Without a context nothing is attributed, which is the pre-tenancy shape.
    const uncontextual = await processor.storeReport(
      { ...parsed.reportData, reportId: 'ctx-report-2' },
      parsed.records,
    );
    const other = await prisma.report.findUnique({ where: { id: uncontextual.id } });
    assert.equal(other?.orgId, null);
    assert.equal(other?.mailboxId, null);
  });

  await test('a report for another organisation’s domain is quarantined, not stored', async () => {
    type ProcessorInternals = {
      context: { orgId: string | null; mailboxId: string | null; label?: string } | null;
      processMessage: (message: any, result: any) => Promise<boolean>;
    };

    const processor = new EmailProcessor();
    const internals = processor as unknown as ProcessorInternals;
    internals.context = { orgId: orgB, mailboxId: null, label: 'Beta reports' };

    const result = emptyResult();
    const handled = await internals.processMessage(
      aggregateMessage('owned-alpha.test', 'quarantine-report-1'),
      result,
    );

    assert.equal(handled, true);
    assert.equal(result.quarantined, 1);
    assert.equal(result.processed, 0);
    assert.equal(
      await prisma.report.count({ where: { reportId: 'quarantine-report-1' } }),
      0,
      'a quarantined report must not be stored',
    );

    const log = await prisma.processingLog.findFirst({
      where: { status: 'quarantined', details: { contains: 'owned-alpha.test' } },
    });
    assert.ok(log, 'a quarantined processing-log entry is required');
    assert.equal(log!.orgId, orgB);
    assert.equal(log!.mailboxId, null);
    assert.match(log!.details ?? '', /another organisation owns that domain/);
  });

  await test('a report for a new domain claims it and is stored for the ingesting org', async () => {
    type ProcessorInternals = {
      context: { orgId: string | null; mailboxId: string | null } | null;
      processMessage: (message: any, result: any) => Promise<boolean>;
    };

    const processor = new EmailProcessor();
    const internals = processor as unknown as ProcessorInternals;
    internals.context = { orgId: orgA, mailboxId: mailboxA.id };

    const result = emptyResult();
    await internals.processMessage(aggregateMessage('claim-on-report.test', 'claim-report-1'), result);

    assert.equal(result.processed, 1);
    assert.equal(result.quarantined, 0);

    const domain = await prisma.domain.findUnique({ where: { name: 'claim-on-report.test' } });
    assert.equal(domain?.orgId, orgA);
    assert.equal(domain?.claimSource, 'report');

    const report = await prisma.report.findUnique({ where: { reportId: 'claim-report-1' } });
    assert.equal(report?.orgId, orgA);
    assert.equal(report?.mailboxId, mailboxA.id);
  });

  // --- mailbox CRUD over HTTP --------------------------------------------------------------
  console.log('\nMailbox CRUD');

  let createdMailboxId = '';

  await test('an org admin creates a mailbox and the password never comes back', async () => {
    const created = await call('POST', `/api/organizations/${orgA}/mailboxes`, {
      cookie: aliceCookie,
      orgId: orgA,
      body: {
        label: '  Alpha inbound  ',
        host: ' imap.alpha.test ',
        port: 993,
        user: ' dmarc@alpha.test ',
        password: MAILBOX_SECRET,
        verifyTls: true,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mailbox = created.body.mailbox;
    createdMailboxId = mailbox.id;

    assert.equal(mailbox.label, 'Alpha inbound');
    assert.equal(mailbox.host, 'imap.alpha.test');
    assert.equal(mailbox.user, 'dmarc@alpha.test');
    assert.equal(mailbox.port, 993);
    assert.equal(mailbox.verifyTls, true);
    assert.equal(mailbox.enabled, true);
    assert.equal(mailbox.passwordSet, true);
    assert.equal('password' in mailbox, false);
    assert.equal(JSON.stringify(created.body).includes(MAILBOX_SECRET), false);

    const stored = await prisma.orgMailbox.findUnique({ where: { id: createdMailboxId } });
    assert.equal(stored?.password, MAILBOX_SECRET);
  });

  await test('the list is org-scoped and shaped without secrets', async () => {
    const listed = await call('GET', `/api/organizations/${orgA}/mailboxes`, {
      cookie: aliceCookie,
      orgId: orgA,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.data.map((row: any) => row.label).sort(),
      ['Alpha inbound', 'Alpha reports'],
    );
    assert.deepEqual(Object.keys(listed.body.data[0]).sort(), [
      'createdAt',
      'enabled',
      'host',
      'id',
      'label',
      'lastError',
      'lastRunAt',
      'passwordSet',
      'port',
      'updatedAt',
      'user',
      'verifyTls',
    ]);
    assert.equal(JSON.stringify(listed.body).includes(MAILBOX_SECRET), false);
  });

  await test('a blank password keeps the stored one; a new password replaces it', async () => {
    const kept = await call('PATCH', `/api/organizations/${orgA}/mailboxes/${createdMailboxId}`, {
      cookie: aliceCookie,
      orgId: orgA,
      body: { label: 'Alpha primary', password: '' },
    });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.mailbox.label, 'Alpha primary');
    assert.equal(kept.body.mailbox.passwordSet, true);
    assert.equal(
      (await prisma.orgMailbox.findUnique({ where: { id: createdMailboxId } }))?.password,
      MAILBOX_SECRET,
    );

    const replaced = await call('PATCH', `/api/organizations/${orgA}/mailboxes/${createdMailboxId}`, {
      cookie: aliceCookie,
      orgId: orgA,
      body: { password: 'rotated-imap-secret' },
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(JSON.stringify(replaced.body).includes('rotated-imap-secret'), false);
    assert.equal(
      (await prisma.orgMailbox.findUnique({ where: { id: createdMailboxId } }))?.password,
      'rotated-imap-secret',
    );
  });

  await test('validation: a missing host is 400, a duplicate label is 409', async () => {
    const missing = await call('POST', `/api/organizations/${orgA}/mailboxes`, {
      cookie: aliceCookie,
      orgId: orgA,
      body: { label: 'No host', port: 993, user: 'u', password: 'p' },
    });
    assert.equal(missing.status, 400);

    const duplicate = await call('POST', `/api/organizations/${orgA}/mailboxes`, {
      cookie: aliceCookie,
      orgId: orgA,
      body: {
        label: 'Alpha primary',
        host: 'imap.alpha.test',
        port: 993,
        user: 'dmarc@alpha.test',
        password: 'p',
      },
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'MAILBOX_EXISTS');

    const badPort = await call('POST', `/api/organizations/${orgA}/mailboxes`, {
      cookie: aliceCookie,
      orgId: orgA,
      body: { label: 'Bad port', host: 'h', port: 70000, user: 'u', password: 'p' },
    });
    assert.equal(badPort.status, 400);
  });

  await test('cross-org access is 404, not 403', async () => {
    const alphaMailbox = await prisma.orgMailbox.findFirst({ where: { orgId: orgA } });

    // Alice is an org admin of Alpha only; she may not list or touch Beta's mailboxes.
    assert.equal(
      (await call('GET', `/api/organizations/${orgB}/mailboxes`, { cookie: aliceCookie, orgId: orgA })).status,
      404,
    );
    const betaMailbox = await prisma.orgMailbox.create({
      data: {
        orgId: orgB,
        label: 'Beta inbound',
        host: 'imap.beta.test',
        port: 993,
        user: 'dmarc@beta.test',
        password: 'beta-imap-secret',
      },
    });
    assert.equal(
      (
        await call('PATCH', `/api/organizations/${orgB}/mailboxes/${betaMailbox.id}`, {
          cookie: aliceCookie,
          orgId: orgA,
          body: { label: 'hijack' },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('DELETE', `/api/organizations/${orgB}/mailboxes/${betaMailbox.id}`, {
          cookie: aliceCookie,
          orgId: orgA,
        })
      ).status,
      404,
    );
    // Pointing at her own org but a Beta mailbox id is also 404: the row is org-scoped.
    assert.equal(
      (
        await call('PATCH', `/api/organizations/${orgA}/mailboxes/${betaMailbox.id}`, {
          cookie: aliceCookie,
          orgId: orgA,
          body: { label: 'hijack' },
        })
      ).status,
      404,
    );
    // A viewer is not an org admin, even in their own org.
    assert.equal(
      (await call('GET', `/api/organizations/${orgA}/mailboxes`, { cookie: carolCookie, orgId: orgA })).status,
      404,
    );
    // A superadmin may administer any organisation's mailboxes.
    const asSuper = await call('GET', `/api/organizations/${orgB}/mailboxes`, { cookie: superCookie });
    assert.equal(asSuper.status, 200, JSON.stringify(asSuper.body));
    assert.deepEqual(asSuper.body.data.map((row: any) => row.label), ['Beta inbound']);
    assert.ok(alphaMailbox);
  });

  await test('the test endpoint answers 200 with ok:false for an unreachable host', async () => {
    const unreachable = await prisma.orgMailbox.create({
      data: {
        orgId: orgA,
        label: 'Closed port',
        host: '127.0.0.1',
        port: 1,
        user: 'dmarc@alpha.test',
        password: 'irrelevant',
        verifyTls: false,
      },
    });

    const result = await call(
      'POST',
      `/api/organizations/${orgA}/mailboxes/${unreachable.id}/test`,
      { cookie: aliceCookie, orgId: orgA },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, false);
    assert.equal(typeof result.body.message, 'string');
    assert.ok(result.body.message.length > 0);
    void unreachable;
  });

  await test('delete is a hard delete; reports keep orgId and lose mailboxId', async () => {
    const doomed = await prisma.orgMailbox.create({
      data: {
        orgId: orgA,
        label: 'Doomed',
        host: 'imap.alpha.test',
        port: 993,
        user: 'dmarc@alpha.test',
        password: 'p',
      },
    });
    const { DmarcParser } = await import('../src/services/dmarcParser.js');
    const parsed = await new DmarcParser().parseAndValidate(
      Buffer.from(aggregateXml('owned-alpha.test', 'delete-report-1')),
    );
    const saved = await new EmailProcessor().storeReport(parsed.reportData, parsed.records, {
      orgId: orgA,
      mailboxId: doomed.id,
    });

    const removed = await call(
      'DELETE',
      `/api/organizations/${orgA}/mailboxes/${doomed.id}`,
      { cookie: aliceCookie, orgId: orgA },
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(await prisma.orgMailbox.count({ where: { id: doomed.id } }), 0);

    const report = await prisma.report.findUnique({ where: { id: saved.id } });
    assert.equal(report?.orgId, orgA);
    assert.equal(report?.mailboxId, null);
  });

  // --- processing-log scope ----------------------------------------------------------------
  console.log('\nProcessing-log scope');

  await test('an active organisation filters logs by orgId, including quarantine rows', async () => {
    await prisma.processingLog.createMany({
      data: [
        { status: 'quarantined', details: 'scope-log-a', orgId: orgA },
        { status: 'quarantined', details: 'scope-log-b', orgId: orgB },
      ],
    });

    const forA = await call('GET', '/api/processing-logs?search=scope-log-', {
      cookie: aliceCookie,
      orgId: orgA,
    });
    assert.equal(forA.status, 200, JSON.stringify(forA.body));
    assert.deepEqual(forA.body.data.map((row: any) => row.details), ['scope-log-a']);

    const forB = await call('GET', '/api/processing-logs?search=scope-log-', {
      cookie: bobCookie,
      orgId: orgB,
    });
    assert.deepEqual(forB.body.data.map((row: any) => row.details), ['scope-log-b']);

    const all = await call('GET', '/api/processing-logs?search=scope-log-', { cookie: superCookie });
    assert.deepEqual(
      all.body.data.map((row: any) => row.details).sort(),
      ['scope-log-a', 'scope-log-b'],
    );

    const superA = await call('GET', '/api/processing-logs?search=scope-log-', {
      cookie: superCookie,
      orgId: orgA,
    });
    assert.deepEqual(superA.body.data.map((row: any) => row.details), ['scope-log-a']);
  });

  // --- virtual legacy mailbox --------------------------------------------------------------
  console.log('\nVirtual legacy mailbox');

  await test('the virtual legacy mailbox appears for Default, and disappears with a real row', async () => {
    process.env.IMAP_HOST = 'legacy.example.test';
    process.env.IMAP_USER = 'legacy@example.test';
    process.env.IMAP_PASSWORD = 'legacy-environment-secret';

    try {
      const before = await orgMailboxes.resolveIngestMailboxes();
      const virtual = before.find((row) => row.orgId === defaultOrgId && row.mailboxId === null);
      assert.ok(virtual, 'the Default organisation must fall back to the legacy mailbox');
      assert.equal(virtual!.label, 'Legacy settings');
      assert.equal(virtual!.config.host, 'legacy.example.test');
      assert.equal(virtual!.config.user, 'legacy@example.test');
      assert.equal(virtual!.config.password, 'legacy-environment-secret');

      // A real mailbox in another organisation must not suppress it.
      assert.ok(
        before.some((row) => row.orgId === orgA && row.mailboxId !== null),
        'enabled org mailboxes are returned with their id',
      );

      const own = await prisma.orgMailbox.create({
        data: {
          orgId: defaultOrgId,
          label: 'Default inbound',
          host: 'imap.default.test',
          port: 993,
          user: 'dmarc@default.test',
          password: 'p',
        },
      });

      const withOwn = await orgMailboxes.resolveIngestMailboxes();
      assert.equal(
        withOwn.some((row) => row.orgId === defaultOrgId && row.mailboxId === null),
        false,
        'a real Default mailbox replaces the virtual one',
      );
      const real = withOwn.find((row) => row.mailboxId === own.id);
      assert.ok(real);
      assert.equal(real!.orgId, defaultOrgId);
      assert.equal(real!.config.host, 'imap.default.test');

      // Disabling it brings the virtual mailbox back (no enabled rows for Default).
      await prisma.orgMailbox.update({ where: { id: own.id }, data: { enabled: false } });
      const back = await orgMailboxes.resolveIngestMailboxes();
      assert.ok(back.some((row) => row.orgId === defaultOrgId && row.mailboxId === null));
      assert.equal(back.some((row) => row.mailboxId === own.id), false);
    } finally {
      delete process.env.IMAP_HOST;
      delete process.env.IMAP_USER;
      delete process.env.IMAP_PASSWORD;
    }
  });

  await test('the virtual legacy mailbox is absent when the legacy config is unset', async () => {
    const rows = await orgMailboxes.resolveIngestMailboxes();
    assert.equal(
      rows.some((row) => row.label === 'Legacy settings'),
      false,
      'an unconfigured legacy mailbox must not appear as a runnable mailbox',
    );
  });

  server.close();
} catch (error) {
  console.error('❌ Ingestion test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

rmSync(tempDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
