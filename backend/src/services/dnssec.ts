import { createHash } from 'node:crypto';

/**
 * DNSSEC inspection.
 *
 * Node's stub resolver cannot request DS or DNSKEY (c-ares supports them, the JS wrapper
 * does not), and RRSIG/DNSKEY answers need the DO bit at all. So this asks a validating
 * resolver over DNS-over-HTTPS instead: Cloudflare first, Google as the fallback.
 *
 * That is a deliberate trade, and it is worth being precise about it: the queries leave the
 * host, and the answer depends on that resolver's own validation. What this module reports is
 * therefore "a validating resolver sees X", not "I validated the chain myself". The `AD` bit
 * is passed through for exactly that reason - when it is set, the resolver performed the
 * validation and this answer is the result of it.
 *
 * The two things worth knowing from the outside are both computed here, not read:
 *  - the key tag (RFC 4034 Appendix B), so a DS can be matched to a DNSKEY in the zone;
 *  - the DS digest (RFC 4034 §5.1.4), so "the DS at the registrar matches a key in the zone"
 *    is a fact rather than a hope. A mismatch is the failure mode that takes a whole domain
 *    off the air for validating resolvers, which is why it gets its own status.
 */

export interface DsRecord {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

export interface DnskeyRecord {
  flags: number;
  protocol: number;
  algorithm: number;
  /** base64, as published. */
  publicKey: string;
  keyTag: number;
  /** True for flags 257 (SEP/KSK): the key a DS should point at. */
  isKeySigningKey: boolean;
}

export interface DnssecInspection {
  /** False when no validating resolver could be reached at all. */
  queried: boolean;
  error?: string;
  /** DS records at the parent. */
  ds: DsRecord[];
  /** DNSKEY records in the zone. */
  dnskey: DnskeyRecord[];
  /** CDS (RFC 8078) published by the zone itself, for automated rollover. */
  cds: DsRecord[];
  /** The resolver says this data validated (the AD bit). */
  authenticated: boolean;
  /** DS ↔ DNSKEY by computed digest; `key: null` means the registrar's DS matches nothing. */
  matches: Array<{ ds: DsRecord; key: DnskeyRecord | null }>;
}

const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

const ALGORITHM_NAMES: Record<number, string> = {
  5: 'RSASHA1',
  7: 'RSASHA1-NSEC3-SHA1',
  8: 'RSASHA256',
  10: 'RSASHA512',
  13: 'ECDSAP256SHA256',
  14: 'ECDSAP384SHA384',
  15: 'ED25519',
  16: 'ED448',
};

export function algorithmName(algorithm: number): string {
  return ALGORITHM_NAMES[algorithm] ?? `algorithm ${algorithm}`;
}

/** RFC 4034 Appendix B. RSAMD5 (1) is the documented exception and is not used here. */
export function keyTag(rdata: Buffer): number {
  let accumulator = 0;
  for (let i = 0; i < rdata.length; i += 1) {
    accumulator += i % 2 === 0 ? rdata[i] << 8 : rdata[i];
  }
  accumulator += (accumulator >> 16) & 0xffff;
  return accumulator & 0xffff;
}

/** DNSKEY RDATA: flags(2) protocol(1) algorithm(1) public key. */
export function dnskeyRdata(key: Pick<DnskeyRecord, 'flags' | 'protocol' | 'algorithm' | 'publicKey'>): Buffer {
  const publicKey = Buffer.from(key.publicKey.replace(/\s+/g, ''), 'base64');
  const header = Buffer.alloc(4);
  header.writeUInt16BE(key.flags ?? 0, 0);
  header.writeUInt8(key.protocol ?? 3, 2);
  header.writeUInt8(key.algorithm ?? 0, 3);
  return Buffer.concat([header, publicKey]);
}

/** Wire-format owner name: length-prefixed labels, lowercased, root terminator (RFC 4034 §6.2). */
export function wireName(name: string): Buffer {
  const labels = name
    .replace(/\.$/, '')
    .toLowerCase()
    .split('.')
    .filter((label) => label.length > 0);
  const parts = labels.map((label) => {
    const bytes = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/**
 * DS digest, digest type 2 (SHA-256) only - type 1 (SHA-1) is deprecated by RFC 8624 and
 * offering it would invite publishing it.
 */
export function dsDigest(
  name: string,
  key: Pick<DnskeyRecord, 'flags' | 'protocol' | 'algorithm' | 'publicKey'>,
): string {
  return createHash('sha256')
    .update(Buffer.concat([wireName(name), dnskeyRdata(key)]))
    .digest('hex');
}

/** The DS record a registrar should hold for this key. */
export function dsFromDnskey(name: string, key: DnskeyRecord): DsRecord {
  return {
    keyTag: key.keyTag,
    algorithm: key.algorithm,
    digestType: 2,
    digest: dsDigest(name, key),
  };
}

export function parseDs(data: string): DsRecord | null {
  const [keyTag, algorithm, digestType, digest] = data.trim().split(/\s+/);
  if (!keyTag || !algorithm || !digestType || !digest) {
    return null;
  }
  return {
    keyTag: Number.parseInt(keyTag, 10),
    algorithm: Number.parseInt(algorithm, 10),
    digestType: Number.parseInt(digestType, 10),
    digest: digest.toLowerCase(),
  };
}

export function parseDnskey(data: string): DnskeyRecord | null {
  const parts = data.trim().split(/\s+/);
  if (parts.length < 4) {
    return null;
  }
  const [flags, protocol, algorithm, ...rest] = parts;
  const publicKey = rest.join('');
  const record = {
    flags: Number.parseInt(flags, 10),
    protocol: Number.parseInt(protocol, 10),
    algorithm: Number.parseInt(algorithm, 10),
    publicKey,
  };
  return {
    ...record,
    keyTag: keyTag(dnskeyRdata(record)),
    isKeySigningKey: record.flags === 257,
  };
}

interface DohAnswer {
  type: number;
  data: string;
}

interface DohResponse {
  ad: boolean;
  answers: DohAnswer[];
}

const TYPE_DS = 43;
const TYPE_DNSKEY = 48;
const TYPE_CDS = 59;

/** One DoH query, trying each endpoint in turn. Throws only when all of them fail. */
async function dohQuery(
  name: string,
  type: 'DS' | 'DNSKEY' | 'CDS',
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DohResponse> {
  let lastError: unknown;

  for (const endpoint of DOH_ENDPOINTS) {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}&do=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const request = fetchImpl(url, {
        headers: { accept: 'application/dns-json' },
        signal: controller.signal,
      });
      // The abort signal is advisory: a fetch implementation - a test double, a proxy, a
      // runtime with a stuck socket - can ignore it and never settle. Racing an explicit
      // deadline keeps one hung query from stalling the whole domain check.
      request.catch(() => {});
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs),
      );
      const response = await Promise.race([request, deadline]);
      if (!response.ok) {
        throw new Error(`${new URL(endpoint).host} answered HTTP ${response.status}`);
      }

      const body = (await response.json()) as {
        Status?: number;
        AD?: boolean;
        Answer?: Array<{ type?: number; data?: string }>;
      };

      // 3 = NXDOMAIN: a real answer (the name does not exist), not a transport failure.
      if (body.Status !== undefined && body.Status !== 0 && body.Status !== 3) {
        throw new Error(`DNS response status ${body.Status} from ${new URL(endpoint).host}`);
      }

      return {
        ad: body.AD === true,
        answers: (body.Answer ?? [])
          .filter((answer): answer is { type: number; data: string } =>
            typeof answer?.data === 'string' && typeof answer?.type === 'number',
          )
          .map((answer) => ({ type: answer.type, data: answer.data })),
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('no DNS-over-HTTPS endpoint answered');
}

export async function inspectDnssec(
  domain: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DnssecInspection> {
  const name = domain.replace(/\.$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 5000;

  try {
    const [dsResponse, dnskeyResponse, cdsResponse] = await Promise.all([
      dohQuery(name, 'DS', fetchImpl, timeoutMs),
      dohQuery(name, 'DNSKEY', fetchImpl, timeoutMs),
      // CDS is often absent; a failure here must not sink the whole inspection.
      dohQuery(name, 'CDS', fetchImpl, timeoutMs).catch(() => ({ ad: false, answers: [] })),
    ]);

    const ds = dsResponse.answers
      .filter((answer) => answer.type === TYPE_DS)
      .map((answer) => parseDs(answer.data))
      .filter((record): record is DsRecord => record !== null);

    const dnskey = dnskeyResponse.answers
      .filter((answer) => answer.type === TYPE_DNSKEY)
      .map((answer) => parseDnskey(answer.data))
      .filter((record): record is DnskeyRecord => record !== null);

    const cds = cdsResponse.answers
      .filter((answer) => answer.type === TYPE_CDS)
      .map((answer) => parseDs(answer.data))
      .filter((record): record is DsRecord => record !== null);

    return {
      queried: true,
      ds,
      dnskey,
      cds,
      authenticated: dsResponse.ad || dnskeyResponse.ad,
      matches: ds.map((record) => ({
        ds: record,
        key:
          dnskey.find(
            (key) =>
              key.keyTag === record.keyTag &&
              key.algorithm === record.algorithm &&
              // Digest type 2 is all this app publishes or recommends; anything else can only
              // be matched by key tag + algorithm, which is what the registrar requires anyway.
              (record.digestType !== 2 || dsDigest(name, key) === record.digest),
          ) ?? null,
      })),
    };
  } catch (error) {
    return {
      queried: false,
      error: error instanceof Error ? error.message : String(error),
      ds: [],
      dnskey: [],
      cds: [],
      authenticated: false,
      matches: [],
    };
  }
}
