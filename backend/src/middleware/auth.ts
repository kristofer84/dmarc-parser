import type { NextFunction, Request, Response } from 'express';
import {
  SESSION_COOKIE,
  resolveSession,
  type AuthUser,
} from '../services/auth.js';
import { getDomainsForUser } from '../services/auth.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
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
 * The domains a request may read.
 *
 * `null` means unrestricted (admins). An empty array means the user has no domains
 * assigned yet: callers must return empty results rather than an error.
 */
export async function getDomainScope(req: AuthenticatedRequest): Promise<string[] | null> {
  if (!req.user || req.user.role === 'admin') {
    return null;
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
