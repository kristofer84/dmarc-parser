import { randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { resolveMailboxConfig, type MailboxConfig } from './mailboxConfig.js';

/**
 * One-click hosted addresses.
 *
 * An address is a **plus alias** on a mailbox this instance already ingests:
 *
 *     dmarc@example.org  →  dmarc+<token>@example.org
 *
 * No MX, catch-all or per-org IMAP configuration is involved: the receiving mail server delivers
 * the plus address into the base mailbox (Dovecot/Postfix use `+` by default here), and this app
 * routes it by the token in `Delivered-To` / `X-Original-To` / `To`. The token is a capability to
 * *inject* mail for the organisation, never a read credential; the normal organisation scope and
 * domain-ownership/quarantine rules still decide what is stored and who can see it.
 *
 * A hosted address row therefore has no credentials and no host: only the base mailbox (or the
 * legacy virtual mailbox for Default), the token, and the address to display.
 */

export interface HostedAddressRow {
  id: string;
  orgId: string;
  label: string;
  token: string;
  address: string;
  baseMailboxId: string | null;
  enabled: boolean;
  lastReportAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedHostedAddress {
  id: string;
  label: string;
  token: string;
  address: string;
  baseMailbox: { id: string; label: string } | null;
  enabled: boolean;
  lastReportAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class HostedAddressError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'HostedAddressError';
    this.statusCode = options.statusCode ?? 400;
    this.code = options.code ?? 'VALIDATION_ERROR';
  }
}

export function serializeHostedAddress(
  row: HostedAddressRow & { baseMailbox?: { id: string; label: string } | null },
): SerializedHostedAddress {
  return {
    id: row.id,
    label: row.label,
    token: row.token,
    address: row.address,
    baseMailbox: row.baseMailbox ?? null,
    enabled: row.enabled,
    lastReportAt: row.lastReportAt ? row.lastReportAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const BASE_INCLUDE = { baseMailbox: { select: { id: true, label: true } } } as const;

export async function listHostedAddresses(orgId: string): Promise<SerializedHostedAddress[]> {
  const rows = await prisma.hostedAddress.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    include: BASE_INCLUDE,
  });
  return rows.map((row) => serializeHostedAddress(row));
}

export async function getHostedAddress(
  orgId: string,
  id: string,
): Promise<HostedAddressRow | null> {
  return prisma.hostedAddress.findFirst({ where: { id, orgId } });
}

/** The enabled aliases, preloaded per ingestion run and matched in memory by token. */
export async function listEnabledHostedAddresses(): Promise<HostedAddressRow[]> {
  return prisma.hostedAddress.findMany({ where: { enabled: true } });
}

async function isDefaultOrg(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  return org?.slug === 'default';
}

async function resolveBaseMailbox(
  orgId: string,
  baseMailboxId: unknown,
): Promise<{ row: { id: string; label: string } | null; user: string }> {
  if (baseMailboxId !== undefined && baseMailboxId !== null && typeof baseMailboxId !== 'string') {
    throw new HostedAddressError('baseMailboxId must be a string or null');
  }

  if (typeof baseMailboxId === 'string' && baseMailboxId.length > 0) {
    const row = await prisma.orgMailbox.findFirst({
      where: { id: baseMailboxId, orgId },
      select: { id: true, label: true, user: true },
    });
    if (!row) {
      throw new HostedAddressError('Base mailbox not found in this organisation', {
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    }
    return { row: { id: row.id, label: row.label }, user: row.user };
  }

  // No explicit choice: the first enabled mailbox of the org, else the legacy virtual one for
  // Default. A hosted address must have a real delivery path or it can never receive anything.
  const first = await prisma.orgMailbox.findFirst({
    where: { orgId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, label: true, user: true },
  });
  if (first) {
    return { row: { id: first.id, label: first.label }, user: first.user };
  }

  if (await isDefaultOrg(orgId)) {
    const legacy: { configured: boolean; config: MailboxConfig | null } = await resolveMailboxConfig();
    if (legacy.configured && legacy.config) {
      return { row: null, user: legacy.config.user };
    }
  }

  throw new HostedAddressError(
    'This organisation has no mailbox to host an alias on. Add an IMAP mailbox first (or configure the legacy mailbox for the Default organisation).',
    { statusCode: 409, code: 'NO_BASE_MAILBOX' },
  );
}

function addressParts(user: string): { local: string; domain: string } {
  const at = user.lastIndexOf('@');
  if (at <= 0 || at === user.length - 1) {
    throw new HostedAddressError(
      'The base mailbox user is not an email address, so an alias cannot be derived from it',
      { statusCode: 409, code: 'NO_BASE_MAILBOX' },
    );
  }
  // Drop an existing detail tag: `dmarc+old@` should produce `dmarc+<new>@`, not `dmarc+old+<new>@`.
  const local = user.slice(0, at).split('+')[0].trim().toLowerCase();
  const domain = user.slice(at + 1).trim().toLowerCase();
  if (!local || !domain) {
    throw new HostedAddressError('The base mailbox user is not usable for an alias', {
      statusCode: 409,
      code: 'NO_BASE_MAILBOX',
    });
  }
  return { local, domain };
}

function newToken(): string {
  // Hex keeps the local part safe in every mail system; 16 chars is not guessable in practice.
  return randomBytes(8).toString('hex');
}

export interface CreateHostedAddressInput {
  label: unknown;
  baseMailboxId?: unknown;
}

export async function createHostedAddress(
  orgId: string,
  input: CreateHostedAddressInput,
): Promise<SerializedHostedAddress> {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) {
    throw new HostedAddressError('A label is required');
  }

  const base = await resolveBaseMailbox(orgId, input.baseMailboxId);
  const { local, domain } = addressParts(base.user);

  for (let attempt = 0; attempt < 5; attempt++) {
    const token = newToken();
    const address = `${local}+${token}@${domain}`;
    try {
      const created = await prisma.hostedAddress.create({
        data: {
          orgId,
          label,
          token,
          address,
          baseMailboxId: base.row?.id ?? null,
        },
        include: BASE_INCLUDE,
      });
      return serializeHostedAddress(created);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        // Either the label is taken or this token collided; a second attempt fixes the latter.
        const clash = await prisma.hostedAddress.findFirst({
          where: { OR: [{ orgId, label }, { token }, { address }] },
          select: { label: true, token: true },
        });
        if (clash?.label === label) {
          throw new HostedAddressError(
            `This organisation already has a hosted address labelled "${label}"`,
            { statusCode: 409, code: 'HOSTED_ADDRESS_EXISTS' },
          );
        }
        continue;
      }
      throw error;
    }
  }

  throw new HostedAddressError('Could not allocate a unique hosted address; try again', {
    statusCode: 503,
    code: 'TOKEN_EXHAUSTED',
  });
}

export async function updateHostedAddress(
  orgId: string,
  id: string,
  input: { label?: unknown; enabled?: unknown },
): Promise<SerializedHostedAddress> {
  const existing = await getHostedAddress(orgId, id);
  if (!existing) {
    throw new HostedAddressError('Hosted address not found', { statusCode: 404, code: 'NOT_FOUND' });
  }

  const data: { label?: string; enabled?: boolean } = {};
  if (input.label !== undefined) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label) {
      throw new HostedAddressError('A label is required');
    }
    data.label = label;
  }
  if (input.enabled !== undefined) {
    data.enabled = Boolean(input.enabled);
  }

  try {
    const updated = await prisma.hostedAddress.update({
      where: { id },
      data,
      include: BASE_INCLUDE,
    });
    return serializeHostedAddress(updated);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new HostedAddressError('Another hosted address already uses that label', {
        statusCode: 409,
        code: 'HOSTED_ADDRESS_EXISTS',
      });
    }
    throw error;
  }
}

