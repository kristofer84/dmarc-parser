import express from 'express';
import { rateLimit } from '../middleware/validation.js';
import {
  getDomainScope,
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  authenticate,
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  findUserByEmail,
  getDomainsForUser,
  hashPassword,
  pruneExpiredSessions,
  toAuthUser,
  validatePasswordStrength,
  verifyPassword,
} from '../services/auth.js';
import { prisma } from '../db/prisma.js';
import { getBooleanSetting, getNumberSetting } from '../services/settings.js';
import {
  getDomainsForOrganization,
  listUserOrganizations,
  signupOrganization,
} from '../services/organizations.js';
import { resolveWebAuthnConfig } from '../services/webauthnConfig.js';
import { clearSessionCookie, setSessionCookie } from '../services/sessionCookie.js';

const router = express.Router();

// POST /auth/login
router.post('/login', rateLimit(10, 60000), async (req: AuthenticatedRequest, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string' || email.length === 0 || password.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Email and password are required');
  }

  await pruneExpiredSessions();

  const outcome = await authenticate(email, password);

  if (!outcome.ok) {
    if (outcome.reason === 'locked') {
      req.audit = {
        action: 'auth.login',
        outcome: 'failure',
        actor: email.trim().toLowerCase(),
        detail: { reason: 'locked', method: 'password' },
      };
      return sendError(
        res,
        429,
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again later.',
        outcome.lockedUntil ? { lockedUntil: outcome.lockedUntil.toISOString() } : undefined,
      );
    }
    // Deliberately identical for "no such user" and "wrong password". The audit row keeps the
    // attempted address, which the response deliberately does not confirm.
    req.audit = {
      action: 'auth.login',
      outcome: 'failure',
      actor: email.trim().toLowerCase(),
      detail: { reason: 'invalid_credentials', method: 'password' },
    };
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const session = await createSession(outcome.user.id, {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });

  setSessionCookie(req, res, session.token, session.expiresAt);

  const organizations = await listUserOrganizations(outcome.user.id);
  // The active organisation is the first membership; its domains are what the UI lists.
  const domains = organizations[0]
    ? await getDomainsForOrganization(organizations[0].id)
    : await getDomainsForUser(outcome.user.id);
  console.log(`🔑 Login: ${outcome.user.email} (${outcome.user.role})`);

  req.audit = {
    action: 'auth.login',
    actor: outcome.user.email,
    actorId: outcome.user.id,
    detail: { method: 'password', role: outcome.user.role },
  };

  return res.json({
    user: outcome.user,
    domains,
    organizations,
    activeOrganizationId: organizations[0]?.id ?? null,
    expiresAt: session.expiresAt.toISOString(),
  });
});

// POST /auth/logout
router.post('/logout', async (req: AuthenticatedRequest, res) => {
  if (req.sessionToken) {
    await destroySession(req.sessionToken);
  }
  clearSessionCookie(res);

  if (req.user) {
    req.audit = { action: 'auth.logout', target: req.user.email };
  }
  return res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const [scope, memberships] = await Promise.all([
    // The active organisation's domains, not the legacy assignment list.
    getDomainScope(req),
    listUserOrganizations(req.user!.id),
  ]);

  // A superadmin can switch to any organisation, not only the ones they are a member of.
  const organizations =
    req.user!.role === 'admin'
      ? (await prisma.organization.findMany({ orderBy: { name: 'asc' } })).map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          role: 'admin' as const,
          createdAt: org.createdAt.toISOString(),
        }))
      : memberships;

  // `scope === null` means all domains (superadmin viewing all orgs); the SPA still expects a
  // list, so it gets every domain name rather than a null.
  const domains =
    scope === null
      ? (await prisma.domain.findMany({ select: { name: true }, orderBy: { name: 'asc' } })).map(
          (row) => row.name.toLowerCase(),
        )
      : scope;

  return res.json({
    user: req.user,
    domains,
    organizations,
    activeOrganizationId: req.organizationId ?? null,
    orgRole: req.orgRole ?? (req.user!.role === 'admin' ? 'admin' : null),
    isSuperAdmin: req.user!.role === 'admin',
  });
});

