import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Tests for passkey (WebAuthn) registration and sign-in.
 *
 * Nothing here is mocked. A real P-256 keypair is generated with node:crypto, the
 * attestation object and the assertion signatures are built byte by byte the way an
 * authenticator would (CBOR-encoded COSE key and all), and the requests go over HTTP to a
 * real Express app on a throwaway SQLite database. That matters for this feature in
 * particular: the whole risk is in the verification path, and a stubbed verifier would
 * prove only that the stub was called.
 *
 * The environment has to be set before the application modules are imported, because
 * config/env.ts and the Prisma client read it at import time - hence the dynamic imports
 * below rather than top-of-file ones.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = dirname(here);

const RP_ID = 'dmarc.test.local';
const ORIGIN = 'https://dmarc.test.local';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';

const tempDir = mkdtempSync(join(tmpdir(), 'dmarc-webauthn-'));
const databaseFile = join(tempDir, 'webauthn-test.db');

process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.PUBLIC_ORIGIN = ORIGIN;
process.env.NODE_ENV = 'test';
process.env.ENABLE_SCHEDULED_EMAIL_PROCESSING = 'false';
delete process.env.WEBAUTHN_ORIGIN;
delete process.env.WEBAUTHN_RP_ID;
delete process.env.WEBAUTHN_RP_NAME;

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

// ---------------------------------------------------------------- WebAuthn test authenticator

interface TestKey {
  privateKey: KeyObject;
  x: Buffer;
  y: Buffer;
}

function newP256Key(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return {
    privateKey,
    x: Buffer.from(jwk.x, 'base64url'),
    y: Buffer.from(jwk.y, 'base64url'),
  };
}

/**
 * A CBOR encoder just big enough for the two structures WebAuthn needs here. Written out
 * rather than pulled in so the test does not depend on a CBOR library's canonical-form
 * choices - the point is to produce exactly the bytes an authenticator would.
 */
function cborHead(major: number, value: number): Buffer {
  if (value < 24) {
    return Buffer.from([(major << 5) | value]);
  }
  if (value <= 0xff) {
    return Buffer.from([(major << 5) | 24, value]);
  }
  if (value <= 0xffff) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(value, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(value, 1);
  return buffer;
}

const cborText = (value: string): Buffer =>
  Buffer.concat([cborHead(3, Buffer.byteLength(value)), Buffer.from(value, 'utf8')]);

const cborBytes = (value: Uint8Array): Buffer =>
  Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);

const cborInt = (value: number): Buffer =>
  value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);

function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  return Buffer.concat([cborHead(5, entries.length), ...entries.flat()]);
}

/** COSE_Key for ES256, which is what decodeCredentialPublicKey() walks. */
function cosePublicKey(key: TestKey): Buffer {
  return cborMap([
    [cborInt(1), cborInt(2)], // kty: EC2
    [cborInt(3), cborInt(-7)], // alg: ES256
    [cborInt(-1), cborInt(1)], // crv: P-256
    [cborInt(-2), cborBytes(key.x)],
    [cborInt(-3), cborBytes(key.y)],
  ]);
}

