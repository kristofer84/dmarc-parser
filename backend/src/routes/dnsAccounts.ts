import express from 'express';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/validation.js';
import {
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  createDnsAccount,
  deleteDnsAccount,
  getDnsAccount,
  listDnsAccounts,
  updateDnsAccount,
  verifyDnsAccount,
} from '../services/dnsAccounts.js';
import { pathParam } from '../utils/requestParams.js';

/**
 * DNS accounts owned by an organisation.
 *
 * Credentials belong to the organisation, never to a domain: several domains may share one
 * Cloudflare token or one Loopia API user, and rotating it is a single edit. The service in
 * `services/dnsAccounts.ts` is already org-scoped, so this router only adds the guard, the
 * error mapping and the audit trail.
 *
 * The guard is deliberately the same as the mailbox one: the instance superadmin, or an admin
 * of *this* organisation. Anything else answers **404**, never 403, so an organisation id
 * cannot be probed for existence.
 *
 * Nothing here ever returns or logs a credential - serialisation carries `credentialSet` only,
 * and the audit detail names the label and the provider at most.
 *
 * Mounted at `/api/organizations` **before** the organisations router (`routes/organizations.ts`),
 * which owns `/`, `/:id/members` and `/:id/role`; the `/:orgId/dns-accounts` paths do not
 * overlap, and mounting this one first keeps the more specific paths unambiguous.
 */
const router = express.Router();

router.use(requireAuth);

const verifyLimit = rateLimit(10, 60_000, 'dns-account-verify');

/**
 * True when the caller may administer the organisation in the path. The active organisation is
 * established by `attachOrganization`, which only sets `orgRole` from a real membership.
 */
async function mayAdminister(req: AuthenticatedRequest, orgId: string): Promise<boolean> {
  if (req.user!.role === 'admin') {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    return org !== null;
  }
  if (!orgId || req.organizationId !== orgId || req.orgRole !== 'admin') {
    return false;
  }
  return true;
}

function sendTyped(res: express.Response, error: unknown): void {
  const typed = error as Error & { statusCode?: number; code?: string };
  sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
}

/** Never 403: a foreign or unknown organisation is indistinguishable from a missing one. */
function notFound(res: express.Response): void {
  sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
}

// GET /organizations/:orgId/dns-accounts
router.get('/:orgId/dns-accounts', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await mayAdminister(req, orgId))) {
    return notFound(res);
  }

  try {
    return res.json({ data: await listDnsAccounts(orgId) });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// POST /organizations/:orgId/dns-accounts
router.post('/:orgId/dns-accounts', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await mayAdminister(req, orgId))) {
    return notFound(res);
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  try {
    const account = await createDnsAccount(orgId, {
      label: body.label,
      provider: body.provider,
      enabled: body.enabled,
      credentials: body.credentials,
    });

    // Set before responding so a failed write is audited with the same detail. Credentials are
    // never part of it - `audit.ts` would redact them, but they are not passed at all.
    req.audit = {
      action: 'dnsAccount.create',
      target: account.label,
      orgId,
      detail: { provider: account.provider, enabled: account.enabled },
    };
    console.log(`🔐 ${req.user!.email} added the ${account.provider} DNS account "${account.label}"`);
    return res.status(201).json({ data: account });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// PATCH /organizations/:orgId/dns-accounts/:id - partial; blank credentials keep the stored ones
router.patch('/:orgId/dns-accounts/:id', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await mayAdminister(req, orgId))) {
    return notFound(res);
  }

  const id = pathParam(req, 'id');
  const body = (req.body ?? {}) as Record<string, unknown>;

  try {
    const existing = await getDnsAccount(orgId, id);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', 'DNS account not found');
    }

    const account = await updateDnsAccount(orgId, id, {
      label: body.label,
      enabled: body.enabled,
      credentials: body.credentials,
    });

    const changed = {
      ...(body.label === undefined ? {} : { label: account.label }),
      ...(body.enabled === undefined ? {} : { enabled: account.enabled }),
      // Only the fact that credentials were replaced, never the values.
      ...(body.credentials === undefined ? {} : { credentials: 'replaced' }),
    };

    req.audit = {
      action: 'dnsAccount.update',
      target: account.label,
      orgId,
      detail: { changed },
    };
    console.log(`🔐 ${req.user!.email} updated the DNS account "${account.label}"`);
    return res.json({ data: account });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// DELETE /organizations/:orgId/dns-accounts/:id - domains keep existing, unassigned
router.delete('/:orgId/dns-accounts/:id', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await mayAdminister(req, orgId))) {
    return notFound(res);
  }

  const id = pathParam(req, 'id');

  try {
    const existing = await getDnsAccount(orgId, id);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', 'DNS account not found');
    }

    await deleteDnsAccount(orgId, id);

    req.audit = {
      action: 'dnsAccount.delete',
      target: existing.label,
      orgId,
      detail: { provider: existing.provider },
    };
    console.log(`🔐 ${req.user!.email} removed the DNS account "${existing.label}"`);
    return res.json({ ok: true });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// POST /organizations/:orgId/dns-accounts/:id/verify - one read-only list call
router.post('/:orgId/dns-accounts/:id/verify', verifyLimit, async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await mayAdminister(req, orgId))) {
    return notFound(res);
  }

  const id = pathParam(req, 'id');

  try {
    const existing = await getDnsAccount(orgId, id);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', 'DNS account not found');
    }

    // 200 even when the provider refuses the credentials: the answer is the result, not a
    // transport failure - the same rule the mailbox test endpoint follows.
    const result = await verifyDnsAccount(orgId, id);

    req.audit = {
      action: 'dnsAccount.verify',
      target: existing.label,
      orgId,
      detail: { provider: existing.provider, ok: result.ok, visible: result.visible?.length ?? 0 },
    };
    return res.json(result);
  } catch (error) {
    return sendTyped(res, error);
  }
});

export default router;