// POST /auth/change-password
router.post('/change-password', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'currentPassword and newPassword are required');
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
    req.audit = {
      action: 'auth.password.change',
      outcome: 'failure',
      target: req.user!.email,
      detail: { reason: 'current_password_incorrect' },
    };
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }

  try {
    validatePasswordStrength(newPassword);
  } catch (error) {
    return sendError(res, 400, 'VALIDATION_ERROR', (error as Error).message);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(newPassword),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // Changing a password invalidates every other session for that account.
  await destroyAllSessionsForUser(user.id);
  const session = await createSession(user.id, {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  setSessionCookie(req, res, session.token, session.expiresAt);

  console.log(`🔐 Password changed for ${user.email}`);
  req.audit = {
    action: 'auth.password.change',
    target: user.email,
    detail: { sessionsRevoked: true },
  };
  return res.json({ ok: true });
});

// POST /auth/register - only when self-registration is enabled in settings
router.post('/register', rateLimit(5, 60000), async (req: AuthenticatedRequest, res) => {
  if (!(await getBooleanSetting('auth.registrationOpen'))) {
    return sendError(
      res,
      403,
      'REGISTRATION_CLOSED',
      'Self-registration is disabled. Ask an administrator for an account.',
    );
  }

  const { email, password, name } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Email and password are required');
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Enter a valid email address');
  }

  try {
    validatePasswordStrength(password);
  } catch (error) {
    return sendError(res, 400, 'VALIDATION_ERROR', (error as Error).message);
  }

  if (await findUserByEmail(normalizedEmail)) {
    return sendError(res, 409, 'CONFLICT', 'An account with that email already exists');
  }

  const created = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
      passwordHash: hashPassword(password),
      // New accounts see nothing until an admin assigns domains.
      role: 'user',
    },
  });

  console.log(`👤 Registered ${created.email} (no domains assigned yet)`);
  req.audit = {
    action: 'auth.register',
    actor: created.email,
    actorId: created.id,
    target: created.email,
    detail: { selfRegistered: true },
  };
  return res.status(201).json({ user: toAuthUser(created), domains: [] });
});

// POST /auth/signup-org - public, setting-gated: create an organisation and its first admin
router.post('/signup-org', rateLimit(5, 60 * 60 * 1000, 'org-signup'), async (req, res) => {
  if (!(await getBooleanSetting('auth.orgSignupOpen'))) {
    return sendError(res, 403, 'SIGNUP_DISABLED', 'Organisation self-signup is disabled');
  }

  try {
    const result = await signupOrganization({
      organizationName: req.body?.organizationName ?? req.body?.name,
      name: req.body?.adminName ?? req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
    });

    const session = await createSession(result.user.id, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    setSessionCookie(req, res, session.token, session.expiresAt);

    req.audit = {
      action: 'organization.signup',
      actor: result.user.email,
      actorId: result.user.id,
      orgId: result.organization.id,
      target: result.organization.name,
    };

    return res.status(201).json({
      user: result.user,
      domains: [],
      organizations: [result.organization],
      activeOrganizationId: result.organization.id,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (error) {
    const typed = error as Error & { statusCode?: number; code?: string };
    return sendError(res, typed.statusCode ?? 500, typed.code ?? 'INTERNAL_SERVER_ERROR', typed.message);
  }
});

// GET /auth/session-policy - what the login page needs to know before signing in
router.get('/session-policy', async (_req, res) => {
  const [registrationOpen, orgSignupOpen, sessionHours, webauthn] = await Promise.all([
    getBooleanSetting('auth.registrationOpen'),
    getBooleanSetting('auth.orgSignupOpen'),
    getNumberSetting('auth.sessionHours'),
    resolveWebAuthnConfig(),
  ]);

  // Announced rather than probed: a deployment with no origin configured must tell the
  // login page not to offer passkeys at all, instead of letting the user tap a button
  // that can only fail.
  return res.json({
    registrationOpen,
    orgSignupOpen,
    sessionHours,
    passkeysEnabled: webauthn.enabled,
  });
});

export default router;
