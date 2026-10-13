import { startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { authApi } from '@/api/client';
import type { PasskeySummary } from '@/types/api';

/**
 * The registration half of the WebAuthn flow. The login half lives in `useAuth`, because a
 * passkey login has to replace the session state in the same breath as the cookie.
 */

/**
 * True when the user backed out of the browser's passkey prompt.
 *
 * This is not an error case: dismissing the sheet is a legitimate choice, and on some platforms
 * it is also what a timeout looks like. @simplewebauthn/browser re-wraps the DOMException in a
 * `WebAuthnError`, so a cancellation arrives as name `NotAllowedError` with code
 * `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`; an aborted ceremony arrives as `AbortError`. Checking
 * only `name` catches the first, and both are checked so the caller can stay quiet either way.
 */
export function isPasskeyCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
    return true;
  }

  return error instanceof WebAuthnError && error.code === 'ERROR_CEREMONY_ABORTED';
}

/**
 * Register a credential for the signed-in user and return the server's full list, so the
 * caller never has to guess at what changed.
 */
export async function registerPasskey(): Promise<PasskeySummary[]> {
  const optionsJSON = await authApi.passkeyRegisterOptions();
  // Handed to the helper untouched: it is the library's wire format, challenge included.
  const credential = await startRegistration({ optionsJSON });
  return authApi.passkeyRegisterVerify(credential);
}

/** `singleDevice` never leaves the authenticator, `multiDevice` is synced to the user's account. */
export function describePasskeyDevice(deviceType: PasskeySummary['deviceType']): string {
  if (deviceType === 'multiDevice') {
    return 'Synced across your devices';
  }
  if (deviceType === 'singleDevice') {
    return 'Stored on one device only';
  }
  // The authenticator data did not report backup eligibility.
  return 'Device type unknown';
}
