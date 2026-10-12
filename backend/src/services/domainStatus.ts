import { createPublicKey } from 'node:crypto';
import {
  resolve4,
  resolve6,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveTxt,
} from 'node:dns/promises';

/**
 * Mail-authentication status checker for a single domain.
 *
 * It answers the question an operator would otherwise answer with `dig`: are MX,
 * SPF, DMARC and DKIM in place, and do the optional extras (MTA-STS, TLS-RPT,
 * BIMI, autodiscover, CAA) agree with what is published. The output is data, not
 * prose, and never an exception - a report that hides nine healthy checks because
 * the tenth one timed out is useless, so every check runs in its own try/catch and
 * every lookup has a deadline.
 *
 * `resolver` and `fetchImpl` are injectable so the whole module can be tested
 * without touching the network; the unit tests do exactly that.
 */

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info' | 'skipped';

export interface DomainCheckResult {
  /** Stable slug, e.g. 'mx', 'spf', 'dmarc'. DKIM uses 'dkim:<selector>'. */
  id: string;
  label: string;
  status: CheckStatus;
  summary: string;
  details?: string[];
  fix?: string;
}

export interface DomainCheckReport {
  domain: string;
  checkedAt: string;
  durationMs: number;
  status: CheckStatus;
  results: DomainCheckResult[];
  dkimSelectors: string[];
}

export interface DomainCheckOptions {
  dkimSelectors?: string[];
  expectedMx?: string[];
  timeoutMs?: number;
  includeOptional?: boolean;
  /** Injectable for tests; defaults to node:dns/promises. */
  resolver?: DnsResolver;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DnsResolver {
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolve6?(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  /** `issuewild` is not in the minimum shape but is needed to judge wildcard CAA. */
  resolveCaa?(name: string): Promise<CaaRecord[]>;
}

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface CaaRecord {
  critical: number;
  issue?: string;
  issuewild?: string;
  iodef?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** RFC 7208 section 4.6.4: more than ten DNS lookups makes the whole record a permerror. */
const SPF_LOOKUP_LIMIT = 10;
/** SPF starts degrading before the hard limit, so the report warns from here up. */
const SPF_LOOKUP_WARN = 8;
const MAX_POLICY_BYTES = 32 * 1024;
const MAX_LOGO_BYTES = 256 * 1024;

const STATUS_RANK: Record<CheckStatus, number> = {
  skipped: 0,
  info: 1,
  ok: 2,
  warn: 3,
  error: 4,
};

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const SPF_VERSION = /^v=spf1(?:\s|$)/i;
const DMARC_VERSION = /^v=dmarc1\s*(?:;|$)/i;
const STS_VERSION = /^v=stsv1\s*(?:;|$)/i;
/** Mechanisms that cost one of the ten permitted SPF DNS lookups. */
const SPF_LOOKUP_MECHANISM = /^(?:include|a|mx|ptr|exists)(?::|$)/;

/** Worst status wins; 'info' and 'skipped' rank below 'ok' so they never drag a report down. */
function worse(a: CheckStatus, b: CheckStatus): CheckStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * ENODATA/ENOTFOUND mean "this name carries no record of that type" and are a
 * normal answer for optional records, not a failure of the lookup itself.
 * ESERVFAIL and timeouts are real failures and must surface as errors/warnings.
 */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENODOMAIN';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function dnsFailure(error: unknown): string {
  const code = errorCode(error);
  if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENODOMAIN') {
    return 'no record of that type is published';
  }
  if (code === 'ESERVFAIL') {
    return 'the resolver returned SERVFAIL';
  }
  if (code === 'ETIMEOUT') {
    return 'the lookup timed out';
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'the lookup timed out';
  }
  return describeError(error);
}

class TimeoutError extends Error {
  readonly code = 'ETIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Every await in this module goes through here, so no single lookup can stall a report. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${what} did not answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function stripQualifier(term: string): string {
  return term.replace(/^[+\-~?]/, '');
}

/**
 * Splits a `key=value` list into a map. DMARC and DKIM separate entries with
 * ';' and the MTA-STS policy file with newlines, but the shape is identical.
 * Records come from DNS, i.e. from whoever controls the zone, so `__proto__`
 * is dropped rather than assigned.
 */
function parseTagList(record: string, separator: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(separator)) {
    const position = part.indexOf('=');
    if (position < 1) {
      continue;
    }
    const key = part.slice(0, position).trim().toLowerCase();
    const value = part.slice(position + 1).trim();
    if (key.length === 0 || key === '__proto__' || key === 'constructor' || tags.has(key)) {
      continue;
    }
    tags.set(key, value);
  }
  return tags;
}

