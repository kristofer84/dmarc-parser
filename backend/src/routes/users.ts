import express from 'express';
import { prisma } from '../db/prisma.js';
import { requireAdmin, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  destroyAllSessionsForUser,
  getDomainsForUser,
  hashPassword,
  setDomainsForUser,
  toAuthUser,
  validatePasswordStrength,
} from '../services/auth.js';
import { removeAllCredentialsForUser } from '../services/webauthn.js';

const router = express.Router();

// Everything here is administrator-only.
router.use(requireAdmin);

function serializeUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  domains?: { domain: string }[];
  _count?: { sessions: number; webauthnCredentials?: number };
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === 'admin' ? 'admin' : 'user',
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    domains: (user.domains ?? []).map((d) => d.domain),
    activeSessions: user._count?.sessions ?? 0,
    // Shown next to the "remove passkeys" recovery button, so an administrator can tell
    // whether the button would do anything at all.
    passkeyCount: user._count?.webauthnCredentials ?? 0,
  };
}

function validateEmail(email: unknown): string {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw Object.assign(new Error('Enter a valid email address'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return email.trim().toLowerCase();
}

// GET /users
router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
    include: {
      domains: { orderBy: { domain: 'asc' } },
      _count: {
        select: {
          sessions: { where: { expiresAt: { gt: new Date() } } },
          webauthnCredentials: true,
        },
      },
    },
  });

  return res.json({ data: users.map(serializeUser) });
});

// GET /users/available-domains - every domain the app has seen, for the assignment picker
router.get('/available-domains', async (_req, res) => {
  const [reportDomains, forensicDomains, assigned] = await Promise.all([
    prisma.report.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.forensicReport.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.userDomain.findMany({ select: { domain: true, userId: true } }),
  ]);

  const names = new Set<string>();
  for (const row of [...reportDomains, ...forensicDomains]) {
    names.add(row.domain.toLowerCase());
  }
  for (const row of assigned) {
    names.add(row.domain.toLowerCase());
  }

  const assignmentCounts = new Map<string, number>();
  for (const row of assigned) {
    const key = row.domain.toLowerCase();
    assignmentCounts.set(key, (assignmentCounts.get(key) ?? 0) + 1);
  }

  return res.json({
    data: [...names].sort().map((domain) => ({
      domain,
      assignedUsers: assignmentCounts.get(domain) ?? 0,
    })),
  });
});

// POST /users
router.post('/', async (req: AuthenticatedRequest, res) => {
  const { email, password, name, role, domains } = req.body ?? {};

  try {
    validateEmail(email);
    if (typeof password !== 'string') {
      throw Object.assign(new Error('password is required'), {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    validatePasswordStrength(password);
  } catch (error) {
    const typed = error as Error & { code?: string; statusCode?: number };
    return sendError(res, typed.statusCode ?? 400, typed.code ?? 'VALIDATION_ERROR', typed.message);
  }

  const normalizedEmail = (email as string).trim().toLowerCase();

  if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
    return sendError(res, 409, 'CONFLICT', 'An account with that email already exists');
  }

  const created = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
      passwordHash: hashPassword(password),
      role: role === 'admin' ? 'admin' : 'user',
      mustChangePassword: req.body?.mustChangePassword === true,
    },
  });

  if (Array.isArray(domains) && domains.length > 0) {
    await setDomainsForUser(created.id, domains.filter((d: unknown): d is string => typeof d === 'string'));
  }

  const withDomains = await prisma.user.findUnique({
    where: { id: created.id },
    include: {
      domains: true,
      _count: { select: { sessions: true, webauthnCredentials: true } },
    },
  });

  console.log(`👤 ${req.user!.email} created user ${created.email} (${created.role})`);
  return res.status(201).json({ user: serializeUser(withDomains!) });
});

