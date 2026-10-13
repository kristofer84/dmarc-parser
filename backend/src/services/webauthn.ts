import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts,
} from '@simplewebauthn/server';
import { prisma } from '../db/prisma.js';
import { toAuthUser, type AuthUser } from './auth.js';
import type { WebAuthnConfig } from './webauthnConfig.js';

/**
 * Passkey ceremonies.
 *
 * Passwords stay the fallback everywhere in this design: nothing here can lock a user out
 * of their own account, and an administrator can delete every credential a user has
 * without touching the password hash.
 *
 * Three things about this file are load-bearing:
 *
 * 1. The challenge is the anti-replay nonce. It is minted by the library, kept server-side
 *    here, and matched against what the browser signs; a challenge that arrives from the
 *    client without a matching issued ceremony is never trusted, because the whole point
 *    of the signature is that it covers a value the client could not have chosen.
 * 2. A ceremony is consumed exactly once, before verification runs - not after it
 *    succeeds. Otherwise a captured assertion could be replayed against the same
 *    challenge until one attempt happened to pass.
 * 3. The sign counter is the cloned-authenticator signal. Authenticators that support it
 *    increment a counter on every assertion; a counter that does not move forward means
 *    the private key is in two places at once. Counter-less authenticators report 0
 *    forever, which is why 0 is excluded from that comparison in both directions.
 */

/** The response bodies as the library defines them, so the shapes cannot drift. */
export type RegistrationResponseJSON = VerifyRegistrationResponseOpts['response'];
export type AuthenticationResponseJSON = VerifyAuthenticationResponseOpts['response'];

export type CeremonyType = 'registration' | 'authentication';

interface Ceremony {
  type: CeremonyType;
  /** base64url, exactly as it was handed to the browser. */
  challenge: string;
  /** The account the ceremony was started for; null for a usernameless sign-in. */
  userId: string | null;
  expiresAt: number;
}

const CEREMONY_TTL_MS = 5 * 60 * 1000;

/**
 * Issued ceremonies, awaiting their response.
 *
 * A module-level Map is correct for this application because it ships as a single
 * container with one process (see the all-in-one Dockerfile): the instance that answers
 * /options is always the instance that answers /verify. Behind a load balancer or with
 * more than one replica this breaks completely and confusingly - sign-in fails on every
 * request that lands on the other instance, and only sometimes - so the Map has to become
 * shared state (Redis, or a ceremony row in the database) before this app is ever scaled
 * horizontally. The 5-minute TTL is the same window browsers allow for the ceremony, and
 * the sweep keeps abandoned ceremonies from accumulating.
 */
const ceremonies = new Map<string, Ceremony>();

function sweepExpired(now: number): void {
  for (const [id, ceremony] of ceremonies) {
    if (ceremony.expiresAt <= now) {
      ceremonies.delete(id);
    }
  }
}

function issueCeremony(type: CeremonyType, challenge: string, userId: string | null): string {
  const now = Date.now();
  sweepExpired(now);
  const ceremonyId = randomBytes(24).toString('base64url');
  ceremonies.set(ceremonyId, { type, challenge, userId, expiresAt: now + CEREMONY_TTL_MS });
  return ceremonyId;
}

/** Single-use: the ceremony is gone whether or not the response turns out to verify. */
function consumeCeremony(ceremonyId: string, type: CeremonyType): Ceremony | null {
  const ceremony = ceremonies.get(ceremonyId);
  if (!ceremony) {
    return null;
  }
  ceremonies.delete(ceremonyId);
  if (ceremony.type !== type || ceremony.expiresAt <= Date.now()) {
    return null;
  }
  return ceremony;
}

/**
 * The challenge the client actually signed, taken from the signed clientDataJSON. This is the
 * value that has to be matched against our own records, and reading it here is what lets a
 * client that does not echo a ceremony id still be verified: the id is a convenience for the
 * client, the challenge is the security boundary.
 */
function readSignedChallenge(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): string | null {
  try {
    const clientData = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
    ) as { challenge?: unknown };
    return typeof clientData.challenge === 'string' && clientData.challenge.length > 0
      ? clientData.challenge
      : null;
  } catch {
    return null;
  }
}