function splitTag(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(':')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseSpfRecord(record: string): {
  mechanisms: string[];
  qualifier: string | null;
  allQualifier: string | null;
  hasRedirect: boolean;
  includes: string[];
} {
  // Terms are whitespace separated and case insensitive (RFC 7208 section 4.6.1).
  // Modifiers such as redirect= and exp= are kept in `mechanisms` so that callers
  // walking the record (see countSpfLookups) do not have to re-parse the text.
  const terms = record
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const mechanisms = terms.filter((term) => !/^v=spf1$/i.test(term)).map((term) => term.toLowerCase());

  const allTerm = mechanisms.find((term) => /^[+\-~?]?all$/.test(term)) ?? null;
  const allMatch = allTerm ? /^([+\-~?])?all$/.exec(allTerm) : null;
  const lastTerm = mechanisms.length > 0 ? mechanisms[mechanisms.length - 1] : null;
  const bare = mechanisms.map(stripQualifier);

  return {
    mechanisms,
    // SPF's implicit qualifier is '+', so a bare term means pass.
    qualifier: lastTerm ? (/^([+\-~?])/.exec(lastTerm)?.[1] ?? '+') : null,
    allQualifier: allMatch ? allMatch[1] ?? '+' : null,
    hasRedirect: bare.some((term) => term.startsWith('redirect=')),
    includes: bare.filter((term) => term.startsWith('include:')).map((term) => term.slice('include:'.length)),
  };
}

export function parseDmarcRecord(record: string): Record<string, string> {
  return Object.fromEntries(parseTagList(record, ';'));
}

export function parseDkimRecord(record: string): {
  version: string | null;
  keyType: string | null;
  publicKey: string | null;
  flags: string[];
  hashes: string[];
  services: string[];
  notes: string | null;
} {
  const tags = parseTagList(record, ';');
  return {
    version: tags.get('v') ?? null,
    // No defaulting here: the caller decides whether a missing k= means rsa.
    keyType: tags.get('k') ?? null,
    publicKey: tags.get('p') ?? null,
    flags: splitTag(tags.get('t')),
    hashes: splitTag(tags.get('h')),
    services: splitTag(tags.get('s')),
    notes: tags.get('n') ?? null,
  };
}

function algorithmOf(keyType: string): 'rsa' | 'ed25519' | 'unknown' {
  if (keyType === 'rsa') {
    return 'rsa';
  }
  if (keyType === 'ed25519') {
    return 'ed25519';
  }
  return 'unknown';
}

export function inspectDkimKey(record: string): {
  valid: boolean;
  algorithm: 'rsa' | 'ed25519' | 'unknown';
  bits: number | null;
  reason: string | null;
} {
  const parsed = parseDkimRecord(record);
  // RFC 6376 section 3.6.1: k= defaults to rsa.
  const keyType = (parsed.keyType ?? 'rsa').toLowerCase();
  const algorithm = algorithmOf(keyType);

  if (parsed.publicKey === null) {
    return { valid: false, algorithm, bits: null, reason: 'the record has no p= tag' };
  }
  if (parsed.publicKey.length === 0) {
    // An empty p= is the revocation form, not a broken key: the signer withdrew it.
    return {
      valid: false,
      algorithm,
      bits: null,
      reason: 'p= is empty, which revokes the key - this selector can no longer sign',
    };
  }

  const compact = parsed.publicKey.replace(/\s+/g, '');
  const der = Buffer.from(compact, 'base64');
  // Buffer.from drops characters outside the base64 alphabet, so re-encoding is the
  // only way to tell a real key from a string of garbage.
  if (der.length === 0 || der.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    return { valid: false, algorithm, bits: null, reason: 'p= is not valid base64' };
  }

  if (keyType === 'ed25519') {
    // An Ed25519 public key is the raw 32 byte point, not a DER structure.
    if (der.length !== 32) {
      return {
        valid: false,
        algorithm,
        bits: null,
        reason: `an Ed25519 public key must be 32 bytes, got ${der.length}`,
      };
    }
    return { valid: true, algorithm, bits: null, reason: null };
  }

  if (keyType !== 'rsa') {
    return { valid: false, algorithm, bits: null, reason: `unsupported key type k=${parsed.keyType}` };
  }

  // RFC 6376 wants SubjectPublicKeyInfo. Some implementations published a bare
  // PKCS#1 RSAPublicKey instead and receivers still accept it, so try both.
  for (const type of ['spki', 'pkcs1'] as const) {
    try {
      const key = createPublicKey({ key: der, format: 'der', type });
      const bits = key.asymmetricKeyDetails?.modulusLength ?? null;
      return { valid: true, algorithm: 'rsa', bits, reason: null };
    } catch {
      // Fall through to the next encoding, then report the failure below.
    }
  }
  return { valid: false, algorithm: 'rsa', bits: null, reason: 'p= does not decode to an RSA public key' };
}

export async function countSpfLookups(
  domain: string,
  txt: (name: string) => Promise<string[][]>,
  maxDepth = SPF_LOOKUP_LIMIT,
): Promise<{ lookups: number; exceeded: boolean; trace: string[] }> {
  const trace: string[] = [];
  const state = { lookups: 0, exceeded: false };

  const walk = async (name: string, depth: number): Promise<void> => {
    if (state.exceeded || depth > maxDepth) {
      return;
    }

    let records: string[];
    try {
      records = (await txt(name)).map((chunks) => chunks.join(''));
    } catch (error) {
      trace.push(`${name}: lookup failed (${dnsFailure(error)})`);
      return;
    }

    const record = records.find((candidate) => SPF_VERSION.test(candidate.trim()));
    if (!record) {
      // An include: target without its own SPF record still cost a query, but there
      // is nothing underneath it to walk.
      return;
    }

    for (const term of parseSpfRecord(record).mechanisms) {
      const bare = stripQualifier(term);
      const redirect = bare.startsWith('redirect=') ? bare.slice('redirect='.length) : null;
      if (!SPF_LOOKUP_MECHANISM.test(bare) && redirect === null) {
        continue;
      }

      state.lookups++;
      trace.push(`${name}: ${bare}`);
      if (state.lookups > SPF_LOOKUP_LIMIT) {
        // Past ten lookups receivers stop evaluating and return permerror, so the
        // rest of the trace is not worth fetching.
        state.exceeded = true;
        return;
      }

      const target = bare.startsWith('include:') ? bare.slice('include:'.length) : redirect;
      if (target) {
        await walk(target, depth + 1);
      }
    }
  };

  await walk(normalizeDomain(domain), 0);
  return { lookups: state.lookups, exceeded: state.exceeded, trace };
}

interface Resolution {
  addresses: string[];
  cname: string | null;
  failure: string | null;
}

interface CheckContext {
  domain: string;
  timeoutMs: number;
  dkimSelectors: string[];
  expectedMx: string[];
  resolver: DnsResolver;
  fetchImpl: typeof fetch;
  lookupMx: (name: string) => Promise<MxRecord[]>;
  lookupTxtRaw: (name: string) => Promise<string[][]>;
  lookupTxt: (name: string) => Promise<string[]>;
  lookupA: (name: string) => Promise<string[]>;
  lookupAaaa: ((name: string) => Promise<string[]>) | null;
  lookupCname: (name: string) => Promise<string[]>;
  lookupCaa: (name: string) => Promise<CaaRecord[]>;
}

function memoize<T>(work: (name: string) => Promise<T>): (name: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (name: string): Promise<T> => {
    const key = name.toLowerCase();
    let cached = cache.get(key);
    if (!cached) {
      // Negative answers are cached too: several checks ask for the same MX set,
      // and re-querying an absent name only multiplies the failure modes.
      cached = work(key);
      cache.set(key, cached);
    }
    return cached;
  };
}

function createContext(
  domain: string,
  options: {
    timeoutMs: number;
    dkimSelectors: string[];
    expectedMx: string[];
    resolver: DnsResolver;
    fetchImpl: typeof fetch;
  },
): CheckContext {
  const { timeoutMs, resolver } = options;
  const resolve6Fn = resolver.resolve6;
  const resolveCaaFn = resolver.resolveCaa;

  const lookupTxtRaw = memoize((name: string) =>
    withTimeout(resolver.resolveTxt(name), timeoutMs, `TXT ${name}`),
  );

  return {
    domain,
    timeoutMs,
    dkimSelectors: options.dkimSelectors,
    expectedMx: options.expectedMx,
    resolver,
    fetchImpl: options.fetchImpl,
    lookupMx: memoize((name: string) => withTimeout(resolver.resolveMx(name), timeoutMs, `MX ${name}`)),
    lookupTxtRaw,
    lookupTxt: async (name: string) => (await lookupTxtRaw(name)).map((chunks) => chunks.join('')),
    lookupA: memoize((name: string) => withTimeout(resolver.resolve4(name), timeoutMs, `A ${name}`)),
    lookupAaaa: resolve6Fn
      ? memoize((name: string) => withTimeout(resolve6Fn(name), timeoutMs, `AAAA ${name}`))
      : null,
    lookupCname: memoize((name: string) => withTimeout(resolver.resolveCname(name), timeoutMs, `CNAME ${name}`)),
    lookupCaa: resolveCaaFn
      ? memoize((name: string) => withTimeout(resolveCaaFn(name), timeoutMs, `CAA ${name}`))
      : async () => {
          throw new Error('the configured resolver cannot answer CAA queries');
        },
  };
}

/** A/AAAA first, then CNAME - an MX pointing only at a CNAME is a finding, not a pass. */
async function resolveHost(ctx: CheckContext, name: string): Promise<Resolution> {
  const attempts: Array<Promise<string[]>> = [ctx.lookupA(name)];
  if (ctx.lookupAaaa) {
    attempts.push(ctx.lookupAaaa(name));
  }
  const settled = await Promise.allSettled(attempts);
  const addresses = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
  if (addresses.length > 0) {
    return { addresses, cname: null, failure: null };
  }

  const rejected = settled.find((outcome) => outcome.status === 'rejected');
  let cname: string | null = null;
  try {
    const names = await ctx.lookupCname(name);
    cname = names[0] ?? null;
  } catch {
    // No CNAME either; the A/AAAA failure below is the message worth showing.
  }
  const failure = rejected && rejected.status === 'rejected' ? dnsFailure(rejected.reason) : 'no A or AAAA record';
  return { addresses, cname, failure };
}

function isIpLiteral(name: string): boolean {
  const bare = name.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
}

/** Runs a fetched response through the caller's parser while the deadline is still armed. */
async function fetchWithTimeout<T>(
  ctx: CheckContext,
  url: string,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    // The race is belt and braces: global fetch honours the signal, but an injected
    // implementation might not, and no check is allowed to hang the report.
    return await withTimeout(
      (async () =>
        consume(await ctx.fetchImpl(url, { signal: controller.signal, redirect: 'follow' })))(),
      ctx.timeoutMs + 1000,
      `GET ${url}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Reads at most `limit` characters, so a hostile or broken server cannot balloon memory. */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      text += Buffer.from(value).toString('utf8');
    }
    if (text.length >= limit) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

function abbreviate(record: string): string {
  return record.length <= 120 ? record : `${record.slice(0, 117)}...`;
}

type CheckOutcome = DomainCheckResult | DomainCheckResult[];
type CheckRunner = (ctx: CheckContext) => Promise<CheckOutcome>;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkMx(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'mx', label: 'MX records' };
  let records: MxRecord[];
  try {
    records = await ctx.lookupMx(ctx.domain);
  } catch (error) {
    if (isAbsent(error)) {
      return [
        {
          ...base,
          status: 'error',
          summary: 'no MX record is published, so the domain cannot receive mail',
          fix: 'Add an MX record pointing at your mail host (for example "10 mail.example.com") at your DNS provider.',
        },
      ];
    }
    return [
      {
        ...base,
        status: 'error',
        summary: `the MX lookup failed: ${dnsFailure(error)}`,
        fix: 'Check that the zone is delegated and that the resolver answers MX queries.',
      },
    ];
  }

  if (records.length === 1 && records[0].exchange === '.') {
    // RFC 7505: a single "." MX is the explicit "this domain accepts no mail" form.
    return [
      {
        ...base,
        status: 'info',
        summary: 'the domain publishes a null MX and explicitly accepts no mail',
        details: ['0 .'],
      },
    ];
  }

  const sorted = [...records].sort(
    (a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange),
  );
  const details = sorted.map((record) => `priority ${record.priority}: ${record.exchange}`);
  const problems: string[] = [];
  const expected = ctx.expectedMx.map((host) => host.toLowerCase().replace(/\.$/, ''));
  const published = new Set(sorted.map((record) => record.exchange.toLowerCase().replace(/\.$/, '')));

  for (const record of sorted) {
    const exchange = record.exchange.toLowerCase().replace(/\.$/, '');
    if (exchange === ctx.domain) {
      problems.push(`${record.exchange} points at the domain itself, which RFC 5321 section 5.1 discourages`);
    }
    if (isIpLiteral(exchange)) {
      problems.push(`${record.exchange} is an address literal, but an MX target must be a hostname`);
      continue;
    }

    const resolution = await resolveHost(ctx, exchange);
    if (resolution.addresses.length > 0) {
      details.push(`${exchange} resolves to ${resolution.addresses.join(', ')}`);
    } else if (resolution.cname) {
      problems.push(`${exchange} is only a CNAME (to ${resolution.cname}); RFC 5321 forbids that for an MX target`);
      details.push(`${exchange} -> CNAME ${resolution.cname}`);
    } else {
      problems.push(`${exchange} does not resolve (${resolution.failure ?? 'no A or AAAA record'})`);
      details.push(`${exchange} does not resolve`);
    }
  }

  const missingExpected = expected.filter((host) => !published.has(host));
  if (missingExpected.length > 0) {
    problems.push(`expected MX host(s) not published: ${missingExpected.join(', ')}`);
  }

  const status: CheckStatus = problems.length > 0 ? 'warn' : 'ok';
  return [
    {
      ...base,
      status,
      summary:
        problems.length > 0
          ? `${sorted.length} MX record${sorted.length === 1 ? '' : 's'}, with problems: ${problems[0]}`
          : `${sorted.length} MX record${sorted.length === 1 ? '' : 's'}, all resolving`,
      details: [...details, ...problems],
      fix:
        problems.length > 0
          ? 'Make every MX target resolve, keep MX targets out of the apex, and remove any MX that the mail host does not own.'
          : undefined,
    },
  ];
}

async function checkSpf(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'spf', label: 'SPF record' };
  let records: string[];
  try {
    records = (await ctx.lookupTxt(ctx.domain)).filter((record) => SPF_VERSION.test(record.trim()));
  } catch (error) {
    if (isAbsent(error)) {
      records = [];
    } else {
      return [
        {
          ...base,
          status: 'error',
          summary: `the SPF lookup failed: ${dnsFailure(error)}`,
          fix: 'Check that the apex TXT records are reachable from the resolver used by this service.',
        },
      ];
    }
  }

  if (records.length === 0) {
    return [
      {
        ...base,
        status: 'error',
        summary: 'no v=spf1 record is published, so receivers cannot tell which hosts may send as this domain',
        fix: 'Publish one TXT record starting with "v=spf1" that lists your senders and ends in "-all".',
      },
    ];
  }
  if (records.length > 1) {
    return [
      {
        ...base,
        status: 'error',
        summary: `${records.length} v=spf1 records are published; a receiver treats more than one as a permanent error`,
        details: records,
        fix: 'Merge them into a single TXT record - two SPF records never combine, they break SPF entirely.',
      },
    ];
  }

  const record = records[0];
  const parsed = parseSpfRecord(record);
  // The budget is the difference between "SPF looks fine" and "SPF is silently ignored
  // by every large receiver", so it is always reported.
  const budget = await countSpfLookups(ctx.domain, ctx.lookupTxtRaw);
  const details = [
    record,
    `terms: ${parsed.mechanisms.length}`,
    `DNS lookups used: ${budget.lookups} of ${SPF_LOOKUP_LIMIT}`,
  ];

  let status: CheckStatus;
  let summary: string;
  let fix: string | undefined;

  if (parsed.allQualifier === null) {
    status = 'error';
    summary = 'the record has no "all" mechanism, so senders that are not listed are not explicitly rejected';
    fix = 'Add "-all" (or at worst "~all") as the last mechanism of the record.';
  } else if (parsed.allQualifier === '-') {
    status = 'ok';
    summary = `SPF is published and ends in -all (${parsed.mechanisms.length} terms, ${budget.lookups} DNS lookup${budget.lookups === 1 ? '' : 's'})`;
  } else if (parsed.allQualifier === '~') {
    status = 'warn';
    summary = 'SPF ends in ~all (soft fail), so unlisted senders are marked but still delivered';
    fix = 'Move to "-all" once the sender list is complete; "~all" only flags forgeries.';
  } else {
    status = 'error';
    summary = `SPF ends in ${parsed.allQualifier}all, which claims every host on the internet may send as this domain`;
    fix = 'Replace the "all" mechanism with "-all"; "?all" and "+all" provide no protection.';
  }

  if (budget.exceeded) {
    status = 'error';
    summary = `SPF needs more than ${SPF_LOOKUP_LIMIT} DNS lookups (${budget.lookups} counted), so receivers return permerror and ignore it`;
    fix = 'Flatten the include: chain, or remove mechanisms that are not needed, until the record stays under ten lookups.';
  } else if (budget.lookups >= SPF_LOOKUP_WARN) {
    status = worse(status, 'warn');
    summary = `${summary}; ${budget.lookups} DNS lookups is close to the limit of ${SPF_LOOKUP_LIMIT}`;
  }

  if (budget.trace.length > 0 && budget.lookups >= SPF_LOOKUP_WARN) {
    details.push(...budget.trace.map((line) => `lookup: ${line}`));
  }

  return [{ ...base, status, summary, details, fix }];
}

async function checkDmarc(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'dmarc', label: 'DMARC record' };
  const name = `_dmarc.${ctx.domain}`;
  let records: string[];
  try {
    records = (await ctx.lookupTxt(name)).filter((record) => DMARC_VERSION.test(record.trim()));
  } catch (error) {
    if (isAbsent(error)) {
      records = [];
    } else {
      return [
        {
          ...base,
          status: 'error',
          summary: `the DMARC lookup failed: ${dnsFailure(error)}`,
          fix: `Check that ${name} is reachable from the resolver used by this service.`,
        },
      ];
    }
  }

  if (records.length === 0) {
    return [
      {
        ...base,
        status: 'error',
        summary: `no DMARC record is published at ${name}, so the domain has no protection against spoofing`,
        fix: `Publish a TXT record at ${name} such as "v=DMARC1; p=none; rua=mailto:dmarc@${ctx.domain}" and tighten p= from there.`,
      },
    ];
  }

  const record = records[0];
  const tags = parseDmarcRecord(record);
  const policy = (tags.p ?? '').toLowerCase();
  const subdomainPolicy = (tags.sp ?? '').toLowerCase();
  const pct = tags.pct === undefined ? 100 : Number.parseInt(tags.pct, 10);
  const details = [record, `p=${policy || '(missing)'}`];
  if (tags.rua) {
    details.push(`rua=${tags.rua}`);
  }
  if (tags.ruf) {
    details.push(`ruf=${tags.ruf}`);
  }
  if (tags.pct) {
    details.push(`pct=${tags.pct}`);
  }

  let status: CheckStatus;
  let summary: string;
  let fix: string | undefined;

  if (policy !== 'none' && policy !== 'quarantine' && policy !== 'reject') {
    status = 'error';
    summary = `the DMARC record has no usable policy (p=${policy || 'missing'}), so receivers fall back to monitoring only`;
    fix = 'Set p= to none, quarantine or reject; "none" still records reports, anything else also blocks.';
  } else if (policy === 'none') {
    status = 'warn';
    summary = 'DMARC is monitoring only (p=none), so nothing is blocked and forged mail still arrives';
    fix = 'Review the aggregate reports, then move to p=quarantine and eventually p=reject.';
  } else {
    status = 'ok';
    summary = `DMARC is published with p=${policy}${tags.rua ? '' : ' but no reporting address'}`;
  }

  if (!tags.rua) {
    status = worse(status, 'warn');
    summary = 'DMARC publishes no rua= address, so nobody receives aggregate reports';
    fix = tags.ruf
      ? 'Add rua= to receive the aggregate reports that tell you whether the policy is safe to tighten.'
      : 'Add rua=mailto:... so you actually see what happens to your mail; without reports a stricter policy is guesswork.';
  }

  if (Number.isFinite(pct) && pct < 100) {
    status = worse(status, 'warn');
    summary = `${summary}; pct=${tags.pct} means the policy applies to only part of the mail`;
    fix = 'Raise pct to 100 once you are confident the policy does not break legitimate mail.';
  }

  const rank: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };
  if (subdomainPolicy && (rank[subdomainPolicy] ?? -1) >= 0 && (rank[subdomainPolicy] ?? -1) < (rank[policy] ?? -1)) {
    status = worse(status, 'warn');
    summary = `${summary}; sp=${subdomainPolicy} is weaker than p=${policy}, so subdomains can be spoofed more easily`;
    fix = `Either drop sp= or set it to the same value as p= (${policy}).`;
  }

  if (tags.adkim === 'r' || tags.aspf === 'r') {
    details.push(`${tags.adkim === 'r' ? 'adkim=r' : ''}${tags.aspf === 'r' ? ' aspf=r' : ''}`.trim());
    details.push('relaxed alignment allows a subdomain of the From domain to pass');
  }
  if (!tags.ruf) {
    details.push('no ruf= address: forensic reports are not requested (optional, and many reporters ignore it)');
  }

  return [{ ...base, status, summary, details, fix }];
}

async function checkDkim(ctx: CheckContext): Promise<DomainCheckResult[]> {
  if (ctx.dkimSelectors.length === 0) {
    return [
      {
        id: 'dkim',
        label: 'DKIM keys',
        status: 'skipped',
        summary: 'no DKIM selectors are configured, so no key was checked',
        fix: 'Add the selectors your mail provider publishes (Mailjet uses "mailjet", Microsoft 365 uses "selector1"/"selector2") - a checker cannot find keys it is not told about.',
      },
    ];
  }

  const outcomes = await Promise.allSettled(
    ctx.dkimSelectors.map(async (selector): Promise<DomainCheckResult> => {
      const id = `dkim:${selector}`;
      const label = `DKIM key (${selector})`;
      const name = `${selector}._domainkey.${ctx.domain}`;

      let records: string[];
      try {
        records = await ctx.lookupTxt(name);
      } catch (error) {
        if (isAbsent(error)) {
          return {
            id,
            label,
            status: 'error',
            summary: `no DKIM key is published for selector "${selector}" at ${name}`,
            fix: 'Publish the public key your mail provider gives you, or drop the selector from the check if it is retired.',
          };
        }
        return {
          id,
          label,
          status: 'error',
          summary: `the DKIM lookup for selector "${selector}" failed: ${dnsFailure(error)}`,
          fix: 'Check that the selector name is spelled correctly and that the zone answers TXT queries.',
        };
      }

      const record = records.find((candidate) => parseDkimRecord(candidate).publicKey !== null) ?? records[0];
      const key = inspectDkimKey(record);
      const details = [abbreviate(record), `${key.algorithm} key${key.bits ? `, ${key.bits} bits` : ''}`];

      if (!key.valid) {
        return {
          id,
          label,
          status: 'error',
          summary: `the DKIM key for selector "${selector}" is unusable: ${key.reason ?? 'unknown reason'}`,
          details,
          fix:
            key.reason === null || !key.reason.includes('revokes')
              ? 'Republish the public key exactly as your mail provider exported it.'
              : 'The key was withdrawn: either publish a new key or remove the selector from the signing configuration.',
        };
      }

      if (key.algorithm === 'ed25519') {
        return { id, label, status: 'ok', summary: `selector "${selector}" holds a valid Ed25519 key`, details };
      }
      if (key.algorithm === 'unknown') {
        return {
          id,
          label,
          status: 'warn',
          summary: `selector "${selector}" uses an algorithm this checker does not understand`,
          details,
          fix: 'Verify the k= tag against your mail provider documentation.',
        };
      }

      const bits = key.bits ?? 0;
      if (bits < 1024) {
        return {
          id,
          label,
          status: 'error',
          summary: `selector "${selector}" uses a ${bits}-bit RSA key, below the 1024-bit floor of RFC 8301`,
          details,
          fix: 'Rotate to at least 2048 bits; short keys are cheap to factor and receivers may refuse them.',
        };
      }
      if (bits < 2048) {
        return {
          id,
          label,
          status: 'warn',
          summary: `selector "${selector}" uses a ${bits}-bit RSA key, which is the old minimum rather than the current recommendation`,
          details,
          fix: 'Rotate to a 2048-bit key at your mail provider and bump the selector.',
        };
      }
      if (bits === 2048) {
        return {
          id,
          label,
          status: 'info',
          summary: `selector "${selector}" holds a valid 2048-bit RSA key`,
          details,
        };
      }
      return {
        id,
        label,
        status: 'ok',
        summary: `selector "${selector}" holds a valid ${bits}-bit RSA key`,
        details,
      };
    }),
  );

  return outcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          id: `dkim:${ctx.dkimSelectors[index]}`,
          label: `DKIM key (${ctx.dkimSelectors[index]})`,
          status: 'error' as CheckStatus,
          summary: `the DKIM check for selector "${ctx.dkimSelectors[index]}" failed: ${describeError(outcome.reason)}`,
        },
  );
}

function matchesMxPattern(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.toLowerCase().replace(/\.$/, '');
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  if (normalizedPattern.startsWith('*.')) {
    // MTA-STS allows exactly one leading wildcard, matching one or more labels.
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedPattern === normalizedHost;
}

function parseMtaStsPolicy(body: string): { mode: string; maxAge: string | null; mx: string[] } {
  let mode = '';
  let maxAge: string | null = null;
  const mx: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const position = line.indexOf(':');
    if (position < 1) {
      continue;
    }
    const key = line.slice(0, position).trim().toLowerCase();
    const value = line.slice(position + 1).trim();
    if (key === 'mode' && mode.length === 0) {
      mode = value.toLowerCase();
    } else if (key === 'max_age' && maxAge === null) {
      maxAge = value;
    } else if (key === 'mx' && value.length > 0) {
      mx.push(value);
    }
  }
  return { mode, maxAge, mx };
}

async function checkMtaSts(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'mta-sts', label: 'MTA-STS' };
  const name = `_mta-sts.${ctx.domain}`;
  const policyUrl = `https://mta-sts.${ctx.domain}/.well-known/mta-sts.txt`;

  let records: string[];
  try {
    records = await ctx.lookupTxt(name);
  } catch (error) {
    if (isAbsent(error)) {
      return [
        {
          ...base,
          status: 'info',
          summary: `no MTA-STS record at ${name}, so inbound TLS is not pinned`,
          fix: 'Optional. Publish "v=STSv1; id=..." plus a policy file if you want senders to refuse TLS downgrades.',
        },
      ];
    }
    return [{ ...base, status: 'warn', summary: `the MTA-STS lookup failed: ${dnsFailure(error)}` }];
  }

  const record = records.find((candidate) => STS_VERSION.test(candidate.trim())) ?? records[0] ?? '';
  const tags = parseTagList(record, ';');
  if ((tags.get('v') ?? '').toLowerCase() !== 'stsv1') {
    return [
      {
        ...base,
        status: 'warn',
        summary: `${name} does not begin with v=STSv1, so receivers ignore it`,
        details: [record],
        fix: 'Set the record to "v=STSv1; id=<random string>" and change id whenever the policy file changes.',
      },
    ];
  }

  let body: string;
  try {
    body = await fetchWithTimeout(ctx, policyUrl, async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return readBoundedText(response, MAX_POLICY_BYTES);
    });
  } catch (error) {
    return [
      {
        ...base,
        status: 'warn',
        summary: `MTA-STS is advertised but the policy at ${policyUrl} could not be read: ${describeError(error)}`,
        details: [record],
        fix: 'The policy file must be reachable over HTTPS with a valid certificate, otherwise senders ignore the TXT record.',
      },
    ];
  }

  const { mode, maxAge, mx } = parseMtaStsPolicy(body);
  const details = [
    record,
    `mode=${mode || '(missing)'}`,
    `max_age=${maxAge ?? '(missing)'}`,
    `policy mx: ${mx.join(', ') || '(none)'}`,
  ];

  let actualMx: string[] = [];
  try {
    actualMx = (await ctx.lookupMx(ctx.domain)).map((record2) => record2.exchange).filter((host) => host !== '.');
  } catch {
    // The MX check reports this failure; an empty list here just skips the comparison.
  }

  const uncovered = actualMx.filter((host) => !mx.some((pattern) => matchesMxPattern(pattern, host)));
  if (mode === 'enforce') {
    if (uncovered.length > 0 && actualMx.length > 0) {
      return [
        {
          ...base,
          status: 'warn',
          summary: `the policy enforces TLS but does not list ${uncovered.join(', ')}, so senders that honour it will refuse mail to those hosts`,
          details,
          fix: 'Add every MX host to the policy file, including the ones only used as fallback, and bump the TXT id.',
        },
      ];
    }
    return [
      {
        ...base,
        status: 'ok',
        summary: 'MTA-STS is enforced and the policy covers the published MX hosts',
        details,
      },
    ];
  }
  if (mode === 'testing') {
    return [
      {
        ...base,
        status: 'warn',
        summary: 'the MTA-STS policy is in testing mode, so a failed TLS handshake is reported but not blocked',
        details,
        fix: 'Move to mode=enforce once the reports show no legitimate failure.',
      },
    ];
  }
  if (mode === 'none') {
    return [
      {
        ...base,
        status: 'warn',
        summary: 'the MTA-STS policy uses mode=none, which asks senders to do nothing',
        details,
        fix: 'Use mode=testing or mode=enforce; mode=none only reserves the name.',
      },
    ];
  }
  return [
    {
      ...base,
      status: 'warn',
      summary: `the MTA-STS policy has no usable mode= tag (got "${mode}")`,
      details,
      fix: 'Write "mode: enforce" (or testing) in the first lines of the policy file.',
    },
  ];
}

async function checkTlsRpt(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'tls-rpt', label: 'TLS-RPT report destination' };
  const name = `_smtp._tls.${ctx.domain}`;

  let records: string[];
  try {
    records = await ctx.lookupTxt(name);
  } catch (error) {
    if (isAbsent(error)) {
      return [
        {
          ...base,
          status: 'info',
          summary: `no TLS-RPT record at ${name}, so nobody is told when TLS fails`,
          fix: 'Optional. Publish "v=TLSRPTv1; rua=mailto:tls@..." to receive reports about failed or downgraded sessions.',
        },
      ];
    }
    return [{ ...base, status: 'warn', summary: `the TLS-RPT lookup failed: ${dnsFailure(error)}` }];
  }

  const record = records.find((candidate) => /^v=tlsrptv1\s*(?:;|$)/i.test(candidate.trim())) ?? records[0] ?? '';
  const tags = parseTagList(record, ';');
  if ((tags.get('v') ?? '').toLowerCase() !== 'tlsrptv1') {
    return [
      {
        ...base,
        status: 'warn',
        summary: `${name} does not begin with v=TLSRPTv1, so receivers ignore it`,
        details: [record],
        fix: 'Use "v=TLSRPTv1; rua=mailto:..." - the version tag is required before the address.',
      },
    ];
  }

  const rua = tags.get('rua');
  if (!rua || rua.length === 0) {
    return [
      {
        ...base,
        status: 'warn',
        summary: 'TLS-RPT is published without a rua= address, so the reports have nowhere to go',
        details: [record],
        fix: 'Add rua=mailto:... (comma-separated for several destinations) to the record.',
      },
    ];
  }

  return [
    {
      ...base,
      status: 'ok',
      summary: `TLS-RPT reports are requested to ${rua}`,
      details: [record],
    },
  ];
}