export async function deleteHostedAddress(orgId: string, id: string): Promise<boolean> {
  const existing = await getHostedAddress(orgId, id);
  if (!existing) {
    return false;
  }
  await prisma.hostedAddress.delete({ where: { id } });
  return true;
}

/**
 * The plus detail of an address: the part after the last `+` in the local part. Returns null for
 * an ordinary address, so a base mailbox's own mail is never mistaken for a hosted alias.
 */
export function hostedTokenFromAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  const local = trimmed.slice(0, at);
  const plus = local.lastIndexOf('+');
  if (plus === -1 || plus === local.length - 1) {
    return null;
  }
  const token = local.slice(plus + 1);
  return /^[a-z0-9]{8,64}$/.test(token) ? token : null;
}

/** Looks through the recipient headers in order and returns the first enabled alias. */
export function matchHostedAddress(
  recipients: string[],
  byToken: Map<string, HostedAddressRow>,
): HostedAddressRow | null {
  for (const recipient of recipients) {
    const token = hostedTokenFromAddress(recipient);
    if (token) {
      const row = byToken.get(token);
      if (row) {
        return row;
      }
    }
  }
  return null;
}

export function tokenMap(rows: HostedAddressRow[]): Map<string, HostedAddressRow> {
  return new Map(rows.map((row) => [row.token, row]));
}

/** Set when a report from this address is actually stored, so the UI can show "receiving". */
export async function touchHostedAddress(id: string): Promise<void> {
  try {
    await prisma.hostedAddress.update({
      where: { id },
      data: { lastReportAt: new Date() },
    });
  } catch (error) {
    console.warn(
      `⚠️ Could not update hosted address ${id} lastReportAt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
