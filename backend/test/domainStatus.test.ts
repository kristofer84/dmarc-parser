import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  checkDomain,
  countSpfLookups,
  inspectDkimKey,
  parseDkimRecord,
  parseDmarcRecord,
  parseSpfRecord,
  type DnsResolver,
  type DomainCheckOptions,
  type DomainCheckReport,
  type DomainCheckResult,
  type MxRecord,
} from '../src/services/domainStatus.js';

/**
 * Tests for the domain status checker.
 *
 * Everything runs against a fake resolver and a fake fetch, so the suite needs no
 * network and no DNS fixture server: the failure modes that matter (absent records,
 * SERVFAIL, a fetch that never settles) are all easier to produce on purpose than
 * to find in the wild.
 */

const DOMAIN = 'example.com';

interface Zone {
  mx?: Record<string, MxRecord[]>;
  txt?: Record<string, string[][]>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
  cname?: Record<string, string[]>;
  caa?: Record<string, Array<{ critical: number; issue?: string; issuewild?: string }>>;
}

interface Route {
  status?: number;
  body?: string;
  contentType?: string;
}

function absent(): never {
  throw Object.assign(new Error('query: ENODATA'), { code: 'ENODATA' });
}

function fakeResolver(zone: Zone): DnsResolver {
  return {
    resolveMx: async (name) => zone.mx?.[name] ?? absent(),
    resolveTxt: async (name) => zone.txt?.[name] ?? absent(),
    resolve4: async (name) => zone.a?.[name] ?? absent(),
    resolve6: async (name) => zone.aaaa?.[name] ?? absent(),
    resolveCname: async (name) => zone.cname?.[name] ?? absent(),
    resolveCaa: async (name) => zone.caa?.[name] ?? absent(),
  };
}

function fakeFetch(routes: Record<string, Route>): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[url];
    if (!route) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? 'text/plain' },
    });
  };
  return impl as unknown as typeof fetch;
}

const { publicKey: RSA_2048_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: RSA_1024_KEY } = generateKeyPairSync('rsa', { modulusLength: 1024 });
const RSA_2048 = RSA_2048_KEY.export({ type: 'spki', format: 'der' }).toString('base64');
const RSA_1024 = RSA_1024_KEY.export({ type: 'spki', format: 'der' }).toString('base64');

const MTA_STS_URL = `https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`;
const BIMI_LOGO_URL = 'https://bimi.example.com/logo.svg';

