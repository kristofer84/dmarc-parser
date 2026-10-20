import express from 'express';
import { rateLimit } from '../middleware/validation.js';
import { requireAuth, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import {
  createHostedAddress,
  deleteHostedAddress,
  getHostedAddress,
  listHostedAddresses,
  updateHostedAddress,
  HostedAddressError,
} from '../services/hostedAddresses.js';
import { pathParam } from '../utils/requestParams.js';

/**
 * One-click hosted addresses (`<base-user>+<token>@<base-mailbox-domain>`).
 *
 * Same organisation guard as the mailbox router: the superadmin, or an admin of exactly that
 * organisation; everyone else gets 404 so organisation ids cannot be probed. The address is not
 * a credential for reading - it only routes inbound reports to the organisation. The token is
 * returned because it is part of the address the operator must publish.
 */
const router = express.Router();

router.use(requireAuth);

async function requireOrgAdminForOrg(
  req: AuthenticatedRequest,
  res: express.Response,
  orgId: string,
): Promise<boolean> {
  const allowed =
    req.user!.role === 'admin' ||
    (req.organizationId === orgId && req.orgRole === 'admin');
  if (!allowed) {
    sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
    return false;
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
    return false;
  }
  return true;
}

function sendTyped(res: express.Response, error: unknown): void {
  if (error instanceof HostedAddressError) {
    sendError(res, error.statusCode, error.code, error.message);
    return;
  }
  const typed = error as Error & { statusCode?: number; code?: string };
  sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
}

// GET /organizations/:orgId/hosted-addresses
router.get('/:orgId/hosted-addresses', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }
  return res.json({ data: await listHostedAddresses(orgId) });
});

// POST /organizations/:orgId/hosted-addresses
router.post(
  '/:orgId/hosted-addresses',
  rateLimit(20, 60_000, 'hosted-address-create'),
  async (req: AuthenticatedRequest, res) => {
    const orgId = pathParam(req, 'orgId');
    if (!(await requireOrgAdminForOrg(req, res, orgId))) {
      return;
    }

    try {
      const hostedAddress = await createHostedAddress(orgId, {
        label: req.body?.label,
        baseMailboxId: req.body?.baseMailboxId,
      });
      console.log(
        `📨 ${req.user!.email} created hosted address ${hostedAddress.address} for organisation ${orgId}`,
      );
      req.audit = {
        action: 'org.hostedAddress.create',
        target: hostedAddress.address,
        orgId,
        detail: { label: hostedAddress.label, baseMailboxId: hostedAddress.baseMailbox?.id ?? null },
      };
      return res.status(201).json({ hostedAddress });
    } catch (error) {
      return sendTyped(res, error);
    }
  },
);

// PATCH /organizations/:orgId/hosted-addresses/:id
router.patch('/:orgId/hosted-addresses/:id', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }
  try {
    const hostedAddress = await updateHostedAddress(orgId, pathParam(req, 'id'), {
      label: req.body?.label,
      enabled: req.body?.enabled,
    });
    req.audit = {
      action: 'org.hostedAddress.update',
      target: hostedAddress.address,
      orgId,
      detail: { enabled: hostedAddress.enabled, label: hostedAddress.label },
    };
    return res.json({ hostedAddress });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// DELETE /organizations/:orgId/hosted-addresses/:id
router.delete('/:orgId/hosted-addresses/:id', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }
  const id = pathParam(req, 'id');
  const existing = await getHostedAddress(orgId, id);
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Hosted address not found');
  }
  await deleteHostedAddress(orgId, id);
  req.audit = {
    action: 'org.hostedAddress.delete',
    target: existing.address,
    orgId,
  };
  return res.json({ ok: true });
});

export default router;
