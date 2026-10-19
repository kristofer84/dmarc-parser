import express from 'express';
import type { Request } from 'express';
import { rateLimit } from '../middleware/validation.js';
import { sendError } from '../middleware/auth.js';
import { createSession, getDomainsForUser } from '../services/auth.js';
import { setSessionCookie } from '../services/sessionCookie.js';
import { prisma } from '../db/prisma.js';
import { beginLogin, completeLogin, type OidcFailureReason } from '../services/oidc.js';

/**
 * Public single-sign-on endpoints, mounted at /api/auth.
 *
 * These are reachable before sign-in by definition, so they answer in the shapes the login
 * page needs and nothing else: no secrets, no error detail worth probing, and a redirect
 * back into the UI rather than a JSON error for anything that happens at the provider.
 */
const router = express.Router();

/**
 * Where the provider sends the browser back to, and the origin `/login` lives on.
 *
 * PUBLIC_ORIGIN is the deployer's statement of the public URL (already used for CORS and the
 * passkey origin); without it the request's own host is used, which is what a same-origin
 * deployment behind nginx reports once trust proxy is on.
 */
function requestOrigin(req: Request): string {
  const configured = (process.env.PUBLIC_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)[0];
  const origin = configured ?? `${req.protocol}://${req.get('host')}`;
  return origin.replace(/\/+$/, '');
}

function callbackUrl(req: Request, providerId: string): string {
  return `${requestOrigin(req)}/api/auth/oidc/${encodeURIComponent(providerId)}/callback`;
}

/**
 * Failure reasons are already the public vocabulary; the mapping is the whole contract. An
 * unknown provider and a disabled one share `provider_disabled` so the login page does not
 * confirm that a hidden provider exists.
 */
const FAILURE_CODE: Record<OidcFailureReason, string> = {
  state_invalid: 'state_invalid',
  token_invalid: 'token_invalid',
  email_unverified: 'email_unverified',
  provisioning_disabled: 'provisioning_disabled',
  provider_disabled: 'provider_disabled',
};

// GET /api/auth/providers - public. Enabled providers only, and nothing but what a button needs.
router.get('/providers', async (_req, res) => {
  const providers = await prisma.authProvider.findMany({
    where: { enabled: true, type: 'oidc' },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, type: true },
  });
  return res.json({ providers });
});

// GET /api/auth/oidc/:id/start - mint state/nonce/PKCE and hand the browser to the IdP
router.get('/oidc/:id/start', rateLimit(50, 60000, 'oidc-start'), async (req, res) => {
  let result;
  try {
    result = await beginLogin(req.params.id, callbackUrl(req, req.params.id));
  } catch (error) {
    // A provider that does not answer discovery is a gateway problem, not a client error,
    // and the login page must not be told why.
    console.warn('⚠️ OIDC start failed:', error instanceof Error ? error.message : error);
    return sendError(res, 502, 'PROVIDER_UNAVAILABLE', 'The identity provider could not be reached');
  }

  if (!result.ok) {
    // A disabled or unknown provider is a 404, exactly as if the route did not exist.
    return sendError(res, 404, 'NOT_FOUND', 'Provider not found');
  }

  return res.redirect(302, result.start.url);
});

// GET /api/auth/oidc/:id/callback - validate everything, then mint the ordinary session
router.get('/oidc/:id/callback', rateLimit(50, 60000, 'oidc-callback'), async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  // The URL openid-client reads the authorization response from, including the query string.
  const currentUrl = new URL(`${requestOrigin(req)}${req.originalUrl}`);

  const outcome = await completeLogin({ providerId: req.params.id, code, state, currentUrl });

  if (!outcome.ok) {
    // The redirect target already tells the login page why; the audit row must too, or the
    // difference between "state mismatch" and "email unverified" is lost.
    req.audit = {
      action: 'auth.login',
      outcome: 'failure',
      detail: { method: 'oidc', provider: req.params.id, reason: outcome.reason },
    };
    return res.redirect(302, `/login?error=${FAILURE_CODE[outcome.reason]}`);
  }

  // Identical to a password login from here on: one session mechanism, one cookie.
  const session = await createSession(outcome.user.id, {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  setSessionCookie(req, res, session.token, session.expiresAt);

  const domains = await getDomainsForUser(outcome.user.id);
  console.log(
    `🔐 Login (${outcome.outcome}): ${outcome.user.email} (${outcome.role}) [${domains.length} domain(s)]`,
  );

  req.audit = {
    action: 'auth.login',
    actor: outcome.user.email,
    actorId: outcome.user.id,
    detail: {
      method: 'oidc',
      provider: req.params.id,
      outcome: outcome.outcome,
      role: outcome.role,
    },
  };

  return res.redirect(302, '/');
});

export default router;
