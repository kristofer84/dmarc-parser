import express from 'express';
import type { Response } from 'express';
import { rateLimit } from '../middleware/validation.js';
import { requireAuth, sendError, type AuthenticatedRequest } from '../middleware/auth.js';
import { createSession, getDomainsForUser } from '../services/auth.js';
import { setSessionCookie } from '../services/sessionCookie.js';
import { resolveWebAuthnConfig, type WebAuthnConfig } from '../services/webauthnConfig.js';
import {
  finishAuthentication,
  finishRegistration,
  listCredentials,
  markPromptDismissed,
  removeCredential,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnFailure,
  type WebAuthnFailureReason,
} from '../services/webauthn.js';

/**
 * Passkey (WebAuthn) endpoints, mounted at /api/auth/webauthn.
 *
 * Passwords are untouched and remain the fallback for every account: nothing here removes
 * or invalidates a password hash, and an account with no passkeys behaves exactly as it did
 * before. A successful passkey sign-in goes through createSession()/setSessionCookie(),
 * the same pair the password login uses, so permissions, per-domain scoping and session
 * lifetime are identical by construction rather than by convention.
 */
const router = express.Router();

const FAILURE_STATUS: Record<WebAuthnFailureReason, [number, string]> = {
  disabled: [503, 'WEBAUTHN_DISABLED'],
  unknown_challenge: [400, 'WEBAUTHN_CHALLENGE_INVALID'],
  invalid_response: [401, 'WEBAUTHN_VERIFICATION_FAILED'],
  // The credential-exists and credential-does-not-exist cases deliberately share a status
  // and a code: the response must not tell an attacker whether an account has a passkey.
  no_credential: [401, 'WEBAUTHN_VERIFICATION_FAILED'],
  counter_regression: [401, 'WEBAUTHN_VERIFICATION_FAILED'],
  duplicate_credential: [409, 'CONFLICT'],
};

/** Registration happens while signed in, so a rejected response is a bad request, not a 401. */
const REGISTRATION_FAILURE_STATUS: Partial<Record<WebAuthnFailureReason, [number, string]>> = {
  invalid_response: [400, 'WEBAUTHN_VERIFICATION_FAILED'],
};

function sendFailure(
  res: Response,
  failure: WebAuthnFailure,
  overrides?: Partial<Record<WebAuthnFailureReason, [number, string]>>,
): void {
  const [status, code] = overrides?.[failure.reason] ?? FAILURE_STATUS[failure.reason];
  sendError(res, status, code, failure.message);
}

/** Every ceremony endpoint says the same thing when the deployment cannot do passkeys. */
async function loadConfigOrReject(res: Response): Promise<WebAuthnConfig | null> {
  const config = await resolveWebAuthnConfig();
  if (!config.enabled) {
    sendError(
      res,
      503,
      'WEBAUTHN_DISABLED',
      config.disabledReason ?? 'Passkeys are unavailable on this deployment',
    );
    return null;
  }
  return config;
}

/**
 * The verify body is the credential response itself - the library's own flat
 * RegistrationResponseJSON/AuthenticationResponseJSON, exactly as @simplewebauthn/browser hands
 * it back - with the ceremony id, when the client sends one, as a sibling field. That mirrors
 * the options endpoints, which answer with `{ ...options, ceremonyId }`.
 *
 * Nothing here unwraps a `response` field from the body: in this wire format `response` is the
 * authenticator data, and lifting it out would leave readSignedChallenge() looking for the
 * signed clientDataJSON one level too deep. That mistake made every ceremony id-less
 * registration fail as "expired" while the challenge the browser signed was still sitting in
 * the body, so the shape check below is on the element that is actually required.
 */
function readCeremonyParams(
  body: unknown,
): { ceremonyId: string | null; response: RegistrationResponseJSON | AuthenticationResponseJSON } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const { ceremonyId, ...response } = body as Record<string, unknown>;
  const authenticatorResponse = response.response;
  if (typeof authenticatorResponse !== 'object' || authenticatorResponse === null) {
    return null;
  }
  if (typeof (authenticatorResponse as { clientDataJSON?: unknown }).clientDataJSON !== 'string') {
    return null;
  }

  // The ceremony id is optional on purpose: the challenge inside the signed clientDataJSON is
  // what actually identifies the attempt.
  return {
    ceremonyId: typeof ceremonyId === 'string' && ceremonyId.length > 0 ? ceremonyId : null,
    response: response as unknown as RegistrationResponseJSON | AuthenticationResponseJSON,
  };
}

