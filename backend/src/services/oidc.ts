import { randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import { prisma } from '../db/prisma.js';
import { hashPassword, toAuthUser, type AuthUser, type UserRole } from './auth.js';

/**
 * OpenID Connect sign-in.
 *
 * Passwords and passkeys are untouched: this is a third way into an account and every
 * failure here leaves the other two working. A successful sign-in goes through the same
 * createSession()/setSessionCookie() pair as a password login, so domain scoping and the
 * audit trail are identical by construction.
 *
 * The trust assumption, stated once: the configured identity provider is trusted to say who
 * a subject is. The one thing it is *not* trusted to do unattended is prove ownership of an
 * email address - linking an external subject to an existing local account is an
 * account-takeover primitive unless the provider marks the email verified. So `email_verified`
 * (never the bare `email`) is what authorises a link.
 *
 * Two things about openid-client v6 are load-bearing here:
 *  - `authorizationCodeGrant()` validates the id_token's claims (issuer, audience, expiry,
 *    nonce) but does NOT verify its signature unless `enableNonRepudiationChecks` has been
 *    applied to the Configuration. Without that, a token signed by a key the provider never
 *    published would be accepted; the JWKS check is therefore switched on explicitly, not
 *    assumed.
 *  - The library enforces HTTPS unless `allowInsecureRequests` is applied, which is done
 *    *only* for loopback issuers, because otherwise a provider could point jwks_uri at plain
 *    http and have us fetch signing keys unauthenticated.
 *
 * Claims are only ever read from `tokens.claims()` after `authorizationCodeGrant()` returned
 * with both checks above active; nothing before that is trusted.
 */

/** The provider row as this service needs it, so callers can pass a Prisma row directly. */
export interface OidcProvider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowAutoProvision: boolean;
  adminGroup: string | null;
  groupsClaim: string;
  defaultDomains: string;
}

export type OidcFailureReason =
  | 'state_invalid'
  | 'token_invalid'
  | 'email_unverified'
  | 'provisioning_disabled'
  | 'provider_disabled';

export type OidcLoginResult =
  | { ok: true; user: AuthUser; outcome: 'signed_in' | 'linked' | 'provisioned'; role: UserRole }
  | { ok: false; reason: OidcFailureReason };

export interface AuthorizationStart {
  url: string;
  state: string;
}

function audit(message: string, details?: Record<string, unknown>): void {
  const suffix = details
    ? ` ${Object.entries(details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')}`
    : '';
  console.log(`🔐 oidc ${message}${suffix}`);
}

function validationError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code: 'VALIDATION_ERROR' });
}

/**
 * An issuer must be https, with plain http allowed only for loopback so that a local
 * development identity provider (and the test stub) can work. `issuer` drives both the
 * discovery fetch and the JWKS URL, so accepting a non-TLS issuer in production would let
 * anyone who can answer for it choose the keys we verify id_tokens against.
 */
export function assertValidIssuer(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw validationError('issuer is required');
  }

  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError('issuer must be a valid absolute URL');
  }

  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw validationError('issuer must use https:// (http:// is allowed only for localhost)');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw validationError('issuer must not contain a query string or fragment');
  }

  return value;
}