/** A domain with every check in its healthy form; individual tests break one thing. */
function goodZone(overrides: Partial<Zone> = {}): Zone {
  return {
    mx: overrides.mx ?? { [DOMAIN]: [{ exchange: 'mx1.example.com', priority: 10 }] },
    a: overrides.a ?? { 'mx1.example.com': ['192.0.2.10'] },
    caa: overrides.caa ?? { [DOMAIN]: [{ critical: 0, issue: 'letsencrypt.org' }] },
    cname: overrides.cname,
    aaaa: overrides.aaaa,
    txt: {
      [DOMAIN]: [['v=spf1 include:_spf.example.com -all']],
      '_spf.example.com': [['v=spf1 ip4:192.0.2.0/24 -all']],
      [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']],
      [`mailjet._domainkey.${DOMAIN}`]: [[`v=DKIM1; k=rsa; p=${RSA_2048}`]],
      [`_mta-sts.${DOMAIN}`]: [['v=STSv1; id=20260101']],
      [`_smtp._tls.${DOMAIN}`]: [['v=TLSRPTv1; rua=mailto:tls@example.com']],
      [`default._bimi.${DOMAIN}`]: [
        [`v=BIMI1; l=${BIMI_LOGO_URL}; a=https://bimi.example.com/vmc.pem`],
      ],
      ...overrides.txt,
    },
  };
}

const goodRoutes: Record<string, Route> = {
  [MTA_STS_URL]: { body: 'version: STSv1\nmode: enforce\nmax_age: 604800\nmx: mx1.example.com\n' },
  [BIMI_LOGO_URL]: { body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', contentType: 'image/svg+xml' },
};

async function run(zone: Zone, options: DomainCheckOptions = {}): Promise<DomainCheckReport> {
  return checkDomain(DOMAIN, {
    resolver: fakeResolver(zone),
    fetchImpl: fakeFetch({}),
    includeOptional: false,
    ...options,
  });
}

function byId(results: DomainCheckResult[], id: string): DomainCheckResult {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `expected a result with id "${id}", got ${results.map((r) => r.id).join(', ')}`);
  return found;
}

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

console.log('\nDomain status');

await test('parseSpfRecord lowercases terms, finds the all qualifier and the includes', () => {
  const parsed = parseSpfRecord(
    'v=spf1 include:_spf.example.com +a:mail.example.com redirect=_spf2.example.com ~ALL',
  );
  assert.deepEqual(parsed.mechanisms, [
    'include:_spf.example.com',
    '+a:mail.example.com',
    'redirect=_spf2.example.com',
    '~all',
  ]);
  assert.equal(parsed.qualifier, '~');
  assert.equal(parsed.allQualifier, '~');
  assert.equal(parsed.hasRedirect, true);
  assert.deepEqual(parsed.includes, ['_spf.example.com']);

  assert.equal(parseSpfRecord('v=spf1 -all').allQualifier, '-');
  assert.equal(parseSpfRecord('v=spf1 all').allQualifier, '+');
  assert.equal(parseSpfRecord('v=spf1 +all').allQualifier, '+');
  assert.equal(parseSpfRecord('v=spf1 ?all').allQualifier, '?');
  assert.equal(parseSpfRecord('v=spf1 ip4:192.0.2.1').allQualifier, null);
  assert.equal(parseSpfRecord('v=spf1 ip4:192.0.2.1').qualifier, '+');
});

await test('parseDmarcRecord and parseDkimRecord split the tag lists', () => {
  assert.deepEqual(parseDmarcRecord('v=DMARC1; p=reject; rua=mailto:a@example.com, mailto:b@example.com'), {
    v: 'DMARC1',
    p: 'reject',
    rua: 'mailto:a@example.com, mailto:b@example.com',
  });

  const dkim = parseDkimRecord('v=DKIM1; k=rsa; t=s:y; h=sha256; s=email; n=hello; p=AAAA');
  assert.equal(dkim.version, 'DKIM1');
  assert.equal(dkim.keyType, 'rsa');
  assert.equal(dkim.publicKey, 'AAAA');
  assert.deepEqual(dkim.flags, ['s', 'y']);
  assert.deepEqual(dkim.hashes, ['sha256']);
  assert.deepEqual(dkim.services, ['email']);
  assert.equal(dkim.notes, 'hello');

  // An empty p= must survive parsing as a value, not collapse into "absent".
  const revoked = parseDkimRecord('v=DKIM1; k=rsa; p=');
  assert.equal(revoked.publicKey, '');
  assert.equal(parseDkimRecord('v=DKIM1; k=rsa').publicKey, null);
});

await test('inspectDkimKey accepts a genuine 2048-bit RSA key', () => {
  const inspected = inspectDkimKey(`v=DKIM1; k=rsa; p=${RSA_2048}`);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.algorithm, 'rsa');
  assert.equal(inspected.bits, 2048);
  assert.equal(inspected.reason, null);

  const small = inspectDkimKey(`v=DKIM1; k=rsa; p=${RSA_1024}`);
  assert.equal(small.valid, true);
  assert.equal(small.bits, 1024);
});

await test('inspectDkimKey rejects revoked keys, garbage and non-key base64', () => {
  const revoked = inspectDkimKey('v=DKIM1; k=rsa; p=');
  assert.equal(revoked.valid, false);
  assert.match(revoked.reason ?? '', /revokes the key/);

  const garbage = inspectDkimKey('v=DKIM1; k=rsa; p=this is not base64 !!!');
  assert.equal(garbage.valid, false);
  assert.match(garbage.reason ?? '', /not valid base64/);

  const notAKey = inspectDkimKey('v=DKIM1; k=rsa; p=c29tZSBieXRlcw==');
  assert.equal(notAKey.valid, false);
  assert.match(notAKey.reason ?? '', /does not decode to an RSA public key/);
});