async function checkBimi(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'bimi', label: 'BIMI' };
  const name = `default._bimi.${ctx.domain}`;

  let records: string[];
  try {
    records = await ctx.lookupTxt(name);
  } catch (error) {
    if (isAbsent(error)) {
      return [
        {
          ...base,
          status: 'info',
          summary: `no BIMI record at ${name}, so no logo is displayed next to mail from this domain`,
          fix: 'Optional, and most mailbox providers also require a verified mark certificate. Publish "v=BIMI1; l=<https SVG URL>; a=<VMC URL>" to opt in.',
        },
      ];
    }
    return [{ ...base, status: 'warn', summary: `the BIMI lookup failed: ${dnsFailure(error)}` }];
  }

  const record = records.find((candidate) => /^v=bimi1\s*(?:;|$)/i.test(candidate.trim())) ?? records[0] ?? '';
  const tags = parseTagList(record, ';');
  const version = (tags.get('v') ?? '').toLowerCase();
  const logoUrl = tags.get('l') ?? null;
  const authorityUrl = tags.get('a') ?? null;
  const details = [record, `l=${logoUrl ?? '(missing)'}`, `a=${authorityUrl ?? '(missing)'}`];

  if (version !== 'bimi1') {
    return [
      {
        ...base,
        status: 'warn',
        summary: `${name} does not begin with v=BIMI1, so receivers ignore it`,
        details,
        fix: 'Start the record with "v=BIMI1".',
      },
    ];
  }

  const problems: string[] = [];
  if (!logoUrl) {
    problems.push('no l= logo URL is published, so there is nothing to display');
  } else if (!logoUrl.toLowerCase().startsWith('https://')) {
    problems.push('the l= logo URL is not https, and receivers refuse to fetch anything else');
  }
  if (!authorityUrl) {
    problems.push('no a= certificate URL, and without a verified mark certificate most providers ignore the logo');
  }

  if (logoUrl && logoUrl.toLowerCase().startsWith('https://')) {
    try {
      const logo = await fetchWithTimeout(ctx, logoUrl, async (response) => {
        const contentType = response.headers.get('content-type') ?? '';
        const text = response.ok ? await readBoundedText(response, MAX_LOGO_BYTES) : '';
        return { status: response.status, contentType, text };
      });
      const looksLikeSvg = /svg/i.test(logo.contentType) || /<svg[\s>]/i.test(logo.text);
      if (!logo.status.toString().startsWith('2')) {
        problems.push(`the logo URL answered HTTP ${logo.status}`);
      } else if (!looksLikeSvg) {
        problems.push('the logo URL does not look like an SVG image');
      } else {
        details.push('the logo fetches and looks like SVG');
      }
    } catch (error) {
      problems.push(`the logo could not be fetched: ${describeError(error)}`);
    }
  }

  return [
    {
      ...base,
      status: problems.length === 0 ? 'ok' : 'warn',
      summary:
        problems.length === 0
          ? 'BIMI is published with a logo and a verified mark certificate'
          : `BIMI is incomplete: ${problems[0]}`,
      details: [...details, ...problems],
      fix:
        problems.length === 0
          ? undefined
          : 'Publish a reachable SVG logo over https (l=) and the URL of your verified mark certificate (a=); without both, mailbox providers keep the logo hidden.',
    },
  ];
}

