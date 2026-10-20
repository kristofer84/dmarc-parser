import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Tests for the analytics slice: sender sources, the ranged dashboard summary, the report
 * source-IP filter, the ingest endpoint, and the persistence of the data the parser used to
 * drop (the published policy and the auth_results lists).
 *
 * The app modules are imported dynamically, after DATABASE_URL points at a throwaway SQLite
 * file: config/env.ts and the Prisma client read the environment at import time.
 *
 * backend/.env ships IMAP_* variables, and dotenv does not override existing keys - they are
 * blanked below so the "no mailbox configured" case is actually reachable and the mailbox
 * values used here come from the settings table.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = dirname(here);

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN_PASSWORD = 'analytics-test-password';

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-sources-'));
const databaseFile = join(tempDir, 'sources-test.db');

process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.NODE_ENV = 'test';
process.env.ENABLE_SCHEDULED_EMAIL_PROCESSING = 'false';
process.env.IMAP_HOST = '';
process.env.IMAP_PORT = '';
process.env.IMAP_USER = '';
process.env.IMAP_PASSWORD = '';
delete process.env.PUBLIC_ORIGIN;

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

function closeTo(actual: string | null, expected: Date, toleranceMs = 1000): boolean {
  if (!actual) {
    return false;
  }
  return Math.abs(Date.parse(actual) - expected.getTime()) <= toleranceMs;
}

// ---------------------------------------------------------------- HTTP

interface CallResult {
  status: number;
  cookie: string | null;
  body: any;
}

let base = '';
let server: import('node:http').Server;

async function call(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
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
  const setCookie = response.headers.get('set-cookie');
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: response.status,
    cookie: setCookie ? setCookie.split(';')[0] : null,
    body,
  };
}

async function loginWithPassword(email: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', {
    body: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(result.status, 200, `password login failed: ${JSON.stringify(result.body)}`);
  assert.ok(result.cookie, `login for ${email} must set a session cookie`);
  return result.cookie!;
}

// ---------------------------------------------------------------- fixture XML

const fixtureEnd = Math.floor((Date.now() - DAY_MS) / 1000);
const fixtureBegin = fixtureEnd - 24 * 60 * 60;

const DMARC_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <version>1.0</version>
  <report_metadata>
    <org_name>Fixture Reporter</org_name>
    <email>noreply-dmarc@fixture-reporter.test</email>
    <report_id>fixture-report-1</report_id>
    <date_range>
      <begin>${fixtureBegin}</begin>
      <end>${fixtureEnd}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>fixture.test</domain>
    <adkim>s</adkim>
    <aspf>r</aspf>
    <p>quarantine</p>
    <sp>reject</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.250</source_ip>
      <count>7</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>pass</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>fixture.test</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>fixture.test</domain>
        <result>pass</result>
      </dkim>
      <dkim>
        <domain>mailer.fixture.test</domain>
        <result>fail</result>
      </dkim>
      <spf>
        <domain>bounce.fixture.test</domain>
        <result>softfail</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;

// ---------------------------------------------------------------- setup

let prisma: typeof import('../src/db/prisma.js').prisma;
let mailboxSettings: typeof import('../src/services/settings.js');
let adminCookie = '';
let scopedCookie = '';
let emptyCookie = '';

interface SeededReports {
  a: { id: string; endDate: Date };
  b: { id: string; endDate: Date };
  mid: { id: string; endDate: Date };
  old: { id: string; endDate: Date };
  scoped: { id: string; endDate: Date };
}

let seeded: SeededReports;

