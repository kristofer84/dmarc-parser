import {
  resolve4,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveTxt,
} from 'node:dns/promises';
import {
  parseDmarcRecord,
  parseSpfRecord,
  type CaaRecord,
  type DnsResolver,
  type DomainCheckResult,
} from './domainStatus.js';

/**
 * Generates the DNS records a domain should publish, as copy-pasteable values.
 *
 * This is a pure-ish module: it reads the current state through the same injectable
 * `DnsResolver` interface as domainStatus.ts and never writes anything. The point is that
 * an operator looking at a red status row should get the exact record to publish, not a
 * description of it - mistyped SPF include hosts and missing MTA-STS policy files are the
 * usual reasons a domain stays broken after "fixing" it.
 *
 * Everything is defensive: a lookup that fails or an input that is missing becomes a
 * 'needs-input' record with a note, because a generator that throws is worse than useless
 * when the operator is already looking at a broken domain.
 */

export type SuggestionStatus = 'missing' | 'ok' | 'outdated' | 'needs-input';
export type GeneratedRecordId =
  | 'spf'
  | 'dmarc'
  | 'dkim'
  | 'mta-sts'
  | 'tls-rpt'
  | 'caa'
  | 'autodiscover';
export type GeneratedRecordType = 'TXT' | 'CNAME' | 'A';
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type MtaStsMode = 'testing' | 'enforce';

export interface GeneratedRecord {
  id: GeneratedRecordId;
  label: string;
  /** What the record is for, in the same plain terms as the status report. */
  purpose: string;
  status: SuggestionStatus;
  /** Relative owner name: '@', '_dmarc', 'mailjet._domainkey', ... */
  host: string;
  type: GeneratedRecordType;
  value: string;
  ttl: number;
  notes: string[];
  companionFile?: { path: string; content: string };
  /** DKIM only: where the key actually comes from. */
  providerHint?: string;
}

export interface SpfProvider {
  id: string;
  label: string;
  include: string;
  docs: string;
}

/**
 * The provider's own documentation is the authority; this list is a convenience so the
 * common cases need no lookup. Every `include` host below was confirmed with
 * `dig +short TXT <host>` to publish a `v=spf1` record, and a provider whose host did not
 * was left out - an include: of a host without SPF silently adds nothing.
 */
export const SPF_PROVIDERS: SpfProvider[] = [
  {
    id: 'mailjet',
    label: 'Mailjet',
    include: 'spf.mailjet.com',
    docs: 'https://dev.mailjet.com/docs/email-api/senders-domains/senders-domains-overview',
  },
  {
    id: 'microsoft365',
    label: 'Microsoft 365',
    include: 'spf.protection.outlook.com',
    docs: 'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-spf-configure',
  },
  {
    id: 'google',
    label: 'Google Workspace',
    include: '_spf.google.com',
    docs: 'https://support.google.com/a/answer/33786',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    include: 'sendgrid.net',
    docs: 'https://docs.sendgrid.com/ui/account-and-settings/how-to-set-up-domain-authentication',
  },
  {
    id: 'amazonses',
    label: 'Amazon SES',
    include: 'amazonses.com',
    docs: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-spf.html',
  },
  {
    id: 'mailgun',
    label: 'Mailgun',
    include: 'mailgun.org',
    docs: 'https://documentation.mailgun.com/en/latest/user_manual.html',
  },
  {
    id: 'salesforce',
    label: 'Salesforce',
    include: '_spf.salesforce.com',
    docs: 'https://help.salesforce.com/s/articleView?id=000387128&type=1',
  },
];

export interface SuggestionInput {
  domain: string;
  /** The latest check results for this domain, used to judge what is already published. */
  current: DomainCheckResult[];
  /** Resolved MX exchanges, used to build the MTA-STS policy file. */
  mxHosts: string[];
  /** Default rua=/ruf= target, from the mailbox this app already reads. May be null. */
  mailboxAddress?: string | null;
  /** Selected SPF provider ids from SPF_PROVIDERS. */
  providers?: string[];
  dmarcPolicy?: DmarcPolicy;
  rua?: string;
  ruf?: string;
  mtaStsMode?: MtaStsMode;
  /** MTA-STS policy id. Defaults to a UTC stamp of now; see the note on that record. */
  id?: string;
  /** Injectable for tests; defaults to node:dns/promises. */
  resolver?: DnsResolver;
}

