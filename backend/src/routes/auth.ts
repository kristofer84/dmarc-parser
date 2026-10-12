import express from 'express';
import type { Response } from 'express';
import { rateLimit } from '../middleware/validation.js';
import {
  requireAuth,
  sendError,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  SESSION_COOKIE,
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

const router = express.Router();

/** Behind nginx, so `secure` cookies must be judged from the forwarded protocol. */
function isSecureRequest(req: express.Request): boolean {
  if (req.secure) {
    return true;
  }
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value === 'https';
}

function setSessionCookie(req: express.Request, res: Response, token: string, expiresAt: Date): void {
  const maxAge = Math.max(expiresAt.getTime() - Date.now(), 0);
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAge / 1000)}`,
  ];

  // Only mark Secure on real TLS, otherwise the plain-http dev setup could never log in.
  if (process.env.COOKIE_SECURE === 'true' || isSecureRequest(req)) {
    attributes.push('Secure');
  }

  res.append('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res: Response): void {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

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
      return sendError(
        res,
        429,
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again later.',
        outcome.lockedUntil ? { lockedUntil: outcome.lockedUntil.toISOString() } : undefined,
      );
    }
    // Deliberately identical for "no such user" and "wrong password".
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const session = await createSession(outcome.user.id, {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });

  setSessionCookie(req, res, session.token, session.expiresAt);

  const domains = await getDomainsForUser(outcome.user.id);
  console.log(`🔑 Login: ${outcome.user.email} (${outcome.user.role})`);

  return res.json({ user: outcome.user, domains, expiresAt: session.expiresAt.toISOString() });
});

// POST /auth/logout
router.post('/logout', async (req: AuthenticatedRequest, res) => {
  if (req.sessionToken) {
    await destroySession(req.sessionToken);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const domains = await getDomainsForUser(req.user!.id);
  return res.json({ user: req.user, domains });
});

// POST /auth/change-password
router.post('/change-password', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'currentPassword and newPassword are required');
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
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
  return res.status(201).json({ user: toAuthUser(created), domains: [] });
});

// GET /auth/session-policy - what the login page needs to know before signing in
router.get('/session-policy', async (_req, res) => {
  const [registrationOpen, sessionHours] = await Promise.all([
    getBooleanSetting('auth.registrationOpen'),
    getNumberSetting('auth.sessionHours'),
  ]);

  return res.json({ registrationOpen, sessionHours });
});

export default router;