await test('SPF: a single good record passes and reports the lookup budget', async () => {
  const report = await run({ txt: { [DOMAIN]: [['v=spf1 include:_spf.example.com -all']], '_spf.example.com': [['v=spf1 ip4:192.0.2.0/24 -all']] } });
  const spf = byId(report.results, 'spf');
  assert.equal(spf.status, 'ok');
  assert.match(spf.summary, /-all/);
  assert.match(spf.details?.join('\n') ?? '', /DNS lookups used: 1 of 10/);
});

await test('SPF: a missing record is an error', async () => {
  const report = await run({ txt: {} });
  const spf = byId(report.results, 'spf');
  assert.equal(spf.status, 'error');
  assert.match(spf.summary, /no v=spf1 record/);
  assert.ok(spf.fix);
  assert.equal(report.status, 'error');
});

await test('SPF: two records are an error, because receivers return permerror', async () => {
  const report = await run({ txt: { [DOMAIN]: [['v=spf1 -all'], ['v=spf1 include:_spf.example.com -all']] } });
  const spf = byId(report.results, 'spf');
  assert.equal(spf.status, 'error');
  assert.match(spf.summary, /more than one/);
  assert.equal(spf.details?.length, 2);
});

await test('SPF: ~all warns and +all/?all are errors', async () => {
  const soft = await run({ txt: { [DOMAIN]: [['v=spf1 include:_spf.example.com ~all']] } });
  assert.equal(byId(soft.results, 'spf').status, 'warn');
  assert.match(byId(soft.results, 'spf').summary, /soft fail/);

  const open = await run({ txt: { [DOMAIN]: [['v=spf1 +all']] } });
  assert.equal(byId(open.results, 'spf').status, 'error');
  assert.match(byId(open.results, 'spf').summary, /every host on the internet/);

  const none = await run({ txt: { [DOMAIN]: [['v=spf1 ip4:192.0.2.1']] } });
  assert.equal(byId(none.results, 'spf').status, 'error');
  assert.match(byId(none.results, 'spf').summary, /no "all" mechanism/);
});

await test('countSpfLookups follows includes and stops past the limit of ten', async () => {
  const chained = async (name: string): Promise<string[][]> => {
    const number = Number(/^c(\d+)/.exec(name)?.[1] ?? 0);
    const target = name === DOMAIN ? 'c1.example.com' : `c${number + 1}.example.com`;
    return [[`v=spf1 include:${target} -all`]];
  };

  const budget = await countSpfLookups(DOMAIN, chained);
  assert.equal(budget.exceeded, true);
  assert.equal(budget.lookups, 11);
  assert.equal(budget.trace[0], `${DOMAIN}: include:c1.example.com`);

  // Nine includes is under the limit but already in the range the report warns about.
  const nineDeep = async (name: string): Promise<string[][]> => {
    const number = Number(/^c(\d+)/.exec(name)?.[1] ?? 0);
    if (number >= 9) {
      return [['v=spf1 -all']];
    }
    const target = name === DOMAIN ? 'c1.example.com' : `c${number + 1}.example.com`;
    return [[`v=spf1 include:${target} -all`]];
  };
  const cheap = await countSpfLookups(DOMAIN, nineDeep);
  assert.equal(cheap.exceeded, false);
  assert.equal(cheap.lookups, 9);

  // The checker surfaces both: error past ten, warn from eight.
  const overBudget = await run({}, { resolver: { ...fakeResolver({}), resolveTxt: chained } });
  const overResult = byId(overBudget.results, 'spf');
  assert.equal(overResult.status, 'error');
  assert.match(overResult.summary, /permerror/);
  assert.match(overResult.details?.join('\n') ?? '', /lookup: /);

  const nearBudget = await run({}, { resolver: { ...fakeResolver({}), resolveTxt: nineDeep } });
  const nearResult = byId(nearBudget.results, 'spf');
  assert.equal(nearResult.status, 'warn');
  assert.match(nearResult.summary, /close to the limit/);
});

