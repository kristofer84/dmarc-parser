import { prisma } from '../db/prisma.js';

/**
 * Domain ownership at ingest time.
 *
 * A domain belongs to exactly one organisation (`Domain.name` is unique and `orgId` is a single
 * column). Reports arrive through a mailbox, and a mailbox is owned by an organisation, so the
 * first report for a name claims it for the ingesting organisation. When the name is already
 * owned by *another* organisation the report is quarantined rather than delivered: neither side
 * reads the other's data, and the collision is visible in the processing log. There is no DNS
 * proof here - the security boundary is the mailbox an organisation controls.
 *
 * The claim is a compare-and-set, not a read-then-write: `updateMany({ where: { id, orgId: null
 * } })` only succeeds for the caller that finds the row still unowned, so two mailboxes racing
 * for the same new name cannot both believe they won. The row is re-read afterwards to decide
 * which of them actually did.
 */

export type DomainClaimFailureReason = 'owned_by_other';

export interface DomainClaimSuccess {
  ok: true;
  /** Normalised name (lower case, no trailing dot). */
  domain: string;
  domainId: string;
  /** True when this call created the row or took over an unowned one. */
  claimed: boolean;
  /** Null only when no organisation was given (legacy ingest before any org exists). */
  ownerOrgId: string | null;
}

export interface DomainClaimFailure {
  ok: false;
  reason: DomainClaimFailureReason;
  domain: string;
  domainId: string;
  ownerOrgId: string | null;
}

export type DomainClaimResult = DomainClaimSuccess | DomainClaimFailure;

/** `EXAMPLE.COM.` and `example.com` are the same domain; the unique column has one spelling. */
export function normalizeOwnedDomain(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/** Prisma's unique-constraint violation, without importing the runtime error classes. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * Resolves the Domain row for `domainName` against `orgId`:
 *
 * - no row      → created as owned by `orgId` (`claimSource: 'report'`);
 * - unowned row → claimed with an atomic `updateMany`, re-read after a lost race;
 * - own row     → nothing to do;
 * - other owner → `{ ok: false, reason: 'owned_by_other' }` (caller quarantines).
 *
 * A null `orgId` (no organisation exists yet) leaves the row unowned and never rejects: there
 * is no tenant to quarantine on behalf of.
 */
export async function claimOrCheckDomain(
  orgId: string | null,
  domainName: string,
): Promise<DomainClaimResult> {
  const name = normalizeOwnedDomain(domainName);
  if (!name) {
    throw Object.assign(new Error('A domain name is required'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  let row = await prisma.domain.findUnique({ where: { name } });

  if (!row) {
    try {
      const created = await prisma.domain.create({
        data: {
          name,
          orgId: orgId ?? null,
          claimedAt: orgId ? new Date() : null,
          claimSource: orgId ? 'report' : null,
        },
      });
      return {
        ok: true,
        domain: name,
        domainId: created.id,
        claimed: orgId !== null,
        ownerOrgId: created.orgId ?? null,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Another ingestion created it between the read and the write; fall through to the
      // claim/check path with the row that now exists.
      row = await prisma.domain.findUnique({ where: { name } });
      if (!row) {
        throw error;
      }
    }
  }

  if (row.orgId === null) {
    if (!orgId) {
      return { ok: true, domain: name, domainId: row.id, claimed: false, ownerOrgId: null };
    }

    const claimed = await prisma.domain.updateMany({
      where: { id: row.id, orgId: null },
      data: { orgId, claimedAt: new Date(), claimSource: 'report' },
    });
    // Re-read even when the update reported one row: that is what makes the loser of a race
    // see the winner's org rather than its own assumption.
    const fresh = await prisma.domain.findUnique({ where: { id: row.id } });
    const ownerOrgId = fresh?.orgId ?? null;

    if (ownerOrgId === orgId) {
      return {
        ok: true,
        domain: name,
        domainId: row.id,
        claimed: claimed.count > 0,
        ownerOrgId,
      };
    }
    return {
      ok: false,
      reason: 'owned_by_other',
      domain: name,
      domainId: row.id,
      ownerOrgId,
    };
  }

  if (orgId !== null && row.orgId === orgId) {
    return { ok: true, domain: name, domainId: row.id, claimed: false, ownerOrgId: row.orgId };
  }

  if (!orgId) {
    // No tenant to attribute the report to, and the name belongs to one: keep it out of the
    // unscoped pool rather than making it readable through the legacy UserDomain bridge.
    return {
      ok: false,
      reason: 'owned_by_other',
      domain: name,
      domainId: row.id,
      ownerOrgId: row.orgId,
    };
  }

  return {
    ok: false,
    reason: 'owned_by_other',
    domain: name,
    domainId: row.id,
    ownerOrgId: row.orgId,
  };
}
