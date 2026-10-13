import { computed, reactive } from 'vue';
import { startAuthentication } from '@simplewebauthn/browser';
import { authApi } from '@/api/client';
import type { AuthUser } from '@/types/api';

/**
 * Session state for the console.
 *
 * Deliberately a module-level singleton rather than Pinia: the app has no store, and a
 * single reactive object is enough for "who is signed in and what may they see".
 */

interface AuthState {
  user: AuthUser | null;
  domains: string[];
  /** False until the first session probe finishes, so guards do not redirect too early. */
  initialised: boolean;
  loading: boolean;
}

const state = reactive<AuthState>({
  user: null,
  domains: [],
  initialised: false,
  loading: false,
});

let inflight: Promise<void> | null = null;

async function fetchSession(): Promise<void> {
  // Guards run on every navigation; without this the SPA would probe /auth/me each time.
  if (inflight) {
    return inflight;
  }

  state.loading = true;
  inflight = (async () => {
    try {
      const session = await authApi.me();
      state.user = session.user;
      state.domains = session.domains;
    } catch {
      state.user = null;
      state.domains = [];
    } finally {
      state.initialised = true;
      state.loading = false;
      inflight = null;
    }
  })();

  return inflight;
}

async function login(email: string, password: string): Promise<void> {
  const session = await authApi.login(email, password);
  state.user = session.user;
  state.domains = session.domains;
  state.initialised = true;
}

/**
 * Sign in with a passkey. The verify call is what sets the session cookie, so the state here
 * has to be written from its response for the SPA and the cookie to agree; there is no password
 * to keep around and nothing else to send.
 *
 * A thrown error is left to the caller: whether the user simply dismissed the prompt is a
 * presentation decision, not a session one. `initialised` is untouched so a cancelled attempt
 * cannot leave the guards thinking the session was probed.
 */
async function loginWithPasskey(): Promise<void> {
  const optionsJSON = await authApi.passkeyLoginOptions();
  const credential = await startAuthentication({ optionsJSON });
  const session = await authApi.passkeyLoginVerify(credential);
  state.user = session.user;
  state.domains = session.domains;
  state.initialised = true;
}

/**
 * Re-read the session from the server. Passkey changes - adding or removing one, dismissing the
 * invitation - all move fields only the server knows (`passkeyCount`, `passkeyPromptDismissed`),
 * so the cached user has to be replaced rather than patched.
 */
async function refreshSession(): Promise<void> {
  const session = await authApi.me();
  state.user = session.user;
  state.domains = session.domains;
  state.initialised = true;
}

async function logout(): Promise<void> {
  try {
    await authApi.logout();
  } finally {
    state.user = null;
    state.domains = [];
    state.initialised = true;
  }
}

/** Called when any request comes back 401, e.g. after the session expired. */
function clearSession(): void {
  state.user = null;
  state.domains = [];
  state.initialised = true;
}

export function useAuth() {
  return {
    state,
    isAuthenticated: computed(() => state.user !== null),
    isAdmin: computed(() => state.user?.role === 'admin'),
    fetchSession,
    login,
    loginWithPasskey,
    refreshSession,
    logout,
    clearSession,
  };
}