/**
 * Takes the ceremony being answered, exactly once.
 *
 * A ceremony id is used when the client sends one - it names the attempt even when the rest of
 * the response is malformed. Without it the ceremony is found by the challenge inside the
 * signed clientDataJSON, which still means "one this server issued, of the right kind, within
 * its TTL, and not yet used": a challenge of the client's own choosing can never be accepted,
 * and a replay finds nothing left to consume.
 */
function takeCeremony(params: {
  ceremonyId: string | null;
  challenge: string | null;
  type: CeremonyType;
}): Ceremony | null {
  if (params.ceremonyId) {
    return consumeCeremony(params.ceremonyId, params.type);
  }

  if (!params.challenge) {
    return null;
  }

  for (const [id, ceremony] of ceremonies) {
    if (ceremony.type !== params.type || ceremony.challenge !== params.challenge) {
      continue;
    }
    ceremonies.delete(id);
    return ceremony.expiresAt <= Date.now() ? null : ceremony;
  }

  return null;
}

/** How many ceremonies are outstanding; used by the tests to pin the single-use guarantee. */
export function pendingCeremonyCount(): number {
  return ceremonies.size;
}

const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
type Transport = (typeof TRANSPORTS)[number];

/** Transports arrive as JSON text because SQLite has no array column here. */
function parseTransports(raw: string): Transport[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is Transport =>
      TRANSPORTS.includes(value as Transport),
    );
  } catch {
    return [];
  }
}

/** How the account's id is handed to the authenticator: it must be bytes, as base64url. */
function userHandleFor(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

function audit(message: string, details?: Record<string, unknown>): void {
  const suffix = details
    ? ` ${Object.entries(details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')}`
    : '';
  console.log(`🔑 passkey ${message}${suffix}`);
}

export type WebAuthnFailureReason =
  | 'disabled'
  | 'unknown_challenge'
  | 'invalid_response'
  | 'duplicate_credential'
  | 'no_credential'
  | 'counter_regression';

export type WebAuthnFailure = {
  ok: false;
  reason: WebAuthnFailureReason;
  message: string;
};

/**
 * Login failures are deliberately indistinguishable: an attacker must not learn from the
 * response whether a credential - and therefore an account - exists.
 */
const GENERIC_LOGIN_FAILURE = 'That passkey could not be verified';

export interface CeremonyStart {
  ceremonyId: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}

export interface AuthenticationCeremonyStart {
  ceremonyId: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}

export async function startRegistration(
  user: { id: string; email: string; name: string | null },
  config: WebAuthnConfig,
): Promise<CeremonyStart> {
  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    // The account id is the library's `userID`; it round-trips through the authenticator
    // as the user handle, so it is base64url-encoded rather than sent as a raw cuid.
    userID: userHandleFor(user.id),
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    // Excluded so an authenticator that already holds a passkey for this account says so
    // in the browser, instead of silently creating a second credential for the same key.
    excludeCredentials: existing.map((credential) => ({
      id: Buffer.from(credential.credentialId, 'base64url'),
      type: 'public-key' as const,
      transports: parseTransports(credential.transports),
    })),
  });

  const ceremonyId = issueCeremony('registration', options.challenge, user.id);
  return { ceremonyId, options };
}

export interface RegistrationResult {
  ok: true;
  credential: {
    id: string;
    label: string | null;
    deviceType: string | null;
    backedUp: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
  };
}