const sha256 = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function clientDataJSON(type: string, challenge: string, origin: string = ORIGIN): string {
  return JSON.stringify({ type, challenge, origin, crossOrigin: false });
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

interface RegistrationParams {
  challenge: string;
  credentialId: Buffer;
  key: TestKey;
  counter?: number;
  userVerified?: boolean;
  origin?: string;
  rpID?: string;
}

function registrationResponse(params: RegistrationParams) {
  // UP | AT | UV. The attested credential data (aaguid, length-prefixed id, COSE key) is
  // only present because AT is set, which is exactly what turns this into a registration.
  const flags = 0x01 | 0x40 | (params.userVerified === false ? 0 : 0x04);
  const authData = Buffer.concat([
    sha256(Buffer.from(params.rpID ?? RP_ID, 'utf8')),
    Buffer.from([flags]),
    uint32(params.counter ?? 0),
    Buffer.alloc(16),
    uint16(params.credentialId.length),
    params.credentialId,
    cosePublicKey(params.key),
  ]);

  const attestationObject = cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('attStmt'), Buffer.from([0xa0])],
    [cborText('authData'), cborBytes(authData)],
  ]);

  const rawClientData = clientDataJSON('webauthn.create', params.challenge, params.origin);

  return {
    id: b64(params.credentialId),
    rawId: b64(params.credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64(Buffer.from(rawClientData, 'utf8')),
      attestationObject: b64(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
  };
}

interface AssertionParams {
  challenge: string;
  credentialId: Buffer;
  key: TestKey;
  counter: number;
  userHandle?: string;
  origin?: string;
  rpID?: string;
  userVerified?: boolean;
  tamperSignature?: boolean;
}

function assertionResponse(params: AssertionParams) {
  const flags = 0x01 | (params.userVerified ? 0x04 : 0);
  const authData = Buffer.concat([
    sha256(Buffer.from(params.rpID ?? RP_ID, 'utf8')),
    Buffer.from([flags]),
    uint32(params.counter),
  ]);

  const rawClientData = clientDataJSON('webauthn.get', params.challenge, params.origin);
  const clientDataBytes = Buffer.from(rawClientData, 'utf8');

  // The signature covers authData || SHA-256(clientDataJSON). WebAuthn wraps EC2
  // signatures in an ASN.1 SEQUENCE of r and s - Node's default DER encoding - which is
  // not the same as the raw r||s form JWS uses.
  const signatureBase = Buffer.concat([authData, sha256(clientDataBytes)]);
  const signature = Buffer.from(
    sign('sha256', signatureBase, { key: params.key.privateKey }),
  );
  if (params.tamperSignature) {
    signature[10] ^= 0xff;
  }

  return {
    id: b64(params.credentialId),
    rawId: b64(params.credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64(clientDataBytes),
      authenticatorData: b64(authData),
      signature: b64(signature),
      ...(params.userHandle ? { userHandle: params.userHandle } : {}),
    },
    clientExtensionResults: {},
  };
}

// ---------------------------------------------------------------- throwaway instance

let base = '';
let prisma: typeof import('../src/db/prisma.js').prisma;
let server: import('node:http').Server;
let resolveConfig: typeof import('../src/services/webauthnConfig.js').resolveWebAuthnConfig;
let counterRule: typeof import('../src/services/webauthn.js').isCounterRegression;
let pendingCeremonies: typeof import('../src/services/webauthn.js').pendingCeremonyCount;

let adminId = '';
let clientId = '';
let adminCookie = '';
let clientCookie = '';

async function call(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(';')[0] : null,
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

async function startRegistration(cookie: string) {
  const result = await call('POST', '/api/auth/webauthn/register/options', { cookie });
  assert.equal(result.status, 200, `register/options failed: ${JSON.stringify(result.body)}`);
  // The body is the library's own flat options JSON with the ceremony id alongside it - the
  // shape the SPA hands straight to navigator.credentials.create().
  assert.ok(result.body.rp?.id, 'expected a flat PublicKeyCredentialCreationOptionsJSON');
  return { ceremonyId: result.body.ceremonyId as string, options: result.body as any };
}

async function startLogin() {
  const result = await call('POST', '/api/auth/webauthn/login/options', { body: {} });
  assert.equal(result.status, 200, `login/options failed: ${JSON.stringify(result.body)}`);
  assert.ok(typeof result.body.challenge === 'string', 'expected a flat request options JSON');
  return { ceremonyId: result.body.ceremonyId as string, options: result.body as any };
}

try {
  // A throwaway database, created with the same `prisma db push` the container runs on
  // start, so the test exercises the real schema rather than a fixture.
  const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
  await promisify(execFile)(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
  });

  const app = await import('../src/app.js');
  ({ prisma } = await import('../src/db/prisma.js'));
  const auth = await import('../src/services/auth.js');
  const webauthnConfig = await import('../src/services/webauthnConfig.js');
  resolveConfig = webauthnConfig.resolveWebAuthnConfig;
  const webauthn = await import('../src/services/webauthn.js');
  counterRule = webauthn.isCounterRegression;
  pendingCeremonies = webauthn.pendingCeremonyCount;

  const admin = await prisma.user.create({
    data: {
      email: 'admin@test.local',
      name: 'Administrator',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      isActive: true,
    },
  });
  const client = await prisma.user.create({
    data: {
      email: 'client@test.local',
      passwordHash: auth.hashPassword(ADMIN_PASSWORD),
      role: 'user',
    },
  });
  adminId = admin.id;
  clientId = client.id;

  server = app.createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
} catch (error) {
  console.error('❌ WebAuthn test setup failed:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

adminCookie = await loginWithPassword('admin@test.local');

// ---------------------------------------------------------------- configuration

console.log('\nPasskey configuration');

await test('an origin is enough to enable passkeys, and the RP ID derives from its hostname', async () => {
  const config = await resolveConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.origin, ORIGIN);
  assert.equal(config.rpID, RP_ID);
  assert.equal(config.disabledReason, null);
  // Falls back to the branding setting, which is seeded with its default.
  assert.equal(config.rpName, 'DMARC Viewer');
});

await test('a fresh deployment with no origin disables passkeys instead of breaking later', async () => {
  const savedOrigin = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  try {
    const config = await resolveConfig();
    assert.equal(config.enabled, false);
    assert.match(config.disabledReason ?? '', /PUBLIC_ORIGIN/);

    // Announced, so the sign-in page never offers a button that cannot work...
    const policy = await call('GET', '/api/auth/session-policy');
    assert.equal(policy.status, 200);
    assert.equal(policy.body.passkeysEnabled, false);

    // ...and every ceremony endpoint refuses clearly rather than throwing.
    const options = await call('POST', '/api/auth/webauthn/login/options', { body: {} });
    assert.equal(options.status, 503);
    assert.equal(options.body.error.code, 'WEBAUTHN_DISABLED');

    const register = await call('POST', '/api/auth/webauthn/register/options', {
      cookie: adminCookie,
    });
    assert.equal(register.status, 503);
    assert.equal(register.body.error.code, 'WEBAUTHN_DISABLED');
  } finally {
    process.env.PUBLIC_ORIGIN = savedOrigin;
  }
});

await test('the origin is normalised, so a trailing slash cannot silently break every assertion', async () => {
  const saved = process.env.WEBAUTHN_ORIGIN;
  process.env.WEBAUTHN_ORIGIN = `${ORIGIN}:443/`;
  try {
    const config = await resolveConfig();
    assert.equal(config.origin, ORIGIN);
    assert.equal(config.enabled, true);
  } finally {
    if (saved === undefined) {
      delete process.env.WEBAUTHN_ORIGIN;
    } else {
      process.env.WEBAUTHN_ORIGIN = saved;
    }
  }
});

await test('an RP ID unrelated to the origin disables passkeys rather than failing in the browser', async () => {
  const saved = process.env.WEBAUTHN_RP_ID;
  process.env.WEBAUTHN_RP_ID = 'somewhere.else';
  try {
    const config = await resolveConfig();
    assert.equal(config.enabled, false);
    assert.match(config.disabledReason ?? '', /WEBAUTHN_RP_ID/);
  } finally {
    if (saved === undefined) {
      delete process.env.WEBAUTHN_RP_ID;
    } else {
      process.env.WEBAUTHN_RP_ID = saved;
    }
  }
});

await test('WEBAUTHN_RP_NAME overrides the branding instance name', async () => {
  const saved = process.env.WEBAUTHN_RP_NAME;
  process.env.WEBAUTHN_RP_NAME = 'Mail Ops';
  try {
    assert.equal((await resolveConfig()).rpName, 'Mail Ops');
  } finally {
    if (saved === undefined) {
      delete process.env.WEBAUTHN_RP_NAME;
    } else {
      process.env.WEBAUTHN_RP_NAME = saved;
    }
  }
});

// ---------------------------------------------------------------- registration

console.log('\nPasskey registration');

const key = newP256Key();
const credentialId = randomBytes(32);
let storedPublicKey = '';
let credentialRowId = '';

await test('register/options without a session is rejected', async () => {
  const result = await call('POST', '/api/auth/webauthn/register/options');
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'UNAUTHORIZED');
});

await test('register/options issues a challenge bound to the origin and asks for preferred user verification', async () => {
  const { options } = await startRegistration(adminCookie);

  assert.equal(options.rp.id, RP_ID);
  assert.equal(options.rp.name, 'DMARC Viewer');
  assert.equal(options.authenticatorSelection.userVerification, 'preferred');
  assert.equal(options.authenticatorSelection.residentKey, 'preferred');
  assert.equal(options.attestation, 'none');
  assert.ok(typeof options.challenge === 'string' && options.challenge.length > 20);
  // The account id round-trips through the authenticator as the user handle, so it is
  // base64url of the user id rather than the raw cuid.
  assert.equal(options.user.id, Buffer.from(adminId, 'utf8').toString('base64url'));
  assert.deepEqual(options.excludeCredentials, []);
});

await test('a real attestation verifies against the issued challenge and is stored', async () => {
  const { ceremonyId, options } = await startRegistration(adminCookie);

  const result = await call('POST', '/api/auth/webauthn/register/verify', {
    cookie: adminCookie,
    body: {
      ceremonyId,
      label: 'Test laptop',
      response: registrationResponse({
        challenge: options.challenge,
        credentialId,
        key,
      }),
    },
  });

  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.credentials.length, 1);
  assert.equal(result.body.credentials[0].label, 'Test laptop');
  assert.equal(result.body.credentials[0].deviceType, 'singleDevice');

  const row = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: b64(credentialId) },
  });
  assert.ok(row, 'the verified credential should be persisted');
  assert.equal(row.userId, adminId);
  assert.equal(row.counter, 0);
  assert.equal(row.transports, '["internal"]');
  assert.equal(row.backedUp, false);
  assert.ok(row.publicKey.length > 20);

  storedPublicKey = row.publicKey;
  credentialRowId = row.id;
});

