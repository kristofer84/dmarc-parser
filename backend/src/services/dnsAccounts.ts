import { prisma } from '../db/prisma.js';
import { LoopiaClient, LoopiaError } from './loopia.js';

/**
 * Named DNS-provider accounts, assignable per domain.
 *
 * Credentials are stored as JSON text in the database - the same store and the same caveat as
 * the mailbox password and OIDC client secrets. They are **write-only over the API**: responses
 * carry `credentialSet`, never the secret. Nothing in this module logs a credential, and the
 * provider error text is the only thing surfaced when a verification fails.
 *
 * The two providers need different fields. Keeping one table with a JSON column avoids a pair
 * of nullable columns that would only ever be half-filled.
 */

export const DNS_ACCOUNT_PROVIDERS = ['cloudflare', 'loopia'] as const;
export type DnsAccountProvider = (typeof DNS_ACCOUNT_PROVIDERS)[number];

export interface CloudflareCredentials {
  token: string;
}

export interface LoopiaCredentials {
  username: string;
  password: string;
}

export type DnsAccountCredentials = CloudflareCredentials | LoopiaCredentials;

export interface DnsAccountRow {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  credentials: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedDnsAccount {
  id: string;
  label: string;
  provider: DnsAccountProvider;
  enabled: boolean;
  /** Never the secret itself. */
  credentialSet: boolean;
  domainCount?: number;
  createdAt: string;
  updatedAt: string;
}

export class DnsAccountError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'DnsAccountError';
    this.statusCode = options.statusCode ?? 400;
    this.code = options.code ?? 'VALIDATION_ERROR';
  }
}

export function isDnsAccountProvider(value: unknown): value is DnsAccountProvider {
  return typeof value === 'string' && (DNS_ACCOUNT_PROVIDERS as readonly string[]).includes(value);
}

export function parseCredentials(provider: string, raw: string): DnsAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DnsAccountError('Stored DNS credentials are not valid JSON', {
      statusCode: 500,
      code: 'DNS_ACCOUNT_CORRUPT',
    });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DnsAccountError('Stored DNS credentials have an unexpected shape', {
      statusCode: 500,
      code: 'DNS_ACCOUNT_CORRUPT',
    });
  }
  const record = parsed as Record<string, unknown>;
  if (provider === 'cloudflare' && typeof record.token === 'string' && record.token.trim()) {
    return { token: record.token.trim() };
  }
  if (
    provider === 'loopia' &&
    typeof record.username === 'string' &&
    record.username.trim() &&
    typeof record.password === 'string' &&
    record.password.length > 0
  ) {
    return { username: record.username.trim(), password: record.password };
  }
  throw new DnsAccountError('Stored DNS credentials are incomplete', {
    statusCode: 500,
    code: 'DNS_ACCOUNT_CORRUPT',
  });
}

/**
 * Validate the writable credential fields for a provider. A blank value is *not* accepted here;
 * the update path keeps the stored value by omitting the field entirely.
 */
export function readCredentials(
  provider: DnsAccountProvider,
  input: unknown,
): DnsAccountCredentials {
  const record = (input ?? {}) as Record<string, unknown>;

  if (provider === 'cloudflare') {
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    if (!token) {
      throw new DnsAccountError('A Cloudflare API token is required');
    }
    return { token };
  }

  const username = typeof record.username === 'string' ? record.username.trim() : '';
  const password = typeof record.password === 'string' ? record.password : '';
  if (!username) {
    throw new DnsAccountError('A Loopia API user is required');
  }
  if (!password) {
    throw new DnsAccountError('A Loopia API password is required');
  }
  return { username, password };
}

function credentialSet(provider: string, raw: string): boolean {
  try {
    parseCredentials(provider, raw);
    return true;
  } catch {
    return false;
  }
}

export function serializeDnsAccount(
  row: Pick<DnsAccountRow, 'id' | 'label' | 'provider' | 'enabled' | 'credentials' | 'createdAt' | 'updatedAt'>,
  domainCount?: number,
): SerializedDnsAccount {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider as DnsAccountProvider,
    enabled: row.enabled,
    credentialSet: credentialSet(row.provider, row.credentials),
    ...(domainCount === undefined ? {} : { domainCount }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listDnsAccounts(orgId: string): Promise<SerializedDnsAccount[]> {
  const rows = await prisma.dnsAccount.findMany({
    where: { orgId },
    orderBy: [{ provider: 'asc' }, { label: 'asc' }],
    include: { _count: { select: { domains: true } } },
  });
  return rows.map((row) => serializeDnsAccount(row, row._count.domains));
}

export async function getDnsAccount(orgId: string, id: string): Promise<DnsAccountRow | null> {
  return prisma.dnsAccount.findFirst({ where: { id, orgId } });
}

/** Enabled accounts only: what an unassigned domain in this org may auto-select from. */
export async function listEnabledDnsAccounts(orgId: string): Promise<DnsAccountRow[]> {
  return prisma.dnsAccount.findMany({ where: { orgId, enabled: true } });
}

export async function findDnsAccountForDomain(domainName: string): Promise<DnsAccountRow | null> {
  const domain = await prisma.domain.findUnique({
    where: { name: domainName },
    select: { dnsAccountId: true },
  });
  if (!domain?.dnsAccountId) {
    return null;
  }
  return prisma.dnsAccount.findUnique({ where: { id: domain.dnsAccountId } });
}

export interface CreateDnsAccountInput {
  label: unknown;
  provider: unknown;
  enabled?: unknown;
  credentials: unknown;
}

export async function createDnsAccount(
  orgId: string,
  input: CreateDnsAccountInput,
): Promise<SerializedDnsAccount> {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) {
    throw new DnsAccountError('A label is required');
  }
  if (!isDnsAccountProvider(input.provider)) {
    throw new DnsAccountError(`provider must be one of ${DNS_ACCOUNT_PROVIDERS.join(', ')}`);
  }
  const credentials = readCredentials(input.provider, input.credentials);

  try {
    const created = await prisma.dnsAccount.create({
      data: {
        orgId,
        label,
        provider: input.provider,
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
        credentials: JSON.stringify(credentials),
      },
    });
    return serializeDnsAccount(created);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new DnsAccountError(`This organisation already has a DNS account labelled "${label}"`, {
        statusCode: 409,
        code: 'DNS_ACCOUNT_EXISTS',
      });
    }
    throw error;
  }
}