export async function finishRegistration(
  params: {
    userId: string;
    userEmail: string;
    ceremonyId: string | null;
    response: RegistrationResponseJSON;
    label?: string | null;
  },
  config: WebAuthnConfig,
): Promise<RegistrationResult | WebAuthnFailure> {
  const ceremony = takeCeremony({
    ceremonyId: params.ceremonyId,
    challenge: readSignedChallenge(params.response),
    type: 'registration',
  });
  if (!ceremony || ceremony.userId !== params.userId) {
    audit('registration rejected: unknown ceremony', { user: params.userEmail });
    return {
      ok: false,
      reason: 'unknown_challenge',
      message: 'This registration attempt has expired. Start again.',
    };
  }

  // Passing expectedOrigin and expectedRPID is what makes the browser's binding real: the
  // library compares both against the value the authenticator signed over.
  const verification = await verifyRegistrationResponse({
    response: params.response,
    expectedChallenge: ceremony.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    // The options advertise userVerification: 'preferred', which means "ask for it, but do
    // not reject a security key that only proves presence". Requiring it here would reject
    // exactly those authenticators. Raise both together to 'required'/true to enforce it.
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    audit('registration rejected: verification failed', { user: params.userEmail });
    return {
      ok: false,
      reason: 'invalid_response',
      message: 'That passkey could not be verified',
    };
  }

  const { credentialID, credentialPublicKey, counter, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  // base64url in both directions, as the schema and the library both expect.
  const credentialId = Buffer.from(credentialID).toString('base64url');
  const publicKey = Buffer.from(credentialPublicKey).toString('base64url');

  const duplicate = await prisma.webAuthnCredential.findUnique({ where: { credentialId } });
  if (duplicate) {
    audit('registration rejected: credential already registered', {
      user: params.userEmail,
      owner: duplicate.userId === params.userId ? 'self' : 'other-account',
    });
    return {
      ok: false,
      reason: 'duplicate_credential',
      message: 'That passkey is already registered',
    };
  }

  const label =
    typeof params.label === 'string' && params.label.trim().length > 0
      ? params.label.trim().slice(0, 64)
      : null;

  const transports = params.response.response.transports ?? [];

  const created = await prisma.webAuthnCredential.create({
    data: {
      userId: params.userId,
      credentialId,
      publicKey,
      counter,
      transports: JSON.stringify(transports.filter((t) => TRANSPORTS.includes(t as Transport))),
      label,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    },
  });

  audit('registered', {
    user: params.userEmail,
    label: label ?? '(unlabelled)',
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  });

  return {
    ok: true,
    credential: {
      id: created.id,
      label: created.label,
      deviceType: created.deviceType,
      backedUp: created.backedUp,
      createdAt: created.createdAt,
      lastUsedAt: created.lastUsedAt,
    },
  };
}

/**
 * Usernameless sign-in: the options carry no credential ids, so the browser offers every
 * discoverable passkey it holds for this RP and the account is identified from the
 * credential that comes back.
 */
export async function startAuthentication(config: WebAuthnConfig): Promise<AuthenticationCeremonyStart> {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials: [],
    userVerification: 'preferred',
  });

  const ceremonyId = issueCeremony('authentication', options.challenge, null);
  return { ceremonyId, options };
}

export type AuthenticationResult = { ok: true; user: AuthUser } | WebAuthnFailure;

/**
 * The cloned-authenticator rule, stated once: an authenticator that implements a sign
 * counter must move it forward on every assertion, so a counter that does not advance means
 * the private key is in two places at once. 0 means the authenticator does not implement a
 * counter at all (many platform passkeys report 0 forever), which is why 0 is excluded at
 * both ends rather than treated as "went backwards".
 */
export function isCounterRegression(storedCounter: number, presentedCounter: number): boolean {
  return presentedCounter !== 0 && storedCounter !== 0 && presentedCounter <= storedCounter;
}

/**
 * The sign counter read straight out of an assertion's authenticator data: 32 bytes of RP ID
 * hash, one byte of flags, then a 4-byte big-endian counter (WebAuthn 6.1). Read here so
 * that this module enforces the rule above itself instead of delegating the only check to
 * the library - the library applies the same rule during verification and remains as a
 * second opinion, but a dependency bump must not be able to switch the signal off silently.
 */
function readAssertionCounter(response: AuthenticationResponseJSON): number | null {
  const authData = Buffer.from(response.response.authenticatorData, 'base64url');
  if (authData.length < 37) {
    return null;
  }
  return authData.readUInt32BE(33);
}