await test('DMARC: a missing record is an error', async () => {
  const report = await run({ txt: { [DOMAIN]: [['v=spf1 -all']] } });
  const dmarc = byId(report.results, 'dmarc');
  assert.equal(dmarc.status, 'error');
  assert.match(dmarc.summary, /no DMARC record/);
  assert.match(dmarc.fix ?? '', /_dmarc\.example\.com/);
});

await test('DMARC: p=none is a warning, not a pass', async () => {
  const report = await run({ txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none; rua=mailto:dmarc@example.com']] } });
  const dmarc = byId(report.results, 'dmarc');
  assert.equal(dmarc.status, 'warn');
  assert.match(dmarc.summary, /monitoring only/);
});

await test('DMARC: p=reject with rua and ruf passes', async () => {
  const report = await run({
    txt: {
      [`_dmarc.${DOMAIN}`]: [
        ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com; ruf=mailto:forensic@example.com'],
      ],
    },
  });
  const dmarc = byId(report.results, 'dmarc');
  assert.equal(dmarc.status, 'ok');
  assert.match(dmarc.summary, /p=reject/);
  assert.doesNotMatch(dmarc.summary, /no rua/);
  assert.match(dmarc.details?.join('\n') ?? '', /ruf=mailto:forensic@example\.com/);

  // Without rua= the policy still blocks, but nobody learns about the collateral damage.
  const noReports = await run({ txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=reject']] } });
  assert.equal(byId(noReports.results, 'dmarc').status, 'warn');
  assert.match(byId(noReports.results, 'dmarc').summary, /no rua=/);
});

await test('DMARC: pct=50 and sp weaker than p both warn', async () => {
  const partial = await run({
    txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=reject; pct=50; rua=mailto:dmarc@example.com']] },
  });
  assert.equal(byId(partial.results, 'dmarc').status, 'warn');
  assert.match(byId(partial.results, 'dmarc').summary, /pct=50/);

  const subdomains = await run({
    txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=reject; sp=none; rua=mailto:dmarc@example.com']] },
  });
  const dmarc = byId(subdomains.results, 'dmarc');
  assert.equal(dmarc.status, 'warn');
  assert.match(dmarc.summary, /sp=none is weaker than p=reject/);
});

await test('DKIM: a missing selector is an error naming the selector', async () => {
  const report = await run({ txt: {} }, { dkimSelectors: ['mailjet'] });
  const dkim = byId(report.results, 'dkim:mailjet');
  assert.equal(dkim.status, 'error');
  assert.match(dkim.summary, /no DKIM key is published for selector "mailjet"/);
  assert.match(dkim.summary, /mailjet\._domainkey\.example\.com/);
});

await test('DKIM: an empty p= is reported as a revoked key', async () => {
  const report = await run(
    { txt: { [`mailjet._domainkey.${DOMAIN}`]: [['v=DKIM1; k=rsa; p=']] } },
    { dkimSelectors: ['mailjet'] },
  );
  const dkim = byId(report.results, 'dkim:mailjet');
  assert.equal(dkim.status, 'error');
  assert.match(dkim.summary, /revokes the key/);
  assert.match(dkim.fix ?? '', /withdrawn/);
});

await test('DKIM: a genuine 2048-bit key is reported with its size, a 1024-bit one warns', async () => {
  const report = await run(
    { txt: { [`mailjet._domainkey.${DOMAIN}`]: [[`v=DKIM1; k=rsa; p=${RSA_2048}`]] } },
    { dkimSelectors: ['mailjet'] },
  );
  const dkim = byId(report.results, 'dkim:mailjet');
  assert.equal(dkim.status, 'ok');
  assert.match(dkim.summary, /2048-bit RSA key/);
  assert.match(dkim.details?.join('\n') ?? '', /rsa key, 2048 bits/);

  const weak = await run(
    { txt: { [`mailjet._domainkey.${DOMAIN}`]: [[`v=DKIM1; k=rsa; p=${RSA_1024}`]] } },
    { dkimSelectors: ['mailjet'] },
  );
  assert.equal(byId(weak.results, 'dkim:mailjet').status, 'warn');
  assert.match(byId(weak.results, 'dkim:mailjet').summary, /1024-bit RSA key/);
});

await test('DKIM: garbage base64 is an error, and no selectors means skipped', async () => {
  const report = await run(
    { txt: { [`mailjet._domainkey.${DOMAIN}`]: [['v=DKIM1; k=rsa; p=not base64 at all !!!']] } },
    { dkimSelectors: ['mailjet'] },
  );
  assert.equal(byId(report.results, 'dkim:mailjet').status, 'error');
  assert.match(byId(report.results, 'dkim:mailjet').summary, /not valid base64/);

  const none = await run({ txt: {} });
  const skipped = byId(none.results, 'dkim');
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.summary, /no DKIM selectors are configured/);
  assert.match(skipped.fix ?? '', /selectors your mail provider publishes/);
  assert.deepEqual(none.dkimSelectors, []);
});

await test('MX: no record at all is an error, and nothing else is skipped', async () => {
  const report = await run({ txt: { [DOMAIN]: [['v=spf1 -all']] } });
  const mx = byId(report.results, 'mx');
  assert.equal(mx.status, 'error');
  assert.match(mx.summary, /cannot receive mail/);
  assert.equal(report.results.length, 4);
});

await test('MX: an exchange that does not resolve is a warning', async () => {
  const report = await run({
    mx: {
      [DOMAIN]: [
        { exchange: 'mx1.example.com', priority: 10 },
        { exchange: 'gone.example.com', priority: 20 },
      ],
    },
    a: { 'mx1.example.com': ['192.0.2.10'] },
    txt: {},
  });
  const mx = byId(report.results, 'mx');
  assert.equal(mx.status, 'warn');
  assert.match(mx.summary, /gone\.example\.com/);
  assert.match(mx.details?.join('\n') ?? '', /gone\.example\.com does not resolve/);
});

await test('MX: two valid exchanges are ordered by priority in the details', async () => {
  const report = await run({
    mx: {
      [DOMAIN]: [
        { exchange: 'mx2.example.com', priority: 20 },
        { exchange: 'mx1.example.com', priority: 10 },
      ],
    },
    a: { 'mx1.example.com': ['192.0.2.10'], 'mx2.example.com': ['192.0.2.11'] },
    txt: {},
  });
  const mx = byId(report.results, 'mx');
  assert.equal(mx.status, 'ok');
  assert.match(mx.details?.[0] ?? '', /^priority 10: mx1\.example\.com$/);
  assert.match(mx.details?.[1] ?? '', /^priority 20: mx2\.example\.com$/);
  assert.match(mx.details?.join('\n') ?? '', /mx1\.example\.com resolves to 192\.0\.2\.10/);
});

await test('MX: an address literal and an apex exchange are both warned about', async () => {
  const literal = await run({ mx: { [DOMAIN]: [{ exchange: '192.0.2.1', priority: 10 }] }, txt: {} });
  assert.equal(byId(literal.results, 'mx').status, 'warn');
  assert.match(byId(literal.results, 'mx').summary, /address literal/);

  const apex = await run({
    mx: { [DOMAIN]: [{ exchange: DOMAIN, priority: 10 }] },
    a: { [DOMAIN]: ['192.0.2.10'] },
    txt: {},
  });
  assert.equal(byId(apex.results, 'mx').status, 'warn');
  assert.match(byId(apex.results, 'mx').summary, /points at the domain itself/);
});

await test('MX: an expected host that is not published warns', async () => {
  const report = await run(
    { mx: { [DOMAIN]: [{ exchange: 'mx1.example.com', priority: 10 }] }, a: { 'mx1.example.com': ['192.0.2.10'] }, txt: {} },
    { expectedMx: ['mx1.example.com', 'backup.example.net'] },
  );
  const mx = byId(report.results, 'mx');
  assert.equal(mx.status, 'warn');
  assert.match(mx.summary, /expected MX host\(s\) not published: backup\.example\.net/);
});

await test('MTA-STS: enforced policy that covers the MX hosts passes', async () => {
  const report = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone()),
    fetchImpl: fakeFetch(goodRoutes),
    includeOptional: true,
    timeoutMs: 500,
  });
  const sts = byId(report.results, 'mta-sts');
  assert.equal(sts.status, 'ok');
  assert.match(sts.details?.join('\n') ?? '', /mode=enforce/);
  assert.match(sts.details?.join('\n') ?? '', /max_age=604800/);
});