const TTL = 300;
/** RFC 7208 section 4.6.4: more than ten DNS lookups makes the whole SPF record a permerror. */
const SPF_LOOKUP_LIMIT = 10;
/** SPF starts degrading before the hard limit; a record this close is worth a warning. */
const SPF_LOOKUP_WARN = 8;
/** RFC 8461 section 3.2: testing is the safe first mode, and its max_age may be short. */
const MTA_STS_MAX_AGE: Record<MtaStsMode, number> = { testing: 86400, enforce: 604800 };

const PURPOSE = {
  spf: 'SPF lists the hosts that may send mail as the domain, so a receiver can reject a forgery. Without it anyone can send as the domain and the receiver cannot tell.',
  dmarc:
    'DMARC tells receivers what to do when SPF or DKIM fails, and where to send reports about it. Without it a spoofed message that fails authentication is still delivered.',
  dkim: 'A DKIM key lets a receiver prove a message was signed by this domain and not altered in transit. Without it a forgery cannot be told apart by signature.',
  mtaSts:
    'MTA-STS tells senders to encrypt mail in transit to the domain and to refuse delivery if TLS cannot be negotiated, which blocks downgrade attacks.',
  tlsRpt:
    'TLS-RPT asks receiving servers to report TLS failures and downgrades, so a delivery problem is visible before mail silently stops arriving.',
  caa: 'CAA names the certificate authorities allowed to issue certificates for the domain, so a certificate issued by anyone else can be refused automatically.',
  autodiscover:
    'The autoconfig and autodiscover hostnames let a mail client find the IMAP and SMTP settings from just the address instead of being configured by hand.',
} as const;

const PURPOSE_BY_ID: Record<GeneratedRecordId, string> = {
  spf: PURPOSE.spf,
  dmarc: PURPOSE.dmarc,
  dkim: PURPOSE.dkim,
  'mta-sts': PURPOSE.mtaSts,
  'tls-rpt': PURPOSE.tlsRpt,
  caa: PURPOSE.caa,
  autodiscover: PURPOSE.autodiscover,
};

const DMARC_RANK: Record<DmarcPolicy, number> = { none: 0, quarantine: 1, reject: 2 };

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** ENODATA/ENOTFOUND mean "nothing published", not "the lookup failed". */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENODOMAIN';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a TXT name without ever throwing. `readable: false` means the lookup itself failed,
 * which is different from "no record": the caller must not then claim the record is missing.
 */
async function lookupTxt(
  resolver: DnsResolver,
  name: string,
): Promise<{ records: string[]; readable: boolean; failure: string | null }> {
  try {
    const chunks = await resolver.resolveTxt(name);
    return { records: chunks.map((parts) => parts.join('')), readable: true, failure: null };
  } catch (error) {
    if (isAbsent(error)) {
      return { records: [], readable: true, failure: null };
    }
    return { records: [], readable: false, failure: describeError(error) };
  }
}

async function lookupCaa(
  resolver: DnsResolver,
  name: string,
): Promise<{ records: CaaRecord[]; readable: boolean; failure: string | null }> {
  if (!resolver.resolveCaa) {
    return { records: [], readable: false, failure: 'the configured resolver cannot answer CAA queries' };
  }
  try {
    return { records: await resolver.resolveCaa(name), readable: true, failure: null };
  } catch (error) {
    if (isAbsent(error)) {
      return { records: [], readable: true, failure: null };
    }
    return { records: [], readable: false, failure: describeError(error) };
  }
}

function resultById(current: DomainCheckResult[], id: string): DomainCheckResult | undefined {
  return current.find((result) => result.id === id || result.id.startsWith(`${id}:`));
}

/** Maps a stored check status onto the generator's status when DNS cannot be read. */
function statusFromCheck(current: DomainCheckResult[], id: string): SuggestionStatus | null {
  const result = resultById(current, id);
  if (!result) {
    return null;
  }
  if (result.status === 'ok') {
    return 'ok';
  }
  if (result.status === 'info') {
    return 'missing';
  }
  if (result.status === 'warn' || result.status === 'error') {
    return 'outdated';
  }
  return null;
}

function toMailto(address: string): string {
  const trimmed = address.trim();
  return /^mailto:/i.test(trimmed) ? trimmed : `mailto:${trimmed}`;
}

function defaultResolver(): DnsResolver {
  return { resolveMx, resolveTxt, resolve4, resolveCname, resolveCaa };
}

