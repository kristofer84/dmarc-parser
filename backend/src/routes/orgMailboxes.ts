import express from 'express';
import { rateLimit } from '../middleware/validation.js';
import {
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { testMailboxConnection } from '../services/mailboxConfig.js';
import {
  createOrgMailbox,
  deleteOrgMailbox,
  getOrgMailbox,
  listOrgMailboxes,
  mailboxConfigFromRow,
  updateOrgMailbox,
  OrgMailboxError,
} from '../services/orgMailboxes.js';
import { pathParam } from '../utils/requestParams.js';

/**
 * An organisation's IMAP mailboxes.
 *
 * Mounted by the coordinator at `/api/organizations` **before** routes/organizations.ts, so the
 * paths are `/api/organizations/:orgId/mailboxes...`. The two routers do not actually overlap
 * (`:id/members` versus `:orgId/mailboxes`), but mounting this one first removes the question.
 *
 * Guard: the instance superadmin, or an admin of exactly that organisation. Everyone else gets
 * **404**, not 403 - a 403 would confirm that an organisation id exists, which is precisely
 * what an org admin of another tenant must not be able to probe. `req.organizationId` comes
 * from the `X-Org-Id` header after membership validation, so it is never attacker-chosen
 * without a matching membership.
 *
 * The password is write-only: it is accepted on create and (optionally) on update, and never
 * appears in a response, an audit row or a log line. `passwordSet` says whether one is stored.
 */

const router = express.Router();

router.use(requireAuth);

const testLimit = rateLimit(10, 60_000, 'org-mailbox-test');

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
  const org = orgId ? await prisma.organization.findUnique({ where: { id: orgId } }) : null;
  if (!org) {
    sendError(res, 404, 'NOT_FOUND', 'Organisation not found');
    return false;
  }
  return true;
}

function sendTyped(res: express.Response, error: unknown): void {
  const typed = error as Error & { statusCode?: number; code?: string };
  if (error instanceof OrgMailboxError) {
    sendError(res, error.statusCode, error.code, error.message);
    return;
  }
  sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
}

// GET /organizations/:orgId/mailboxes
router.get('/:orgId/mailboxes', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }
  return res.json({ data: await listOrgMailboxes(orgId) });
});

// POST /organizations/:orgId/mailboxes
router.post('/:orgId/mailboxes', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }

  try {
    const mailbox = await createOrgMailbox(orgId, req.body ?? {});
    req.audit = {
      action: 'org.mailbox.create',
      target: mailbox.label,
      orgId,
      detail: {
        host: mailbox.host,
        port: mailbox.port,
        user: mailbox.user,
        verifyTls: mailbox.verifyTls,
        enabled: mailbox.enabled,
      },
    };
    return res.status(201).json({ mailbox });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// PATCH /organizations/:orgId/mailboxes/:id - partial; a blank password keeps the stored one
router.patch('/:orgId/mailboxes/:id', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }

  try {
    const mailbox = await updateOrgMailbox(orgId, pathParam(req, 'id'), req.body ?? {});
    if (!mailbox) {
      return sendError(res, 404, 'NOT_FOUND', 'Mailbox not found');
    }
    const body = req.body ?? {};
    req.audit = {
      action: 'org.mailbox.update',
      target: mailbox.label,
      orgId,
      detail: {
        // Which fields the caller supplied, never the values of the secret one.
        fields: Object.keys(body).filter((key) => key !== 'password'),
        passwordChanged: typeof body.password === 'string' && body.password.length > 0,
        enabled: mailbox.enabled,
      },
    };
    return res.json({ mailbox });
  } catch (error) {
    return sendTyped(res, error);
  }
});

// DELETE /organizations/:orgId/mailboxes/:id - hard delete; reports keep their orgId
router.delete('/:orgId/mailboxes/:id', async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }

  const id = pathParam(req, 'id');
  const existing = await getOrgMailbox(orgId, id);
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Mailbox not found');
  }

  await deleteOrgMailbox(orgId, id);
  req.audit = {
    action: 'org.mailbox.delete',
    target: existing.label,
    orgId,
    detail: { host: existing.host, user: existing.user },
  };
  return res.json({ ok: true });
});

// POST /organizations/:orgId/mailboxes/test - test the form's values before saving
router.post('/:orgId/mailboxes/test', testLimit, async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  let stored: Awaited<ReturnType<typeof getOrgMailbox>> = null;
  if (typeof body.id === 'string' && body.id.length > 0) {
    stored = await getOrgMailbox(orgId, body.id);
    if (!stored) {
      return sendError(res, 404, 'NOT_FOUND', 'Mailbox not found');
    }
  }

  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  const host = text(body.host, stored?.host ?? '');
  const user = text(body.user, stored?.user ?? '');
  const password =
    typeof body.password === 'string' && body.password.length > 0
      ? body.password
      : stored?.password ?? '';
  const port =
    typeof body.port === 'number'
      ? body.port
      : typeof body.port === 'string' && body.port.trim()
        ? Number.parseInt(body.port, 10)
        : stored?.port ?? 993;
  const verifyTls =
    typeof body.verifyTls === 'boolean' ? body.verifyTls : stored?.verifyTls ?? true;

  if (!host || !user || !password) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'host, user and password are required');
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'port must be between 1 and 65535');
  }

  const result = await testMailboxConnection({ host, port, user, password, verifyTls });
  req.audit = {
    action: 'org.mailbox.test',
    target: stored?.label ?? user,
    orgId,
    detail: { ok: result.ok },
  };
  return res.json(result);
});

// POST /organizations/:orgId/mailboxes/:id/test - one real IMAP connection, then close
router.post('/:orgId/mailboxes/:id/test', testLimit, async (req: AuthenticatedRequest, res) => {
  const orgId = pathParam(req, 'orgId');
  if (!(await requireOrgAdminForOrg(req, res, orgId))) {
    return;
  }

  const existing = await getOrgMailbox(orgId, pathParam(req, 'id'));
  if (!existing) {
    return sendError(res, 404, 'NOT_FOUND', 'Mailbox not found');
  }

  const outcome = await testMailboxConnection(mailboxConfigFromRow(existing));
  req.audit = {
    action: 'org.mailbox.test',
    target: existing.label,
    orgId,
    // The message is the provider's own text and never contains the password.
    detail: { ok: outcome.ok },
    outcome: outcome.ok ? 'success' : 'failure',
  };
  // 200 even on failure, like the settings page: a wrong hostname is an answer, not an error.
  return res.json({ ok: outcome.ok, message: outcome.message });
});

export default router;