await test('MTA-STS: an advertised policy that 404s is a warning', async () => {
  const report = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone()),
    fetchImpl: fakeFetch({}),
    includeOptional: true,
    timeoutMs: 500,
  });
  const sts = byId(report.results, 'mta-sts');
  assert.equal(sts.status, 'warn');
  assert.match(sts.summary, /HTTP 404/);
  assert.match(sts.fix ?? '', /reachable over HTTPS/);
});

await test('MTA-STS: absence is info, and a fetch that never settles still ends in a warning', async () => {
  const absentReport = await run({ txt: {} }, { includeOptional: true });
  assert.equal(byId(absentReport.results, 'mta-sts').status, 'info');

  const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const report = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone()),
    fetchImpl: hanging,
    includeOptional: true,
    timeoutMs: 50,
  });
  assert.equal(byId(report.results, 'mta-sts').status, 'warn');
  assert.match(byId(report.results, 'mta-sts').summary, /could not be read/);
});

await test('optional checks report absence as info and the CAA/autodiscover findings as such', async () => {
  const report = await checkDomain(DOMAIN, {
    resolver: fakeResolver({
      mx: { [DOMAIN]: [{ exchange: 'mx1.example.com', priority: 10 }] },
      a: { 'mx1.example.com': ['192.0.2.10'] },
      cname: { [`autoconfig.${DOMAIN}`]: ['mail.example.com'] },
      txt: {},
      caa: { [DOMAIN]: [{ critical: 0, issue: 'digicert.com; cansignhttpexchanges=yes' }] },
    }),
    fetchImpl: fakeFetch({}),
    includeOptional: true,
    timeoutMs: 500,
  });

  assert.equal(byId(report.results, 'tls-rpt').status, 'info');
  assert.equal(byId(report.results, 'bimi').status, 'info');
  assert.match(byId(report.results, 'bimi').fix ?? '', /Optional/);

  const autodiscover = byId(report.results, 'autodiscover');
  assert.equal(autodiscover.status, 'ok');
  assert.match(autodiscover.summary, /1 of 2/);
  assert.match(autodiscover.details?.join('\n') ?? '', /autoconfig\.example\.com -> CNAME mail\.example\.com/);

  const caa = byId(report.results, 'caa');
  assert.equal(caa.status, 'warn');
  assert.match(caa.summary, /no issue\/issuewild value allows letsencrypt\.org/);
  assert.match(caa.fix ?? '', /Let's Encrypt/);
});

await test('TLS-RPT and BIMI are reported with their rua and logo state', async () => {
  const report = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone()),
    fetchImpl: fakeFetch(goodRoutes),
    includeOptional: true,
    timeoutMs: 500,
  });
  assert.equal(byId(report.results, 'tls-rpt').status, 'ok');
  assert.match(byId(report.results, 'tls-rpt').summary, /tls@example\.com/);

  const bimi = byId(report.results, 'bimi');
  assert.equal(bimi.status, 'ok');
  assert.match(bimi.details?.join('\n') ?? '', /looks like SVG/);

  // Without a= most providers ignore the logo even when l= is fine.
  const noVmc = await checkDomain(DOMAIN, {
    resolver: fakeResolver(
      goodZone({ txt: { [`default._bimi.${DOMAIN}`]: [[`v=BIMI1; l=${BIMI_LOGO_URL}`]] } }),
    ),
    fetchImpl: fakeFetch(goodRoutes),
    includeOptional: true,
    timeoutMs: 500,
  });
  assert.equal(byId(noVmc.results, 'bimi').status, 'warn');
  assert.match(byId(noVmc.results, 'bimi').summary, /verified mark certificate/);
});

