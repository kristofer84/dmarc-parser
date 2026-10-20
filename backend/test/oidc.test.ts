import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';

/**
 * Tests for OIDC single-sign-on.
 *
 * Nothing about the protocol is mocked. A real RSA keypair is generated with node:crypto, a
 * real identity provider (discovery document, JWKS, authorize and token endpoints) is stood
 * up on an ephemeral port, and the app's own routes are driven over HTTP with redirects
 * followed by hand. That matters here: the entire risk of the feature is in what the server
 * accepts from the provider, and a stubbed verifier would prove only that the stub ran.
 *
 * The environment has to be set before the application modules are imported, because
 * config/env.ts and the Prisma client read it at import time - hence the dynamic imports.
 * PUBLIC_ORIGIN is deliberately left unset so the callback URL is derived from the request,
 * exactly as it is in a same-origin deployment.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = dirname(here);

const CLIENT_ID = 'dmarc-console';
const CLIENT_SECRET = 'stub-client-secret-value';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-oidc-'));
const databaseFile = join(tempDir, 'oidc-test.db');

process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.NODE_ENV = 'test';
process.env.ENABLE_SCHEDULED_EMAIL_PROCESSING = 'false';
delete process.env.PUBLIC_ORIGIN;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ ${name}\n     ${message}`);
  }
}

// ---------------------------------------------------------------- signing keys

interface SigningKey {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function newRsaKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function signJwt(payload: Record<string, unknown>, key: SigningKey, kid: string): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput), key.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

const signingKey = newRsaKey('test-key');
// A second, valid-looking key that is absent from the JWKS: what a forged token looks like.
const otherKey = newRsaKey('other-key');

// ---------------------------------------------------------------- stub identity provider

/** Mutable behaviour of the stub, set by each test before a flow is started. */
const stub = {
  sub: 'sub-initial',
  email: 'oidc-user@test.local',
  emailVerified: true,
  omitEmailVerified: false,
  name: 'OIDC User',
  groups: [] as string[],
  tamperNonce: false,
  signWithUnknownKey: false,
};

/** Remembers the nonce/redirect_uri/challenge an authorization request arrived with, keyed by code. */
const pendingCodes = new Map<
  string,
  { nonce: string; redirectUri: string; state: string; challenge: string }
>();

let stubBase = '';

