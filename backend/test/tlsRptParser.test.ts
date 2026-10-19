import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { TlsRptParser } from '../src/services/tlsRptParser.js';

/**
 * TLS-RPT (RFC 8460). The fixture is shaped like Google's reports: two policies in one report,
 * one of them with a failure-details entry. Parsing is what turns "the sender says TLS worked"
 * into a row the console can show, so the assertions are about the fields an operator reads.
 */

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

const REPORT = {
  'organization-name': 'Google Inc.',
  'date-range': {
    'start-datetime': '2026-10-18T00:00:00Z',
    'end-datetime': '2026-10-18T23:59:59Z',
  },
  'contact-info': 'smtp-tls-reporting@google.com',
  'report-id': '2026-10-18T00:00:00Z_xcds.net',
  policies: [
    {
      policy: {
        'policy-type': 'sts',
        'policy-string': ['version: STSv1', 'mode: testing', 'mx: mail.xcds.net'],
        'policy-domain': 'xcds.net',
        'mx-host': 'mail.xcds.net',
      },
      summary: {
        'total-successful-session-count': 412,
        'total-failure-session-count': 3,
      },
      'failure-details': [
        {
          'result-type': 'starttls-not-supported',
          'sending-mta-ip': '203.0.113.7',
          'receiving-mx-hostname': 'mail.xcds.net',
          'failed-session-count': 3,
        },
      ],
    },
    {
      policy: {
        'policy-type': 'sts',
        'policy-domain': 'kuverto.se',
        'mx-host': 'mail.kuverto.se',
      },
      summary: { 'total-successful-session-count': 88 },
    },
  ],
};

const body = Buffer.from(JSON.stringify(REPORT));

await test('classifies a .json attachment', () => {
  assert.equal(TlsRptParser.looksLikeTlsRpt('report.json', 'application/tlsrpt+json', body), true);
});

await test('classifies gzipped JSON with a generic content type', () => {
  assert.equal(
    TlsRptParser.looksLikeTlsRpt('report.json.gz', 'application/octet-stream', gzipSync(body)),
    true,
  );
});

await test('does not claim a DMARC aggregate zip', () => {
  assert.equal(
    TlsRptParser.looksLikeTlsRpt('google.com!example.com!123.zip', 'application/zip', Buffer.from('PK\x03\x04')),
    false,
  );
});

await test('parses one entry per policy, with counts and failure detail', () => {
  const entries = TlsRptParser.parse(gzipSync(body), { filename: 'report.json.gz' });
  assert.equal(entries.length, 2);

  const [first, second] = entries;
  assert.equal(first.policyDomain, 'xcds.net');
  assert.equal(first.mxHost, 'mail.xcds.net');
  assert.equal(first.successfulCount, 412);
  assert.equal(first.failureCount, 3);
  assert.equal(first.failureDetails.length, 1);
  assert.equal(first.failureDetails[0].resultType, 'starttls-not-supported');
  assert.equal(first.failureDetails[0].count, 3);
  assert.equal(first.failureDetails[0].sendingMtaIp, '203.0.113.7');
  // The policy as published at report time is kept: it is what the evidence refers to.
  assert.deepEqual(JSON.parse(first.policyString ?? '[]'), [
    'version: STSv1',
    'mode: testing',
    'mx: mail.xcds.net',
  ]);

  assert.equal(second.policyDomain, 'kuverto.se');
  assert.equal(second.failureCount, 0);
  assert.deepEqual(second.failureDetails, []);
});

await test('dedup key is stable across a resend and distinct per policy', () => {
  const first = TlsRptParser.parse(body, { filename: 'a.json' });
  const again = TlsRptParser.parse(gzipSync(body), { filename: 'b.json.gz' });
  assert.deepEqual(
    first.map((e) => e.dedupKey),
    again.map((e) => e.dedupKey),
  );
  assert.notEqual(first[0].dedupKey, first[1].dedupKey);
});

await test('a report with no report-id still dedupes on its content', () => {
  const withoutId = { ...REPORT, 'report-id': undefined };
  const a = TlsRptParser.parse(Buffer.from(JSON.stringify(withoutId)), { filename: 'a.json' });
  const b = TlsRptParser.parse(Buffer.from(JSON.stringify(withoutId)), { filename: 'a.json' });
  assert.equal(a[0].dedupKey, b[0].dedupKey);
});

await test('refuses a report with no policies, naming the file', () => {
  assert.throws(
    () => TlsRptParser.parse(Buffer.from('{"policies":[]}'), { filename: 'empty.json' }),
    /no policies|empty\.json/,
  );
});

await test('refuses a non-JSON attachment with a useful message', () => {
  assert.throws(
    () => TlsRptParser.parse(Buffer.from('not json at all'), { filename: 'broken.json' }),
    /broken\.json/,
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