export async function finishAuthentication(
  params: { ceremonyId: string | null; response: AuthenticationResponseJSON },
  config: WebAuthnConfig,
): Promise<AuthenticationResult> {
  const ceremony = takeCeremony({
    ceremonyId: params.ceremonyId,
    challenge: readSignedChallenge(params.response),
    type: 'authentication',
  });
  if (!ceremony) {
    audit('login rejected: unknown ceremony');
    return { ok: false, reason: 'unknown_challenge', message: 'This sign-in attempt has expired. Try again.' };
  }

  const stored = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: params.response.id },
    include: { user: { include: { _count: { select: { webauthnCredentials: true } } } } },
  });

  // Same response as a bad signature: whether this credential is registered anywhere is
  // not the caller's business.
  if (!stored) {
    audit('login rejected: unknown credential');
    return { ok: false, reason: 'no_credential', message: GENERIC_LOGIN_FAILURE };
  }

  if (!stored.user.isActive) {
    audit('login rejected: inactive account', { user: stored.user.email });
    return { ok: false, reason: 'invalid_response', message: GENERIC_LOGIN_FAILURE };
  }

  // A discoverable credential carries the account id it was created for. Mismatches mean
  // the client paired one account's credential id with another's handle.
  if (params.response.response.userHandle && params.response.response.userHandle !== userHandleFor(stored.userId)) {
    audit('login rejected: user handle mismatch', { user: stored.user.email });
    return { ok: false, reason: 'invalid_response', message: GENERIC_LOGIN_FAILURE };
  }

  const presentedCounter = readAssertionCounter(params.response);
  if (presentedCounter !== null && isCounterRegression(stored.counter, presentedCounter)) {
    // Rejected before the signature is even checked: a counter that did not move is a
    // stronger signal than whether this particular signature happens to verify.
    audit('COUNTER REGRESSION - possible cloned authenticator', {
      user: stored.user.email,
      storedCounter: stored.counter,
      presentedCounter,
    });
    return { ok: false, reason: 'counter_regression', message: GENERIC_LOGIN_FAILURE };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      // Both non-zero counters must move forward; 0 means the authenticator does not
      // implement a counter, and the library applies the same exclusion.
      authenticator: {
        credentialID: Buffer.from(stored.credentialId, 'base64url'),
        credentialPublicKey: Buffer.from(stored.publicKey, 'base64url'),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('counter value')) {
      // The library's own backstop, reached when an authenticator reports 0 after having
      // reported a real count - a wiped or re-cloned device rather than a stale sign-in.
      // It throws before checking the signature, so this is still a valid assertion whose
      // key appears to be in two places. Treat it as an incident, not a typo.
      audit('COUNTER REGRESSION - possible cloned authenticator', {
        user: stored.user.email,
        storedCounter: stored.counter,
        reported: message,
      });
      return { ok: false, reason: 'counter_regression', message: GENERIC_LOGIN_FAILURE };
    }
    audit('login rejected: verification error', { user: stored.user.email, error: message });
    return { ok: false, reason: 'invalid_response', message: GENERIC_LOGIN_FAILURE };
  }

  if (!verification.verified) {
    audit('login rejected: bad signature', { user: stored.user.email });
    return { ok: false, reason: 'invalid_response', message: GENERIC_LOGIN_FAILURE };
  }

  const newCounter = verification.authenticationInfo.newCounter;

  const user = await prisma.user.update({
    where: { id: stored.userId },
    data: {
      lastLoginAt: new Date(),
      // The lockout exists to stop password guessing. A verified assertion is proof of
      // possession of a registered key, so a failed-password lockout must not stand in the
      // way - otherwise anyone could lock a user out of their own passkey by guessing.
      failedLoginCount: 0,
      lockedUntil: null,
    },
    include: { _count: { select: { webauthnCredentials: true } } },
  });

  await prisma.webAuthnCredential.update({
    where: { id: stored.id },
    data: {
      counter: newCounter,
      lastUsedAt: new Date(),
      // A passkey can be re-registered to a newer device type (e.g. an iCloud keychain
      // copy), and the sync state is only reported by the authenticator on each assertion.
      backedUp: verification.authenticationInfo.credentialBackedUp,
      deviceType: verification.authenticationInfo.credentialDeviceType,
    },
  });

  audit('login', {
    user: user.email,
    credential: stored.label ?? stored.id,
    counter: newCounter,
  });

  return { ok: true, user: toAuthUser(user) };
}

export interface CredentialSummary {
  id: string;
  label: string | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * The client-facing shape. Note what is absent: the public key and the credential id are
 * never returned, because a passkey is only safe while its credential id stays out of a
 * page that an attacker might read; the row id is enough to list and delete one.
 */
export async function listCredentials(userId: string): Promise<CredentialSummary[]> {
  const rows = await prisma.webAuthnCredential.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function removeCredential(userId: string, id: string): Promise<boolean> {
  // Scoped by userId in the query itself: another account's credential id deletes nothing,
  // so it cannot be distinguished from one that never existed.
  const result = await prisma.webAuthnCredential.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** The account-recovery path when a device is lost: remove every passkey the user has. */
export async function removeAllCredentialsForUser(userId: string): Promise<number> {
  const result = await prisma.webAuthnCredential.deleteMany({ where: { userId } });
  return result.count;
}

export async function markPromptDismissed(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passkeyPromptDismissedAt: new Date() },
  });
}