function buildStubIssuer(): express.Application {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer: stubBase,
      authorization_endpoint: `${stubBase}/authorize`,
      token_endpoint: `${stubBase}/token`,
      jwks_uri: `${stubBase}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['openid', 'email', 'profile'],
    });
  });

  app.get('/jwks', (_req, res) => {
    res.json({ keys: [signingKey.jwk] });
  });

  app.get('/authorize', (req, res) => {
    const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    const challenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
    if (!redirectUri) {
      res.status(400).send('missing redirect_uri');
      return;
    }
    if (!challenge) {
      res.status(400).send('missing code_challenge');
      return;
    }

    const code = randomBytes(16).toString('hex');
    pendingCodes.set(code, { nonce, redirectUri, state, challenge });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    res.redirect(302, target.toString());
  });

  app.post('/token', (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const entry = pendingCodes.get(code);
    if (!entry) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    pendingCodes.delete(code);

    // PKCE is enforced rather than recorded: the verifier must hash to the challenge sent on
    // the authorization request, so a client that only pretended to use PKCE fails here.
    const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';
    const derived = createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || derived !== entry.challenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'pkce mismatch' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: stubBase,
      sub: stub.sub,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 300,
      nonce: stub.tamperNonce ? 'definitely-not-the-nonce' : entry.nonce,
      email: stub.email,
      // Entra ID and others leave the claim out entirely rather than sending false.
      ...(stub.omitEmailVerified ? {} : { email_verified: stub.emailVerified }),
      name: stub.name,
      ...(stub.groups.length > 0 ? { groups: stub.groups } : {}),
    };

    const key = stub.signWithUnknownKey ? otherKey : signingKey;
    const kid = stub.signWithUnknownKey ? 'other-key' : 'test-key';

    res.json({
      access_token: 'stub-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: signJwt(claims, key, kid),
    });
  });

  return app;
}

/** Fresh subject and default claims for one flow; the subject is unique per call by design. */
function scenario(overrides: Partial<typeof stub> = {}): string {
  Object.assign(stub, {
    email: 'oidc-user@test.local',
    emailVerified: true,
    omitEmailVerified: false,
    name: 'OIDC User',
    groups: [],
    tamperNonce: false,
    signWithUnknownKey: false,
    ...overrides,
  });
  stub.sub = `sub-${randomBytes(8).toString('hex')}`;
  return stub.sub;
}

// ---------------------------------------------------------------- throwaway app instance

interface CallResult {
  status: number;
  location: string | null;
  cookie: string | null;
  body: any;
}

let base = '';
let prisma: typeof import('../src/db/prisma.js').prisma;
let server: import('node:http').Server;
let invalidateProviderCache: typeof import('../src/services/oidc.js').invalidateProviderCache;
let pendingCeremonies: typeof import('../src/services/oidc.js').pendingCeremonyCount;

let adminCookie = '';
let mainProvider: { id: string; name: string };
let disabledProvider: { id: string; name: string };

async function call(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const setCookie = response.headers.get('set-cookie');
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: response.status,
    location: response.headers.get('location'),
    cookie: setCookie ? setCookie.split(';')[0] : null,
    body,
  };
}

async function loginWithPassword(email: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', {
    body: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(result.status, 200, `password login failed: ${JSON.stringify(result.body)}`);
  assert.ok(result.cookie, 'a successful password login must set a session cookie');
  return result.cookie!;
}

/** Drives /start and the stub's /authorize, returning the callback URL the IdP produced. */
async function beginFlow(providerId = mainProvider.id): Promise<string> {
  const start = await call('GET', `/api/auth/oidc/${providerId}/start`);
  assert.equal(start.status, 302, `start failed: ${JSON.stringify(start.body)}`);
  assert.ok(start.location, 'start must redirect to the provider');

  // The authorization request must carry the anti-CSRF and PKCE parameters.
  const authorizeUrl = new URL(start.location!);
  assert.ok(authorizeUrl.searchParams.get('state'), 'start must send a state');
  assert.ok(authorizeUrl.searchParams.get('nonce'), 'start must send a nonce');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizeUrl.searchParams.get('code_challenge'), 'start must send a PKCE challenge');
  assert.equal(authorizeUrl.searchParams.get('scope'), 'openid email profile');

  const authorize = await fetch(start.location!, { redirect: 'manual' });
  assert.equal(authorize.status, 302, 'the provider must redirect back to the callback');
  const callback = authorize.headers.get('location');
  assert.ok(callback, 'the provider must send a Location');
  return callback!;
}

/** Follows the callback manually, keeping the redirect and the cookie. */
async function hitCallback(callbackUrl: string, cookie?: string): Promise<CallResult> {
  const response = await fetch(callbackUrl, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    location: response.headers.get('location'),
    cookie: setCookie ? setCookie.split(';')[0] : null,
    body,
  };
}

async function configureProvider(overrides: Record<string, unknown>): Promise<void> {
  await prisma.authProvider.update({ where: { id: mainProvider.id }, data: overrides as never });
  invalidateProviderCache(mainProvider.id);
}

try {
  const stubServer = buildStubIssuer().listen(0);
  await new Promise<void>((resolve) => stubServer.once('listening', resolve));
  stubBase = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;

  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const app = await import('../src/app.js');
  ({ prisma } = await import('../src/db/prisma.js'));
  const auth = await import('../src/services/auth.js');
  const oidc = await import('../src/services/oidc.js');
  invalidateProviderCache = oidc.invalidateProviderCache;
  pendingCeremonies = oidc.pendingCeremonyCount;

  await prisma.user.create({
    data: {
      email: 'admin@test.local',
      name: 'Administrator',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      isActive: true,
    },
  });

  mainProvider = await prisma.authProvider.create({
    data: {
      name: 'Test IdP',
      issuer: stubBase,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    },
  });
  disabledProvider = await prisma.authProvider.create({
    data: {
      name: 'Disabled IdP',
      issuer: stubBase,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      enabled: false,
    },
  });

  server = app.createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
} catch (error) {
  console.error('❌ OIDC test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

adminCookie = await loginWithPassword('admin@test.local');

// ---------------------------------------------------------------- discovery of providers

console.log('\nProvider discovery');

await test('the public provider list offers enabled OIDC providers and nothing else', async () => {
  const result = await call('GET', '/api/auth/providers');
  assert.equal(result.status, 200);
  const ids = result.body.providers.map((provider: { id: string }) => provider.id);
  assert.ok(ids.includes(mainProvider.id), 'the enabled provider must be listed');
  assert.ok(!ids.includes(disabledProvider.id), 'a disabled provider must not be listed');
  assert.deepEqual(Object.keys(result.body.providers[0]).sort(), ['id', 'name', 'type']);
});

await test('a disabled provider 404s on /start', async () => {
  const result = await call('GET', `/api/auth/oidc/${disabledProvider.id}/start`);
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'NOT_FOUND');

  const unknown = await call('GET', '/api/auth/oidc/does-not-exist/start');
  assert.equal(unknown.status, 404);
});

await test('the admin list reports clientSecretSet instead of the secret, and never the secret', async () => {
  const result = await call('GET', '/api/providers', { cookie: adminCookie });
  assert.equal(result.status, 200);
  const provider = result.body.data.find((row: { id: string }) => row.id === mainProvider.id);
  assert.ok(provider, 'the provider must be listed for an administrator');
  assert.equal(provider.clientSecretSet, true);
  assert.equal(provider.clientSecret, undefined);
  assert.ok(!JSON.stringify(result.body).includes(CLIENT_SECRET), 'the secret must appear in no body');
});

// ---------------------------------------------------------------- happy path and provisioning

console.log('\nSign-in and provisioning');

await test('a full sign-in sets a session cookie that then authenticates /api/auth/me', async () => {
  scenario({ email: 'first@test.local' });
  const callback = await hitCallback(await beginFlow());

  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.equal(callback.location, '/');
  assert.ok(callback.cookie, 'a successful sign-in must set a session cookie');
  assert.match(callback.cookie!, /^dmarc_session=/);

  const me = await call('GET', '/api/auth/me', { cookie: callback.cookie! });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.email, 'first@test.local');
});

await test('auto-provisioning creates a domain-less ordinary user', async () => {
  scenario({ email: 'provisioned@test.local' });
  const callback = await hitCallback(await beginFlow());
  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.equal(callback.location, '/');

  const user = await prisma.user.findUnique({
    where: { email: 'provisioned@test.local' },
    include: { domains: true, identities: true },
  });
  assert.ok(user, 'the user must have been created');
  assert.equal(user!.role, 'user');
  assert.equal(user!.domains.length, 0, 'a provisioned user gets no domains by default');
  assert.equal(user!.identities.length, 1);
  assert.equal(user!.identities[0].subject, stub.sub);
});

await test('a verified email links to the existing account instead of creating a duplicate', async () => {
  const existing = await prisma.user.create({
    data: {
      email: 'link-me@test.local',
      passwordHash: 'scrypt$16384$8$1$c2FsdA$aGFzaA',
      role: 'user',
    },
  });

  const subject = scenario({ email: 'link-me@test.local' });
  const callback = await hitCallback(await beginFlow());
  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.equal(callback.location, '/');

  const identity = await prisma.userIdentity.findFirst({
    where: { providerId: mainProvider.id, subject },
  });
  assert.ok(identity, 'the identity must have been created');
  assert.equal(identity!.userId, existing.id, 'the identity must point at the existing account');

  const count = await prisma.user.count({ where: { email: 'link-me@test.local' } });
  assert.equal(count, 1, 'linking must not create a second account');

  const me = await call('GET', '/api/auth/me', { cookie: callback.cookie! });
  assert.equal(me.body.user.id, existing.id);
});

await test('an unverified email neither links nor provisions', async () => {
  const existing = await prisma.user.create({
    data: {
      email: 'victim@test.local',
      passwordHash: 'scrypt$16384$8$1$c2FsdA$aGFzaA',
      role: 'user',
    },
  });

  const subject = scenario({ email: 'victim@test.local', emailVerified: false });
  const callback = await hitCallback(await beginFlow());

  assert.equal(callback.status, 302);
  assert.match(callback.location ?? '', /\/login\?error=email_unverified/);
  assert.equal(callback.cookie, null, 'a rejected sign-in must set no cookie');

  const identity = await prisma.userIdentity.findFirst({
    where: { providerId: mainProvider.id, subject },
  });
  assert.equal(identity, null, 'an unverified email must not link');
  assert.equal(
    await prisma.user.count({ where: { email: 'victim@test.local' } }),
    1,
    'no new account may be created for an unverified email',
  );
  assert.equal(
    await prisma.user.count({ where: { id: existing.id } }),
    1,
    'the existing account is untouched',
  );
});

await test('a provider with allowAutoProvision off rejects an unknown account', async () => {
  await configureProvider({ allowAutoProvision: false });
  try {
    const subject = scenario({ email: 'not-allowed@test.local' });
    const callback = await hitCallback(await beginFlow());
    assert.match(callback.location ?? '', /\/login\?error=provisioning_disabled/);

    assert.equal(await prisma.user.count({ where: { email: 'not-allowed@test.local' } }), 0);
    assert.equal(
      await prisma.userIdentity.findFirst({ where: { providerId: mainProvider.id, subject } }),
      null,
    );
  } finally {
    await configureProvider({ allowAutoProvision: true });
  }
});

await test('a provider with allowAutoProvision off still links a pre-created account', async () => {
  // The flag governs creating accounts, not admitting ones an administrator already made: an
  // address with a local account signs in (and gains the identity link) even with it off.
  const existing = await prisma.user.create({
    data: {
      email: 'pre-created@test.local',
      passwordHash: 'scrypt$16384$8$1$c2FsdA$aGFzaA',
      role: 'user',
    },
  });

  await configureProvider({ allowAutoProvision: false });
  try {
    const subject = scenario({ email: 'pre-created@test.local' });
    const callback = await hitCallback(await beginFlow());
    assert.equal(callback.status, 302, JSON.stringify(callback.body));
    assert.equal(callback.location, '/');
    assert.ok(callback.cookie, 'a linked sign-in must set a session cookie');

    const identity = await prisma.userIdentity.findFirst({
      where: { providerId: mainProvider.id, subject },
    });
    assert.ok(identity, 'the identity must be created for the pre-created account');
    assert.equal(identity!.userId, existing.id);
    assert.equal(
      await prisma.user.count({ where: { email: 'pre-created@test.local' } }),
      1,
      'linking must not create a second account',
    );

    const me = await call('GET', '/api/auth/me', { cookie: callback.cookie! });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.user.id, existing.id);
  } finally {
    await configureProvider({ allowAutoProvision: true });
  }
});

await test('an absent email_verified claim is refused without the opt-in', async () => {
  // Not every provider sends the marker (Entra ID v2.0 does not). Absence is not consent:
  // the strict default still refuses it.
  scenario({ email: 'no-marker@test.local', omitEmailVerified: true });
  const callback = await hitCallback(await beginFlow());
  assert.match(callback.location ?? '', /\/login\?error=email_unverified/);
  assert.equal(callback.cookie, null);
  assert.equal(await prisma.user.count({ where: { email: 'no-marker@test.local' } }), 0);
});

await test('the trustUnverifiedEmail opt-in accepts an absent claim and provisions', async () => {
  await configureProvider({ trustUnverifiedEmail: true });
  try {
    scenario({ email: 'trusted-marker@test.local', omitEmailVerified: true });
    const callback = await hitCallback(await beginFlow());
    assert.equal(callback.status, 302, JSON.stringify(callback.body));
    assert.equal(callback.location, '/');
    assert.ok(callback.cookie, 'a provisioned sign-in must set a session cookie');

    const user = await prisma.user.findUnique({ where: { email: 'trusted-marker@test.local' } });
    assert.ok(user, 'the opt-in must allow provisioning from the bare email claim');
  } finally {
    await configureProvider({ trustUnverifiedEmail: false });
  }
});

await test('the opt-in never overrides an explicit email_verified: false', async () => {
  // A provider that says "not verified" must not be overruled by a setting meant for providers
  // that say nothing at all.
  await configureProvider({ trustUnverifiedEmail: true });
  try {
    scenario({ email: 'explicitly-unverified@test.local', emailVerified: false });
    const callback = await hitCallback(await beginFlow());
    assert.match(callback.location ?? '', /\/login\?error=email_unverified/);
    assert.equal(callback.cookie, null);
    assert.equal(await prisma.user.count({ where: { email: 'explicitly-unverified@test.local' } }), 0);
  } finally {
    await configureProvider({ trustUnverifiedEmail: false });
  }
});

await test('a groups claim cannot grant administrator: SSO is identity-only', async () => {
  // The stub emits this claim verbatim on the id_token, so the test proves the absence of any
  // group-based promotion rather than assuming the token is clean. A provider that maps a group
  // literally named "admin"/"admins" must not be able to hand out authority in this app.
  scenario({ email: 'oidc-groups@test.local', groups: ['admin', 'admins', 'dmarc-admins'] });
  const callback = await hitCallback(await beginFlow());
  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.equal(callback.location, '/');

  const user = await prisma.user.findUnique({
    where: { email: 'oidc-groups@test.local' },
    include: { domains: true },
  });
  assert.equal(user?.role, 'user', 'no group claim may confer the administrator role');
  assert.equal(user!.domains.length, 0, 'a provisioned SSO user gets no domains');
});

await test('defaultDomains are assigned to a provisioned user', async () => {
  await configureProvider({ defaultDomains: JSON.stringify(['example.com', 'example.org']) });
  try {
    scenario({ email: 'with-domains@test.local' });
    const callback = await hitCallback(await beginFlow());
    assert.equal(callback.status, 302, JSON.stringify(callback.body));

    const user = await prisma.user.findUnique({
      where: { email: 'with-domains@test.local' },
      include: { domains: { orderBy: { domain: 'asc' } } },
    });
    assert.deepEqual(
      user?.domains.map((domain) => domain.domain),
      ['example.com', 'example.org'],
    );

    const me = await call('GET', '/api/auth/me', { cookie: callback.cookie! });
    assert.deepEqual(me.body.domains.sort(), ['example.com', 'example.org']);
  } finally {
    await configureProvider({ defaultDomains: '[]' });
  }
});

// ---------------------------------------------------------------- token validation

console.log('\nToken validation');

await test('an id_token whose nonce does not match is rejected', async () => {
  const subject = scenario({ email: 'bad-nonce@test.local', tamperNonce: true });
  const callback = await hitCallback(await beginFlow());

  assert.match(callback.location ?? '', /\/login\?error=token_invalid/);
  assert.equal(callback.cookie, null);
  assert.equal(await prisma.user.count({ where: { email: 'bad-nonce@test.local' } }), 0);
  assert.equal(
    await prisma.userIdentity.findFirst({ where: { providerId: mainProvider.id, subject } }),
    null,
  );
});

await test('an id_token signed by a key that is not in the JWKS is rejected', async () => {
  const subject = scenario({ email: 'bad-signature@test.local', signWithUnknownKey: true });
  const callback = await hitCallback(await beginFlow());

  assert.match(callback.location ?? '', /\/login\?error=token_invalid/);
  assert.equal(callback.cookie, null);
  assert.equal(await prisma.user.count({ where: { email: 'bad-signature@test.local' } }), 0);
  assert.equal(
    await prisma.userIdentity.findFirst({ where: { providerId: mainProvider.id, subject } }),
    null,
  );
});

// ---------------------------------------------------------------- state handling

console.log('\nState handling');

await test('an unknown state is rejected without contacting the provider', async () => {
  const callback = await call(
    'GET',
    `/api/auth/oidc/${mainProvider.id}/callback?code=whatever&state=nonsense`,
  );
  assert.equal(callback.status, 302);
  assert.match(callback.location ?? '', /\/login\?error=state_invalid/);
  assert.equal(callback.cookie, null);
});

await test('a missing state is rejected', async () => {
  const callback = await call('GET', `/api/auth/oidc/${mainProvider.id}/callback?code=whatever`);
  assert.equal(callback.status, 302);
  assert.match(callback.location ?? '', /\/login\?error=state_invalid/);
});

await test('a state issued for one provider cannot be spent on another', async () => {
  scenario({ email: 'wrong-provider@test.local' });
  const callback = await beginFlow(mainProvider.id);

  // Same state, same code, a different provider id in the path.
  const swapped = callback.replace(
    `/api/auth/oidc/${mainProvider.id}/callback`,
    `/api/auth/oidc/${disabledProvider.id}/callback`,
  );
  const result = await hitCallback(swapped);
  assert.match(result.location ?? '', /\/login\?error=state_invalid/);
  assert.equal(
    await prisma.user.count({ where: { email: 'wrong-provider@test.local' } }),
    0,
  );
});

await test('a state cannot be replayed', async () => {
  scenario({ email: 'replay@test.local' });
  const callback = await beginFlow();

  const first = await hitCallback(callback);
  assert.equal(first.status, 302);
  assert.equal(first.location, '/', 'the first use must succeed');

  const second = await hitCallback(callback);
  assert.equal(second.status, 302);
  assert.match(second.location ?? '', /\/login\?error=state_invalid/);
  assert.equal(second.cookie, null, 'a replayed callback must not mint a second session');

  // One user and one identity, not two.
  assert.equal(await prisma.user.count({ where: { email: 'replay@test.local' } }), 1);
});

await test('no ceremonies are left behind by a completed flow', async () => {
  scenario({ email: 'cleanup@test.local' });
  await hitCallback(await beginFlow());
  // The map is swept per start as well; a completed login must not linger.
  assert.equal(pendingCeremonies(), 0);
});

// ---------------------------------------------------------------- admin API

console.log('\nAdmin provider API');

await test('creating a provider validates the issuer and requires credential fields', async () => {
  const badIssuer = await call('POST', '/api/providers', {
    cookie: adminCookie,
    body: { name: 'Bad', issuer: 'ftp://idp.example.com', clientId: 'x', clientSecret: 'y' },
  });
  assert.equal(badIssuer.status, 400);
  assert.match(badIssuer.body.error.message, /https/);

  const plainHttp = await call('POST', '/api/providers', {
    cookie: adminCookie,
    body: { name: 'Bad', issuer: 'http://idp.example.com', clientId: 'x', clientSecret: 'y' },
  });
  assert.equal(plainHttp.status, 400);

  const missingSecret = await call('POST', '/api/providers', {
    cookie: adminCookie,
    body: { name: 'Bad', issuer: 'https://idp.example.com', clientId: 'x' },
  });
  assert.equal(missingSecret.status, 400);
});

await test('PATCH keeps the stored secret when the field is blank and can disable a provider', async () => {
  const blank = await call('PATCH', `/api/providers/${mainProvider.id}`, {
    cookie: adminCookie,
    body: { clientSecret: '   ' },
  });
  assert.equal(blank.status, 200);
  const stored = await prisma.authProvider.findUnique({ where: { id: mainProvider.id } });
  assert.equal(stored!.clientSecret, CLIENT_SECRET, 'a blank secret must keep the stored one');

  const rename = await call('PATCH', `/api/providers/${mainProvider.id}`, {
    cookie: adminCookie,
    body: { name: 'Renamed IdP' },
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.provider.name, 'Renamed IdP');
  assert.ok(!JSON.stringify(rename.body).includes(CLIENT_SECRET));

  await call('PATCH', `/api/providers/${mainProvider.id}`, {
    cookie: adminCookie,
    body: { name: 'Test IdP' },
  });
});

await test('the test endpoint reports resolved endpoints and answers a bad issuer with ok:false', async () => {
  const good = await call('POST', `/api/providers/${mainProvider.id}/test`, { cookie: adminCookie });
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
  assert.equal(good.body.issuer, stubBase);
  assert.equal(good.body.authorization_endpoint, `${stubBase}/authorize`);
  assert.equal(good.body.token_endpoint, `${stubBase}/token`);
  assert.equal(good.body.jwks_uri, `${stubBase}/jwks`);

  const broken = await prisma.authProvider.create({
    data: {
      name: 'Broken IdP',
      // A loopback port nothing is listening on: reachable URL, unreachable server.
      issuer: 'http://127.0.0.1:9',
      clientId: 'x',
      clientSecret: 'y',
    },
  });
  const bad = await call('POST', `/api/providers/${broken.id}/test`, { cookie: adminCookie });
  assert.equal(bad.status, 200, 'a failed test is information, not an error');
  assert.equal(bad.body.ok, false);
  assert.ok(typeof bad.body.message === 'string' && bad.body.message.length > 0);

  await prisma.authProvider.delete({ where: { id: broken.id } });
});

await test('deleting a provider cascades its identities but keeps the user', async () => {
  const temporary = await prisma.authProvider.create({
    data: {
      name: 'Temporary IdP',
      issuer: stubBase,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: 'cascade@test.local',
      passwordHash: 'scrypt$16384$8$1$c2FsdA$aGFzaA',
      role: 'user',
    },
  });
  await prisma.userIdentity.create({
    data: { userId: user.id, providerId: temporary.id, subject: 'cascade-subject' },
  });

  const removed = await call('DELETE', `/api/providers/${temporary.id}`, { cookie: adminCookie });
  assert.equal(removed.status, 200);
  assert.equal(await prisma.userIdentity.count({ where: { providerId: temporary.id } }), 0);
  assert.ok(await prisma.user.findUnique({ where: { id: user.id } }), 'the account itself survives');
});

// ---------------------------------------------------------------- done

server.close();
await prisma.$disconnect();
rmSync(tempDir, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`, () => resolve());
});
// Explicit: the rate limiter's sweeper interval keeps the event loop alive, so the process
// would otherwise sit here after the suite has finished.
process.exit(failed > 0 ? 1 : 0);
