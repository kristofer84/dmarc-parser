import express from 'express';
import { rateLimit } from '../middleware/validation.js';
import {
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import {
  addOrganizationMember,
  createOrganization,
  getMembership,
  listOrganizationMembers,
  listUserOrganizations,
  removeOrganizationMember,
  updateOrganizationMemberRole,
} from '../services/organizations.js';
import { pathParam } from '../utils/requestParams.js';

/**
 * Organisations and their members.
 *
 * Reads are membership-scoped: a regular user only ever sees organisations they belong to, and
 * an organisation's member list is only readable by that organisation's admins (or the instance
 * superadmin). Mutations set `req.audit` with an explicit `orgId`, so an action taken by a
 * superadmin in org B while their UI is pointed at org A is recorded against B.
 *
 * The instance superadmin creates organisations here too; public self-signup is the separate,
 * setting-gated `/api/auth/signup-org`.
 */
const router = express.Router();

router.use(requireAuth);

/** Members of an organisation are visible to its admins only; everyone else gets 404. */
async function requireMemberAdmin(
  req: AuthenticatedRequest,
  orgId: string,
): Promise<boolean> {
  if (req.user!.role === 'admin') {
    return true;
  }
  if (req.organizationId !== orgId) {
    return false;
  }
  if (req.orgRole !== 'admin') {
    return false;
  }
  const membership = await getMembership(req.user!.id, orgId);
  return membership?.role === 'admin';
}

// GET /organizations - mine, or every organisation for a superadmin
router.get('/', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role === 'admin') {
    const organizations = await prisma.organization.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { memberships: true, domains: true, mailboxes: true, dnsAccounts: true } } },
    });
    return res.json({
      data: organizations.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt.toISOString(),
        counts: {
          members: org._count.memberships,
          domains: org._count.domains,
          mailboxes: org._count.mailboxes,
          dnsAccounts: org._count.dnsAccounts,
        },
      })),
    });
  }

  return res.json({ data: await listUserOrganizations(req.user!.id) });
});

// POST /organizations - any signed-in user may create one; creator becomes its admin
router.post('/', rateLimit(5, 60 * 60 * 1000, 'org-create'), async (req: AuthenticatedRequest, res) => {
  try {
    const organization = await createOrganization({
      name: String(req.body?.name ?? ''),
      ownerUserId: req.user!.id,
    });

    req.audit = {
      action: 'organization.create',
      target: organization.name,
      orgId: organization.id,
      detail: { slug: organization.slug },
    };
    return res.status(201).json({ organization });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// GET /organizations/:id/members
router.get('/:id/members', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'id');
  if (!(await requireMemberAdmin(req, orgId))) {
    return sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    return sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
  }
  return res.json({ data: await listOrganizationMembers(orgId) });
});

// POST /organizations/:id/members - attach an existing account or create one
router.post('/:id/members', rateLimit(30, 60_000, 'org-member-add'), async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'id');
  if (!(await requireMemberAdmin(req, orgId))) {
    return sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
  }

  try {
    const member = await addOrganizationMember(orgId, {
      email: req.body?.email,
      role: req.body?.role,
      name: req.body?.name,
      password: req.body?.password,
    });

    req.audit = {
      action: 'organization.member.add',
      target: member.email,
      orgId,
      detail: { role: member.role },
    };
    return res.status(201).json({ member });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// PATCH /organizations/:id/members/:userId - change a member's role
router.patch('/:id/members/:userId', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'id');
  if (!(await requireMemberAdmin(req, orgId))) {
    return sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
  }

  try {
    const member = await updateOrganizationMemberRole(orgId, pathParam(req, 'userId'), req.body?.role);
    req.audit = {
      action: 'organization.member.role',
      target: member.email,
      orgId,
      detail: { role: member.role },
    };
    return res.json({ member });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// DELETE /organizations/:id/members/:userId - remove the membership, not the account
router.delete('/:id/members/:userId', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'id');
  if (!(await requireMemberAdmin(req, orgId))) {
    return sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
  }

  try {
    const removed = await removeOrganizationMember(orgId, pathParam(req, 'userId'));
    if (!removed) {
      return sendError(res, 404, 'NOT_FOUND', 'Membership not found');
    }
    req.audit = {
      action: 'organization.member.remove',
      target: pathParam(req, 'userId'),
      orgId,
    };
    return res.json({ ok: true });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

/** Kept for the superadmin UI: the role the caller has in one organisation. */
router.get('/:id/role', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'id');
  if (req.user!.role === 'admin') {
    return res.json({ role: 'admin' });
  }
  const membership = await getMembership(req.user!.id, orgId);
  if (!membership) {
    return sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
  }
  return res.json({ role: membership.role });
});

export default router;
