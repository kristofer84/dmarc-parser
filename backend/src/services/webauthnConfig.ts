import { getSetting } from './settings.js';

/**
 * Where this deployment's passkeys live.
 *
 * WebAuthn binds every credential to the pair (RP ID, origin). The browser refuses to
 * create a credential for an RP ID that is not the current host or a parent of it, and
 * the library re-checks the origin string and the SHA-256 of the RP ID on *every*
 * response. Get either value wrong and nothing fails loudly at configuration time: the
 * ceremony starts, the authenticator prompts, and then every verification - now and
 * later - fails, which is the "passkeys silently never work" trap. So both values are
 * resolved in this one place, from configuration, and handed to the library for each
 * ceremony.
 *
 * Two consequences worth remembering:
 *  - The origin must be exactly what the browser puts in clientDataJSON: scheme, host,
 *    no trailing slash, no default port. `URL.origin` normalises all of that, which is
 *    why the value is parsed rather than used as written - an operator typing
 *    "https://dmarc.example.com/" would otherwise break every assertion.
 *  - A passkey is scoped to one origin only. PUBLIC_ORIGIN is a comma-separated CORS
 *    allow-list, but only its first entry can be the origin passkeys are bound to; the
 *    rest are front ends that cannot share them.
 */
export interface WebAuthnConfig {
  enabled: boolean;
  /** Registrable domain the credentials are scoped to. */
  rpID: string;
  /** Exact browser origin, normalised. Empty when the feature is disabled. */
  origin: string;
  rpName: string;
  /** Human-readable reason passkeys are unavailable, or null when they are usable. */
  disabledReason: string | null;
}

const DISABLED_HINT =
  'Passkeys are unavailable on this deployment: set PUBLIC_ORIGIN (or WEBAUTHN_ORIGIN) ' +
  'to the origin users sign in on, e.g. https://dmarc.example.com';

function parseOrigin(raw: string): URL | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Resolved per request rather than cached at boot: PUBLIC_ORIGIN comes from the
 * environment, but the RP name comes from a setting an administrator can change without
 * a restart (settings.ts caches it for 15s).
 */
export async function resolveWebAuthnConfig(): Promise<WebAuthnConfig> {
  const rpName =
    process.env.WEBAUTHN_RP_NAME?.trim() || (await getSetting('branding.instanceName'));

  const rawOrigin =
    process.env.WEBAUTHN_ORIGIN?.trim() ||
    (process.env.PUBLIC_ORIGIN ?? '').split(',')[0]?.trim() ||
    '';

  const parsed = parseOrigin(rawOrigin);
  if (!parsed) {
    return {
      enabled: false,
      rpID: '',
      origin: '',
      rpName,
      disabledReason: DISABLED_HINT,
    };
  }

  const origin = parsed.origin;
  const rpID = process.env.WEBAUTHN_RP_ID?.trim() || parsed.hostname;

  // A parent domain is a legitimate RP ID (it is how one passkey is shared across
  // subdomains), an unrelated one is not: the browser would refuse the ceremony and the
  // operator would only see a generic "not allowed" in the browser console.
  const relatedToOrigin = parsed.hostname === rpID || parsed.hostname.endsWith(`.${rpID}`);
  if (!relatedToOrigin) {
    const reason =
      `Passkeys are unavailable: WEBAUTHN_RP_ID is "${rpID}" but the origin is ` +
      `"${origin}". The RP ID must be that hostname or a parent of it.`;
    console.warn(`⚠️ ${reason}`);
    return { enabled: false, rpID, origin, rpName, disabledReason: reason };
  }

  return { enabled: true, rpID, origin, rpName, disabledReason: null };
}

/** The subset of the config the login page needs before it decides to offer passkeys. */
export async function isWebAuthnEnabled(): Promise<boolean> {
  return (await resolveWebAuthnConfig()).enabled;
}