await test('the report status is the worst result, and info/skipped never drag it down', async () => {
  const healthy = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone()),
    fetchImpl: fakeFetch(goodRoutes),
    dkimSelectors: ['mailjet'],
    includeOptional: true,
    timeoutMs: 500,
  });
  assert.equal(healthy.status, 'ok');
  assert.ok(
    healthy.results.every((result) => result.status !== 'error' && result.status !== 'warn'),
    'nothing in a healthy zone may be a warn or an error',
  );
  assert.equal(
    byId(healthy.results, 'dkim:mailjet').status,
    'ok',
    'a 2048-bit key is the recommendation, so it is a pass rather than a note',
  );
  assert.ok(healthy.results.every((result) => result.status === 'ok' || result.status === 'info'));
  assert.deepEqual(healthy.dkimSelectors, ['mailjet']);
  assert.equal(healthy.domain, DOMAIN);
  assert.ok(Date.parse(healthy.checkedAt) > 0);

  // A skipped DKIM check must not turn a healthy domain into anything but 'ok'.
  const noSelectors = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone()),
    fetchImpl: fakeFetch(goodRoutes),
    includeOptional: true,
    timeoutMs: 500,
  });
  assert.equal(byId(noSelectors.results, 'dkim').status, 'skipped');
  assert.equal(noSelectors.status, 'ok');

  const soft = await checkDomain(DOMAIN, {
    resolver: fakeResolver(
      goodZone({ txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none; rua=mailto:dmarc@example.com']] } }),
    ),
    fetchImpl: fakeFetch(goodRoutes),
    dkimSelectors: ['mailjet'],
    includeOptional: true,
    timeoutMs: 500,
  });
  assert.equal(soft.status, 'warn');

  const broken = await checkDomain(DOMAIN, {
    resolver: fakeResolver(goodZone({ mx: {} })),
    fetchImpl: fakeFetch(goodRoutes),
    dkimSelectors: ['mailjet'],
    includeOptional: true,
    timeoutMs: 500,
  });
  assert.equal(broken.status, 'error');
});

