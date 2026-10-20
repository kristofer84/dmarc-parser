import { prisma } from '../db/prisma.js';
import { resolveMailboxConfig, type MailboxConfig } from './mailboxConfig.js';

/**
 * Per-organisation IMAP mailboxes.
 *
 * One row per mailbox an organisation ingests from; the credentials are stored like the legacy
 * mailbox password (plain text in the local database) and are **write-only over the API** -
 * responses carry `passwordSet`, never the value. Nothing in this module logs a password or a
 * connection summary that contains one.
 *
 * The "legacy" mailbox is the pre-tenancy one configured through `IMAP_*`/settings. It is not
 * copied into the database: `resolveIngestMailboxes()` adds a *virtual* row for the Default
 * organisation while that organisation has no enabled mailbox rows of its own, so an existing
 * deployment keeps ingesting after the upgrade and the environment password stays in the
 * environment. As soon as the Default organisation gets a real mailbox the virtual one
 * disappears, which is what makes "we moved the mailbox" a single visible step.
 */

export interface OrgMailboxRow {
  id: string;
  orgId: string;
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  verifyTls: boolean;
  enabled: boolean;
  lastRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the API returns. `passwordSet` replaces the password, which is never serialised. */
export interface SerializedOrgMailbox {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  verifyTls: boolean;
  enabled: boolean;
  passwordSet: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One mailbox the scheduler should ingest. `mailboxId: null` means the virtual legacy one. */
export interface IngestMailbox {
  orgId: string;
  mailboxId: string | null;
  /** The mailbox's own label, or 'Legacy settings' for the virtual row. */
  label: string;
  /** Organisation name, for the scheduler's log line. */
  orgName: string | null;
  config: MailboxConfig;
}

export class OrgMailboxError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'OrgMailboxError';
    this.statusCode = options.statusCode ?? 400;
    this.code = options.code ?? 'VALIDATION_ERROR';
  }
}

function validationError(message: string): OrgMailboxError {
  return new OrgMailboxError(message, { statusCode: 400, code: 'VALIDATION_ERROR' });
}

export function serialize(row: OrgMailboxRow): SerializedOrgMailbox {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    user: row.user,
    verifyTls: row.verifyTls,
    enabled: row.enabled,
    passwordSet: row.password.length > 0,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Alias with an explicit name, for callers that find `serialize` too bare. */
export const serializeMailbox = serialize;

export function mailboxConfigFromRow(row: OrgMailboxRow): MailboxConfig {
  return {
    host: row.host,
    port: row.port,
    user: row.user,
    password: row.password,
    verifyTls: row.verifyTls,
  };
}

export async function listOrgMailboxes(orgId: string): Promise<SerializedOrgMailbox[]> {
  const rows = await prisma.orgMailbox.findMany({
    where: { orgId },
    orderBy: { label: 'asc' },
  });
  return rows.map((row) => serialize(row as OrgMailboxRow));
}

export async function getOrgMailbox(
  orgId: string,
  id: string,
): Promise<OrgMailboxRow | null> {
  const row = await prisma.orgMailbox.findFirst({ where: { id, orgId } });
  return (row as OrgMailboxRow | null) ?? null;
}

function readLabel(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw validationError('A label is required');
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('The label must be text');
  }
  const label = value.trim();
  if (!label) {
    if (required) {
      throw validationError('A label is required');
    }
    return undefined;
  }
  if (label.length > 100) {
    throw validationError('The label must be at most 100 characters');
  }
  return label;
}

function readHost(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw validationError('An IMAP host is required');
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('The IMAP host must be text');
  }
  const host = value.trim();
  if (!host) {
    if (required) {
      throw validationError('An IMAP host is required');
    }
    return undefined;
  }
  return host;
}

function readUser(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw validationError('An IMAP user is required');
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('The IMAP user must be text');
  }
  const user = value.trim();
  if (!user) {
    if (required) {
      throw validationError('An IMAP user is required');
    }
    return undefined;
  }
  return user;
}

function readPort(value: unknown, required: boolean): number | undefined {
  if (value === undefined || value === null || value === '') {
    return required ? 993 : undefined;
  }
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw validationError('The port must be an integer between 1 and 65535');
  }
  return port;
}

/** Blank means "keep the stored one" on update; required and non-blank on create. */
function readPassword(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw validationError('An IMAP password is required');
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('The IMAP password must be text');
  }
  if (value.length === 0) {
    if (required) {
      throw validationError('An IMAP password is required');
    }
    return undefined;
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw validationError(`"${field}" must be true or false`);
  }
  return value;
}

function duplicateLabel(error: unknown): OrgMailboxError | null {
  if ((error as { code?: string } | null)?.code === 'P2002') {
    return new OrgMailboxError(
      'That organisation already has a mailbox with this label',
      { statusCode: 409, code: 'MAILBOX_EXISTS' },
    );
  }
  return null;
}

export async function createOrgMailbox(
  orgId: string,
  input: {
    label?: unknown;
    host?: unknown;
    port?: unknown;
    user?: unknown;
    password?: unknown;
    verifyTls?: unknown;
    enabled?: unknown;
  },
): Promise<SerializedOrgMailbox> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    throw new OrgMailboxError('Organisation not found', { statusCode: 404, code: 'NOT_FOUND' });
  }

  const data = {
    orgId,
    label: readLabel(input.label, true)!,
    host: readHost(input.host, true)!,
    port: readPort(input.port, true)!,
    user: readUser(input.user, true)!,
    password: readPassword(input.password, true)!,
    verifyTls: readBoolean(input.verifyTls, 'verifyTls') ?? true,
    enabled: readBoolean(input.enabled, 'enabled') ?? true,
  };

  try {
    const row = await prisma.orgMailbox.create({ data });
    return serialize(row as OrgMailboxRow);
  } catch (error) {
    const duplicate = duplicateLabel(error);
    if (duplicate) {
      throw duplicate;
    }
    throw error;
  }
}