async function checkAutodiscover(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'autodiscover', label: 'Mail client autodiscovery' };
  const names = [`autoconfig.${ctx.domain}`, `autodiscover.${ctx.domain}`];
  const details: string[] = [];
  let published = 0;

  for (const name of names) {
    const resolution = await resolveHost(ctx, name);
    if (resolution.addresses.length > 0) {
      published++;
      details.push(`${name} resolves to ${resolution.addresses.join(', ')}`);
    } else if (resolution.cname) {
      published++;
      details.push(`${name} -> CNAME ${resolution.cname}`);
    } else {
      details.push(`${name} does not exist`);
    }
  }

  if (published === 0) {
    return [
      {
        ...base,
        status: 'info',
        summary: 'neither autoconfig nor autodiscover resolves, so mail clients must be configured by hand',
        details,
        fix: 'Optional. Point autoconfig.<domain> or autodiscover.<domain> at your mail host (usually a CNAME) so clients find the IMAP/SMTP settings automatically.',
      },
    ];
  }

  return [
    {
      ...base,
      status: 'ok',
      summary: `${published} of 2 autodiscovery hostnames are published`,
      details,
    },
  ];
}

async function checkCaa(ctx: CheckContext): Promise<DomainCheckResult[]> {
  const base = { id: 'caa', label: 'CAA records' };
  if (!ctx.resolver.resolveCaa) {
    return [
      {
        ...base,
        status: 'skipped',
        summary: 'the configured resolver cannot answer CAA queries, so the record was not checked',
      },
    ];
  }

  let records: CaaRecord[];
  try {
    records = await ctx.lookupCaa(ctx.domain);
  } catch (error) {
    if (isAbsent(error)) {
      return [
        {
          ...base,
          status: 'info',
          summary: 'no CAA record is published, so any certificate authority may issue for this domain',
          fix: 'Optional. A CAA record listing letsencrypt.org prevents other CAs from issuing certificates for the domain.',
        },
      ];
    }
    return [{ ...base, status: 'warn', summary: `the CAA lookup failed: ${dnsFailure(error)}` }];
  }

  const details = records.map((record) => {
    const parts = [`${record.critical}`];
    if (record.issue !== undefined) {
      parts.push(`issue="${record.issue}"`);
    }
    if (record.issuewild !== undefined) {
      parts.push(`issuewild="${record.issuewild}"`);
    }
    if (record.iodef !== undefined) {
      parts.push(`iodef="${record.iodef}"`);
    }
    return `flag ${parts.join(' ')}`;
  });

  const authorities = records
    .flatMap((record) => [record.issue, record.issuewild])
    .filter((value): value is string => typeof value === 'string')
    // A property value may carry parameters ("digicert.com; cansignhttpexchanges=yes");
    // only the CA hostname decides who may issue.
    .map((value) => value.split(';')[0].trim().toLowerCase())
    .filter((value) => value.length > 0);

  const allowsLetsEncrypt = authorities.includes('letsencrypt.org');
  if (!allowsLetsEncrypt) {
    return [
      {
        ...base,
        status: 'warn',
        summary: 'a CAA record is published but no issue/issuewild value allows letsencrypt.org',
        details,
        fix: 'This deployment issues its certificates with Let\'s Encrypt, so a CAA that excludes it will break renewals - add "issue letsencrypt.org" (and "issuewild letsencrypt.org" if wildcards are used).',
      },
    ];
  }

  return [
    {
      ...base,
      status: 'ok',
      summary: 'a CAA record is published and letsencrypt.org may issue',
      details,
    },
  ];
}