await test('registering the same credential twice is rejected as a conflict', async () => {
  const { ceremonyId, options } = await startRegistration(adminCookie);

  const result = await call('POST', '/api/auth/webauthn/register/verify', {
    cookie: adminCookie,
    body: {
      ceremonyId,
      response: registrationResponse({
        challenge: options.challenge,
        credentialId,
        key,
      }),
    },
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'CONFLICT');
  assert.equal(await prisma.webAuthnCredential.count({ where: { userId: adminId } }), 1);
});

await test('a registration response signed over a challenge we never issued is rejected', async () => {
  const { options } = await startRegistration(adminCookie);

  const otherCredentialId = randomBytes(32);
  const result = await call('POST', '/api/auth/webauthn/register/verify', {
    cookie: adminCookie,
    body: {
      ceremonyId: randomBytes(24).toString('base64url'),
      response: registrationResponse({
        challenge: options.challenge,
        credentialId: otherCredentialId,
        key: newP256Key(),
      }),
    },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'WEBAUTHN_CHALLENGE_INVALID');
  assert.equal(await prisma.webAuthnCredential.count({ where: { credentialId: b64(otherCredentialId) } }), 0);
});

await test('registration options exclude the credential this account already registered', async () => {
  const { options } = await startRegistration(adminCookie);
  assert.equal(options.excludeCredentials.length, 1);
  assert.equal(options.excludeCredentials[0].id, b64(credentialId));
  assert.equal(options.excludeCredentials[0].type, 'public-key');
});

// ---------------------------------------------------------------- credential list

console.log('\nCredential list');

await test('the list never exposes the public key or the credential id', async () => {
  const result = await call('GET', '/api/auth/webauthn/credentials', { cookie: adminCookie });
  assert.equal(result.status, 200);

  const [credential] = result.body.credentials;
  assert.deepEqual(
    Object.keys(credential).sort(),
    ['backedUp', 'createdAt', 'deviceType', 'id', 'label', 'lastUsedAt'].sort(),
  );
  assert.equal(credential.id, credentialRowId);
  assert.equal(credential.lastUsedAt, null);

  // The strongest form of the check: the stored public key never appears anywhere in the
  // response, so it cannot leak through a field that was added later either.
  assert.ok(!JSON.stringify(result.body).includes(storedPublicKey));
  assert.ok(!JSON.stringify(result.body).includes(b64(credentialId)));
});

await test('the "not now" answer is remembered per account, not per browser', async () => {
  const before = await call('GET', '/api/auth/me', { cookie: adminCookie });
  assert.equal(before.body.user.passkeyCount, 1);
  assert.equal(before.body.user.passkeyPromptDismissed, false);

  const dismissed = await call('POST', '/api/auth/webauthn/prompt-dismissed', {
    cookie: adminCookie,
  });
  assert.equal(dismissed.status, 200);

  const after = await call('GET', '/api/auth/me', { cookie: adminCookie });
  assert.equal(after.body.user.passkeyPromptDismissed, true);
  assert.ok(
    (await prisma.user.findUnique({ where: { id: adminId } }))!.passkeyPromptDismissedAt,
    'the timestamp should be persisted on the user row',
  );
});

// ---------------------------------------------------------------- authentication

console.log('\nPasskey sign-in');

let passkeyCookie = '';

await test('login/options offers no allow-list, so any discoverable passkey can be used', async () => {
  const { options } = await startLogin();
  assert.deepEqual(options.allowCredentials, []);
  assert.equal(options.rpId, RP_ID);
  assert.equal(options.userVerification, 'preferred');
});

await test('a real assertion signs in with the same session and counts as a credential use', async () => {
  const { ceremonyId, options } = await startLogin();

  const result = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId,
      // userVerified stays false: the options say 'preferred', so a security key that only
      // proves presence must be accepted.
      response: assertionResponse({
        challenge: options.challenge,
        credentialId,
        key,
        counter: 1,
        userHandle: Buffer.from(adminId, 'utf8').toString('base64url'),
      }),
    },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, adminId);
  assert.equal(result.body.user.passkeyCount, 1);
  assert.ok(result.cookie, 'a passkey sign-in must issue a session cookie');
  passkeyCookie = result.cookie!;

  // Same session mechanism as the password login: the cookie opens /me the same way.
  const me = await call('GET', '/api/auth/me', { cookie: passkeyCookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, adminId);
  assert.equal(me.body.user.role, 'admin');

  const row = await prisma.webAuthnCredential.findUnique({ where: { id: credentialRowId } });
  assert.equal(row!.counter, 1, 'the sign counter must be advanced');
  assert.ok(row!.lastUsedAt, 'the credential should be marked as used');
});

await test('a challenge that was never issued is rejected', async () => {
  const { options } = await startLogin();

  const result = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId: randomBytes(24).toString('base64url'),
      response: assertionResponse({
        challenge: options.challenge,
        credentialId,
        key,
        counter: 2,
      }),
    },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

await test('a challenge cannot be replayed a second time', async () => {
  const { ceremonyId, options } = await startLogin();
  const response = assertionResponse({
    challenge: options.challenge,
    credentialId,
    key,
    counter: 2,
  });

  const first = await call('POST', '/api/auth/webauthn/login/verify', { body: { ceremonyId, response } });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const replay = await call('POST', '/api/auth/webauthn/login/verify', { body: { ceremonyId, response } });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

await test('a tampered signature fails verification', async () => {
  const { ceremonyId, options } = await startLogin();

  const result = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId,
      response: assertionResponse({
        challenge: options.challenge,
        credentialId,
        key,
        counter: 3,
        tamperSignature: true,
      }),
    },
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'WEBAUTHN_VERIFICATION_FAILED');
});

await test('an assertion for a credential we never issued fails, and says nothing new', async () => {
  const before = pendingCeremonies();
  const { ceremonyId, options } = await startLogin();
  assert.equal(
    pendingCeremonies(),
    before + 1,
    'issuing options should leave exactly one ceremony outstanding',
  );

  const result = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId,
      response: assertionResponse({
        challenge: options.challenge,
        credentialId: randomBytes(32),
        key: newP256Key(),
        counter: 1,
      }),
    },
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'WEBAUTHN_VERIFICATION_FAILED');
  // ...and the rejected attempt consumed its challenge: that is what makes a captured
  // response useless after a single try, whether or not it ever verified.
  assert.equal(pendingCeremonies(), before, 'the ceremony must be gone after the attempt');
  // Byte-for-byte the same answer as a signature failure: nothing here may reveal whether
  // that credential - and therefore an account - exists.
  assert.deepEqual(
    { code: result.body.error.code, message: result.body.error.message },
    { code: 'WEBAUTHN_VERIFICATION_FAILED', message: 'That passkey could not be verified' },
  );
});

