import { computed, reactive } from 'vue';
import { startAuthentication } from '@simplewebauthn/browser';
import { authApi } from '@/api/client';
import type { AuthUser, OrganizationSummary } from '@/types/api';

/**
 * Session state for the console.
 *
 * Deliberately a module-level singleton rather than Pinia: the app has no store, and a
 * single reactive object is enough for "who is signed in and what may they see".
 */

interface AuthState {
  user: AuthUser | null;
  domains: string[];
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  orgRole: 'admin' | 'viewer' | null;
  isSuperAdmin: boolean;
  /** False until the first session probe finishes, so guards do not redirect too early. */
  initialised: boolean;
  loading: boolean;
}

const ORG_STORAGE_KEY = 'dmarc.activeOrgId';

const state = reactive<AuthState>({
  user: null,
  domains: [],
  organizations: [],
  activeOrganizationId: null,
  orgRole: null,
  isSuperAdmin: false,
  initialised: false,
  loading: false,
});

/** Applies a session response and reconciles the stored organisation choice. */
function applySession(session: {
  user: AuthUser;
  domains: string[];
  organizations?: OrganizationSummary[];
  activeOrganizationId?: string | null;
  orgRole?: 'admin' | 'viewer' | null;
  isSuperAdmin?: boolean;
}): void {
  state.user = session.user;
  state.domains = session.domains ?? [];
  state.organizations = session.organizations ?? [];
  state.isSuperAdmin = session.isSuperAdmin ?? session.user.role === 'admin';

  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ORG_STORAGE_KEY) : null;
  const validStored = stored && state.organizations.some((org) => org.id === stored) ? stored : null;
  state.activeOrganizationId = validStored ?? session.activeOrganizationId ?? null;
  if (state.activeOrganizationId && typeof localStorage !== 'undefined') {
    localStorage.setItem(ORG_STORAGE_KEY, state.activeOrganizationId);
  }

  // A password login answers without `orgRole`, but the membership list it does return carries
  // the same fact. Without this an org admin would be treated as a viewer - no domain editing,
  // no Organisation page - until the next full page load.
  state.orgRole =
    session.orgRole ??
    state.organizations.find((org) => org.id === state.activeOrganizationId)?.role ??
    null;
}

/** Switching reloads the SPA: every view caches data for the previous tenant. */
function switchOrganization(orgId: string | null): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  if (orgId) {
    localStorage.setItem(ORG_STORAGE_KEY, orgId);
  } else {
    localStorage.removeItem(ORG_STORAGE_KEY);
  }
  window.location.assign('/');
}

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
      applySession(session);
    } catch {
      state.user = null;
      state.domains = [];
      state.organizations = [];
      state.activeOrganizationId = null;
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
  applySession(session);
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
  applySession(session);
  state.initialised = true;
}

/**
 * Re-read the session from the server. Passkey changes - adding or removing one, dismissing the
 * invitation - all move fields only the server knows (`passkeyCount`, `passkeyPromptDismissed`),
 * so the cached user has to be replaced rather than patched.
 */
async function refreshSession(): Promise<void> {
  const session = await authApi.me();
  applySession(session);
  state.initialised = true;
}

async function logout(): Promise<void> {
  try {
    await authApi.logout();
  } finally {
    state.user = null;
    state.domains = [];
    state.organizations = [];
    state.activeOrganizationId = null;
    state.initialised = true;
  }
}

/** Called when any request comes back 401, e.g. after the session expired. */
function clearSession(): void {
  state.user = null;
  state.domains = [];
  state.organizations = [];
  state.activeOrganizationId = null;
  state.initialised = true;
}

export function useAuth() {
  return {
    state,
    isAuthenticated: computed(() => state.user !== null),
    isAdmin: computed(() => state.user?.role === 'admin'),
    /** Superadmin or an admin of the active organisation. */
    isOrgAdmin: computed(
      () => state.user?.role === 'admin' || state.orgRole === 'admin'
    ),
    organizations: computed(() => state.organizations),
    activeOrganizationId: computed(() => state.activeOrganizationId),
    isSuperAdmin: computed(() => state.isSuperAdmin),
    switchOrganization,
    fetchSession,
    login,
    loginWithPasskey,
    refreshSession,
    logout,
    clearSession,
  };
}