const CHECKS: ReadonlyArray<{ id: string; label: string; optional: boolean; run: CheckRunner }> = [
  { id: 'mx', label: 'MX records', optional: false, run: checkMx },
  { id: 'spf', label: 'SPF record', optional: false, run: checkSpf },
  { id: 'dmarc', label: 'DMARC record', optional: false, run: checkDmarc },
  { id: 'dkim', label: 'DKIM keys', optional: false, run: checkDkim },
  { id: 'mta-sts', label: 'MTA-STS', optional: true, run: checkMtaSts },
  { id: 'tls-rpt', label: 'TLS-RPT report destination', optional: true, run: checkTlsRpt },
  { id: 'bimi', label: 'BIMI', optional: true, run: checkBimi },
  { id: 'autodiscover', label: 'Mail client autodiscovery', optional: true, run: checkAutodiscover },
  { id: 'caa', label: 'CAA records', optional: true, run: checkCaa },
];

function defaultResolver(): DnsResolver {
  return { resolveMx, resolveTxt, resolve4, resolve6, resolveCname, resolveCaa };
}

export async function checkDomain(domain: string, options: DomainCheckOptions = {}): Promise<DomainCheckReport> {
  const started = Date.now();
  const normalized = normalizeDomain(domain);
  const dkimSelectors = (options.dkimSelectors ?? []).map((selector) => selector.trim()).filter((s) => s.length > 0);
  const includeOptional = options.includeOptional ?? true;

  if (!DOMAIN_PATTERN.test(normalized) || normalized.length > 253) {
    return {
      domain: normalized,
      checkedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      status: 'error',
      results: [
        {
          id: 'domain',
          label: 'Domain name',
          status: 'error',
          summary: `"${domain}" is not a valid domain name, so nothing was checked`,
          fix: 'Pass a bare registrable name such as "example.com" - no scheme, no path.',
        },
      ],
      dkimSelectors,
    };
  }

  const ctx = createContext(normalized, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dkimSelectors,
    expectedMx: options.expectedMx ?? [],
    resolver: options.resolver ?? defaultResolver(),
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  });

  const active = CHECKS.filter((check) => !check.optional || includeOptional);
  const outcomes = await Promise.allSettled(active.map((check) => check.run(ctx)));

  const results: DomainCheckResult[] = [];
  outcomes.forEach((outcome, index) => {
    const check = active[index];
    if (outcome.status === 'fulfilled') {
      results.push(...(Array.isArray(outcome.value) ? outcome.value : [outcome.value]));
      return;
    }
    // A check that threw anyway (a bug, or a resolver that returned something
    // unexpected) still gets reported rather than taking the whole report down.
    results.push({
      id: check.id,
      label: check.label,
      status: 'error',
      summary: `the ${check.id} check failed unexpectedly: ${describeError(outcome.reason)}`,
      fix: 'This looks like a bug in the checker or an unexpected DNS answer; the other checks ran normally.',
    });
  });

  return {
    domain: normalized,
    checkedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    status: results.reduce<CheckStatus>((worst, result) => worse(worst, result.status), 'ok'),
    results,
    dkimSelectors,
  };
}