/** Partial update. An absent or blank password keeps the stored one. */
export async function updateOrgMailbox(
  orgId: string,
  id: string,
  input: {
    label?: unknown;
    host?: unknown;
    port?: unknown;
    user?: unknown;
    password?: unknown;
    verifyTls?: unknown;
    enabled?: unknown;
  },
): Promise<SerializedOrgMailbox | null> {
  const existing = await getOrgMailbox(orgId, id);
  if (!existing) {
    return null;
  }

  const data: {
    label?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    verifyTls?: boolean;
    enabled?: boolean;
  } = {};

  const label = readLabel(input.label, false);
  if (label !== undefined) data.label = label;
  const host = readHost(input.host, false);
  if (host !== undefined) data.host = host;
  const port = readPort(input.port, false);
  if (port !== undefined) data.port = port;
  const user = readUser(input.user, false);
  if (user !== undefined) data.user = user;
  const password = readPassword(input.password, false);
  if (password !== undefined) data.password = password;
  const verifyTls = readBoolean(input.verifyTls, 'verifyTls');
  if (verifyTls !== undefined) data.verifyTls = verifyTls;
  const enabled = readBoolean(input.enabled, 'enabled');
  if (enabled !== undefined) data.enabled = enabled;

  if (Object.keys(data).length === 0) {
    return serialize(existing);
  }

  try {
    const row = await prisma.orgMailbox.update({ where: { id: existing.id }, data });
    return serialize(row as OrgMailboxRow);
  } catch (error) {
    const duplicate = duplicateLabel(error);
    if (duplicate) {
      throw duplicate;
    }
    throw error;
  }
}

/**
 * Hard delete of the mailbox row. Reports keep their `orgId` and lose `mailboxId`
 * (`onDelete: SetNull`), so history does not disappear with the credentials.
 */
export async function deleteOrgMailbox(orgId: string, id: string): Promise<boolean> {
  const existing = await getOrgMailbox(orgId, id);
  if (!existing) {
    return false;
  }
  await prisma.orgMailbox.delete({ where: { id: existing.id } });
  return true;
}

/**
 * The organisation that pre-tenancy data was moved into: the row with slug `default`, else the
 * oldest organisation (which is what `ensureDefaultOrganization()` created or adopted).
 */
export async function getDefaultOrganizationId(): Promise<string | null> {
  const bySlug = await prisma.organization.findUnique({ where: { slug: 'default' } });
  if (bySlug) {
    return bySlug.id;
  }
  const oldest = await prisma.organization.findFirst({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return oldest?.id ?? null;
}

/**
 * Every mailbox the scheduler should ingest, sequentially.
 *
 * Enabled rows first, ordered by organisation name and label so a log line's position is
 * stable. Then the virtual legacy mailbox: the Default organisation's environment/settings
 * credentials, but only while that organisation has no enabled row of its own.
 */
export async function resolveIngestMailboxes(): Promise<IngestMailbox[]> {
  const rows = await prisma.orgMailbox.findMany({
    where: { enabled: true },
    include: { organization: { select: { name: true } } },
  });

  const ordered = [...rows].sort(
    (a, b) =>
      a.organization.name.localeCompare(b.organization.name) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );

  const mailboxes: IngestMailbox[] = ordered.map((row) => ({
    orgId: row.orgId,
    mailboxId: row.id,
    label: row.label,
    orgName: row.organization.name,
    config: mailboxConfigFromRow(row as OrgMailboxRow),
  }));

  const defaultOrgId = await getDefaultOrganizationId();
  const hasOwnMailbox = defaultOrgId
    ? rows.some((row) => row.orgId === defaultOrgId)
    : false;

  if (defaultOrgId && !hasOwnMailbox) {
    const legacy = await resolveMailboxConfig();
    if (legacy.configured && legacy.config) {
      const org = await prisma.organization.findUnique({ where: { id: defaultOrgId } });
      mailboxes.push({
        orgId: defaultOrgId,
        mailboxId: null,
        label: 'Legacy settings',
        orgName: org?.name ?? null,
        config: legacy.config,
      });
    }
  }

  return mailboxes;
}

/**
 * Records the outcome of one mailbox run. A null `mailboxId` is the virtual legacy mailbox:
 * there is no row to update, and its failure is still visible in the instance-level status.
 */
export async function recordMailboxRun(
  mailboxId: string | null,
  error: unknown,
): Promise<void> {
  if (!mailboxId) {
    return;
  }

  const message =
    error === null || error === undefined
      ? null
      : (error instanceof Error ? error.message : String(error)).slice(0, 500);

  try {
    await prisma.orgMailbox.update({
      where: { id: mailboxId },
      data: { lastRunAt: new Date(), lastError: message },
    });
  } catch (updateError) {
    // The row may have been deleted while the cycle was running; that is not a reason to
    // fail the cycle or to stop the other mailboxes.
    console.warn(`⚠️ Could not record the mailbox run for ${mailboxId}:`, updateError);
  }
}