export interface UpdateDnsAccountInput {
  label?: unknown;
  enabled?: unknown;
  /** Omitted, or all-blank, means "keep the stored credentials". */
  credentials?: unknown;
}

export async function updateDnsAccount(
  orgId: string,
  id: string,
  input: UpdateDnsAccountInput,
): Promise<SerializedDnsAccount> {
  const existing = await getDnsAccount(orgId, id);
  if (!existing) {
    throw new DnsAccountError('DNS account not found', { statusCode: 404, code: 'NOT_FOUND' });
  }

  const data: Record<string, unknown> = {};

  if (input.label !== undefined) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label) {
      throw new DnsAccountError('A label is required');
    }
    data.label = label;
  }
  if (input.enabled !== undefined) {
    data.enabled = Boolean(input.enabled);
  }

  // Provider is immutable: changing it would leave credentials of one shape under the other,
  // and every stored credential would have to be replaced anyway. Create a new account instead.
  if (input.credentials !== undefined) {
    const provider = existing.provider as DnsAccountProvider;
    const raw = (input.credentials ?? {}) as Record<string, unknown>;
    const provided =
      provider === 'cloudflare'
        ? typeof raw.token === 'string' && raw.token.trim().length > 0
        : (typeof raw.username === 'string' && raw.username.trim().length > 0) ||
          (typeof raw.password === 'string' && raw.password.length > 0);

    if (provided) {
      data.credentials = JSON.stringify(readCredentials(provider, raw));
    }
  }

  try {
    const updated = await prisma.dnsAccount.update({ where: { id }, data });
    return serializeDnsAccount(updated);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new DnsAccountError('Another DNS account already uses that label', {
        statusCode: 409,
        code: 'DNS_ACCOUNT_EXISTS',
      });
    }
    throw error;
  }
}

/** Deleting an account leaves its domains unassigned (Prisma `onDelete: SetNull`). */
export async function deleteDnsAccount(orgId: string, id: string): Promise<boolean> {
  const existing = await getDnsAccount(orgId, id);
  if (!existing) {
    return false;
  }
  await prisma.dnsAccount.delete({ where: { id } });
  return true;
}

export interface DnsAccountVerification {
  ok: boolean;
  message?: string;
  /** What the credentials can see: Cloudflare zone names or Loopia domain names. */
  visible?: string[];
}

/**
 * Read-only credential check. It performs exactly one list call, which matters for Loopia's
 * per-minute rate limit; it writes nothing and does not touch any zone.
 */
export async function verifyDnsAccount(orgId: string, id: string): Promise<DnsAccountVerification> {
  const row = await getDnsAccount(orgId, id);
  if (!row) {
    throw new DnsAccountError('DNS account not found', { statusCode: 404, code: 'NOT_FOUND' });
  }
  const credentials = parseCredentials(row.provider, row.credentials);

  try {
    if (row.provider === 'cloudflare') {
      const token = (credentials as CloudflareCredentials).token;
      const response = await fetch(
        `${(process.env.CLOUDFLARE_API_BASE ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '')}/zones?per_page=50`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { success?: boolean; errors?: Array<{ message?: string }>; result?: Array<{ name?: string }> }
        | null;
      if (!response.ok || body?.success === false) {
        return {
          ok: false,
          message: body?.errors?.[0]?.message ?? `Cloudflare answered HTTP ${response.status}`,
        };
      }
      return {
        ok: true,
        visible: (body?.result ?? [])
          .map((zone) => zone.name)
          .filter((name): name is string => typeof name === 'string'),
      };
    }

    const loopia = credentials as LoopiaCredentials;
    const client = new LoopiaClient({ user: loopia.username, password: loopia.password });
    const domains = await client.getDomains();
    return { ok: true, visible: domains };
  } catch (error) {
    if (error instanceof LoopiaError) {
      return { ok: false, message: error.message };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The provider could not be reached',
    };
  }
}
