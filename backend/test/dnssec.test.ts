import assert from 'node:assert/strict';
import {
  algorithmName,
  dsDigest,
  dsFromDnskey,
  inspectDnssec,
  keyTag,
  parseDnskey,
  parseDs,
  wireName,
} from '../src/services/dnssec.js';

/**
 * DNSSEC maths and parsing. The vectors are the live key-signing key of xcds.net and its
 * published DS, plus kuverto.se which uses the SAME key material under a different owner name -
 * that pair is what proves the digest really covers the owner name, not just the record.
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

const KSK =
  '257 3 8 AwEAAclIpBWZzC2Q9emw7p5YJZs7PcdWC2apU59ndPue84ZlPk1k/y2O1khqMlOsJXrCsWJuZ3BCQ77rCu0oEURDgKQi15mNIb0KI4d9BJVojL47a+FuGw6ZIKjBm4EYr84BvOHvmju9tPkSV/lYM8oA5wndi/tjSXazETP/4lFI5jFT5KOF8EwRRtN9oh7Jtrv1OhS22UEkwk3Ozc8o2guYkJH3Ei9g0zXyluUC7QA5W5XaItxDXuLfSvF5aW5mzxSPWucbxLddJXd5EdQaPOEpl1M+6dab+VRdW4ywxb8BDztEPDeV2vs6iLrz4PmGDtC3mHlfXcMdjgl2O5dPHTKib6k=';
const XCDS_DS = '8fcc25dfc073290a8bff6afaf5929052f01a2cde55744293109882fcb6c27466';
const KUVERTO_DS = '51b764f3daa9dd3631552a5b30ee0a7c0a3225dd914dd985e2a8b983a4f3dda8';

await test('parses a DNSKEY and computes the published key tag (12412)', () => {
  const key = parseDnskey(KSK);
  assert.ok(key);
  assert.equal(key.flags, 257);
  assert.equal(key.algorithm, 8);
  assert.equal(key.isKeySigningKey, true);
  assert.equal(key.keyTag, 12412);
});

await test('the DS digest for xcds.net matches the live DS record', () => {
  const key = parseDnskey(KSK);
  assert.ok(key);
  assert.equal(dsDigest('xcds.net', key), XCDS_DS);
});

await test('the same key under another owner name hashes differently', () => {
  const key = parseDnskey(KSK);
  assert.ok(key);
  assert.equal(dsDigest('kuverto.se', key), KUVERTO_DS);
  assert.notEqual(dsDigest('kuverto.se', key), XCDS_DS);
});

await test('a trailing dot or mixed case does not change the digest', () => {
  const key = parseDnskey(KSK);
  assert.ok(key);
  assert.equal(dsDigest('XCDS.NET.', key), XCDS_DS);
});

await test('dsFromDnskey produces the record a registrar needs', () => {
  const key = parseDnskey(KSK);
  assert.ok(key);
  assert.deepEqual(dsFromDnskey('xcds.net', key), {
    keyTag: 12412,
    algorithm: 8,
    digestType: 2,
    digest: XCDS_DS,
  });
});

await test('wire name is length-prefixed and lowercased', () => {
  assert.deepEqual([...wireName('A.Bc')], [1, 0x61, 2, 0x62, 0x63, 0]);
});

await test('key tag is the RFC 4034 checksum, checked against a second live key', () => {
  // The zone's ZSK, whose key tag Loopia's own DNSSEC panel reports as 26676. Two independent
  // keys agreeing is what makes this a check of the algorithm rather than of one constant.
  const zsk = parseDnskey(
    '256 3 8 AwEAAcF1c0LEhMaPlW1GI5YYBhaiZ3tt8CP+0qQnyoWWIDFEeiNEMAl60EsuIQdDIwqjqsGfkTe1hQBEffL6qaKHPbKRtgmglkmAH1oMmVMlOeJ/VXreQ1cDPLsy+9trFA1rE2tF6mG1qFlR7Fo8n0Ka0KCDDNgUbpqsWhTY7GscDsQg6G3krUsx6yFWuP0DSp4Z1VbDzWXb1qu4lG7GUf1Om47aTrZCXYBH5nwygQu3E5pCi/L8uv5zkkCd8oTd3XiEtfp6DMnJh7M66GJbpgLI2LZHflqOBaSHOuIJBgXL7aUn0mJOm0UCSymic/iNij5zhTsaY7UtEWY4//CQ5aEZn18=',
  );
  assert.ok(zsk);
  assert.equal(zsk.keyTag, 26676);
  assert.equal(zsk.isKeySigningKey, false);
  assert.equal(keyTag(Buffer.alloc(0)), 0);
});

await test('parses a DS record, and rejects a truncated one', () => {
  assert.deepEqual(parseDs(`12412 8 2 ${XCDS_DS}`), {
    keyTag: 12412,
    algorithm: 8,
    digestType: 2,
    digest: XCDS_DS,
  });
  assert.equal(parseDs('12412 8 2'), null);
});

await test('algorithm names cover what is deployed here', () => {
  assert.equal(algorithmName(8), 'RSASHA256');
  assert.equal(algorithmName(13), 'ECDSAP256SHA256');
  assert.equal(algorithmName(200), 'algorithm 200');
});

await test('an unreachable resolver is reported, not thrown', async () => {
  const result = await inspectDnssec('xcds.net', {
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  assert.equal(result.queried, false);
  assert.match(result.error ?? '', /offline/);
});

await test('a resolver answer is parsed into DS/key/matches', async () => {
  const answers: Record<string, string[]> = {
    DS: [`12412 8 2 ${XCDS_DS}`],
    DNSKEY: [KSK],
    CDS: [],
  };
  const fakeFetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    const type = parsed.searchParams.get('type') ?? '';
    return {
      ok: true,
      json: async () => ({
        Status: 0,
        AD: true,
        Answer: (answers[type] ?? []).map((data) => ({
          type: type === 'DNSKEY' ? 48 : type === 'CDS' ? 59 : 43,
          data,
        })),
      }),
    };
  }) as unknown as typeof fetch;

  const result = await inspectDnssec('xcds.net', { fetchImpl: fakeFetch });
  assert.equal(result.queried, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.ds.length, 1);
  assert.equal(result.dnskey.length, 1);
  assert.equal(result.matches[0].key?.keyTag, 12412);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
