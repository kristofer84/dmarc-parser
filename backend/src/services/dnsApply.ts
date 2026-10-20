import { prisma } from '../db/prisma.js';
import type { DnsResolver, DomainCheckResult } from './domainStatus.js';
import {
  parseCredentials,
  readCredentials,
  type CloudflareCredentials,
  type DnsAccountCredentials,
  type LoopiaCredentials,
} from './dnsAccounts.js';
import { resolveMailboxConfig } from './mailboxConfig.js';
import { LoopiaClient, LoopiaError, type LoopiaOptions } from './loopia.js';
import {
  SPF_PROVIDERS,
  generateRecords,
  type DmarcPolicy,
  type GeneratedRecord,
  type GeneratedRecordType,
  type MtaStsMode,
} from './recordSuggestions.js';
import { getSetting } from './settings.js';

/**
 * Applying the generated records through a DNS provider's API.
 *
 * Two writers exist: Cloudflare's JSON API and Loopia's XML-RPC API. The plan/apply rules are
 * provider-independent and deliberately conservative:
 *
 * 1. **Nothing is deleted.** The zone belongs to the operator and carries records this app
 *    knows nothing about (mail hosts, verification TXT, a dozen A records behind a wildcard
 *    name). An apply creates a record, or replaces the one record it can positively identify
 *    as the same record - never removes anything else at that name. Loopia has no update call,
 *    so its writer implements a replacement as remove-then-add; it still only removes the one
 *    identified record.
 * 2. **The client never supplies a value.** A plan is recomputed on every apply, so a stale
 *    or hand-edited request cannot write something the generator did not produce.
 *
 * Which writer answers is decided by `dns.provider` (auto by default): with `auto`, only the
 * providers whose credentials are configured are tried, and the first one that holds the
 * domain wins. Cloudflare is tried before Loopia when both do. Pinning the setting removes
 * that ambiguity.
 */

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
/** The organisation the pre-tenancy deployment was migrated into; it keeps the legacy fallbacks. */
const DEFAULT_ORG_SLUG = 'default';
/** A write to a third party must not hold an HTTP request open; Cloudflare answers in ms. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** A subdomain may be several labels below its zone; this bounds the walk up the name. */
const MAX_ZONE_ATTEMPTS = 5;
/** Matches the TTL the record generator advertises in the copy-paste UI. */
const RECORD_TTL = 300;

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface ExistingDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  /** Preserved by the Loopia writer on replacement; Cloudflare patches content in place. */
  ttl?: number;
}

export type DnsProviderName = 'cloudflare' | 'loopia';

/** One named provider account, as the resolver hands it to the writer factory. */
export interface DnsAccountRef {
  id: string;
  label: string;
  provider: DnsProviderName;
}

/** An account a caller injected instead of having it read from the database (tests). */
export interface InjectedDnsAccount {
  id: string;
  label: string;
  provider: DnsProviderName;
  enabled?: boolean;
  /** Same shape as a stored row: `{ token }` for Cloudflare, `{ username, password }` for Loopia. */
  credentials: Record<string, unknown>;
}

/** What a provider writer needs to do for the generic plan/apply logic. */
export interface DnsWriter {
  provider: DnsProviderName;
  /** Human label for warnings and errors. */
  label: string;
  /** The named account the credentials came from; `null` for the legacy implicit account. */
  account: DnsAccountRef | null;
  findZone(domain: string): Promise<{ zone: CloudflareZone | null; warnings: string[] }>;
  list(zone: CloudflareZone, fqdn: string): Promise<ExistingDnsRecord[]>;
  create(zone: CloudflareZone, fqdn: string, type: string, value: string): Promise<{ id: string }>;
  /** Replace the identified record's value. Cloudflare patches; Loopia removes then adds. */
  replace(zone: CloudflareZone, target: ExistingDnsRecord, value: string): Promise<{ id: string }>;
}

export type DnsAction = 'create' | 'update' | 'unchanged' | 'unsupported';

export interface DnsPlanRecord {
  key: string;
  label: string;
  type: GeneratedRecordType;
  name: string;
  value: string;
  /** Every existing record content at that name+type; SPF and DMARC may have several. */
  current: string[];
  action: DnsAction;
  reason?: string;
}

export interface DnsPlan {
  provider: DnsProviderName;
  /** Which account answered; `null` when the legacy env/settings credentials were used. */
  account: DnsAccountRef | null;
  zone: CloudflareZone | null;
  records: DnsPlanRecord[];
  warnings: string[];
}

export interface DnsApplyRequest {
  keys: string[];
  overwrite?: boolean;
}

export interface DnsApplyResult {
  applied: Array<{ key: string; action: 'create' | 'update'; recordId: string }>;
  skipped: Array<{ key: string; reason: string; current: string[] }>;
}

export interface DmarcRuaResult {
  value: string;
  previous: string | null;
  recordId: string;
}

/** What the record generator needs to know about a domain, read from our own database. */
export interface DomainDnsContext {
  current: DomainCheckResult[];
  mxHosts: string[];
  mailboxAddress: string | null;
}

export interface CloudflareOptions {
  /** Tests pass one; otherwise the environment, then the setting, decides. */
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DnsPlanOptions extends CloudflareOptions {
  /** Pin a provider; otherwise the `dns.provider` setting (auto by default) decides. */
  provider?: DnsProviderName;
  /** Tests and callers can inject Loopia credentials/base URL; otherwise env then settings. */
  loopia?: LoopiaOptions;
  /** Skips the database read; tests inject an empty context so nothing is queried. */
  context?: DomainDnsContext;
  resolver?: DnsResolver;
  providers?: string[];
  dmarcPolicy?: DmarcPolicy;
  rua?: string;
  ruf?: string;
  mtaStsMode?: MtaStsMode;
  /** Inject accounts instead of reading them from the database (tests). */
  dnsAccounts?: InjectedDnsAccount[];
  /** Force one account instead of the domain's assignment (diagnostics, superadmin). */
  dnsAccountId?: string;
}

/**
 * A failure either from Cloudflare or from the apply rules. Routes read `statusCode`/`code`
 * off any thrown error, the same way the rest of the codebase does.
 */
export class CloudflareError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? 'CLOUDFLARE_ERROR';
  }
}