try {
  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const app = await import('../src/app.js');
  ({ prisma } = await import('../src/db/prisma.js'));
  const auth = await import('../src/services/auth.js');
  mailboxSettings = await import('../src/services/settings.js');

  server = app.createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
      name: 'Scoped User',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'user',
      isActive: true,
    },
  });
  await prisma.userDomain.create({ data: { userId: scoped.id, domain: 'scoped.test' } });

  await prisma.user.create({
    data: {
      email: 'empty@test.local',
      name: 'No Domains',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'user',
      isActive: true,
    },
  });

  /**
   * Seeds one aggregate report. `policy` off leaves the policy columns null, which is what a
   * row ingested before those columns existed looks like.
   */
  async function seedReport(options: {
    reportId: string;
    domain: string;
    orgName: string;
    daysAgo: number;
    records: Array<{
      sourceIp: string;
      count: number;
      disposition: string;
      dkim: string;
      spf: string;
    }>;
    policy?: boolean;
  }): Promise<{ id: string; endDate: Date }> {
    const endDate = new Date(Date.now() - options.daysAgo * DAY_MS);
    const created = await prisma.report.create({
      data: {
        reportId: options.reportId,
        domain: options.domain,
        orgName: options.orgName,
        email: `noreply-dmarc@${options.domain}`,
        startDate: new Date(endDate.getTime() - DAY_MS),
        endDate,
        ...(options.policy
          ? {
              policyP: 'quarantine',
              policySp: null,
              policyPct: 100,
              policyAdkim: 'r',
              policyAspf: 'r',
            }
          : {}),
        records: {
          create: options.records.map((record) => ({
            sourceIp: record.sourceIp,
            count: record.count,
            disposition: record.disposition,
            dkim: record.dkim,
            spf: record.spf,
            headerFrom: options.domain,
          })),
        },
      },
      select: { id: true, endDate: true },
    });
    return created;
  }

  seeded = {
    a: await seedReport({
      reportId: 'r-a',
      domain: 'example.com',
      orgName: 'Google LLC',
      daysAgo: 1,
      records: [
        // dkim passes, spf fails: a DMARC pass, and the case where "did it pass" and
        // "did every mechanism pass" differ.
        { sourceIp: '203.0.113.5', count: 100, disposition: 'none', dkim: 'pass', spf: 'fail' },
        { sourceIp: '198.51.100.9', count: 10, disposition: 'reject', dkim: 'fail', spf: 'fail' },
      ],
    }),
    b: await seedReport({
      reportId: 'r-b',
      domain: 'example.com',
      orgName: 'Microsoft Corp',
      daysAgo: 2,
      records: [
        { sourceIp: '203.0.113.5', count: 50, disposition: 'none', dkim: 'fail', spf: 'pass' },
      ],
    }),
    mid: await seedReport({
      reportId: 'r-mid',
      domain: 'example.com',
      orgName: 'Google LLC',
      daysAgo: 20,
      records: [
        { sourceIp: '192.0.2.20', count: 30, disposition: 'none', dkim: 'pass', spf: 'fail' },
      ],
    }),
    old: await seedReport({
      reportId: 'r-old',
      domain: 'example.com',
      orgName: 'Google LLC',
      daysAgo: 200,
      records: [
        { sourceIp: '203.0.113.5', count: 1000, disposition: 'quarantine', dkim: 'fail', spf: 'fail' },
        { sourceIp: '192.0.2.77', count: 5, disposition: 'none', dkim: 'pass', spf: 'pass' },
      ],
    }),
    scoped: await seedReport({
      reportId: 'r-scoped',
      domain: 'scoped.test',
      orgName: 'Yahoo',
      daysAgo: 1,
      records: [
        { sourceIp: '203.0.113.5', count: 20, disposition: 'none', dkim: 'pass', spf: 'pass' },
        { sourceIp: '198.51.100.200', count: 3, disposition: 'none', dkim: 'fail', spf: 'fail' },
      ],
    }),
  };

  adminCookie = await loginWithPassword('admin@test.local');
  scopedCookie = await loginWithPassword('scoped@test.local');
  emptyCookie = await loginWithPassword('empty@test.local');
} catch (error) {
  console.error('❌ Sources test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------- sources

console.log('\nSources aggregation');

await test('30d: messages, failures and the three pass rates per source', async () => {
  const result = await call('GET', '/api/sources?range=30d', { cookie: adminCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.range, '30d');
  assert.ok(result.body.since, 'since must be echoed for a fixed range');

  // The window holds r-a, r-b, r-mid and r-scoped: 213 messages, 200 passing DMARC.
  assert.deepEqual(result.body.totals, {
    messages: 213,
    failures: 13,
    dmarcPassRate: 94,
    sourceCount: 4,
  });

  assert.equal(result.body.sources.length, 4, 'one row per source IP in the window');
  const busiest = result.body.sources[0];
  assert.equal(busiest.sourceIp, '203.0.113.5');
  assert.equal(busiest.messages, 170);
  assert.equal(busiest.failures, 0, 'dkim pass or spf pass is a DMARC pass, never a failure');
  assert.equal(busiest.dmarcPassRate, 100);
  assert.equal(busiest.spfPassRate, 41); // 70 of 170 messages passed SPF
  assert.equal(busiest.dkimPassRate, 71); // 120 of 170 passed DKIM
  assert.deepEqual(busiest.dispositions, { none: 170, quarantine: 0, reject: 0 });
  assert.deepEqual(busiest.domains, ['example.com', 'scoped.test']);
  assert.deepEqual(busiest.organizations, ['Google LLC', 'Microsoft Corp', 'Yahoo']);

  const failed = result.body.sources.find((row: any) => row.sourceIp === '198.51.100.9');
  assert.equal(failed.dmarcPassRate, 0);
  assert.equal(failed.failures, 10);
  assert.deepEqual(failed.dispositions, { none: 0, quarantine: 0, reject: 10 });
});

await test('firstSeen and lastSeen cover all time, not just the selected range', async () => {
  const result = await call('GET', '/api/sources?range=30d', { cookie: adminCookie });
  const busiest = result.body.sources.find((row: any) => row.sourceIp === '203.0.113.5');

  // The IP also appears in a 200-day-old report. Within the 30d window that report is gone,
  // but the sender's history must still say when it was first seen - that is the whole point.
  assert.ok(
    closeTo(busiest.firstSeen, seeded.old.endDate),
    `firstSeen ${busiest.firstSeen} should be the 200-day-old report`,
  );
  assert.ok(closeTo(busiest.lastSeen, seeded.a.endDate), `lastSeen ${busiest.lastSeen}`);
});

await test('range filtering: 7d/30d/90d/all select different reports', async () => {
  const seven = await call('GET', '/api/sources?range=7d', { cookie: adminCookie });
  assert.equal(seven.body.totals.messages, 183, 'r-mid (20 days old) is outside 7d');
  assert.equal(seven.body.totals.sourceCount, 3);
  assert.ok(
    !seven.body.sources.some((row: any) => row.sourceIp === '192.0.2.20'),
    'the 20-day-old source must not appear in the 7d window',
  );
  assert.ok(
    !seven.body.sources.some((row: any) => row.sourceIp === '192.0.2.77'),
    'the 200-day-old source must not appear in the 7d window',
  );

  const ninety = await call('GET', '/api/sources?range=90d', { cookie: adminCookie });
  assert.equal(ninety.body.totals.messages, 213, 'the 20-day-old report is inside 90d');

  const all = await call('GET', '/api/sources?range=all', { cookie: adminCookie });
  assert.equal(all.body.since, null, 'all time has no lower bound');
  assert.equal(all.body.totals.messages, 1218);
  assert.equal(all.body.totals.failures, 1013);
  assert.equal(all.body.totals.dmarcPassRate, 17);
  assert.equal(all.body.totals.sourceCount, 5);

  // The window bound is midnight UTC of "now minus the range", so a test running just after
  // midnight still agrees with the endpoint.
  const expectedSince = Date.parse(seven.body.since);
  assert.ok(
    Math.abs(expectedSince - (Date.now() - 7 * DAY_MS)) < DAY_MS,
    `since ${seven.body.since} is not roughly seven days back`,
  );
  assert.equal(new Date(expectedSince).toISOString().slice(11), '00:00:00.000Z');
});

await test('an unknown range falls back to the default instead of failing', async () => {
  const result = await call('GET', '/api/sources?range=fortnight', { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.range, '30d');
  assert.equal(result.body.totals.messages, 213);
});

await test('limit is clamped and sorted by messages, while totals stay whole-window', async () => {
  const two = await call('GET', '/api/sources?range=all&limit=2', { cookie: adminCookie });
  assert.equal(two.body.sources.length, 2);
  assert.deepEqual(
    two.body.sources.map((row: any) => row.sourceIp),
    ['203.0.113.5', '192.0.2.20'],
    'sorted by messages descending',
  );
  assert.equal(two.body.totals.sourceCount, 5, 'the totals describe every source in the window');
  assert.equal(two.body.totals.messages, 1218);

  const zero = await call('GET', '/api/sources?range=all&limit=0', { cookie: adminCookie });
  assert.equal(zero.body.sources.length, 1, 'limit below 1 is clamped to 1');

  const huge = await call('GET', '/api/sources?range=all&limit=99999', { cookie: adminCookie });
  assert.equal(huge.body.sources.length, 5, 'a huge limit is clamped to 500 but only 5 exist');

  const nonsense = await call('GET', '/api/sources?range=all&limit=abc', { cookie: adminCookie });
  assert.equal(nonsense.body.sources.length, 5, 'a non-numeric limit falls back to the default');
});

await test('a scoped user sees only their domain, including the all-time span', async () => {
  const result = await call('GET', '/api/sources?range=all', { cookie: scopedCookie });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.totals, {
    messages: 23,
    failures: 3,
    dmarcPassRate: 87,
    sourceCount: 2,
  });

  const busiest = result.body.sources[0];
  assert.equal(busiest.sourceIp, '203.0.113.5');
  assert.equal(busiest.messages, 20);
  assert.deepEqual(busiest.domains, ['scoped.test']);
  assert.deepEqual(busiest.organizations, ['Yahoo']);
  assert.ok(
    closeTo(busiest.firstSeen, seeded.scoped.endDate),
    'a scoped user must not learn the sender was seen on an example.com report',
  );
  assert.ok(!result.body.sources.some((row: any) => row.sourceIp === '192.0.2.20'));
});

await test('a user with no domains gets empty totals, not everything and not an error', async () => {
  const result = await call('GET', '/api/sources', { cookie: emptyCookie });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.totals, {
    messages: 0,
    failures: 0,
    dmarcPassRate: 0,
    sourceCount: 0,
  });
  assert.deepEqual(result.body.sources, []);
});

await test('sources requires a session', async () => {
  const result = await call('GET', '/api/sources');
  assert.equal(result.status, 401);
});

// ---------------------------------------------------------------- reports filter

console.log('\nReports sourceIp filter');

await test('sourceIp includes exactly the reports that carry a record from that IP', async () => {
  const result = await call('GET', '/api/reports?sourceIp=203.0.113.5', { cookie: adminCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.pagination.total, 4, 'r-a, r-b, r-old and r-scoped all have it');
  assert.equal(result.body.data.length, 4);
  assert.ok(result.body.data.every((row: any) => row.domain));

  const single = await call('GET', '/api/reports?sourceIp=198.51.100.200', { cookie: adminCookie });
  assert.equal(single.body.pagination.total, 1);
  assert.equal(single.body.data[0].domain, 'scoped.test');

  const unknown = await call('GET', '/api/reports?sourceIp=192.0.2.250', { cookie: adminCookie });
  assert.equal(unknown.body.pagination.total, 0);
  assert.deepEqual(unknown.body.data, []);
});

await test('the sourceIp filter composes with domain scoping', async () => {
  const result = await call('GET', '/api/reports?sourceIp=203.0.113.5', { cookie: scopedCookie });
  assert.equal(result.body.pagination.total, 1);
  assert.equal(result.body.data[0].domain, 'scoped.test');
});

// ---------------------------------------------------------------- summary

console.log('\nSummary ranges');

await test('range=7d restricts every number and keeps every existing field', async () => {
  const result = await call('GET', '/api/summary?range=7d', { cookie: adminCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));

  assert.equal(result.body.range, '7d');
  assert.ok(result.body.since);
  assert.equal(result.body.totalReports, 3);
  assert.equal(result.body.totalMessages, 183);
  assert.equal(result.body.avgDmarcPassRate, 93);
  assert.equal(result.body.avgSpfPassRate, 38);
  assert.equal(result.body.avgDkimPassRate, 66);
  assert.deepEqual(result.body.policyDistribution, { none: 173, quarantine: 0, reject: 10 });

  // Fields the current dashboard already reads must not disappear.
  for (const field of ['totalReports', 'totalMessages', 'avgSpfPassRate', 'avgDkimPassRate',
    'policyDistribution', 'trendsData', 'topSources', 'topIPs']) {
    assert.ok(field in result.body, `existing field ${field} is missing`);
  }

  // 7 days plus today, zero-filled so the chart spans the window the user picked.
  assert.equal(result.body.trendsData.length, 8);
  const dates = result.body.trendsData.map((point: any) => point.date);
  assert.deepEqual([...dates].sort(), dates, 'trend points are ordered');
  assert.equal(dates[0], result.body.since.slice(0, 10));
  assert.equal(dates[dates.length - 1], new Date().toISOString().slice(0, 10));
  assert.equal(
    result.body.trendsData.reduce((sum: number, point: any) => sum + point.messageCount, 0),
    result.body.totalMessages,
    'every message in the window is in exactly one bucket',
  );
  // r-a (110) and r-scoped (23) both ended one day ago, so they share a bucket.
  const yesterday = result.body.trendsData[result.body.trendsData.length - 2];
  assert.equal(yesterday.messageCount, 133);
  assert.equal(yesterday.failureRate, 10, '13 of 133 messages failed DMARC');
});

await test('range=all buckets the whole span and stays bounded', async () => {
  const result = await call('GET', '/api/summary?range=all', { cookie: adminCookie });
  assert.equal(result.body.range, 'all');
  assert.equal(result.body.since, null);
  assert.equal(result.body.totalReports, 5);
  assert.equal(result.body.totalMessages, 1218);
  assert.equal(result.body.avgDmarcPassRate, 17);

  const trends = result.body.trendsData;
  assert.ok(trends.length <= 365, `all-time trends must be capped at 365 buckets, got ${trends.length}`);
  assert.equal(
    trends.reduce((sum: number, point: any) => sum + point.messageCount, 0),
    result.body.totalMessages,
    'no message may be lost in bucketing',
  );
});

await test('an unknown range falls back to 30d and still answers', async () => {
  const result = await call('GET', '/api/summary', { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.range, '30d');
  assert.equal(result.body.totalReports, 4);
});

await test('an all-time span longer than a year is thinned, never truncated', async () => {
  await prisma.report.create({
    data: {
      reportId: 'ancient-1',
      domain: 'ancient.test',
      orgName: 'Ancient Reporter',
      email: 'noreply-dmarc@ancient.test',
      startDate: new Date(Date.now() - 601 * DAY_MS),
      endDate: new Date(Date.now() - 600 * DAY_MS),
      records: {
        create: [
          {
            sourceIp: '192.0.2.10',
            count: 4,
            disposition: 'none',
            dkim: 'fail',
            spf: 'fail',
            headerFrom: 'ancient.test',
          },
        ],
      },
    },
  });

  const result = await call('GET', '/api/summary?range=all', { cookie: adminCookie });
  const trends = result.body.trendsData;
  assert.ok(trends.length <= 365, `got ${trends.length} buckets`);
  assert.ok(trends.length > 200, 'thinning must keep the resolution as high as the cap allows');
  assert.equal(
    trends.reduce((sum: number, point: any) => sum + point.messageCount, 0),
    result.body.totalMessages,
    'thinned buckets must still account for every message',
  );
});

await test('the summary is domain scoped', async () => {
  const result = await call('GET', '/api/summary?range=all', { cookie: scopedCookie });
  assert.equal(result.body.totalReports, 1);
  assert.equal(result.body.totalMessages, 23);
  assert.equal(result.body.avgDmarcPassRate, 87);

  const empty = await call('GET', '/api/summary?range=all', { cookie: emptyCookie });
  assert.equal(empty.body.totalReports, 0);
  assert.deepEqual(empty.body.trendsData, []);
});

// ---------------------------------------------------------------- ingest persistence

console.log('\nIngest persistence');

await test('the parser returns the published policy and the auth_results lists', async () => {
  const { DmarcParser } = await import('../src/services/dmarcParser.js');
  const parsed = await new DmarcParser().parseAndValidate(Buffer.from(DMARC_FIXTURE));

  assert.equal(parsed.reportData.policyP, 'quarantine');
  assert.equal(parsed.reportData.policySp, 'reject');
  assert.equal(parsed.reportData.policyPct, 100);
  assert.equal(parsed.reportData.policyAdkim, 's');
  assert.equal(parsed.reportData.policyAspf, 'r');

  assert.deepEqual(parsed.records[0].dkimAuth, [
    { domain: 'fixture.test', result: 'pass' },
    { domain: 'mailer.fixture.test', result: 'fail' },
  ]);
  // Not `pass`/`fail`: auth_results carries the receiver's own vocabulary and is kept verbatim.
  assert.deepEqual(parsed.records[0].spfAuth, [
    { domain: 'bounce.fixture.test', result: 'softfail' },
  ]);
});

await test('storeReport persists the policy columns and the auth arrays as JSON text', async () => {
  const { DmarcParser } = await import('../src/services/dmarcParser.js');
  const { EmailProcessor } = await import('../src/services/emailProcessor.js');
  const parsed = await new DmarcParser().parseAndValidate(Buffer.from(DMARC_FIXTURE));

  const saved = await new EmailProcessor().storeReport(parsed.reportData, parsed.records);
  const row = await prisma.report.findUnique({ where: { id: saved.id }, include: { records: true } });

  assert.ok(row);
  assert.equal(row!.domain, 'fixture.test');
  assert.equal(row!.policyP, 'quarantine');
  assert.equal(row!.policySp, 'reject');
  assert.equal(row!.policyPct, 100);
  assert.equal(row!.policyAdkim, 's');
  assert.equal(row!.policyAspf, 'r');
  assert.equal(row!.records.length, 1);

  const record = row!.records[0];
  assert.equal(record.dkim, 'pass');
  assert.equal(record.spf, 'fail');
  assert.deepEqual(JSON.parse(record.dkimAuth), [
    { domain: 'fixture.test', result: 'pass' },
    { domain: 'mailer.fixture.test', result: 'fail' },
  ]);
  assert.deepEqual(JSON.parse(record.spfAuth), [
    { domain: 'bounce.fixture.test', result: 'softfail' },
  ]);
});

await test('the report detail returns the published policy and parsed auth entries', async () => {
  // The write path is exercised separately above; this proves the read path does not drop the
  // new columns and hands the UI arrays rather than JSON text.
  const { DmarcParser } = await import('../src/services/dmarcParser.js');
  const { EmailProcessor } = await import('../src/services/emailProcessor.js');
  const parsed = await new DmarcParser().parseAndValidate(Buffer.from(DMARC_FIXTURE));
  parsed.reportData.reportId = 'fixture-detail-1';
  const saved = await new EmailProcessor().storeReport(parsed.reportData, parsed.records);

  const result = await call('GET', `/api/reports/${saved.id}`, { cookie: adminCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.policy, {
    p: 'quarantine',
    sp: 'reject',
    pct: 100,
    adkim: 's',
    aspf: 'r',
  });
  assert.deepEqual(result.body.records[0].dkimAuth, [
    { domain: 'fixture.test', result: 'pass' },
    { domain: 'mailer.fixture.test', result: 'fail' },
  ]);
  assert.deepEqual(result.body.records[0].spfAuth, [
    { domain: 'bounce.fixture.test', result: 'softfail' },
  ]);
});

await test('a row from before the columns existed still reads without crashing', async () => {
  const legacy = await prisma.report.create({
    data: {
      reportId: 'legacy-1',
      domain: 'legacy.test',
      orgName: 'Legacy Reporter',
      email: 'noreply-dmarc@legacy.test',
      startDate: new Date(Date.now() - 4 * DAY_MS),
      endDate: new Date(Date.now() - 3 * DAY_MS),
      records: {
        create: [
          {
            sourceIp: '192.0.2.99',
            count: 6,
            disposition: 'none',
            dkim: 'pass',
            spf: 'pass',
            headerFrom: 'legacy.test',
          },
        ],
      },
    },
    include: { records: true },
  });

  assert.equal(legacy.policyP, null);
  assert.equal(legacy.records[0].dkimAuth, '[]', 'the column default is an empty JSON array');

  const detail = await call('GET', `/api/reports/${legacy.id}`, { cookie: adminCookie });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.totalMessages, 6);

  const sources = await call('GET', '/api/sources?range=all', { cookie: adminCookie });
  assert.equal(sources.status, 200);
  const legacySource = sources.body.sources.find((row: any) => row.sourceIp === '192.0.2.99');
  assert.ok(legacySource, 'a report with null policy columns still aggregates');
  assert.equal(legacySource.messages, 6);
});

// ---------------------------------------------------------------- ingest endpoint

console.log('\nIngest endpoint');

await test('with no mailbox configured the ingest answer is unconfigured but scoped', async () => {
  const result = await call('GET', '/api/domains/example.com/ingest', { cookie: adminCookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, {
    rua: null,
    ruf: null,
    configured: false,
    lastReportAt: seeded.a.endDate.toISOString(),
    reports30d: 3,
    verified: true,
  });
});

await test('a configured mailbox yields mailto: addresses and a verified flag from real reports', async () => {
  await mailboxSettings.setSetting('mailbox.host', 'imap.test.local');
  await mailboxSettings.setSetting('mailbox.user', 'dmarc@example.com');
  await mailboxSettings.setSetting('mailbox.password', 'not-a-real-password');

  const result = await call('GET', '/api/domains/example.com/ingest', { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.rua, 'mailto:dmarc@example.com');
  assert.equal(result.body.ruf, 'mailto:dmarc@example.com');
  assert.equal(result.body.configured, true);
  assert.equal(result.body.reports30d, 3);
  assert.equal(result.body.verified, true);
  assert.ok(closeTo(result.body.lastReportAt, seeded.a.endDate));

  const unknown = await call('GET', '/api/domains/nothing.test/ingest', { cookie: adminCookie });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.lastReportAt, null);
  assert.equal(unknown.body.reports30d, 0);
  assert.equal(unknown.body.verified, false, 'no report means not verified, not an error');
});

await test('a report older than 30 days is not proof of a working ingest address', async () => {
  const result = await call('GET', '/api/domains/old-only.test/ingest', { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.verified, false);

  await prisma.report.create({
    data: {
      reportId: 'old-only-1',
      domain: 'old-only.test',
      orgName: 'Old Reporter',
      email: 'noreply-dmarc@old-only.test',
      startDate: new Date(Date.now() - 100 * DAY_MS),
      endDate: new Date(Date.now() - 99 * DAY_MS),
      records: {
        create: [
          {
            sourceIp: '192.0.2.150',
            count: 2,
            disposition: 'none',
            dkim: 'fail',
            spf: 'fail',
            headerFrom: 'old-only.test',
          },
        ],
      },
    },
  });

  const after = await call('GET', '/api/domains/old-only.test/ingest', { cookie: adminCookie });
  assert.ok(after.body.lastReportAt, 'the last report is still reported');
  assert.equal(after.body.reports30d, 0);
  assert.equal(after.body.verified, false);
});

await test('the ingest answer is out of scope for a user without the domain', async () => {
  const outOfScope = await call('GET', '/api/domains/example.com/ingest', { cookie: scopedCookie });
  assert.equal(outOfScope.status, 404);

  const inScope = await call('GET', '/api/domains/scoped.test/ingest', { cookie: scopedCookie });
  assert.equal(inScope.status, 200);
  assert.equal(inScope.body.reports30d, 1);

  const anonymous = await call('GET', '/api/domains/scoped.test/ingest');
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------- done

server.close();
await prisma.$disconnect();
rmSync(tempDir, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`, () => resolve());
});
// The rate limiter's sweeper interval keeps the event loop alive, so the process would
// otherwise sit here after the suite has finished.
process.exit(failed > 0 ? 1 : 0);