await test('the counter rule ignores authenticators that report no counter at all', async () => {
  // Both ends excluded: many platform passkeys report 0 forever, so 0 must not read as
  // "went backwards", but it also must not excuse a real counter that did.
  assert.equal(counterRule(0, 0), false);
  assert.equal(counterRule(0, 5), false);
  assert.equal(counterRule(5, 0), false);

  assert.equal(counterRule(5, 5), true);
  assert.equal(counterRule(5, 4), true);
  assert.equal(counterRule(5, 6), false);
});

await test('a counter regression is rejected as a cloned authenticator', async () => {
  const stored = await prisma.webAuthnCredential.findUnique({ where: { id: credentialRowId } });
  assert.ok(stored && stored.counter > 0, 'this test needs a credential with a non-zero counter');

  const { ceremonyId, options } = await startLogin();

  const result = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId,
      response: assertionResponse({
        challenge: options.challenge,
        credentialId,
        key,
        counter: stored.counter,
      }),
    },
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'WEBAUTHN_VERIFICATION_FAILED');

  const after = await prisma.webAuthnCredential.findUnique({ where: { id: credentialRowId } });
  assert.equal(after!.counter, stored.counter, 'a rejected assertion must not move the counter');
});

await test('a client that does not echo the ceremony id is still bound to the challenge it signed', async () => {
  // The SPA posts the credential response exactly as the browser library produced it, with no
  // ceremony id at all. The challenge inside the signed clientDataJSON is the real binding, so
  // that must be verified against what we issued - not merely accepted.
  const { options } = await startLogin();
  const response = assertionResponse({
    challenge: options.challenge,
    credentialId,
    key,
    counter: 3,
  });

  const result = await call('POST', '/api/auth/webauthn/login/verify', { body: { response } });
  assert.equal(result.status, 200, JSON.stringify(result.body));

  // ...and still single-use: the ceremony was consumed by that one call.
  const replay = await call('POST', '/api/auth/webauthn/login/verify', { body: { response } });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, 'WEBAUTHN_CHALLENGE_INVALID');

  // A challenge of the client's own choosing is refused even when the caller holds a real
  // ceremony id and signs a perfectly valid assertion over it: the challenge, not the id, is
  // what ties the response to the one we issued.
  const issued = await startLogin();
  const forged = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId: issued.ceremonyId,
      response: assertionResponse({
        challenge: 'a-challenge-the-client-made-up',
        credentialId,
        key,
        counter: 4,
      }),
    },
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error.code, 'WEBAUTHN_VERIFICATION_FAILED');
});