await test('a resolver that fails every query still yields a full report', async () => {
  const broken: DnsResolver = {
    resolveMx: async () => {
      throw Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' });
    },
    resolveTxt: async () => {
      throw Object.assign(new Error('queryTxt ESERVFAIL'), { code: 'ESERVFAIL' });
    },
    resolve4: async () => {
      throw Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' });
    },
    resolve6: async () => {
      throw Object.assign(new Error('queryAaaa ESERVFAIL'), { code: 'ESERVFAIL' });
    },
    resolveCname: async () => {
      throw Object.assign(new Error('queryCname ESERVFAIL'), { code: 'ESERVFAIL' });
    },
    resolveCaa: async () => {
      throw Object.assign(new Error('queryCaa ESERVFAIL'), { code: 'ESERVFAIL' });
    },
  };

  const report = await checkDomain(DOMAIN, {
    resolver: broken,
    fetchImpl: fakeFetch({}),
    dkimSelectors: ['mailjet'],
    includeOptional: true,
    timeoutMs: 100,
  });

  assert.equal(report.status, 'error');
  assert.equal(report.results.length, 9);
  assert.match(byId(report.results, 'spf').summary, /SERVFAIL/);
  assert.match(byId(report.results, 'dmarc').summary, /SERVFAIL/);
});

await test('an invalid domain name is reported instead of throwing', async () => {
  const report = await checkDomain('not a domain', { resolver: fakeResolver({}), includeOptional: true });
  assert.equal(report.status, 'error');
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].id, 'domain');
  assert.match(report.results[0].summary, /not a valid domain name/);
});

await test('checkDomain never rejects, whatever the resolver throws', async () => {
  const hostile: DnsResolver = {
    resolveMx: async () => {
      throw 'not even an Error';
    },
    resolveTxt: async () => null as unknown as string[][],
    resolve4: async () => {
      throw null;
    },
    resolveCname: async () => {
      throw undefined;
    },
  };
  const report = await checkDomain(DOMAIN, {
    resolver: hostile,
    fetchImpl: fakeFetch({}),
    dkimSelectors: ['mailjet'],
    includeOptional: true,
    timeoutMs: 100,
  });
  assert.ok(report.results.length >= 4);
  assert.ok(report.results.every((result) => typeof result.summary === 'string' && result.summary.length > 0));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
