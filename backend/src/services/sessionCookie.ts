import type { Request, Response } from 'express';
import { SESSION_COOKIE } from './auth.js';

/**
 * The one place the session cookie is written.
 *
 * Passkey sign-in must produce exactly the same session as a password sign-in - same
 * cookie, same attributes, same server-side token - so the write lives here rather than
 * being duplicated in the WebAuthn routes. Two implementations would eventually diverge
 * (Secure flag, SameSite, lifetime) and one of the two sign-in paths would be the weaker.
 */

/** Behind nginx, so `secure` cookies must be judged from the forwarded protocol. */
export function isSecureRequest(req: Request): boolean {
  if (req.secure) {
    return true;
  }
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: Date): void {
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

export function clearSessionCookie(res: Response): void {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}