// ---------------------------------------------------------------- ownership and recovery

console.log('\nOwnership and recovery');

await test('another account cannot remove your credential, and the 404 reveals nothing', async () => {
  clientCookie = await loginWithPassword('client@test.local');

  const denied = await call('DELETE', `/api/auth/webauthn/credentials/${credentialRowId}`, {
    cookie: clientCookie,
  });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error.code, 'NOT_FOUND');
  assert.ok(
    await prisma.webAuthnCredential.findUnique({ where: { id: credentialRowId } }),
    'the credential must survive another account deleting it',
  );

  // The owner can, and the password still works afterwards - nobody is locked out.
  const removed = await call('DELETE', `/api/auth/webauthn/credentials/${credentialRowId}`, {
    cookie: adminCookie,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.credentials, []);
  assert.equal(await prisma.webAuthnCredential.count({ where: { userId: adminId } }), 0);

  await loginWithPassword('admin@test.local');
});

await test('a passkey sign-in still works while a failed-password lockout is active', async () => {
  const clientKey = newP256Key();
  const clientCredentialId = randomBytes(32);

  const { ceremonyId, options } = await startRegistration(clientCookie);
  const registration = await call('POST', '/api/auth/webauthn/register/verify', {
    cookie: clientCookie,
    body: {
      ceremonyId,
      label: 'Client phone',
      response: registrationResponse({
        challenge: options.challenge,
        credentialId: clientCredentialId,
        key: clientKey,
      }),
    },
  });
  assert.equal(registration.status, 201, JSON.stringify(registration.body));

  // The registration half of the same no-ceremony-id flow the SPA uses.
  const idlessKey = newP256Key();
  const idlessCredentialId = randomBytes(32);
  const idlessStart = await startRegistration(clientCookie);
  const idless = await call('POST', '/api/auth/webauthn/register/verify', {
    cookie: clientCookie,
    body: {
      response: registrationResponse({
        challenge: idlessStart.options.challenge,
        credentialId: idlessCredentialId,
        key: idlessKey,
      }),
    },
  });
  assert.equal(idless.status, 201, JSON.stringify(idless.body));
  assert.equal(idless.body.credentials.length, 2);

  // Lock the account the way repeated password failures would.
  await prisma.user.update({
    where: { id: clientId },
    data: { lockedUntil: new Date(Date.now() + 900_000), failedLoginCount: 9 },
  });

  const login = await startLogin();
  const result = await call('POST', '/api/auth/webauthn/login/verify', {
    body: {
      ceremonyId: login.ceremonyId,
      response: assertionResponse({
        challenge: login.options.challenge,
        credentialId: clientCredentialId,
        key: clientKey,
        counter: 1,
        userHandle: Buffer.from(clientId, 'utf8').toString('base64url'),
      }),
    },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, clientId);

  const user = await prisma.user.findUnique({ where: { id: clientId } });
  assert.equal(user!.lockedUntil, null, 'a verified passkey clears the password lockout');
});

await test('an administrator can clear every passkey for a user as the lost-device recovery', async () => {
  const removed = await call('DELETE', `/api/users/${clientId}/passkeys`, { cookie: adminCookie });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, 2);
  assert.equal(await prisma.webAuthnCredential.count({ where: { userId: clientId } }), 0);

  const me = await call('GET', '/api/auth/me', { cookie: clientCookie });
  assert.equal(me.body.user.passkeyCount, 0);

  // The account-recovery guarantee: the password is untouched and still signs in.
  await loginWithPassword('client@test.local');
});

await test('an administrator cannot clear passkeys for a user that does not exist', async () => {
  const result = await call('DELETE', '/api/users/cnonexistentuser000000000/passkeys', {
    cookie: adminCookie,
  });
  assert.equal(result.status, 404);
});

// ---------------------------------------------------------------- done

server.close();
await prisma.$disconnect();
rmSync(tempDir, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`, () => resolve());
});
// Explicit: the rate limiter's sweeper interval keeps the event loop alive, so the
// process would otherwise sit here after the suite has finished.
process.exit(failed > 0 ? 1 : 0);
