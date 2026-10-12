import assert from 'node:assert/strict';
import {
  checkDomain,
  type DnsResolver,
  type DomainCheckResult,
  type MxRecord,
} from '../src/services/domainStatus.js';
import {
  buildDmarcRecord,
  buildMtaStsPolicy,
  buildMtaStsTxtRecord,
  buildSpfRecord,
  generateRecords,
  type GeneratedRecord,
  type SuggestionInput,
} from '../src/services/recordSuggestions.js';

/**
 * Tests for the record-suggestion generator.
 *
 * Everything is offline: the current state comes from domainStatus.ts running against the
 * same fake resolver, so what the generator sees is exactly what the status page would show.
 * The tests that matter most are the ones that would produce a broken record if the value
 * were wrong - a second SPF record, an MTA-STS policy that misses an MX host, a CAA that
 * blocks the CA actually in use.
 */

const DOMAIN = 'example.com';

interface Zone {
  mx?: Record<string, MxRecord[]>;
  txt?: Record<string, string[][]>;
  a?: Record<string, string[]>;
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
    resolve6: async (name) => absent(),
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

/** The stored results the route would pass in, produced by the real checker. */
async function currentFor(zone: Zone, selectors: string[] = []): Promise<DomainCheckResult[]> {
  const report = await checkDomain(DOMAIN, {
    resolver: fakeResolver(zone),
    fetchImpl: fakeFetch({
      [`https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`]: {
        body: 'version: STSv1\nmode: testing\nmax_age: 86400\nmx: mx1.example.com\n',
      },
    }),
    dkimSelectors: selectors,
    includeOptional: true,
    timeoutMs: 200,
  });
  return report.results;
}

async function suggest(overrides: Partial<SuggestionInput> = {}): Promise<GeneratedRecord[]> {
  const { records } = await generateRecords({
    domain: DOMAIN,
    current: [],
    mxHosts: [],
    resolver: fakeResolver({}),
    ...overrides,
  });
  return records;
}

/** Generates against the same zone the stored check saw, so DNS and "current" agree. */
async function suggestFor(
  zone: Zone,
  overrides: Partial<SuggestionInput> = {},
  selectors: string[] = [],
): Promise<GeneratedRecord[]> {
  return suggest({ current: await currentFor(zone, selectors), resolver: fakeResolver(zone), ...overrides });
}

function record(records: GeneratedRecord[], id: GeneratedRecord['id']): GeneratedRecord {
  const found = records.find((entry) => entry.id === id);
  assert.ok(found, `expected a "${id}" record, got ${records.map((entry) => entry.id).join(', ')}`);
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

console.log('\nRecord suggestions');

await test('buildSpfRecord: no providers is just -all', () => {
  const built = buildSpfRecord([], []);
  assert.equal(built.value, 'v=spf1 -all');
  assert.equal(built.lookups, 0);
  assert.deepEqual(built.warnings, []);
});

await test('buildSpfRecord: one provider costs one lookup and keeps the include host verbatim', () => {
  const built = buildSpfRecord([], ['mailjet']);
  assert.equal(built.value, 'v=spf1 include:spf.mailjet.com -all');
  assert.equal(built.lookups, 1);
  assert.deepEqual(built.warnings, []);
});

await test('buildSpfRecord: three providers are all included, in the order given', () => {
  const built = buildSpfRecord([], ['mailjet', 'google', 'microsoft365']);
  assert.equal(
    built.value,
    'v=spf1 include:spf.mailjet.com include:_spf.google.com include:spf.protection.outlook.com -all',
  );
  assert.equal(built.lookups, 3);
});

await test('buildSpfRecord: duplicate include hosts are collapsed and unknown ids warn', () => {
  const duplicate = buildSpfRecord([], ['sendgrid', 'sendgrid']);
  assert.equal(duplicate.value, 'v=spf1 include:sendgrid.net -all');
  assert.equal(duplicate.lookups, 1);

  const unknown = buildSpfRecord([], ['not-a-provider']);
  assert.equal(unknown.value, 'v=spf1 -all');
  assert.equal(unknown.lookups, 0);
  assert.match(unknown.warnings.join(' '), /Unknown provider id "not-a-provider"/);
});

await test('buildSpfRecord: extra domains become includes, and eleven lookups are called out', () => {
  const built = buildSpfRecord(['lists.example.net'], ['mailjet']);
  assert.equal(built.value, 'v=spf1 include:spf.mailjet.com include:lists.example.net -all');
  assert.equal(built.lookups, 2);

  const many = buildSpfRecord(
    ['a.example.net', 'b.example.net', 'c.example.net', 'd.example.net', 'e.example.net', 'f.example.net', 'g.example.net', 'h.example.net', 'i.example.net'],
    ['mailjet'],
  );
  assert.equal(many.lookups, 10);
  assert.match(many.warnings.join(' '), /10 of the 10 DNS lookups/);

  const over = buildSpfRecord(
    ['a.example.net', 'b.example.net', 'c.example.net', 'd.example.net', 'e.example.net', 'f.example.net', 'g.example.net', 'h.example.net', 'i.example.net', 'j.example.net'],
    ['mailjet'],
  );
  assert.equal(over.lookups, 11);
  assert.match(over.warnings.join(' '), /permerror/);
});

await test('SPF suggestion: a missing record is missing, with the lookup budget explained', async () => {
  const records = await suggest({ current: [], providers: ['mailjet'] });
  const spf = record(records, 'spf');
  assert.equal(spf.status, 'missing');
  assert.equal(spf.host, '@');
  assert.equal(spf.type, 'TXT');
  assert.equal(spf.value, 'v=spf1 include:spf.mailjet.com -all');
  assert.equal(spf.ttl, 300);
  assert.match(spf.notes.join(' '), /1 of the 10 DNS lookups/);
  // Nothing is published yet, so the "merge, do not add" warning has no place here.
  assert.doesNotMatch(spf.notes.join(' '), /exactly one SPF record/);
});

await test('SPF suggestion: a published record without the provider is outdated and says one record only', async () => {
  const zone: Zone = { txt: { [DOMAIN]: [['v=spf1 include:_spf.example.com -all']] } };
  const records = await suggestFor(zone, { providers: ['mailjet'] });
  const spf = record(records, 'spf');
  assert.equal(spf.status, 'outdated');
  assert.match(spf.notes.join(' '), /exactly one SPF record/);
  assert.match(spf.notes.join(' '), /does not cover spf\.mailjet\.com/);
});

await test('SPF suggestion: a published record that covers the provider is ok', async () => {
  const zone: Zone = { txt: { [DOMAIN]: [['v=spf1 include:spf.mailjet.com -all']] } };
  const records = await suggestFor(zone, { providers: ['mailjet'] });
  const spf = record(records, 'spf');
  assert.equal(spf.status, 'ok');
  assert.match(spf.notes.join(' '), /exactly one SPF record/);
});

await test('SPF suggestion: two published records are already broken', async () => {
  const zone: Zone = { txt: { [DOMAIN]: [['v=spf1 -all'], ['v=spf1 include:spf.mailjet.com -all']] } };
  const records = await suggestFor(zone, { providers: ['mailjet'] });
  const spf = record(records, 'spf');
  assert.equal(spf.status, 'outdated');
  assert.match(spf.notes.join(' '), /2 SPF records are already published/);
  assert.match(spf.notes.join(' '), /exactly one SPF record/);
});

await test('buildDmarcRecord: the full tag set, with and without an address', () => {
  assert.equal(
    buildDmarcRecord({ policy: 'reject', rua: 'dmarc@xcds.net', ruf: 'dmarc@xcds.net' }),
    'v=DMARC1; p=reject; rua=mailto:dmarc@xcds.net; ruf=mailto:dmarc@xcds.net!10m; sp=reject; adkim=s; aspf=s; pct=100',
  );
  assert.equal(
    buildDmarcRecord({ policy: 'none' }),
    'v=DMARC1; p=none; sp=none; adkim=s; aspf=s; pct=100',
  );
  // A mailto: prefix must not be doubled, and an explicit size limit must survive.
  assert.equal(
    buildDmarcRecord({ policy: 'quarantine', rua: 'mailto:postmaster@example.com', ruf: 'mailto:f@example.com!5m' }),
    'v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com; ruf=mailto:f@example.com!5m; sp=quarantine; adkim=s; aspf=s; pct=100',
  );
});

await test('DMARC suggestion: every policy is accepted and the mailbox becomes rua/ruf', async () => {
  for (const policy of ['none', 'quarantine', 'reject'] as const) {
    const records = await suggest({ current: [], mailboxAddress: 'dmarc@xcds.net', dmarcPolicy: policy });
    const dmarc = record(records, 'dmarc');
    assert.equal(dmarc.host, '_dmarc');
    assert.equal(dmarc.status, 'missing');
    assert.match(dmarc.value, new RegExp(`^v=DMARC1; p=${policy}; rua=mailto:dmarc@xcds\\.net; ruf=mailto:dmarc@xcds\\.net!10m; sp=${policy};`));
  }
});

await test('DMARC suggestion: no mailbox address means no rua/ruf and a note', async () => {
  const records = await suggest({ current: [], mailboxAddress: null, dmarcPolicy: 'quarantine' });
  const dmarc = record(records, 'dmarc');
  assert.equal(dmarc.value, 'v=DMARC1; p=quarantine; sp=quarantine; adkim=s; aspf=s; pct=100');
  assert.match(dmarc.notes.join(' '), /No reporting address is configured/);
  assert.doesNotMatch(dmarc.value, /rua=|ruf=/);
});

await test('DMARC suggestion: status follows the published policy', async () => {
  const strong: Zone = { txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']] } };
  const ok = record(await suggestFor(strong, { dmarcPolicy: 'reject' }), 'dmarc');
  assert.equal(ok.status, 'ok');

  const weak: Zone = { txt: { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none; rua=mailto:dmarc@example.com']] } };
  const outdated = record(await suggestFor(weak, { dmarcPolicy: 'reject' }), 'dmarc');
  assert.equal(outdated.status, 'outdated');
  assert.match(outdated.notes.join(' '), /p=none.*weaker than.*p=reject/);

  // A published policy stronger than requested is still ok: nothing needs publishing.
  const stronger = record(await suggestFor(strong, { dmarcPolicy: 'none' }), 'dmarc');
  assert.equal(stronger.status, 'ok');
});

await test('buildMtaStsTxtRecord and buildMtaStsPolicy produce both halves', () => {
  assert.equal(buildMtaStsTxtRecord('20261012000000'), 'v=STSv1; id=20261012000000');
  assert.equal(
    buildMtaStsPolicy('testing', 86400, ['mx1.example.com', 'mx2.example.com']),
    'version: STSv1\nmode: testing\nmax_age: 86400\nmx: mx1.example.com\nmx: mx2.example.com\n',
  );
  // Duplicates and the null MX must not become mx: lines.
  assert.equal(
    buildMtaStsPolicy('enforce', 604800, ['mx1.example.com', 'MX1.example.com.', '.']),
    'version: STSv1\nmode: enforce\nmax_age: 604800\nmx: mx1.example.com\n',
  );
});

await test('MTA-STS suggestion: TXT plus companion file, with one mx: line per host', async () => {
  const records = await suggest({
    current: [],
    mxHosts: ['mx1.example.com', 'mx2.example.com'],
    mtaStsMode: 'testing',
    id: '20261012000000',
  });
  const sts = record(records, 'mta-sts');
  assert.equal(sts.host, '_mta-sts');
  assert.equal(sts.type, 'TXT');
  assert.equal(sts.value, 'v=STSv1; id=20261012000000');
  assert.equal(sts.companionFile?.path, '/.well-known/mta-sts.txt');
  assert.equal(
    sts.companionFile?.content,
    'version: STSv1\nmode: testing\nmax_age: 86400\nmx: mx1.example.com\nmx: mx2.example.com\n',
  );
  assert.equal(sts.status, 'missing');
  assert.match(sts.notes.join(' '), /id must change/);
  assert.match(sts.notes.join(' '), /HTTPS with a certificate/);
  assert.match(sts.notes.join(' '), /Both parts are needed/);

  const enforce = record(
    await suggest({ current: [], mxHosts: ['mx1.example.com'], mtaStsMode: 'enforce' }),
    'mta-sts',
  );
  assert.match(enforce.companionFile?.content ?? '', /mode: enforce\nmax_age: 604800/);
});

await test('MTA-STS suggestion: a 14-digit id is generated when none is supplied', async () => {
  const records = await suggest({ current: [], mxHosts: ['mx1.example.com'] });
  const sts = record(records, 'mta-sts');
  assert.match(sts.value, /^v=STSv1; id=\d{14}$/);
});

await test('MTA-STS suggestion: mode match is ok, the other mode is outdated, no MX is needs-input', async () => {
  const zone: Zone = {
    mx: { [DOMAIN]: [{ exchange: 'mx1.example.com', priority: 10 }] },
    a: { 'mx1.example.com': ['192.0.2.10'] },
    txt: { [`_mta-sts.${DOMAIN}`]: [['v=STSv1; id=20260101']] },
  };
  const current = await currentFor(zone);

  const testing = record(await suggestFor(zone, { mxHosts: ['mx1.example.com'], mtaStsMode: 'testing' }), 'mta-sts');
  assert.equal(testing.status, 'ok');

  const enforce = record(await suggestFor(zone, { mxHosts: ['mx1.example.com'], mtaStsMode: 'enforce' }), 'mta-sts');
  assert.equal(enforce.status, 'outdated');
  assert.match(enforce.notes.join(' '), /already published in testing mode/);

  const noMx = record(await suggest({ current, mxHosts: [], mtaStsMode: 'testing', resolver: fakeResolver(zone) }), 'mta-sts');
  assert.equal(noMx.status, 'needs-input');
  assert.match(noMx.notes.join(' '), /No MX hosts were available/);
});

await test('TLS-RPT suggestion: the record, its host, and the missing address', async () => {
  const records = await suggest({ current: [], mailboxAddress: 'dmarc@xcds.net' });
  const tlsrpt = record(records, 'tls-rpt');
  assert.equal(tlsrpt.host, '_smtp._tls');
  assert.equal(tlsrpt.value, 'v=TLSRPTv1; rua=mailto:dmarc@xcds.net');
  assert.equal(tlsrpt.status, 'missing');

  const noAddress = record(await suggest({ current: [], mailboxAddress: null }), 'tls-rpt');
  assert.equal(noAddress.status, 'needs-input');
  assert.match(noAddress.notes.join(' '), /No reporting address/);

  const published: Zone = { txt: { [`_smtp._tls.${DOMAIN}`]: [['v=TLSRPTv1; rua=mailto:dmarc@example.com']] } };
  assert.equal(record(await suggestFor(published, { mailboxAddress: 'dmarc@xcds.net' }), 'tls-rpt').status, 'ok');
});

await test('CAA suggestion: ok when letsencrypt is allowed, outdated when it is not', async () => {
  const allowed: Zone = { caa: { [DOMAIN]: [{ critical: 0, issue: 'letsencrypt.org' }] } };
  const ok = record(await suggestFor(allowed), 'caa');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.value, '0 issue "letsencrypt.org"');
  assert.match(ok.notes.join(' '), /blocks issuance/);

  const other: Zone = { caa: { [DOMAIN]: [{ critical: 0, issue: 'digicert.com' }] } };
  const outdated = record(await suggestFor(other), 'caa');
  assert.equal(outdated.status, 'outdated');
  assert.match(outdated.notes.join(' '), /does not allow letsencrypt\.org/);
  assert.match(outdated.notes.join(' '), /renewals.*will fail/);

  const missing = record(await suggest({ current: [] }), 'caa');
  assert.equal(missing.status, 'missing');
});

await test('DKIM suggestion: needs-input, the right host, and no fabricated key', async () => {
  const zone: Zone = { txt: { [DOMAIN]: [['v=spf1 -all']] } };
  const current = await currentFor(zone, ['mailjet']);
  const records = await suggest({ current });
  const dkim = record(records, 'dkim');
  assert.equal(dkim.status, 'needs-input');
  assert.equal(dkim.host, 'mailjet._domainkey');
  assert.equal(dkim.type, 'TXT');
  assert.equal(dkim.value, '');
  assert.match(dkim.providerHint ?? '', /Mailjet publishes a TXT record/);
  assert.match(dkim.notes.join(' '), /cannot create it/);
});

await test('DKIM suggestion: Microsoft selectors point at a CNAME, default selector is mailjet', async () => {
  const current = await currentFor({}, ['selector1']);
  const dkim = record(await suggest({ current }), 'dkim');
  assert.equal(dkim.host, 'selector1._domainkey');
  assert.equal(dkim.type, 'CNAME');
  assert.equal(dkim.value, '');
  assert.match(dkim.providerHint ?? '', /selector1-example-com\._domainkey\.<tenant>\.onmicrosoft\.com/);

  const fallback = record(await suggest({ current: [] }), 'dkim');
  assert.equal(fallback.host, 'mailjet._domainkey');
  assert.match(fallback.notes.join(' '), /No DKIM selector is configured/);
});

await test('autodiscover suggestion: only for hostnames the check found absent', async () => {
  const zone: Zone = {
    mx: { [DOMAIN]: [{ exchange: 'mx1.example.com', priority: 10 }] },
    a: { 'mx1.example.com': ['192.0.2.10'] },
  };
  const records = await suggestFor(zone, { mxHosts: ['mx1.example.com'] });
  const autodiscover = records.filter((entry) => entry.id === 'autodiscover');
  assert.deepEqual(
    autodiscover.map((entry) => entry.host).sort(),
    ['autoconfig', 'autodiscover'],
  );
  assert.ok(autodiscover.every((entry) => entry.type === 'A' && entry.value === 'mx1.example.com'));

  const present: Zone = { ...zone, cname: { [`autoconfig.${DOMAIN}`]: ['mail.example.com'] } };
  const onlyOne = (await suggestFor(present, { mxHosts: ['mx1.example.com'] })).filter(
    (entry) => entry.id === 'autodiscover',
  );
  assert.deepEqual(onlyOne.map((entry) => entry.host), ['autodiscover']);
});

await test('every generated record carries a purpose, a status and notes', async () => {
  const records = await suggestFor(
    {},
    { providers: ['mailjet', 'google'], mxHosts: ['mx1.example.com'], mailboxAddress: 'dmarc@xcds.net' },
    ['mailjet'],
  );
  assert.deepEqual(
    [...new Set(records.map((entry) => entry.id))],
    ['spf', 'dmarc', 'dkim', 'mta-sts', 'tls-rpt', 'caa', 'autodiscover'],
  );
  for (const entry of records) {
    assert.ok(entry.purpose.length > 20, `${entry.id} needs a purpose`);
    assert.ok(entry.notes.length > 0, `${entry.id} needs notes`);
    assert.equal(entry.ttl, 300);
  }
});

await test('the selected providers are echoed back, unknown ones are dropped', async () => {
  const result = await generateRecords({
    domain: DOMAIN,
    current: [],
    mxHosts: [],
    providers: ['mailjet', 'nope'],
    resolver: fakeResolver({}),
  });
  assert.deepEqual(result.providers.map((provider) => provider.id), ['mailjet']);
  assert.match(record(result.records, 'spf').notes.join(' '), /Unknown provider id "nope"/);
});

await test('a resolver that throws every query still yields records instead of rejecting', async () => {
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
    resolveCname: async () => {
      throw Object.assign(new Error('queryCname ESERVFAIL'), { code: 'ESERVFAIL' });
    },
    resolveCaa: async () => {
      throw Object.assign(new Error('queryCaa ESERVFAIL'), { code: 'ESERVFAIL' });
    },
  };

  const result = await generateRecords({
    domain: DOMAIN,
    current: [],
    mxHosts: ['mx1.example.com'],
    mailboxAddress: 'dmarc@xcds.net',
    providers: ['mailjet'],
    resolver: broken,
  });

  assert.ok(result.records.length >= 6);
  assert.ok(result.records.every((entry) => typeof entry.value === 'string' && entry.notes.length > 0));
  assert.equal(record(result.records, 'spf').status, 'needs-input');
  assert.equal(record(result.records, 'caa').status, 'needs-input');
});

await test('xcds.net sanity check: the expected SPF, DMARC and MTA-STS values', async () => {
  const result = await generateRecords({
    domain: 'xcds.net',
    current: [],
    mxHosts: ['mail.xcds.net'],
    mailboxAddress: 'dmarc@xcds.net',
    providers: ['mailjet'],
    dmarcPolicy: 'none',
    mtaStsMode: 'testing',
    id: '20261012000000',
    resolver: fakeResolver({}),
  });

  assert.equal(record(result.records, 'spf').value, 'v=spf1 include:spf.mailjet.com -all');
  assert.equal(
    record(result.records, 'dmarc').value,
    'v=DMARC1; p=none; rua=mailto:dmarc@xcds.net; ruf=mailto:dmarc@xcds.net!10m; sp=none; adkim=s; aspf=s; pct=100',
  );
  assert.equal(record(result.records, 'mta-sts').value, 'v=STSv1; id=20261012000000');
  assert.equal(
    record(result.records, 'mta-sts').companionFile?.content,
    'version: STSv1\nmode: testing\nmax_age: 86400\nmx: mail.xcds.net\n',
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
