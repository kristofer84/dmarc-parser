import express from 'express';
import {
  addDmarcRua,
  applyDnsPlan,
  buildDnsPlan,
  resolveDmarcMailboxAddress,
} from '../services/dnsApply.js';
import type { DmarcPolicy, MtaStsMode } from '../services/recordSuggestions.js';
import { normalizeDomainName } from '../services/domainMonitor.js';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/validation.js';
import {
  requireAuth,
  requireOrgAdmin,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { pathParam, queryParam } from '../utils/requestParams.js';

/**
 * "Apply to DNS" - the write path against the operator's DNS provider (Cloudflare or Loopia).
 *
 * Mounted under /api/domains so the paths match the resource they act on
 * (`/api/domains/:name/dns/plan`). Mount it **before** routes/domains.ts: that router answers
 * `GET /:id` and, while a three-segment path cannot match it, keeping the more specific
 * router first removes the question entirely.
 *
 * Every route here is organisation-administrator-only (`requireOrgAdmin`): an instance
 * superadmin, or an admin of the *active* organisation. A non-superadmin may only act on a
 * domain their organisation owns; anything else answers **404**, so other tenants' domain
 * names cannot be probed. `:name` is the domain name (not the row id) because a plan is
 * meaningful for a domain that a superadmin has not tracked in this instance yet.
 */

const router = express.Router();

router.use(requireAuth);

/** Writes to a third party, so a tight budget: ten calls a minute per client and route. */
const planLimit = rateLimit(10, 60000, 'dns-plan');
const applyLimit = rateLimit(10, 60000, 'dns-apply');
const ruaLimit = rateLimit(10, 60000, 'dmarc-rua');

const DMARC_POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];
const MTA_STS_MODES: readonly string[] = ['testing', 'enforce'];

function sendTyped(res: express.Response, error: unknown): void {
  const typed = error as Error & { statusCode?: number; code?: string };
  sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
}

/**
 * Ownership check for a domain name.
 *
 * The instance superadmin reaches every domain. Every other caller must have an active
 * organisation that owns the name; an unowned or untracked name is a 404 rather than "act on
 * everyone's domain". Returning 404 (not 403) keeps the existence of another tenant's domain
 * out of the answer.
 */
async function mayActOnDomain(req: AuthenticatedRequest, domain: string): Promise<boolean> {
  if (req.user?.role === 'admin') {
    return true;
  }
  const orgId = req.organizationId;
  if (!orgId) {
    return false;
  }
  const row = await prisma.domain.findUnique({ where: { name: domain }, select: { orgId: true } });
  return Boolean(row?.orgId && row.orgId === orgId);
}

function domainNotFound(res: express.Response): void {
  sendError(res, 404, 'NOT_FOUND', 'Domain not found');
}

/** Query values mirror the body of POST /:id/records, so a plan can preview another choice. */
function readPlanOptions(
  req: AuthenticatedRequest,
  res: express.Response,
): { providers?: string[]; dmarcPolicy?: DmarcPolicy; rua?: string; ruf?: string; mtaStsMode?: MtaStsMode } | null {
  const providers = queryParam(req, 'providers');
  const dmarcPolicy = queryParam(req, 'dmarcPolicy');
  const mtaStsMode = queryParam(req, 'mtaStsMode');
  const rua = queryParam(req, 'rua');
  const ruf = queryParam(req, 'ruf');

  if (dmarcPolicy !== undefined && !DMARC_POLICIES.includes(dmarcPolicy)) {
    sendError(res, 400, 'VALIDATION_ERROR', `dmarcPolicy must be one of ${DMARC_POLICIES.join(', ')}`);
    return null;
  }
  if (mtaStsMode !== undefined && !MTA_STS_MODES.includes(mtaStsMode)) {
    sendError(res, 400, 'VALIDATION_ERROR', `mtaStsMode must be one of ${MTA_STS_MODES.join(', ')}`);
    return null;
  }

  return {
    ...(providers === undefined
      ? {}
      : { providers: providers.split(',').map((id) => id.trim()).filter((id) => id.length > 0) }),
    ...(dmarcPolicy === undefined ? {} : { dmarcPolicy: dmarcPolicy as DmarcPolicy }),
    ...(mtaStsMode === undefined ? {} : { mtaStsMode: mtaStsMode as MtaStsMode }),
    ...(rua === undefined ? {} : { rua }),
    ...(ruf === undefined ? {} : { ruf }),
  };
}