/** `defaultDomains` is JSON text because SQLite has no array column here. */
export function parseDefaultDomains(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

/** What an admin API response may contain: never the secret, only whether one is set. */
export function serializeProvider(provider: OidcProvider & { createdAt: Date; updatedAt: Date }) {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecretSet: provider.clientSecret.trim().length > 0,
    scopes: provider.scopes,
    allowAutoProvision: provider.allowAutoProvision,
    adminGroup: provider.adminGroup,
    groupsClaim: provider.groupsClaim,
    defaultDomains: parseDefaultDomains(provider.defaultDomains),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------- discovery + config cache

interface CachedConfig {
  config: client.Configuration;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Resolved provider metadata, kept between requests so a login does not re-fetch the
 * discovery document (and so the JWKS cache inside openid-client survives). A module-level
 * Map is correct for this application because it ships as a single container with one
 * process: the instance that answers /start is the instance that answers /callback. Behind a
 * load balancer this - and the ceremony Map below - would need shared state instead.
 *
 * The cache is validated against the row on every use, so a changed issuer or secret is
 * either rediscovered or explicitly invalidated on write; it can never serve stale keys.
 */
const configCache = new Map<string, CachedConfig>();

export function invalidateProviderCache(providerId?: string): void {
  if (providerId === undefined) {
    configCache.clear();
    return;
  }
  configCache.delete(providerId);
}

function isLoopbackHttp(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

async function discover(
  provider: Pick<OidcProvider, 'id' | 'issuer' | 'clientId' | 'clientSecret'>,
  fresh: boolean,
): Promise<client.Configuration> {
  const cached = configCache.get(provider.id);
  if (
    !fresh &&
    cached &&
    cached.issuer === provider.issuer &&
    cached.clientId === provider.clientId &&
    cached.clientSecret === provider.clientSecret
  ) {
    return cached.config;
  }

  const config = await client.discovery(
    new URL(provider.issuer),
    provider.clientId,
    { client_secret: provider.clientSecret },
    client.ClientSecretPost(provider.clientSecret),
    // `enableNonRepudiationChecks` is what makes the library verify the id_token's signature
    // against the provider's JWKS; it is not on by default. `allowInsecureRequests` is only
    // ever added for a loopback issuer: see the module comment.
    {
      execute: [
        client.enableNonRepudiationChecks,
        ...(isLoopbackHttp(provider.issuer) ? [client.allowInsecureRequests] : []),
      ],
    },
  );

  configCache.set(provider.id, {
    config,
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
  });
  return config;
}

export interface ProviderTestResult {
  ok: boolean;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  message?: string;
}

/**
 * Fetches the discovery document without touching the cache: the point of the admin "test"
 * button is to find out whether the issuer answers *now*, not whether it once did.
 */
export async function testProvider(
  provider: Pick<OidcProvider, 'issuer' | 'clientId' | 'clientSecret'>,
): Promise<ProviderTestResult> {
  try {
    const config = await client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      { client_secret: provider.clientSecret },
      client.ClientSecretPost(provider.clientSecret),
      { execute: isLoopbackHttp(provider.issuer) ? [client.allowInsecureRequests] : [] },
    );
    const metadata = config.serverMetadata();
    return {
      ok: true,
      issuer: metadata.issuer,
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      jwks_uri: metadata.jwks_uri,
    };
  } catch (error) {
    // A failed test is information, not an error: the caller turns this into a 200.
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not read the discovery document',
    };
  }
}

// ---------------------------------------------------------------- ceremony state

interface LoginCeremony {
  providerId: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

/**
 * PKCE verifiers and nonces awaiting their callback, keyed by the single-use `state`.
 *
 * Same reasoning as the WebAuthn ceremony Map: one container, one process. The state is the
 * anti-CSRF value - it is minted here, bound to the provider that started the flow, and
 * consumed before anything else happens in the callback, so a captured callback cannot be
 * replayed and a state issued for one provider cannot be spent on another.
 */
const ceremonies = new Map<string, LoginCeremony>();
const CEREMONY_TTL_MS = 10 * 60 * 1000;

function sweepExpiredCeremonies(now: number): void {
  for (const [state, ceremony] of ceremonies) {
    if (ceremony.expiresAt <= now) {
      ceremonies.delete(state);
    }
  }
}

/** Test hook: how many logins are in flight. */
export function pendingCeremonyCount(): number {
  return ceremonies.size;
}

async function loadEnabledProvider(providerId: string): Promise<OidcProvider | null> {
  const provider = await prisma.authProvider.findUnique({ where: { id: providerId } });
  // Product types are not implemented; treating anything else as disabled keeps a future
  // type from being usable before its code exists.
  if (!provider || !provider.enabled || provider.type !== 'oidc') {
    return null;
  }
  return provider;
}

export type BeginLoginResult = { ok: true; start: AuthorizationStart } | { ok: false; reason: 'provider_disabled' };

export async function beginLogin(
  providerId: string,
  redirectUri: string,
): Promise<BeginLoginResult> {
  const provider = await loadEnabledProvider(providerId);
  if (!provider) {
    audit('start rejected: provider unavailable', { provider: providerId });
    return { ok: false, reason: 'provider_disabled' };
  }

  const config = await discover(provider, false);

  const now = Date.now();
  sweepExpiredCeremonies(now);

  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: provider.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  ceremonies.set(state, { providerId, nonce, codeVerifier, expiresAt: now + CEREMONY_TTL_MS });
  audit('start', { provider: provider.name, issuer: provider.issuer });

  return { ok: true, start: { url: url.toString(), state } };
}

// ---------------------------------------------------------------- callback

/**
 * Consumes a state exactly once and returns its ceremony. A reused, unknown, expired or
 * wrong-provider state all answer the same way: there is nothing useful to distinguish.
 */
function takeCeremony(state: string | null, providerId: string): LoginCeremony | null {
  if (!state) {
    return null;
  }
  const ceremony = ceremonies.get(state);
  if (!ceremony) {
    return null;
  }
  // Deleted before use, never after success - a captured callback must not be replayable.
  ceremonies.delete(state);
  if (ceremony.expiresAt <= Date.now() || ceremony.providerId !== providerId) {
    return null;
  }
  return ceremony;
}

/** The groups claim may be a single string or an array of them; anything else is ignored. */
function readGroups(claims: client.IDToken, claimName: string): string[] {
  const raw = claims[claimName];
  if (typeof raw === 'string' && raw.length > 0) {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string');
  }
  return [];
}

function readStringClaim(claims: client.IDToken, name: string): string | null {
  const raw = claims[name];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function grantedRole(groups: string[], adminGroup: string | null): UserRole {
  if (!adminGroup) {
    return 'user';
  }
  return groups.includes(adminGroup) ? 'admin' : 'user';
}

async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { _count: { select: { webauthnCredentials: true } } },
  });
  return user ? toAuthUser(user) : null;
}

export interface CompleteLoginParams {
  providerId: string;
  code: string | null;
  state: string | null;
  /** The URL the browser hit, query string included; openid-client reads the response from it. */
  currentUrl: URL;
}

export async function completeLogin(params: CompleteLoginParams): Promise<OidcLoginResult> {
  const ceremony = takeCeremony(params.state, params.providerId);
  if (!ceremony) {
    audit('login rejected: state invalid', { provider: params.providerId });
    return { ok: false, reason: 'state_invalid' };
  }

  if (!params.code) {
    audit('login rejected: no authorization code', { provider: params.providerId });
    return { ok: false, reason: 'token_invalid' };
  }

  const provider = await loadEnabledProvider(params.providerId);
  if (!provider) {
    audit('login rejected: provider unavailable', { provider: params.providerId });
    return { ok: false, reason: 'provider_disabled' };
  }

  let claims: client.IDToken;
  try {
    const config = await discover(provider, false);
    const tokens = await client.authorizationCodeGrant(config, params.currentUrl, {
      expectedState: params.state ?? undefined,
      expectedNonce: ceremony.nonce,
      pkceCodeVerifier: ceremony.codeVerifier,
      // An id_token is the whole point; without one there is nothing to link or provision from.
      idTokenExpected: true,
    });

    // Validated by the call above (JWKS signature, issuer, audience, expiry, nonce). Claims are
    // never read before this line.
    const parsed = tokens.claims();
    if (!parsed) {
      throw new Error('the token response carried no id_token');
    }
    claims = parsed;
  } catch (error) {
    audit('login rejected: token validation failed', {
      provider: provider.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'token_invalid' };
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  if (!subject) {
    audit('login rejected: id_token has no subject', { provider: provider.name });
    return { ok: false, reason: 'token_invalid' };
  }

  const email = readStringClaim(claims, 'email')?.toLowerCase() ?? null;
  const emailVerified = claims.email_verified === true;
  const groups = readGroups(claims, provider.groupsClaim);

  // 1. A subject we have seen before signs in; nothing else about the token can change that.
  const identity = await prisma.userIdentity.findUnique({
    where: { providerId_subject: { providerId: provider.id, subject } },
    include: { user: true },
  });

  if (identity) {
    if (!identity.user.isActive) {
      audit('login rejected: inactive account', { provider: provider.name, user: identity.user.email });
      return { ok: false, reason: 'token_invalid' };
    }

    await prisma.userIdentity.update({ where: { id: identity.id }, data: { lastLoginAt: new Date() } });
    // A successful federated sign-in clears the password lockout counter exactly as a password
    // login would; the account has demonstrably been authenticated either way.
    await prisma.user.update({
      where: { id: identity.user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });

    const user = await loadAuthUser(identity.user.id);
    if (!user) {
      return { ok: false, reason: 'token_invalid' };
    }
    audit('login known identity', { provider: provider.name, user: user.email, role: user.role });
    return { ok: true, user, outcome: 'signed_in', role: user.role };
  }

  // 2. An unverified (or absent) email never links and never provisions. This is the
  //    account-takeover guard: a provider that lets a user set an arbitrary unverified email
  //    must not be able to claim an account here. The answer is generic on purpose - it does
  //    not reveal whether such an account exists.
  if (!email || !emailVerified) {
    audit('login rejected: email unverified', {
      provider: provider.name,
      subject,
      emailPresent: email !== null,
    });
    return { ok: false, reason: 'email_unverified' };
  }

  // allowAutoProvision is the consent an admin gave by configuring this provider; the global
  // auth.registrationOpen setting deliberately plays no part here. It also gates linking an
  // identity to an existing account, because creating that identity row is itself provisioning:
  // turning the flag off means "only subjects/accounts we already know", not "new users only".
  if (!provider.allowAutoProvision) {
    audit('login rejected: provisioning disabled', { provider: provider.name, email });
    return { ok: false, reason: 'provisioning_disabled' };
  }

  const role = grantedRole(groups, provider.adminGroup);

  // 3. A verified email matching an existing account links that account - the one moment the
  //    provider is trusted to speak for a local user.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.isActive) {
      audit('login rejected: inactive account', { provider: provider.name, user: existing.email });
      return { ok: false, reason: 'token_invalid' };
    }

    try {
      await prisma.userIdentity.create({
        data: { userId: existing.id, providerId: provider.id, subject, email, lastLoginAt: new Date() },
      });
    } catch (error) {
      // A concurrent callback for the same subject won the race; the identity now exists, so
      // the intent of this request is satisfied rather than surfaced as a 500.
      const raced = await prisma.userIdentity.findUnique({
        where: { providerId_subject: { providerId: provider.id, subject } },
      });
      if (!raced || raced.userId !== existing.id) {
        audit('login rejected: could not link identity', {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, reason: 'token_invalid' };
      }
    }

    await prisma.user.update({
      where: { id: existing.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });

    const user = await loadAuthUser(existing.id);
    if (!user) {
      return { ok: false, reason: 'token_invalid' };
    }
    // Linking never changes the existing account's role: the groups claim decides the role at
    // provisioning time only, so a renamed group cannot escalate an account that already exists.
    audit('login linked to existing account', {
      provider: provider.name,
      user: user.email,
      role: user.role,
      claimRole: role,
    });
    return { ok: true, user, outcome: 'linked', role: user.role };
  }

  // 4. No identity, no account, allowed to provision: create both, in one transaction so a
  //    failure cannot leave a user nobody can ever sign in as (an orphan has no password).
  const defaultDomains = parseDefaultDomains(provider.defaultDomains);
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        name: readStringClaim(claims, 'name') ?? readStringClaim(claims, 'preferred_username'),
        // A federated account has no password the user knows. A random one that is never
        // revealed keeps the column honest (and the account password-login-able only after an
        // administrator resets it) without inventing a nullable password.
        passwordHash: hashPassword(randomBytes(32).toString('base64url')),
        role,
        isActive: true,
      },
    });

    await tx.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject, email, lastLoginAt: new Date() },
    });

    if (defaultDomains.length > 0) {
      await tx.userDomain.createMany({
        data: defaultDomains.map((domain) => ({ userId: user.id, domain })),
      });
    }

    return user;
  });

  const user = await loadAuthUser(created.id);
  if (!user) {
    return { ok: false, reason: 'token_invalid' };
  }
  audit('login provisioned', {
    provider: provider.name,
    user: user.email,
    role: user.role,
    domains: defaultDomains.join(',') || '(none)',
  });
  return { ok: true, user, outcome: 'provisioned', role: user.role };
}