/** A UTC `YYYYMMDDHHmmss` stamp; MTA-STS only needs the id to change with the policy. */
function timestampId(now = new Date()): string {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function resolveProviders(ids: string[]): { selected: SpfProvider[]; unknown: string[] } {
  const byId = new Map(SPF_PROVIDERS.map((provider) => [provider.id, provider]));
  const selected: SpfProvider[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const provider = byId.get(id);
    if (provider) {
      selected.push(provider);
    } else {
      unknown.push(raw.trim());
    }
  }

  return { selected, unknown };
}

/**
 * Builds the single SPF record.
 *
 * `domains` are additional sender domains whose own SPF must be pulled in with `include:`
 * (for example a sister domain that has its own senders); each one costs a lookup just like
 * a provider include does. When a provider include host is already covered the duplicate is
 * dropped - repeating an include neither helps nor costs anything, but it makes the record
 * harder to read.
 *
 * There is deliberately no way to produce a second record: RFC 7208 section 3.2 says a
 * receiver that finds more than one `v=spf1` record must treat the check as a permanent
 * error, so a "second" SPF record does not combine with the first - it disables both.
 */
export function buildSpfRecord(
  domains: string[],
  providers: string[],
): { value: string; lookups: number; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map(SPF_PROVIDERS.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const terms = ['v=spf1'];
  let lookups = 0;

  for (const raw of providers) {
    const provider = byId.get(raw.trim().toLowerCase());
    if (!provider) {
      warnings.push(`Unknown provider id "${raw.trim()}" was ignored.`);
      continue;
    }
    const include = normalizeHost(provider.include);
    if (seen.has(include)) {
      continue;
    }
    seen.add(include);
    terms.push(`include:${include}`);
    lookups++;
  }

  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    terms.push(`include:${domain}`);
    lookups++;
  }

  terms.push('-all');

  if (lookups > SPF_LOOKUP_LIMIT) {
    warnings.push(
      `This record needs ${lookups} DNS lookups, and a receiver may use at most ${SPF_LOOKUP_LIMIT}: past that limit SPF returns permerror and is ignored entirely.`,
    );
  } else if (lookups >= SPF_LOOKUP_WARN) {
    warnings.push(`This record needs ${lookups} of the ${SPF_LOOKUP_LIMIT} DNS lookups a receiver may use.`);
  }

  return { value: terms.join(' '), lookups, warnings };
}

export interface DmarcRecordOptions {
  policy: DmarcPolicy;
  rua?: string | null;
  ruf?: string | null;
}

/**
 * Builds the DMARC record. `adkim=s`/`aspf=s` are strict alignment: a subdomain of the From
 * domain may no longer satisfy DKIM/SPF alignment, which is tighter than the RFC default and
 * what a domain with no sending subdomains wants.
 *
 * `sp=` mirrors `p=` on purpose: an explicit subdomain policy that is weaker than `p=` is
 * the usual way a domain ends up "protected" while its subdomains are not.
 */
export function buildDmarcRecord(options: DmarcRecordOptions): string {
  const parts = ['v=DMARC1', `p=${options.policy}`];
  if (options.rua && options.rua.trim()) {
    parts.push(`rua=${toMailto(options.rua)}`);
  }
  if (options.ruf && options.ruf.trim()) {
    const uri = toMailto(options.ruf);
    // RFC 7489 section 6.3 defines the optional "!size" suffix on a dmarc-uri; without it a
    // receiver may mail back a full failing message, which is attacker-controlled content.
    parts.push(`ruf=${uri.includes('!') ? uri : `${uri}!10m`}`);
  }
  parts.push(`sp=${options.policy}`, 'adkim=s', 'aspf=s', 'pct=100');
  return parts.join('; ');
}

export function buildMtaStsTxtRecord(id: string): string {
  return `v=STSv1; id=${id}`;
}

/**
 * Builds the MTA-STS policy file body (RFC 8461 section 3.2).
 *
 * MTA-STS is two records, not one: the TXT record advertises that a policy exists and its
 * id, and this file - served over HTTPS - carries the mode and the MX hosts. A TXT record
 * alone is ignored, and a policy listing fewer hosts than the zone publishes makes senders
 * that honour `mode: enforce` refuse mail to the missing ones.
 */
export function buildMtaStsPolicy(mode: string, maxAge: number, mxHosts: string[]): string {
  const lines = ['version: STSv1', `mode: ${mode}`, `max_age: ${maxAge}`];
  const seen = new Set<string>();

  for (const raw of mxHosts) {
    const host = normalizeHost(raw);
    if (!host || host === '.' || seen.has(host)) {
      continue;
    }
    seen.add(host);
    lines.push(`mx: ${host}`);
  }

  return `${lines.join('\n')}\n`;
}

interface GenerationContext {
  domain: string;
  resolver: DnsResolver;
  input: SuggestionInput;
  selected: SpfProvider[];
  unknownProviders: string[];
  mailboxAddress: string | null;
}

async function generateSpf(ctx: GenerationContext): Promise<GeneratedRecord> {
  const built = buildSpfRecord([], ctx.selected.map((provider) => provider.id));
  const notes = [...built.warnings];

  for (const unknown of ctx.unknownProviders) {
    notes.push(`Unknown provider id "${unknown}" was not included.`);
  }

  // Above the warn threshold buildSpfRecord already explains the budget; do not repeat it.
  if (built.lookups < SPF_LOOKUP_WARN) {
    notes.push(
      `This record spends ${built.lookups} of the ${SPF_LOOKUP_LIMIT} DNS lookups a receiver may use on SPF; past ten the whole record is treated as a permanent error.`,
    );
  }

  const existing = await lookupTxt(ctx.resolver, ctx.domain);
  const spfRecords = existing.records.filter((record) => /^v=spf1(?:\s|$)/i.test(record.trim()));
  let status: SuggestionStatus;

  if (!existing.readable) {
    // A failed lookup is not evidence of absence; lean on the stored check instead.
    status = statusFromCheck(ctx.input.current, 'spf') ?? 'needs-input';
    notes.push(`The published SPF record could not be read (${existing.failure}); the status is taken from the last check.`);
  } else if (spfRecords.length === 0) {
    status = 'missing';
  } else if (spfRecords.length > 1) {
    status = 'outdated';
    notes.push(
      `${spfRecords.length} SPF records are already published. That alone already breaks SPF until they are merged.`,
    );
  } else {
    const published = new Set(parseSpfRecord(spfRecords[0]).includes.map(normalizeHost));
    const wanted = ctx.selected.map((provider) => normalizeHost(provider.include));
    const uncovered = wanted.filter((include) => !published.has(include));
    status = uncovered.length === 0 ? 'ok' : 'outdated';
    if (uncovered.length > 0) {
      notes.push(`The published record does not cover ${uncovered.join(', ')} yet.`);
    }
  }

  if (spfRecords.length > 0) {
    notes.push(
      'There must be exactly one SPF record: a second v=spf1 record makes receivers treat SPF as a permanent error, so merge these mechanisms into the existing record rather than adding a new TXT record.',
    );
  }

  return {
    id: 'spf',
    label: 'SPF record',
    purpose: PURPOSE.spf,
    status,
    host: '@',
    type: 'TXT',
    value: built.value,
    ttl: TTL,
    notes,
  };
}

async function generateDmarc(ctx: GenerationContext): Promise<GeneratedRecord> {
  const policy = ctx.input.dmarcPolicy ?? 'none';
  const rua = (ctx.input.rua ?? ctx.mailboxAddress ?? '').trim();
  const ruf = (ctx.input.ruf ?? ctx.mailboxAddress ?? '').trim();
  const notes: string[] = [];

  if (!rua && !ruf) {
    notes.push(
      'No reporting address is configured: set the mailbox user in Settings, or paste rua= yourself, so the aggregate reports have somewhere to go.',
    );
  }
  notes.push(
    'Start at p=none if you have never seen reports for this domain; tighten to quarantine and then reject once the reports show no legitimate mail failing.',
  );
  if (policy !== 'none') {
    notes.push(`p=${policy} blocks mail, so confirm the reports are clean before publishing this.`);
  }
  if (ruf) {
    notes.push(
      'ruf= forensic reports are only sent by a minority of receivers, and the !10m is the RFC 7489 section 6.3 per-report size limit.',
    );
  }
  notes.push('Publish it at _dmarc.<domain>; a second DMARC record is ignored, with the first one winning.');

  const value = buildDmarcRecord({ policy, rua: rua || null, ruf: ruf || null });
  const existing = await lookupTxt(ctx.resolver, `_dmarc.${ctx.domain}`);
  const dmarcRecords = existing.records.filter((record) => /^v=dmarc1\s*(?:;|$)/i.test(record.trim()));
  let status: SuggestionStatus;

  if (!existing.readable) {
    status = statusFromCheck(ctx.input.current, 'dmarc') ?? 'needs-input';
    notes.push(`The published DMARC record could not be read (${existing.failure}); the status is taken from the last check.`);
  } else if (dmarcRecords.length === 0) {
    status = 'missing';
  } else {
    const publishedPolicy = (parseDmarcRecord(dmarcRecords[0]).p ?? '').toLowerCase() as DmarcPolicy;
    const publishedRank = DMARC_RANK[publishedPolicy] ?? -1;
    if (publishedRank >= DMARC_RANK[policy]) {
      status = 'ok';
    } else {
      status = 'outdated';
      notes.push(`The published policy p=${publishedPolicy || '(missing)'} is weaker than the requested p=${policy}.`);
    }
  }

  return {
    id: 'dmarc',
    label: 'DMARC record',
    purpose: PURPOSE.dmarc,
    status,
    host: '_dmarc',
    type: 'TXT',
    value,
    ttl: TTL,
    notes,
  };
}

/**
 * DKIM cannot be generated: the private key never leaves the sender, so the console can only
 * say which name must carry the key and where the operator finds it. An invented key would
 * either fail every signature or, worse, look valid while the real one is elsewhere.
 */
function generateDkim(ctx: GenerationContext): GeneratedRecord {
  const configured = ctx.input.current
    .filter((result) => result.id.startsWith('dkim:'))
    .map((result) => result.id.slice('dkim:'.length))
    .filter((selector) => selector.length > 0 && !selector.includes(' '));
  const selector = configured[0] ?? 'mailjet';
  const notes: string[] = [];

  if (configured.length === 0) {
    notes.push(
      'No DKIM selector is configured for this domain, so this shows the selector this deployment uses (Mailjet); change it to the selector your provider publishes.',
    );
  }

  const microsoft = /^selector\d+$/i.test(selector);
  const host = `${selector}._domainkey`;

  notes.push(
    "Copy the public key from the provider's panel and paste it here; the console cannot create it, because the matching private key is the signer's.",
  );

  let providerHint: string;
  if (/^mailjet$/i.test(selector)) {
    providerHint =
      'Mailjet publishes a TXT record containing "k=rsa; p=..." for each authenticated sending domain; copy it verbatim.';
  } else if (microsoft) {
    providerHint = `Microsoft 365 uses a CNAME to ${selector}-${ctx.domain.replace(/\./g, '-')}._domainkey.<tenant>.onmicrosoft.com, with <tenant> from the Microsoft 365 admin centre.`;
  } else {
    providerHint = "Paste the value exactly as the provider's DKIM panel exports it.";
  }

  return {
    id: 'dkim',
    label: `DKIM key (${selector})`,
    purpose: PURPOSE.dkim,
    status: 'needs-input',
    host,
    type: microsoft ? 'CNAME' : 'TXT',
    value: '',
    ttl: TTL,
    notes,
    providerHint,
  };
}

async function generateMtaSts(ctx: GenerationContext): Promise<GeneratedRecord> {
  const mode = ctx.input.mtaStsMode ?? 'testing';
  const maxAge = MTA_STS_MAX_AGE[mode];
  const id = ctx.input.id?.trim() || timestampId();
  const mxHosts = ctx.input.mxHosts;

  const notes: string[] = [
    'The id must change every time the policy changes: senders cache the policy against this id, so leaving it alone serves them the old policy indefinitely.',
    `The policy file must be served at https://mta-sts.${ctx.domain}/.well-known/mta-sts.txt over HTTPS with a certificate valid for mta-sts.${ctx.domain}, or senders ignore the TXT record.`,
    'Start in testing mode; move to enforce only once the TLS-RPT reports show no legitimate delivery failures.',
    'Both parts are needed: the TXT record points senders at the policy, and the policy file carries the mode and the MX hosts.',
  ];

  let status: SuggestionStatus;
  const existing = await lookupTxt(ctx.resolver, `_mta-sts.${ctx.domain}`);
  const stsRecord = existing.records.find((record) => /^v=stsv1\s*(?:;|$)/i.test(record.trim()));
  const currentResult = resultById(ctx.input.current, 'mta-sts');
  const currentMode = (currentResult?.details ?? [])
    .map((detail) => /^mode=(testing|enforce|none)$/i.exec(detail.trim())?.[1]?.toLowerCase())
    .find((value) => Boolean(value));

  if (mxHosts.length === 0) {
    status = 'needs-input';
    notes.push('No MX hosts were available, so the policy would list none; add one mx: line per MX host before enforcing.');
  } else if (!existing.readable) {
    status = statusFromCheck(ctx.input.current, 'mta-sts') ?? 'needs-input';
    notes.push(`The published MTA-STS record could not be read (${existing.failure}); the status is taken from the last check.`);
  } else if (!stsRecord) {
    status = 'missing';
  } else if (currentMode === mode) {
    status = 'ok';
  } else {
    status = 'outdated';
    notes.push(
      currentMode
        ? `A policy is already published in ${currentMode} mode, which does not match the requested ${mode} mode; publishing this replaces it.`
        : 'An MTA-STS record is already published but its policy mode could not be read; this replaces it with a known one.',
    );
  }

  return {
    id: 'mta-sts',
    label: 'MTA-STS',
    purpose: PURPOSE.mtaSts,
    status,
    host: '_mta-sts',
    type: 'TXT',
    value: buildMtaStsTxtRecord(id),
    ttl: TTL,
    notes,
    companionFile: {
      path: '/.well-known/mta-sts.txt',
      content: buildMtaStsPolicy(mode, maxAge, mxHosts),
    },
  };
}

async function generateTlsRpt(ctx: GenerationContext): Promise<GeneratedRecord> {
  const address = (ctx.input.rua ?? ctx.mailboxAddress ?? '').trim();
  const notes: string[] = [];
  const value = address ? `v=TLSRPTv1; rua=${toMailto(address)}` : 'v=TLSRPTv1';
  let status: SuggestionStatus;

  if (!address) {
    status = 'needs-input';
    notes.push('No reporting address is configured: set the mailbox user in Settings, or fill in rua=mailto:... yourself.');
  } else {
    const existing = await lookupTxt(ctx.resolver, `_smtp._tls.${ctx.domain}`);
    const record = existing.records.find((candidate) => /^v=tlsrptv1\s*(?:;|$)/i.test(candidate.trim()));
    if (!existing.readable) {
      status = statusFromCheck(ctx.input.current, 'tls-rpt') ?? 'needs-input';
      notes.push(`The published TLS-RPT record could not be read (${existing.failure}); the status is taken from the last check.`);
    } else if (!record) {
      status = 'missing';
    } else if ((parseDmarcRecord(record).rua ?? '').trim().length > 0) {
      status = 'ok';
    } else {
      status = 'outdated';
      notes.push('A TLS-RPT record is published without rua=, so the reports have nowhere to go.');
    }
  }

  notes.push('Optional, and only about transport security; it does not affect whether mail is delivered.');

  return {
    id: 'tls-rpt',
    label: 'TLS-RPT report destination',
    purpose: PURPOSE.tlsRpt,
    status,
    host: '_smtp._tls',
    type: 'TXT',
    value,
    ttl: TTL,
    notes,
  };
}

async function generateCaa(ctx: GenerationContext): Promise<GeneratedRecord> {
  const notes: string[] = [
    'CAA is consulted by certificate authorities before every issuance. Adding a record that omits a CA you actually use blocks issuance for the whole domain, including renewals.',
    "Re-check this record whenever the certificate authority changes, and add an issue entry for every CA in use (including one a CDN or host issues with on your behalf).",
    'This is a CAA record, not a TXT record: pick the CAA type in your DNS provider and enter the value below.',
  ];
  const value = '0 issue "letsencrypt.org"';
  const existing = await lookupCaa(ctx.resolver, ctx.domain);
  let status: SuggestionStatus;

  if (!existing.readable) {
    status = statusFromCheck(ctx.input.current, 'caa') ?? 'needs-input';
    if (existing.failure) {
      notes.push(`The published CAA record could not be read (${existing.failure}); the status is taken from the last check.`);
    }
  } else if (existing.records.length === 0) {
    status = 'missing';
    notes.push('Optional until you rely on it; it only constrains who may issue, so it is safe to add.');
  } else {
    const authorities = existing.records
      .flatMap((record) => [record.issue, record.issuewild])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.split(';')[0].trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (authorities.includes('letsencrypt.org')) {
      status = 'ok';
    } else {
      status = 'outdated';
      notes.push(
        'The published CAA record does not allow letsencrypt.org, so Let\'s Encrypt renewals for this domain will fail until it is added - this is a hazard, not a style issue.',
      );
    }
  }

  return {
    id: 'caa',
    label: 'CAA record',
    purpose: PURPOSE.caa,
    status,
    host: '@',
    type: 'TXT',
    value,
    ttl: TTL,
    notes,
  };
}

/**
 * Autodiscovery hostnames are pure convenience, so they are only suggested when the last
 * check found them absent - suggesting a record that is already published only adds noise.
 * One record is returned per missing hostname, because each is its own owner name.
 */
function generateAutodiscover(ctx: GenerationContext): GeneratedRecord[] {
  const result = resultById(ctx.input.current, 'autodiscover');
  // No check result means nothing is known about these names, so stay quiet rather than
  // suggest a record that may already exist.
  if (!result) {
    return [];
  }

  const wanted = [`autoconfig.${ctx.domain}`, `autodiscover.${ctx.domain}`];
  // Per hostname, not per check: the check reports 'ok' as soon as one of the two resolves,
  // but the other one is still worth publishing.
  const missing = wanted.filter((name) =>
    (result.details ?? []).some((detail) => detail.startsWith(`${name} does not exist`)),
  );
  if (missing.length === 0) {
    return [];
  }

  const mailHost = ctx.input.mxHosts.map(normalizeHost).find((host) => host.length > 0 && host !== '.') ?? '';

  return missing.map((name) => ({
    id: 'autodiscover' as const,
    label: `Autodiscovery host (${name})`,
    purpose: PURPOSE.autodiscover,
    status: (mailHost ? 'missing' : 'needs-input') as SuggestionStatus,
    host: name.split('.')[0],
    type: 'A' as const,
    value: mailHost,
    ttl: TTL,
    notes: [
      'Optional: it does not affect mail flow, only how easily a mail client finds the server settings.',
      mailHost
        ? 'Point it at the mail host so clients discover IMAP/SMTP automatically; a CNAME to that host name avoids updating this record when the address changes.'
        : 'No MX host was available to point this at; add the host manually.',
    ],
  }));
}

function fallbackRecord(id: GeneratedRecordId, label: string, error: unknown): GeneratedRecord {
  return {
    id,
    label,
    purpose: PURPOSE_BY_ID[id],
    status: 'needs-input',
    host: '',
    type: 'TXT',
    value: '',
    ttl: TTL,
    notes: [`The current state could not be read (${describeError(error)}); fill in this record by hand.`],
  };
}

/**
 * Builds every record for one domain. Providers whose include hosts are unknown are dropped
 * rather than guessed, and the returned `providers` are the catalog entries actually used,
 * so a UI can link to the right documentation alongside the values.
 */
export async function generateRecords(
  input: SuggestionInput,
): Promise<{ records: GeneratedRecord[]; providers: SpfProvider[] }> {
  const domain = normalizeDomain(input.domain);
  const resolver = input.resolver ?? defaultResolver();
  const { selected, unknown } = resolveProviders(input.providers ?? []);

  const ctx: GenerationContext = {
    domain,
    resolver,
    input: { ...input, domain },
    selected,
    unknownProviders: unknown,
    mailboxAddress: input.mailboxAddress?.trim() || null,
  };

  const builders: Array<{ id: GeneratedRecordId; label: string; run: () => Promise<GeneratedRecord[]> }> = [
    { id: 'spf', label: 'SPF record', run: async () => [await generateSpf(ctx)] },
    { id: 'dmarc', label: 'DMARC record', run: async () => [await generateDmarc(ctx)] },
    { id: 'dkim', label: `DKIM key`, run: async () => [generateDkim(ctx)] },
    { id: 'mta-sts', label: 'MTA-STS', run: async () => [await generateMtaSts(ctx)] },
    { id: 'tls-rpt', label: 'TLS-RPT report destination', run: async () => [await generateTlsRpt(ctx)] },
    { id: 'caa', label: 'CAA record', run: async () => [await generateCaa(ctx)] },
    { id: 'autodiscover', label: 'Autodiscovery hosts', run: async () => generateAutodiscover(ctx) },
  ];

  const records: GeneratedRecord[] = [];
  for (const builder of builders) {
    try {
      records.push(...(await builder.run()));
    } catch (error) {
      // A bug or an unexpected resolver answer must not cost the operator the other records.
      records.push(fallbackRecord(builder.id, builder.label, error));
    }
  }

  return { records, providers: selected };
}
