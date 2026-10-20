import type { NextFunction, Request, Response } from 'express';
import {
  SESSION_COOKIE,
  resolveSession,
  type AuthUser,
} from '../services/auth.js';
import { getDomainsForUser } from '../services/auth.js';
import { prisma } from '../db/prisma.js';
import type { OrganizationRole } from '../services/organizations.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
  /** Active tenant; absent for a superadmin browsing all organisations. */
  organizationId?: string;
  /** The caller's role in `organizationId` (superadmins count as admin). */
  orgRole?: OrganizationRole;
}

/**
 * Minimal cookie parsing - the app needs exactly one cookie, and this keeps a
 * dependency out of the request path.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      cookies[name] = part.slice(separator + 1).trim();
    }
  }

  return cookies;
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    timestamp: new Date().toISOString(),
    path: res.req.originalUrl,
  });
}

/**
 * Resolves the session cookie if there is one. Never rejects a request - routes decide
 * whether authentication is required, so /health and the login endpoint stay reachable.
 */
export async function attachUser(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const session = await resolveSession(token);
      if (session) {
        req.user = session.user;
        req.sessionToken = token;
      }
    }
  } catch (error) {
    console.warn('⚠️ Failed to resolve session:', error);
  }

  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    // Resource-owning responses stay behind auth; the SPA shows the login view on 401.
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in to access this resource');
    return;
  }
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in to access this resource');
    return;
  }
  if (req.user.role !== 'admin') {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access required');
    return;
  }
  next();
}

/**
 * Resolves the active organisation.
 *
 * The `X-Org-Id` header is the SPA's statement of which tenant it is displaying. It is never
 * trusted on its own: a regular user must have a membership in it, and a superadmin may select
 * any existing organisation. Without the header a regular user falls back to their oldest
 * membership; a superadmin with no header intentionally keeps `organizationId` unset, which
 * means "all organisations" to `getDomainScope`.
 */
export async function attachOrganization(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    next();
    return;
  }

  const header = req.headers['x-org-id'];
  const requested = (Array.isArray(header) ? header[0] : header ?? '').trim();

  try {
    if (req.user.role === 'admin') {
      if (requested) {
        const org = await prisma.organization.findUnique({ where: { id: requested } });
        if (!org) {
          sendError(res, 404, 'ORG_NOT_FOUND', 'Organisation not found');
          return;
        }
        req.organizationId = org.id;
        req.orgRole = 'admin';
      }
      next();
      return;
    }

    const memberships = await prisma.membership.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
    });

    if (requested) {
      const membership = memberships.find((row) => row.orgId === requested);
      if (!membership) {
        sendError(res, 403, 'ORG_FORBIDDEN', 'You are not a member of that organisation');
        return;
      }
      req.organizationId = membership.orgId;
      req.orgRole = membership.role === 'admin' ? 'admin' : 'viewer';
      next();
      return;
    }

    const first = memberships[0];
    if (first) {
      req.organizationId = first.orgId;
      req.orgRole = first.role === 'admin' ? 'admin' : 'viewer';
    }
  } catch (error) {
    console.warn('⚠️ Failed to resolve organisation:', error);
    sendError(res, 500, 'ORG_RESOLUTION_FAILED', 'Could not resolve the active organisation');
    return;
  }

  next();
}

/** Instance superadmin or an admin of the active organisation. */
export function requireOrgAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in to access this resource');
    return;
  }
  if (req.user.role === 'admin') {
    next();
    return;
  }
  if (!req.organizationId || req.orgRole !== 'admin') {
    sendError(res, 403, 'FORBIDDEN', 'Organisation administrator access required');
    return;
  }
  next();
}

/** True when the caller may administer the active organisation (or the instance). */
export function isOrgAdmin(req: AuthenticatedRequest): boolean {
  return req.user?.role === 'admin' || req.orgRole === 'admin';
}

/**
 * The domains a request may read.
 *
 * `null` means unrestricted: only a superadmin with no organisation selected. An organisation
 * member gets the domains owned by that organisation (`Domain.orgId`), never the report rows of
 * another tenant. An empty array means "nothing": callers return empty results, not an error.
 *
 * A user with no memberships at all falls back to the legacy `UserDomain` assignments. That is
 * a migration bridge for accounts created before organisations existed (and keeps the existing
 * test fixtures meaningful); once every account has a membership the fallback is never
 * reached. `ensureDefaultOrganization()` gives existing users one on first start.
 */
export async function getDomainScope(req: AuthenticatedRequest): Promise<string[] | null> {
  if (!req.user) {
    return [];
  }

  // Superadmin, no tenant selected: everything.
  if (req.user.role === 'admin' && !req.organizationId) {
    return null;
  }

  if (req.organizationId) {
    const rows = await prisma.domain.findMany({
      where: { orgId: req.organizationId },
      select: { name: true },
    });
    return rows.map((row) => row.name.toLowerCase());
  }

  return getDomainsForUser(req.user.id);
}

/** True when a domain passes the scope. */
export function isDomainAllowed(scope: string[] | null, domain: string): boolean {
  if (scope === null) {
    return true;
  }
  return scope.includes(domain.toLowerCase());
}
