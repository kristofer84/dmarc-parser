import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { getNumberSetting } from './settings.js';

/**
 * Authentication: password hashing, server-side sessions, and the admin bootstrap.
 *
 * Design notes:
 *  - Passwords use node's built-in scrypt (no native dependency, which matters on the
 *    ARM hosts this runs on) with a per-password salt and a versioned format string.
 *  - Sessions are opaque random tokens; only their SHA-256 is stored, so a database
 *    leak does not hand over live sessions. The cookie is httpOnly + SameSite=Lax.
 *  - Failures are intentionally vague ("invalid email or password") so the login
 *    endpoint cannot be used to enumerate accounts.
 */

export type UserRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  mustChangePassword: boolean;
  /** How many passkeys the account has; drives the "add a passkey" prompt. */
  passkeyCount: number;
  /** True once the account has said "not now" to that prompt, on any browser. */
  passkeyPromptDismissed: boolean;
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// scrypt needs ~128*N*r bytes; give it headroom or the derivation throws on small hosts.
const MAX_MEM = 64 * 1024 * 1024;

export const SESSION_COOKIE = 'dmarc_session';
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);

  if ([N, r, p].some((v) => Number.isNaN(v) || v <= 0)) {
    return false;
  }

  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch (error) {
    console.error('❌ Password verification failed:', error);
    return false;
  }
}

export function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 12) {
    throw Object.assign(new Error('Password must be at least 12 characters long'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (password.length > 512) {
    throw Object.assign(new Error('Password must be at most 512 characters long'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The single place a user is shaped for the client. Every caller supplies at least the
 * scalar columns; only the session and login lookups count credentials, so `_count` is
 * optional and an absent count reads as zero (which is correct for a user just created).
 */
export function toAuthUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  mustChangePassword: boolean;
  passkeyPromptDismissedAt: Date | null;
  _count?: { webauthnCredentials: number };
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === 'admin' ? 'admin' : 'user',
    mustChangePassword: user.mustChangePassword,
    passkeyCount: user._count?.webauthnCredentials ?? 0,
    passkeyPromptDismissed: user.passkeyPromptDismissedAt !== null,
  };
}

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(
  userId: string,
  context: SessionContext = {},
): Promise<{ token: string; expiresAt: Date }> {
  const hours = await getNumberSetting('auth.sessionHours');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.max(hours, 1) * 3600_000);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      ip: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
    },
  });

  return { token, expiresAt };
}

export async function resolveSession(
  token: string,
): Promise<{ user: AuthUser; expiresAt: Date } | null> {
  if (!token || token.length < 20) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    // The credential count travels with every authenticated request: the client needs it
    // to decide whether to keep offering "add a passkey", and it is a single subquery.
    include: { user: { include: { _count: { select: { webauthnCredentials: true } } } } },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  if (!session.user.isActive) {
    return null;
  }

  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return { user: toAuthUser(session.user), expiresAt: session.expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  if (!token) {
    return;
  }
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function destroyAllSessionsForUser(userId: string): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { userId } });
  return result.count;
}

/** Removes expired rows; called opportunistically by the login endpoint. */
export async function pruneExpiredSessions(): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
}

export type LoginOutcome =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'invalid_credentials' | 'locked'; lockedUntil?: Date };

export async function authenticate(email: string, password: string): Promise<LoginOutcome> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalized },
    include: { _count: { select: { webauthnCredentials: true } } },
  });

  if (!user || !user.isActive) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return { ok: false, reason: 'locked', lockedUntil: user.lockedUntil };
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const maxFailures = await getNumberSetting('auth.maxFailedLogins');
    const lockMinutes = await getNumberSetting('auth.lockoutMinutes');
    const failedLoginCount = user.failedLoginCount + 1;
    const lock = failedLoginCount >= maxFailures;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : failedLoginCount,
        lockedUntil: lock ? new Date(Date.now() + lockMinutes * 60_000) : user.lockedUntil,
      },
    });

    if (lock) {
      console.warn(`🔒 Locked account ${user.email} for ${lockMinutes} minutes after repeated failures`);
      return { ok: false, reason: 'locked', lockedUntil: new Date(Date.now() + lockMinutes * 60_000) };
    }

    return { ok: false, reason: 'invalid_credentials' };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return { ok: true, user: toAuthUser(user) };
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
}

export async function findUserWithDomains(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: { domains: { orderBy: { domain: 'asc' } } },
  });
}

export async function getDomainsForUser(userId: string): Promise<string[]> {
  const rows = await prisma.userDomain.findMany({
    where: { userId },
    orderBy: { domain: 'asc' },
  });
  return rows.map((row) => row.domain);
}

export async function setDomainsForUser(userId: string, domains: string[]): Promise<string[]> {
  const normalized = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0))];

  await prisma.$transaction([
    prisma.userDomain.deleteMany({ where: { userId } }),
    ...(normalized.length > 0
      ? [
          prisma.userDomain.createMany({
            data: normalized.map((domain) => ({ userId, domain })),
          }),
        ]
      : []),
  ]);

  return normalized;
}

/**
 * Creates the first administrator. Without ADMIN_EMAIL/ADMIN_PASSWORD a random password is
 * generated and printed once, so a fresh instance is never left with a passwordless admin.
 */
export async function ensureAdminUser(): Promise<void> {
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    return;
  }

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const generatedPassword = !configuredPassword
    ? randomBytes(15).toString('base64url')
    : null;
  const password = configuredPassword ?? generatedPassword!;

  if (!email) {
    console.error(
      '❌ No users exist and ADMIN_EMAIL is not set: the console has no administrator. ' +
        'Set ADMIN_EMAIL and ADMIN_PASSWORD and restart.',
    );
    return;
  }

  validatePasswordStrength(password);

  await prisma.user.create({
    data: {
      email,
      name: 'Administrator',
      passwordHash: hashPassword(password),
      role: 'admin',
      isActive: true,
      mustChangePassword: Boolean(generatedPassword),
    },
  });

  console.log(`👤 Created the first administrator: ${email}`);
  if (generatedPassword) {
    console.warn('='.repeat(72));
    console.warn('⚠️ ADMIN_PASSWORD was not set, so a random password was generated:');
    console.warn(`    ${generatedPassword}`);
    console.warn('    Sign in and change it - it will not be shown again.');
    console.warn('='.repeat(72));
  }
}