function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Cloudflare returns a long TXT value as several quoted chunks, and the same value with the
 * quotes stripped elsewhere. Comparing the raw strings would call an unchanged record an
 * update and then write it back, so both sides are normalised before any comparison.
 */
export function normalizeContent(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/"\s+"/g, '')
    .replace(/^"|"$/g, '')
    .trim();
}

/** FQDN check for a generated owner name; an unusable name must never be sent to the API. */
export function isFqdn(name: string): boolean {
  const normalized = name.trim().replace(/\.$/, '');
  if (normalized.length === 0 || normalized.length > 253) {
    return false;
  }
  const labels = normalized.split('.');
  if (labels.length < 2) {
    return false;
  }
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && /^[a-z0-9_-]+$/i.test(label) && !label.startsWith('-') && !label.endsWith('-'),
  );
}

/** The `v=...` tag of a record value: what makes an SPF record an SPF record. */
export function valueTag(value: string): string | null {
  const match = /^v=([a-z0-9.]+)/i.exec(normalizeContent(value));
  return match ? `v=${match[1]}`.toLowerCase() : null;
}

// ---------------------------------------------------------------- HTTP client

interface CloudflareClient {
  token: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

async function resolveToken(explicit?: string): Promise<string> {
  const fromEnvironment = (explicit ?? process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (fromEnvironment) {
    return fromEnvironment;
  }

  const stored = (await getSetting('dns.cloudflare.token')).trim();
  if (!stored) {
    throw fail(
      409,
      'CLOUDFLARE_NOT_CONFIGURED',
      'No Cloudflare API token is configured: set CLOUDFLARE_API_TOKEN or the DNS token in Settings, or publish the records by hand.',
    );
  }
  return stored;
}

async function cloudflareClientFrom(options: CloudflareOptions): Promise<CloudflareClient> {
  return {
    token: await resolveToken(options.token),
    baseUrl: (options.baseUrl ?? process.env.CLOUDFLARE_API_BASE ?? DEFAULT_BASE_URL).trim().replace(/\/$/, ''),
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function cloudflareMessage(body: CloudflareEnvelope<unknown> | null, status: number): string {
  const first = body?.errors?.find((error) => typeof error?.message === 'string' && error.message.trim().length > 0);
  if (first) {
    return first.message!.trim();
  }
  return `Cloudflare answered HTTP ${status} without an error message`;
}

/**
 * One API call. The abort signal is advisory - a stub, a proxy or a runtime with a stuck
 * socket can ignore it - so an explicit deadline is raced against the request as well.
 */
async function request<T>(
  client: CloudflareClient,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), client.timeoutMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(
      () =>
        reject(
          new CloudflareError(`Cloudflare did not answer within ${Math.round(client.timeoutMs / 1000)}s`, {
            statusCode: 504,
            code: 'CLOUDFLARE_TIMEOUT',
          }),
        ),
      client.timeoutMs,
    );
  });

  try {
    let response: Response;
    try {
      const pending = client.fetchImpl(`${client.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${client.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      // The loser of the race must not surface as an unhandled rejection.
      pending.catch(() => {});
      response = await Promise.race([pending, deadline]);
    } catch (error) {
      if (error instanceof CloudflareError) {
        throw error;
      }
      throw new CloudflareError(`Could not reach Cloudflare: ${describeError(error)}`, {
        statusCode: 502,
        code: 'CLOUDFLARE_UNREACHABLE',
      });
    }

    const text = await response.text();
    let body: CloudflareEnvelope<T> | null = null;
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text) as CloudflareEnvelope<T>;
      } catch {
        body = null;
      }
    }

    if (!response.ok || body?.success === false) {
      throw new CloudflareError(cloudflareMessage(body as CloudflareEnvelope<unknown> | null, response.status), {
        statusCode: 502,
        code: 'CLOUDFLARE_ERROR',
      });
    }
    if (body === null) {
      throw new CloudflareError(`Cloudflare answered HTTP ${response.status} with a body that is not JSON`, {
        statusCode: 502,
        code: 'CLOUDFLARE_ERROR',
      });
    }

    return body.result as T;
  } finally {
    clearTimeout(abortTimer);
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }
}

/**
 * The zone a record belongs to, walking up the name for a subdomain. A domain that is not a
 * zone of its own (mail.example.com) is published inside its parent zone, and Cloudflare's
 * zone list is the only authority on where the split is.
 */
async function findZone(
  client: CloudflareClient,
  domain: string,
): Promise<{ zone: CloudflareZone | null; warnings: string[] }> {
  const labels = domain.split('.');
  const warnings: string[] = [];

  for (let index = 0; index < Math.min(MAX_ZONE_ATTEMPTS, labels.length - 1); index++) {
    const candidate = labels.slice(index).join('.');
    if (candidate.split('.').length < 2) {
      break;
    }

    const zones = await request<Array<{ id?: unknown; name?: unknown }>>(
      client,
      `/zones?name=${encodeURIComponent(candidate)}&status=active`,
    );
    const found = (zones ?? []).find(
      (zone): zone is { id: string; name: string } =>
        typeof zone?.id === 'string' && typeof zone?.name === 'string',
    );

    if (found) {
      const zone = { id: found.id, name: normalizeDomain(found.name) };
      if (zone.name !== domain) {
        warnings.push(
          `${domain} is not a zone of its own; the records are published in the parent zone ${zone.name}.`,
        );
      }
      return { zone, warnings };
    }
  }

  return { zone: null, warnings };
}

async function listRecords(
  client: CloudflareClient,
  zoneId: string,
  fqdn: string,
): Promise<ExistingDnsRecord[]> {
  const result = await request<Array<Record<string, unknown>>>(
    client,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(fqdn)}&per_page=100`,
  );

  return (result ?? [])
    .filter(
      (record) =>
        typeof record?.id === 'string' &&
        typeof record?.content === 'string' &&
        typeof record?.type === 'string' &&
        typeof record?.name === 'string' &&
        normalizeDomain(record.name) === normalizeDomain(fqdn),
    )
    .map((record) => ({
      id: record.id as string,
      name: record.name as string,
      type: (record.type as string).toUpperCase(),
      content: record.content as string,
    }));
}

/**
 * The one existing record an update may replace: same name and type, and for a tagged value
 * (SPF, DMARC, TLS-RPT) the record carrying that tag. Anything else at the same name is left
 * alone - replacing "the first TXT record" would overwrite a verification record.
 */
function pickMatchedRecord(
  records: ExistingDnsRecord[],
  type: GeneratedRecordType,
  value: string,
): ExistingDnsRecord | null {
  const candidates = records.filter((record) => record.type === type.toUpperCase());
  if (candidates.length === 0) {
    return null;
  }

  const tag = valueTag(value);
  if (tag) {
    // A tagged value (SPF, DMARC, TLS-RPT) may only replace a record carrying the same tag.
    // Falling back to "the first TXT at this name" would overwrite a site-verification record
    // and leave the real SPF record in place - the worst of both outcomes.
    return candidates.find((record) => normalizeContent(record.content).toLowerCase().startsWith(tag)) ?? null;
  }

  return candidates[0];
}

// ---------------------------------------------------------------- writers

/**
 * The Cloudflare writer. With a `token` the credentials come from the account row and the
 * settings table is never consulted; without one the legacy lookup order applies unchanged.
 */
function cloudflareWriter(
  options: CloudflareOptions,
  account: DnsAccountRef | null = null,
  token?: string,
): DnsWriter {
  const clientOptions: CloudflareOptions = token === undefined ? options : { ...options, token };
  return {
    provider: 'cloudflare',
    label: account === null ? 'Cloudflare' : `Cloudflare (${account.label})`,
    account,
    async findZone(domain) {
      return findZone(await cloudflareClientFrom(clientOptions), domain);
    },
    async list(zone, fqdn) {
      return listRecords(await cloudflareClientFrom(clientOptions), zone.id, fqdn);
    },
    async create(zone, fqdn, type, value) {
      const client = await cloudflareClientFrom(clientOptions);
      const created = await request<{ id?: unknown }>(client, `/zones/${zone.id}/dns_records`, {
        method: 'POST',
        body: { type, name: fqdn, content: value, ttl: RECORD_TTL },
      });
      return { id: String(created?.id ?? '') };
    },
    async replace(zone, target, value) {
      const client = await cloudflareClientFrom(clientOptions);
      const updated = await request<{ id?: unknown }>(client, `/zones/${zone.id}/dns_records/${target.id}`, {
        method: 'PATCH',
        body: { content: value },
      });
      return { id: String(updated?.id ?? target.id) };
    },
  };
}

/** `@` for the apex, otherwise the labels between the record name and the zone. */
function loopiaSubdomain(zone: string, fqdn: string): string {
  const normalized = normalizeDomain(fqdn);
  if (normalized === zone) {
    return '@';
  }
  if (!normalized.endsWith(`.${zone}`)) {
    throw fail(400, 'VALIDATION_ERROR', `${fqdn} is not inside the ${zone} zone`);
  }
  return normalized.slice(0, -(zone.length + 1));
}

async function loopiaCredentials(
  options: DnsPlanOptions,
): Promise<{ user: string; password: string } | null> {
  const user = (
    options.loopia?.user ??
    process.env.LOOPIA_API_USER ??
    (await getSetting('dns.loopia.username'))
  ).trim();
  const password =
    options.loopia?.password ??
    process.env.LOOPIA_API_PASS ??
    (await getSetting('dns.loopia.password'));
  return user.length > 0 && password.length > 0 ? { user, password } : null;
}

async function loopiaWriter(
  options: DnsPlanOptions,
  credentials: { user: string; password: string },
  account: DnsAccountRef | null = null,
): Promise<DnsWriter> {
  const client = new LoopiaClient({
    ...credentials,
    ...(options.loopia?.baseUrl === undefined ? {} : { baseUrl: options.loopia.baseUrl }),
    ...(options.loopia?.fetchImpl === undefined ? {} : { fetchImpl: options.loopia.fetchImpl }),
    ...(options.loopia?.timeoutMs === undefined ? {} : { timeoutMs: options.loopia.timeoutMs }),
    ...(options.loopia?.retryDelaysMs === undefined
      ? {}
      : { retryDelaysMs: options.loopia.retryDelaysMs }),
  });

  // One cache per writer: a plan lists several names, and each add would otherwise re-read
  // the subdomain list. Loopia rate-limits, so that matters.
  const subdomains = new Map<string, Set<string>>();
  const ensureSubdomain = async (zone: string, sub: string): Promise<void> => {
    if (sub === '@') {
      return;
    }
    let known = subdomains.get(zone);
    if (!known) {
      known = new Set(await client.getSubdomains(zone));
      subdomains.set(zone, known);
    }
    if (!known.has(sub)) {
      await client.addSubdomain(zone, sub);
      known.add(sub);
    }
  };

  return {
    provider: 'loopia',
    label: account === null ? 'Loopia' : `Loopia (${account.label})`,
    account,
    async findZone(domain) {
      const domains = await client.getDomains();
      const match = domains
        .filter((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
        .sort((a, b) => b.length - a.length)[0];
      if (!match) {
        return {
          zone: null,
          warnings: [
            `${domain} is not in the Loopia account this instance is configured with. Register it there, or check the API user.`,
          ],
        };
      }
      const warnings: string[] = [];
      if (match !== domain) {
        warnings.push(
          `${domain} is not a zone of its own; the records are published in the parent zone ${match}.`,
        );
      }
      return { zone: { id: match, name: match }, warnings };
    },
    async list(zone, fqdn) {
      const rows = await client.getZoneRecords(zone.name, loopiaSubdomain(zone.name, fqdn));
      return rows.map((record) => ({
        id: String(record.record_id),
        name: fqdn,
        type: record.type.toUpperCase(),
        content: record.rdata,
        ttl: record.ttl,
      }));
    },
    async create(zone, fqdn, type, value) {
      const sub = loopiaSubdomain(zone.name, fqdn);
      await ensureSubdomain(zone.name, sub);
      const id = await client.addZoneRecord(zone.name, sub, {
        type: type.toUpperCase(),
        ttl: RECORD_TTL,
        priority: 0,
        rdata: value,
      });
      return { id };
    },
    async replace(zone, target, value) {
      const sub = loopiaSubdomain(zone.name, target.name);
      await ensureSubdomain(zone.name, sub);
      // Loopia has no update call. Removing the one identified record and adding its
      // replacement is the only path; nothing else at that name is touched.
      await client.removeZoneRecord(zone.name, sub, Number(target.id));
      const id = await client.addZoneRecord(zone.name, sub, {
        type: target.type.toUpperCase(),
        ttl: target.ttl ?? RECORD_TTL,
        priority: 0,
        rdata: value,
      });
      return { id };
    },
  };
}

/** A stored or injected account, with its credentials already parsed. */
interface ResolvedAccount extends DnsAccountRef {
  credentials: DnsAccountCredentials;
}

function accountRef(account: { id: string; label: string; provider: string }): DnsAccountRef {
  return { id: account.id, label: account.label, provider: account.provider as DnsProviderName };
}

/**
 * Cloudflare first (the legacy preference order), then by label, so auto-selection is stable
 * regardless of the order the rows happen to come back in.
 */
function sortAccounts<T extends { provider: string; label: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.provider !== b.provider) {
      if (a.provider === 'cloudflare') return -1;
      if (b.provider === 'cloudflare') return 1;
      return a.provider.localeCompare(b.provider);
    }
    return a.label.localeCompare(b.label);
  });
}

function resolvedFromRow(row: {
  id: string;
  label: string;
  provider: string;
  credentials: string;
}): ResolvedAccount {
  if (row.provider !== 'cloudflare' && row.provider !== 'loopia') {
    throw fail(500, 'DNS_ACCOUNT_CORRUPT', `DNS account "${row.label}" has an unknown provider`);
  }
  return { ...accountRef(row), credentials: parseCredentials(row.provider, row.credentials) };
}

/**
 * Which accounts may answer for a domain.
 *
 * `null` means "the legacy implicit account": the environment, then the settings table. That is
 * the path for an untracked domain name, for a caller that injected a test context, and for the
 * Default organisation until it owns an account of its own - which is what keeps a deployment
 * that predates tenancy working without copying its credentials into the database.
 *
 * An account that is assigned to the domain but disabled or gone is an error, never a silent
 * fallthrough to another account: writing records through credentials the operator did not
 * choose is exactly the mistake this resolution exists to prevent.
 */
async function resolveAccounts(
  domain: string,
  options: DnsPlanOptions,
): Promise<ResolvedAccount[] | null> {
  if (options.dnsAccounts !== undefined) {
    const injected = sortAccounts(
      options.dnsAccounts
        .filter((account) => options.dnsAccountId === undefined || account.id === options.dnsAccountId)
        .filter((account) => account.enabled !== false)
        .map((account) => ({
          ...accountRef(account),
          credentials: readCredentials(account.provider, account.credentials),
        })),
    );
    if (injected.length === 0) {
      throw fail(
        409,
        'ZONE_NOT_FOUND',
        options.dnsAccountId === undefined
          ? `No enabled DNS account was provided for ${domain}`
          : `No enabled DNS account with id ${options.dnsAccountId} was provided`,
      );
    }
    return injected;
  }

  // An injected context is the offline path (tests): nothing is read from the database, so the
  // legacy credentials remain the only source, exactly as before accounts existed.
  if (options.context !== undefined) {
    return null;
  }

  if (options.dnsAccountId !== undefined) {
    const [forced, domainRow] = await Promise.all([
      prisma.dnsAccount.findUnique({ where: { id: options.dnsAccountId } }),
      prisma.domain.findUnique({ where: { name: domain }, select: { orgId: true } }),
    ]);
    if (!forced || (domainRow?.orgId && forced.orgId !== domainRow.orgId)) {
      throw fail(
        409,
        'ZONE_NOT_FOUND',
        `No DNS account with id ${options.dnsAccountId} belongs to the organisation that owns ${domain}`,
      );
    }
    if (!forced.enabled) {
      throw fail(409, 'DNS_ACCOUNT_DISABLED', `The DNS account "${forced.label}" is disabled`);
    }
    return [resolvedFromRow(forced)];
  }

  const row = await prisma.domain.findUnique({
    where: { name: domain },
    select: { orgId: true, dnsAccountId: true },
  });
  // Untracked name, or a domain no organisation owns yet.
  if (!row?.orgId) {
    return null;
  }

  if (row.dnsAccountId) {
    const assigned = await prisma.dnsAccount.findFirst({
      where: { id: row.dnsAccountId, orgId: row.orgId },
    });
    if (!assigned) {
      throw fail(
        409,
        'ZONE_NOT_FOUND',
        `The DNS account assigned to ${domain} no longer exists. Assign another account, or clear the assignment to use any enabled account.`,
      );
    }
    if (!assigned.enabled) {
      throw fail(
        409,
        'DNS_ACCOUNT_DISABLED',
        `The DNS account "${assigned.label}" assigned to ${domain} is disabled. Enable it or assign another account.`,
      );
    }
    return [resolvedFromRow(assigned)];
  }

  const enabled = await prisma.dnsAccount.findMany({ where: { orgId: row.orgId, enabled: true } });
  if (enabled.length > 0) {
    return sortAccounts(enabled).map(resolvedFromRow);
  }

  const organization = await prisma.organization.findUnique({
    where: { id: row.orgId },
    select: { slug: true },
  });
  if (organization?.slug === DEFAULT_ORG_SLUG) {
    return null;
  }
  throw fail(
    409,
    'DNS_NOT_CONFIGURED',
    `The organisation that owns ${domain} has no enabled DNS account: add one under Organisation → DNS accounts, assign one to the domain, or publish the records by hand.`,
  );
}

/**
 * The writers that could answer, in preference order. `dns.provider` pins one; `auto` includes
 * only accounts (or legacy credentials) that exist, so an instance configured for one provider
 * never makes a pointless call to the other.
 */
async function resolveWriters(domain: string, options: DnsPlanOptions): Promise<DnsWriter[]> {
  const requested = (options.provider ?? (await getSetting('dns.provider'))).trim().toLowerCase();
  if (requested !== 'auto' && requested !== 'cloudflare' && requested !== 'loopia') {
    throw fail(500, 'DNS_NOT_CONFIGURED', `Unknown dns.provider setting: ${requested}`);
  }

  const accounts = await resolveAccounts(domain, options);

  if (accounts !== null) {
    const writers: DnsWriter[] = [];
    for (const account of accounts) {
      if (requested !== 'auto' && account.provider !== requested) {
        continue;
      }
      if (account.provider === 'cloudflare') {
        writers.push(
          cloudflareWriter(
            options,
            accountRef(account),
            (account.credentials as CloudflareCredentials).token,
          ),
        );
        continue;
      }
      const loopia = account.credentials as LoopiaCredentials;
      writers.push(
        await loopiaWriter(options, { user: loopia.username, password: loopia.password }, accountRef(account)),
      );
    }

    if (writers.length === 0) {
      const code =
        requested === 'cloudflare'
          ? 'CLOUDFLARE_NOT_CONFIGURED'
          : requested === 'loopia'
            ? 'LOOPIA_NOT_CONFIGURED'
            : 'DNS_NOT_CONFIGURED';
      throw fail(
        409,
        code,
        requested === 'auto'
          ? `No enabled DNS account is available for ${domain}: add one under Organisation → DNS accounts, or publish the records by hand.`
          : `No enabled ${requested} DNS account is available for ${domain}, and this instance is pinned to ${requested}: add one under Organisation → DNS accounts, or publish the records by hand.`,
      );
    }

    return writers;
  }

  // ---------------------------------------------------------------- legacy credentials
  const writers: DnsWriter[] = [];

  if (requested === 'auto' || requested === 'cloudflare') {
    const token = (
      options.token ??
      process.env.CLOUDFLARE_API_TOKEN ??
      (await getSetting('dns.cloudflare.token'))
    ).trim();
    if (token.length > 0) {
      writers.push(cloudflareWriter(options));
    }
  }

  if (requested === 'auto' || requested === 'loopia') {
    const credentials = await loopiaCredentials(options);
    if (credentials) {
      writers.push(await loopiaWriter(options, credentials));
    }
  }

  if (writers.length === 0) {
    if (requested === 'cloudflare') {
      throw fail(
        409,
        'CLOUDFLARE_NOT_CONFIGURED',
        'This instance is pinned to Cloudflare but no API token is configured: set CLOUDFLARE_API_TOKEN or the DNS token in Settings, or publish the records by hand.',
      );
    }
    if (requested === 'loopia') {
      throw fail(
        409,
        'LOOPIA_NOT_CONFIGURED',
        'This instance is pinned to Loopia but no API credentials are configured: set LOOPIA_API_USER/LOOPIA_API_PASS or the Loopia settings, or publish the records by hand.',
      );
    }
    throw fail(
      409,
      'DNS_NOT_CONFIGURED',
      'No DNS provider is configured: set a Cloudflare API token or Loopia API credentials under Settings → dns, or publish the records by hand.',
    );
  }

  return writers;
}

/**
 * The first configured provider that actually holds the domain. Ties keep the preference
 * order from `resolveWriters`, which is Cloudflare first; `dns.provider` removes the guess.
 */
async function pickWriter(
  writers: DnsWriter[],
  domain: string,
): Promise<{ writer: DnsWriter; zone: CloudflareZone | null; warnings: string[] }> {
  const warnings: string[] = [];
  for (const writer of writers) {
    const result = await writer.findZone(domain);
    warnings.push(...result.warnings);
    if (result.zone) {
      return { writer, zone: result.zone, warnings };
    }
  }
  return { writer: writers[0], zone: null, warnings };
}

// ---------------------------------------------------------------- plan

function fqdnFor(host: string, domain: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed === '@') {
    return domain;
  }
  if (trimmed === domain || trimmed.endsWith(`.${domain}`)) {
    return trimmed;
  }
  return `${trimmed}.${domain}`;
}

function publishedSpfRecords(records: ExistingDnsRecord[]): string[] {
  return records
    .filter((record) => record.type === 'TXT')
    .map((record) => normalizeContent(record.content))
    .filter((content) => /^v=spf1(?:\s|$)/i.test(content));
}

/** The trailing `all` mechanism, which is what decides what happens to unlisted senders. */
function allQualifier(value: string): string | null {
  const match = /(?:^|\s)([~?+-]all)(?:\s|$)/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The provider selection the plan uses when the caller did not ask for one: exactly what the
 * published SPF record already includes. An apply is a click away, and regenerating SPF from an
 * empty selection would produce `v=spf1 -all` - which would stop all mail as soon as someone
 * overwrote the live record with it.
 */
function deriveSpfSelection(records: ExistingDnsRecord[]): { providers: string[]; unmatched: string[] } {
  const published = publishedSpfRecords(records);
  if (published.length !== 1) {
    // Nothing published, or several records: there is no single truth to preserve.
    return { providers: [], unmatched: [] };
  }

  const providers: string[] = [];
  const unmatched: string[] = [];
  for (const match of published[0].matchAll(/\binclude:([^\s]+)/gi)) {
    const include = match[1].toLowerCase().replace(/\.$/, '');
    const known = SPF_PROVIDERS.find((provider) => provider.include.toLowerCase() === include);
    if (known) {
      if (!providers.includes(known.id)) {
        providers.push(known.id);
      }
    } else if (!unmatched.includes(include)) {
      unmatched.push(include);
    }
  }

  return { providers, unmatched };
}

function unsupportedReason(
  record: GeneratedRecord,
  name: string | null,
  zone: CloudflareZone | null,
  unmatchedSpfIncludes: string[],
): string | null {
  if (name === null || !isFqdn(name)) {
    return 'The generated name is not a fully qualified domain name, so it cannot be published as-is.';
  }
  if (record.value.trim().length === 0) {
    return 'No value was generated for this record; it needs input before it can be published.';
  }
  if (record.type === 'DS' || record.id === 'dnssec') {
    return 'A DS record lives at the registrar, not in the zone; publish it there.';
  }
  if (record.companionFile) {
    return 'MTA-STS needs its policy file served over HTTPS as well as this TXT record; publish both by hand.';
  }
  if (record.id === 'caa') {
    // The generator types its CAA suggestion 'TXT' (a known wart in recordSuggestions.ts).
    // Publishing "0 issue ..." as a TXT record would not constrain any CA and would drop junk
    // in the zone, so it stays a copy-paste suggestion.
    return 'The CAA suggestion is not shaped as a TXT record; publish it as a CAA record at the provider instead.';
  }
  if (record.id === 'autodiscover') {
    // Its value is the MX host name, not an address: as an A record Cloudflare would refuse it,
    // and the real record is a CNAME to that host.
    return 'The autodiscovery suggestion carries a host name; publish it as a CNAME to that host by hand.';
  }
  if (zone === null) {
    return 'No zone for this domain was found at the configured DNS provider, so nothing can be applied here.';
  }
  if (record.id === 'spf' && unmatchedSpfIncludes.length > 0) {
    return `The published SPF record includes hosts this app cannot reproduce (${unmatchedSpfIncludes.join(', ')}); edit that record by hand instead.`;
  }
  return null;
}

/** The latest stored check plus the mailbox address, which is what the generator wants. */
export async function loadDomainContext(domain: string): Promise<DomainDnsContext> {
  const stored = await prisma.domain.findUnique({ where: { name: domain } });
  let current: DomainCheckResult[] = [];

  if (stored) {
    const check = await prisma.domainCheck.findFirst({
      where: { domainId: stored.id },
      orderBy: { runAt: 'desc' },
    });
    if (check) {
      try {
        const parsed = JSON.parse(check.resultsJson);
        if (Array.isArray(parsed)) {
          current = parsed as DomainCheckResult[];
        }
      } catch {
        // A corrupted stored report is treated as "nothing known", never as a failure.
      }
    }
  }

  const mxHosts = (current.find((result) => result.id === 'mx')?.details ?? [])
    .map((detail) => /^priority \d+: (.+)$/.exec(detail.trim())?.[1])
    .filter((host): host is string => Boolean(host));

  const mailboxAddress = await mailboxAddressFor(stored?.orgId ?? null);

  return { current, mxHosts, mailboxAddress };
}

/**
 * The address reports should be sent to on behalf of one organisation.
 *
 * A mailbox row the organisation owns wins over the deployment's legacy settings, and the
 * legacy mailbox is only ever used for the Default organisation (or for a name nobody owns
 * yet): routing another tenant's reports to an address it does not control would hand it data
 * it never asked for - and `addDmarcRua` would publish it.
 */
async function mailboxAddressFor(orgId: string | null): Promise<string | null> {
  if (orgId) {
    const mailbox = await prisma.orgMailbox.findFirst({
      where: { orgId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { user: true },
    });
    const user = mailbox?.user?.trim() ?? '';
    if (user) {
      return user;
    }
    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });
    if (organization?.slug !== DEFAULT_ORG_SLUG) {
      return null;
    }
  }

  const legacy = await resolveMailboxConfig();
  return legacy.config?.user ?? null;
}

/** The DMARC `rua` address for a domain: its organisation's mailbox, else the legacy one. */
export async function resolveDmarcMailboxAddress(domain: string): Promise<string | null> {
  const normalized = normalizeDomain(domain);
  const row = await prisma.domain.findUnique({
    where: { name: normalized },
    select: { orgId: true },
  });
  return mailboxAddressFor(row?.orgId ?? null);
}

export async function buildDnsPlan(domain: string, options: DnsPlanOptions = {}): Promise<DnsPlan> {
  const normalized = normalizeDomain(domain);
  if (!isFqdn(normalized)) {
    throw fail(400, 'VALIDATION_ERROR', `"${domain}" does not look like a domain name`);
  }

  const writers = await resolveWriters(normalized, options);
  const context = options.context ?? (await loadDomainContext(normalized));
  const { writer, zone, warnings } = await pickWriter(writers, normalized);

  const recordsAt = new Map<string, ExistingDnsRecord[]>();
  const existingAt = async (fqdn: string): Promise<ExistingDnsRecord[]> => {
    if (!zone) {
      return [];
    }
    const cached = recordsAt.get(fqdn);
    if (cached) {
      return cached;
    }
    const listed = await writer.list(zone, fqdn);
    recordsAt.set(fqdn, listed);
    return listed;
  };

  // The zone's own TXT set is read before generating, so the SPF selection can mirror it.
  const apexRecords = await existingAt(normalized);
  const spfSelection = options.providers === undefined ? deriveSpfSelection(apexRecords) : null;
  const publishedSpf = publishedSpfRecords(apexRecords);

  if (publishedSpf.length > 1) {
    warnings.push(
      `${publishedSpf.length} SPF records are published at ${normalized}. Receivers treat that as a permanent error, so the duplicates must be merged by hand - this app will not guess which one to replace.`,
    );
  }
  if (spfSelection && spfSelection.unmatched.length > 0) {
    warnings.push(
      `The published SPF record includes ${spfSelection.unmatched.join(', ')}, which is not in this app's provider list; the generated SPF cannot reproduce it, so that record is not applied here.`,
    );
  }
  if (zone === null) {
    warnings.push(
      `No active ${writer.label} zone was found for ${normalized}. Add the domain there, or check that the API credentials can see it; the records below can still be copied by hand.`,
    );
  }

  const generated = await generateRecords({
    domain: normalized,
    current: context.current,
    mxHosts: context.mxHosts,
    mailboxAddress: context.mailboxAddress,
    providers: options.providers ?? spfSelection?.providers ?? [],
    ...(options.dmarcPolicy === undefined ? {} : { dmarcPolicy: options.dmarcPolicy }),
    ...(options.rua === undefined ? {} : { rua: options.rua }),
    ...(options.ruf === undefined ? {} : { ruf: options.ruf }),
    ...(options.mtaStsMode === undefined ? {} : { mtaStsMode: options.mtaStsMode }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    // DNSSEC reads keys over DNS-over-HTTPS; reuse the injected fetch so tests stay offline.
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  });

  const usedKeys = new Map<string, number>();
  const records: DnsPlanRecord[] = [];

  for (const record of generated.records) {
    const name = fqdnFor(record.host, normalized);
    // Autodiscovery and DNSSEC can yield several rows with one id; the key must stay unique
    // because it is what an apply request names.
    const seen = usedKeys.get(record.id) ?? 0;
    usedKeys.set(record.id, seen + 1);
    const key = seen === 0 ? record.id : `${record.id}:${name ?? seen}`;

    const reason = unsupportedReason(record, name, zone, spfSelection?.unmatched ?? []);
    if (reason !== null) {
      records.push({
        key,
        label: record.label,
        type: record.type,
        name: name ?? (record.host ? `${record.host}.${normalized}` : normalized),
        value: record.value,
        current: [],
        action: 'unsupported',
        reason,
      });
      continue;
    }

    const fqdn = name as string;
    const existing = await existingAt(fqdn);
    const current = existing.filter((row) => row.type === record.type.toUpperCase()).map((row) => row.content);
    const wanted = normalizeContent(record.value);

    let action: DnsAction;
    let decisionReason: string | undefined;
    if (current.length === 0) {
      action = 'create';
    } else if (current.some((content) => normalizeContent(content) === wanted)) {
      action = 'unchanged';
    } else {
      action = 'update';
      if (record.id === 'spf' && publishedSpf.length === 1) {
        // The generator always ends SPF in -all; the published record may soft-fail. Saying so
        // is what lets an operator decide, because that difference changes how mail is refused.
        const publishedQualifier = allQualifier(publishedSpf[0]);
        const generatedQualifier = allQualifier(wanted);
        if (publishedQualifier && generatedQualifier && publishedQualifier !== generatedQualifier) {
          decisionReason = `The published record ends in ${publishedQualifier}, the generated one in ${generatedQualifier}.`;
        }
      }
    }

    if (action === 'update' && current.length > 1) {
      warnings.push(
        `${current.length} ${record.type} records exist at ${fqdn}; an overwrite replaces only the one carrying the ${valueTag(record.value) ?? 'same'} value and leaves the others untouched.`,
      );
    }

    records.push({
      key,
      label: record.label,
      type: record.type,
      name: fqdn,
      value: record.value,
      current,
      action,
      ...(decisionReason === undefined ? {} : { reason: decisionReason }),
    });
  }

  // The same warning can be produced for more than one record at one name (SPF and a second
  // TXT at the apex); one line each is what an operator can act on.
  return {
    provider: writer.provider,
    account: writer.account,
    zone,
    records,
    warnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------- apply

export async function applyDnsPlan(
  domain: string,
  applyRequest: DnsApplyRequest,
  options: DnsPlanOptions = {},
): Promise<DnsApplyResult> {
  const keys = [...new Set((applyRequest.keys ?? []).map((key) => String(key).trim()).filter(Boolean))];
  if (keys.length === 0) {
    throw fail(400, 'VALIDATION_ERROR', 'keys must name at least one planned record');
  }

  // Recompute: the browser's copy of the plan is a view, never an authority.
  const plan = await buildDnsPlan(domain, options);
  const byKey = new Map(plan.records.map((record) => [record.key, record]));

  const unknown = keys.filter((key) => !byKey.has(key));
  if (unknown.length > 0) {
    throw fail(400, 'VALIDATION_ERROR', `Unknown record key(s): ${unknown.join(', ')}`);
  }
  if (plan.zone === null) {
    throw fail(409, 'ZONE_NOT_FOUND', `No active ${plan.provider} zone was found for ${normalizeDomain(domain)}`);
  }

  // The plan names the provider *and* the account it was built against; reuse that writer
  // rather than re-picking, so a domain that exists in two accounts cannot switch account
  // between plan and apply.
  const writers = await resolveWriters(normalizeDomain(domain), options);
  const writer = plan.account
    ? writers.find((candidate) => candidate.account?.id === plan.account?.id)
    : writers.find((candidate) => candidate.account === null && candidate.provider === plan.provider);
  if (!writer) {
    throw fail(
      409,
      'DNS_NOT_CONFIGURED',
      `The ${plan.provider} credentials used for the plan are no longer configured`,
    );
  }

  const overwrite = applyRequest.overwrite === true;
  const applied: DnsApplyResult['applied'] = [];
  const skipped: DnsApplyResult['skipped'] = [];

  for (const key of keys) {
    const record = byKey.get(key)!;

    if (record.action === 'unsupported') {
      skipped.push({ key, reason: 'unsupported', current: record.current });
      continue;
    }
    if (record.action === 'unchanged') {
      skipped.push({ key, reason: 'unchanged', current: record.current });
      continue;
    }
    if (record.action === 'update' && !overwrite) {
      skipped.push({ key, reason: 'exists', current: record.current });
      continue;
    }

    if (record.action === 'create') {
      const created = await writer.create(plan.zone, record.name, record.type, record.value);
      applied.push({ key, action: 'create', recordId: created.id });
      continue;
    }

    // Fresh read: the plan may be minutes old, and an update must target a record id that
    // still exists.
    const fresh = await writer.list(plan.zone, record.name);
    const target = pickMatchedRecord(fresh, record.type, record.value);
    if (!target) {
      skipped.push({ key, reason: 'missing', current: [] });
      continue;
    }

    const updated = await writer.replace(plan.zone, target, record.value);
    applied.push({ key, action: 'update', recordId: updated.id || target.id });
  }

  return { applied, skipped };
}

// ---------------------------------------------------------------- DMARC rua

function toMailto(address: string): string {
  const trimmed = address.trim();
  return /^mailto:/i.test(trimmed) ? trimmed : `mailto:${trimmed}`;
}

function addressOf(uri: string): string {
  return uri.trim().replace(/^mailto:/i, '').toLowerCase();
}

/**
 * Appends one rua= target to a DMARC record, keeping every other tag and every existing
 * target. A rua list is comma-separated; replacing it would silently stop reports to the
 * address that is already collecting them.
 */
export function mergeDmarcRua(existing: string | null, uri: string): string {
  const target = toMailto(uri);
  const current = existing === null ? null : normalizeContent(existing);

  if (!current || !/^v=dmarc1(?:\s*;|$)/i.test(current)) {
    // A minimal record is the safe default: p=none asks for reports without rejecting mail.
    return `v=DMARC1; p=none; rua=${target}`;
  }

  const parts = current
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const index = parts.findIndex((part) => /^rua\s*=/i.test(part));
  if (index === -1) {
    parts.push(`rua=${target}`);
  } else {
    const value = parts[index].slice(parts[index].indexOf('=') + 1);
    const targets = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (!targets.some((entry) => addressOf(entry) === addressOf(target))) {
      targets.push(target);
    }
    parts[index] = `rua=${targets.join(', ')}`;
  }

  return parts.join('; ');
}

export async function addDmarcRua(
  domain: string,
  mailboxAddress: string,
  options: DnsPlanOptions = {},
): Promise<DmarcRuaResult> {
  const address = mailboxAddress.trim();
  if (address.length === 0) {
    throw fail(
      409,
      'MAILBOX_NOT_CONFIGURED',
      'No mailbox address is configured, so there is no rua target to add: set the mailbox user in Settings first.',
    );
  }

  const normalized = normalizeDomain(domain);
  if (!isFqdn(normalized)) {
    throw fail(400, 'VALIDATION_ERROR', `"${domain}" does not look like a domain name`);
  }

  const writers = await resolveWriters(normalized, options);
  const { writer, zone } = await pickWriter(writers, normalized);
  if (!zone) {
    throw fail(409, 'ZONE_NOT_FOUND', `No active ${writer.label} zone was found for ${normalized}`);
  }

  const fqdn = `_dmarc.${normalized}`;
  const existing = await writer.list(zone, fqdn);
  // RFC 7489: the first record wins, so only a record that starts with v=DMARC1 is merged.
  const dmarc = existing.find((record) => record.type === 'TXT' && /^v=dmarc1(?:\s*;|$)/i.test(normalizeContent(record.content)));
  const previous = dmarc ? normalizeContent(dmarc.content) : null;
  const value = mergeDmarcRua(dmarc ? dmarc.content : null, address);

  // A record that already carries this rua= needs no write; saving it again would only churn
  // the zone's change history.
  if (dmarc && previous === value) {
    return { value, previous, recordId: dmarc.id };
  }

  if (dmarc) {
    const replaced = await writer.replace(zone, dmarc, value);
    return { value, previous, recordId: replaced.id || dmarc.id };
  }

  const created = await writer.create(zone, fqdn, 'TXT', value);
  return { value, previous: null, recordId: created.id };
}