// GET /domains/:name/dns/plan - what would be created, updated, left alone or refused
router.get('/:name/dns/plan', requireOrgAdmin, planLimit, async (req: AuthenticatedRequest, res) => {
  const options = readPlanOptions(req, res);
  if (!options) {
    return;
  }

  try {
    const domain = normalizeDomainName(pathParam(req, 'name'));
    if (!(await mayActOnDomain(req, domain))) {
      return domainNotFound(res);
    }
    const plan = await buildDnsPlan(domain, options);
    return res.json(plan);
  } catch (error) {
    return sendTyped(res, error);
  }
});

// POST /domains/:name/dns/apply - create the selected records, optionally replacing one
router.post('/:name/dns/apply', requireOrgAdmin, applyLimit, async (req: AuthenticatedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawKeys = body.keys;

  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.some((key) => typeof key !== 'string')) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'keys must be a non-empty array of planned record keys');
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'overwrite must be true or false');
  }

  const keys = [...new Set((rawKeys as string[]).map((key) => key.trim()).filter((key) => key.length > 0))];
  const overwrite = body.overwrite === true;

  try {
    const domain = normalizeDomainName(pathParam(req, 'name'));
    if (!(await mayActOnDomain(req, domain))) {
      return domainNotFound(res);
    }

    // Set before the write so a failure is recorded too; the outcome comes from the status.
    req.audit = {
      action: 'domain.dns.apply',
      target: domain,
      detail: { provider: 'cloudflare', keys, overwrite },
    };

    const result = await applyDnsPlan(domain, { keys, overwrite });
    console.log(
      `🌐 ${req.user!.email} applied ${result.applied.length} DNS record(s) to ${domain} (${result.skipped.length} skipped)`,
    );
    return res.json(result);
  } catch (error) {
    return sendTyped(res, error);
  }
});

// POST /domains/:name/dmarc/rua - add this organisation's mailbox to the published DMARC record
router.post('/:name/dmarc/rua', requireOrgAdmin, ruaLimit, async (req: AuthenticatedRequest, res) => {
  try {
    const domain = normalizeDomainName(pathParam(req, 'name'));
    if (!(await mayActOnDomain(req, domain))) {
      return domainNotFound(res);
    }

    // The organisation's own mailbox wins; the legacy settings mailbox is only used for the
    // Default organisation (or a name nobody owns yet), never for another tenant.
    let address = (await resolveDmarcMailboxAddress(domain)) ?? '';

    // A one-click hosted address may be supplied explicitly, but only one that belongs to the
    // domain's organisation (or the legacy mailbox address). Never let a caller put another
    // tenant's address, or an arbitrary string, into a live DMARC record.
    const requested =
      typeof req.body?.address === 'string'
        ? req.body.address.trim().replace(/^mailto:/i, '').toLowerCase()
        : '';
    if (requested) {
      const domainRow = await prisma.domain.findUnique({
        where: { name: domain },
        select: { orgId: true },
      });
      const ownerOrgId =
        domainRow?.orgId ?? (req.user!.role === 'admin' ? req.organizationId ?? null : null);
      const hosted = ownerOrgId
        ? await prisma.hostedAddress.findFirst({
            where: { orgId: ownerOrgId, address: requested, enabled: true },
            select: { address: true },
          })
        : null;
      const legacy = address.toLowerCase();
      if (!hosted && requested !== legacy) {
        return sendError(
          res,
          400,
          'INVALID_RUA_ADDRESS',
          'That address is not an enabled hosted address of this domain\'s organisation',
        );
      }
      address = hosted?.address ?? requested;
    }

    if (!address) {
      return sendError(
        res,
        409,
        'MAILBOX_NOT_CONFIGURED',
        "No mailbox address is configured, so there is no rua target to add: add a mailbox for this organisation (or set the mailbox user in Settings for the Default organisation) first.",
      );
    }

    req.audit = { action: 'domain.dmarc.rua', target: domain, detail: { address } };
    const result = await addDmarcRua(domain, address);
    console.log(`🌐 ${req.user!.email} added ${address} to the rua= list of ${domain}`);
    return res.json(result);
  } catch (error) {
    return sendTyped(res, error);
  }
});

export default router;