// POST /webauthn/register/options - start adding a passkey to the signed-in account
router.post('/register/options', requireAuth, rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const config = await loadConfigOrReject(res);
  if (!config) {
    return;
  }

  const { ceremonyId, options } = await startRegistration(
    { id: req.user!.id, email: req.user!.email, name: req.user!.name },
    config,
  );

  // The options go out in the library's own flat JSON wire format, which the browser helper
  // consumes untouched; the ceremony id rides alongside it. Spread first so no library field
  // can be shadowed.
  return res.json({ ...options, ceremonyId });
});

// POST /webauthn/register/verify - finish it, and hand back the account's credential list
router.post('/register/verify', requireAuth, rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const config = await loadConfigOrReject(res);
  if (!config) {
    return;
  }

  const params = readCeremonyParams(req.body);
  if (!params) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'response is required');
  }

  const label = typeof req.body?.label === 'string' ? req.body.label : null;

  const outcome = await finishRegistration(
    {
      userId: req.user!.id,
      userEmail: req.user!.email,
      ceremonyId: params.ceremonyId,
      response: params.response as RegistrationResponseJSON,
      label,
    },
    config,
  );

  if (!outcome.ok) {
    req.audit = {
      action: 'auth.passkey.register',
      outcome: 'failure',
      target: req.user!.email,
      detail: { reason: outcome.reason },
    };
    return sendFailure(res, outcome, REGISTRATION_FAILURE_STATUS);
  }

  req.audit = {
    action: 'auth.passkey.register',
    target: req.user!.email,
    detail: { label },
  };
  return res.status(201).json({ credentials: await listCredentials(req.user!.id) });
});

// POST /webauthn/login/options - public. No credential ids are offered, so any discoverable
// passkey for this RP can be used and the account is identified by the one that comes back.
router.post('/login/options', rateLimit(20, 60000), async (_req, res) => {
  const config = await loadConfigOrReject(res);
  if (!config) {
    return;
  }

  const { ceremonyId, options } = await startAuthentication(config);
  return res.json({ ...options, ceremonyId });
});

// POST /webauthn/login/verify - public
router.post('/login/verify', rateLimit(20, 60000), async (req: AuthenticatedRequest, res) => {
  const config = await loadConfigOrReject(res);
  if (!config) {
    return;
  }

  const params = readCeremonyParams(req.body);
  if (!params) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'response is required');
  }

  const outcome = await finishAuthentication(
    { ceremonyId: params.ceremonyId, response: params.response as AuthenticationResponseJSON },
    config,
  );

  if (!outcome.ok) {
    // A failed ceremony is worth a row: it is the shape a credential-stuffing or a cloned
    // authenticator makes. The generic message the client got is deliberately not recorded
    // as if it were the reason.
    req.audit = {
      action: 'auth.login',
      outcome: 'failure',
      detail: { method: 'passkey', reason: outcome.reason },
    };
    return sendFailure(res, outcome);
  }

  // Identical to the password login from here on: one session mechanism, one cookie.
  const session = await createSession(outcome.user.id, {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  setSessionCookie(req, res, session.token, session.expiresAt);

  const domains = await getDomainsForUser(outcome.user.id);
  req.audit = {
    action: 'auth.login',
    actor: outcome.user.email,
    actorId: outcome.user.id,
    detail: { method: 'passkey', role: outcome.user.role },
  };
  return res.json({ user: outcome.user, domains, expiresAt: session.expiresAt.toISOString() });
});

// GET /webauthn/credentials - the signed-in account's own passkeys
router.get('/credentials', requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.json({ credentials: await listCredentials(req.user!.id) });
});

// DELETE /webauthn/credentials/:id - one of your own; someone else's is a 404, not a 403,
// so the endpoint cannot be used to probe for other accounts' credential ids.
router.delete('/credentials/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const removed = await removeCredential(req.user!.id, req.params.id);
  if (!removed) {
    return sendError(res, 404, 'NOT_FOUND', 'Passkey not found');
  }

  console.log(`🔑 passkey removed: user=${req.user!.email} id=${req.params.id}`);
  req.audit = { action: 'auth.passkey.remove', target: req.user!.email, detail: { credentialId: req.params.id } };
  return res.json({ credentials: await listCredentials(req.user!.id) });
});

// POST /webauthn/prompt-dismissed - "not now", remembered for the account rather than the browser
router.post('/prompt-dismissed', requireAuth, async (req: AuthenticatedRequest, res) => {
  await markPromptDismissed(req.user!.id);
  return res.json({ passkeyPromptDismissed: true });
});

export default router;