// PATCH /users/:id
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  const { name, role, isActive, mustChangePassword } = req.body ?? {};
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });

  if (!target) {
    return sendError(res, 404, 'NOT_FOUND', 'User not found');
  }

  // Never lock yourself out of the console.
  if (target.id === req.user!.id && (role !== undefined && role !== 'admin')) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'You cannot remove your own administrator role');
  }
  if (target.id === req.user!.id && isActive === false) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'You cannot deactivate your own account');
  }

  if (role !== undefined && role !== 'admin' && target.role === 'admin') {
    const remainingAdmins = await prisma.user.count({
      where: { role: 'admin', isActive: true, id: { not: target.id } },
    });
    if (remainingAdmins === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'The last active administrator cannot be demoted');
    }
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(typeof name === 'string' ? { name: name.trim() || null } : {}),
      ...(role === 'admin' || role === 'user' ? { role } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
      ...(typeof mustChangePassword === 'boolean' ? { mustChangePassword } : {}),
    },
    include: {
      domains: true,
      _count: { select: { sessions: true, webauthnCredentials: true } },
    },
  });

  if (isActive === false) {
    await destroyAllSessionsForUser(updated.id);
  }

  console.log(`👤 ${req.user!.email} updated user ${updated.email}`);
  return res.json({ user: serializeUser(updated) });
});

// POST /users/:id/password - administrative reset
router.post('/:id/password', async (req: AuthenticatedRequest, res) => {
  const { newPassword, mustChangePassword } = req.body ?? {};

  if (typeof newPassword !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'newPassword is required');
  }

  try {
    validatePasswordStrength(newPassword);
  } catch (error) {
    return sendError(res, 400, 'VALIDATION_ERROR', (error as Error).message);
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) {
    return sendError(res, 404, 'NOT_FOUND', 'User not found');
  }

  await prisma.user.update({
    where: { id: target.id },
    data: {
      passwordHash: hashPassword(newPassword),
      mustChangePassword: mustChangePassword !== false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // A reset ends existing sessions, except the admin's own (they may be resetting their own).
  if (target.id !== req.user!.id) {
    await destroyAllSessionsForUser(target.id);
  }

  console.log(`🔐 ${req.user!.email} reset the password of ${target.email}`);
  return res.json({ ok: true });
});

// PUT /users/:id/domains
router.put('/:id/domains', async (req: AuthenticatedRequest, res) => {
  const { domains } = req.body ?? {};

  if (!Array.isArray(domains)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'domains must be an array of domain names');
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) {
    return sendError(res, 404, 'NOT_FOUND', 'User not found');
  }

  const applied = await setDomainsForUser(
    target.id,
    domains.filter((d: unknown): d is string => typeof d === 'string'),
  );

  console.log(`👤 ${req.user!.email} set domains for ${target.email}: ${applied.join(', ') || '(none)'}`);
  return res.json({ domains: applied });
});

// DELETE /users/:id/passkeys - account recovery when a device is lost.
//
// Removing every credential does not touch the password, which is what makes this safe to
// offer: the account falls back to the password it already has, and an administrator who
// fired this by mistake has cost the user nothing but a re-registration.
router.delete('/:id/passkeys', async (req: AuthenticatedRequest, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });

  if (!target) {
    return sendError(res, 404, 'NOT_FOUND', 'User not found');
  }

  const removed = await removeAllCredentialsForUser(target.id);

  console.log(`🔑 ${req.user!.email} removed ${removed} passkey(s) from ${target.email}`);
  return res.json({ removed });
});

// DELETE /users/:id
router.delete('/:id', async (req: AuthenticatedRequest, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });

  if (!target) {
    return sendError(res, 404, 'NOT_FOUND', 'User not found');
  }
  if (target.id === req.user!.id) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'You cannot delete your own account');
  }
  if (target.role === 'admin') {
    const remainingAdmins = await prisma.user.count({
      where: { role: 'admin', id: { not: target.id } },
    });
    if (remainingAdmins === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'The last administrator cannot be deleted');
    }
  }

  await prisma.user.delete({ where: { id: target.id } });
  console.log(`👤 ${req.user!.email} deleted user ${target.email}`);
  return res.json({ ok: true });
});

export default router;
