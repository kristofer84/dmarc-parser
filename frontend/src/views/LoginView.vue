<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
    <div class="max-w-md w-full space-y-6">
      <div class="text-center">
        <BrandMark class="mx-auto h-12 w-12 text-accent" />
        <h1 class="mt-4 text-2xl font-bold text-gray-900">{{ branding.name }}</h1>
        <p class="mt-1 text-sm text-gray-600">Sign in to view report data</p>
      </div>

      <form class="card" @submit.prevent="submit">
        <div class="card-body space-y-4">
          <div v-if="error" class="rounded-md bg-danger-50 p-3 flex items-start justify-between gap-3">
            <p class="text-sm text-danger-700">{{ error }}</p>
            <button
              type="button"
              class="-m-1 p-1 text-danger-700 hover:text-danger-800"
              aria-label="Dismiss this message"
              @click="error = null"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div>
            <label for="email" class="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              v-model="email"
              type="email"
              autocomplete="username"
              required
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label for="password" class="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <button
            type="submit"
            class="btn w-full justify-center bg-accent text-accent-foreground hover:bg-accent/90 focus:ring-accent"
            :disabled="busy || passkeyBusy"
          >
            <span v-if="busy">Signing in…</span>
            <span v-else>Sign in</span>
          </button>

          <!--
            Second, never first: an account without a passkey, a lost device or a browser
            without WebAuthn all still have to get in, so the password form keeps its place and
            the passkey button only appears when the server says it is switched on.
          -->
          <div v-if="policy?.passkeysEnabled" class="space-y-2 border-t border-gray-200 pt-4">
            <button
              type="button"
              class="btn btn-secondary w-full justify-center"
              :disabled="busy || passkeyBusy"
              @click="submitPasskey"
            >
              <span v-if="passkeyBusy">Waiting for your device…</span>
              <span v-else>Sign in with a passkey</span>
            </button>
            <p class="text-xs text-gray-500 text-center">
              Uses the fingerprint, face or PIN of this device. Your password still works if you
              have no passkey yet.
            </p>
          </div>

          <p v-if="policy?.registrationOpen" class="text-xs text-gray-500 text-center">
            Self-registration is enabled. New accounts see no domains until an administrator
            assigns them.
          </p>

          <!--
            Federated sign-in goes after the password form, never before it: the password is the
            one route in that cannot depend on a third party's uptime or configuration. Nothing
            at all is rendered when the server reports no enabled providers, so an instance with
            no SSO looks exactly like it did before this existed.
          -->
          <div v-if="providers.length" class="space-y-2 border-t border-gray-200 pt-4">
            <p class="text-xs text-gray-500 text-center">Or sign in with</p>
            <button
              v-for="provider in providers"
              :key="provider.id"
              type="button"
              class="btn btn-secondary w-full justify-center"
              :disabled="busy || passkeyBusy"
              @click="startOidc(provider)"
            >
              Sign in with {{ provider.name }}
            </button>
          </div>
        </div>
      </form>

      <!--
        Organisation self-signup, only while the instance allows it. It is a second door, not a
        replacement: the account and the organisation are created in one request, and the
        response is a session exactly like a password login.
      -->
      <form v-if="policy?.orgSignupOpen" class="card" @submit.prevent="submitOrgSignup">
        <div class="card-body space-y-4">
          <div>
            <h2 class="text-lg font-medium text-gray-900">Create an organisation</h2>
            <p class="mt-1 text-sm text-gray-600">
              Starts a new tenant with its own domains, mailboxes and DNS accounts. You become its
              first admin.
            </p>
          </div>

          <div v-if="orgError" class="rounded-md bg-danger-50 p-3 flex items-start justify-between gap-3">
            <p class="text-sm text-danger-700">{{ orgError }}</p>
            <button
              type="button"
              class="-m-1 p-1 text-danger-700 hover:text-danger-800"
              aria-label="Dismiss this message"
              @click="orgError = null"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div>
            <label for="org-name" class="block text-sm font-medium text-gray-700 mb-1">
              Organisation name
            </label>
            <input
              id="org-name"
              v-model="orgName"
              type="text"
              required
              autocomplete="organization"
              placeholder="Example Ltd"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label for="org-admin-name" class="block text-sm font-medium text-gray-700 mb-1">
              Your name
            </label>
            <input
              id="org-admin-name"
              v-model="orgAdminName"
              type="text"
              required
              autocomplete="name"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label for="org-email" class="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="org-email"
              v-model="orgEmail"
              type="email"
              required
              autocomplete="username"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label for="org-password" class="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="org-password"
              v-model="orgPassword"
              type="password"
              required
              autocomplete="new-password"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            />
            <p class="mt-1 text-xs text-gray-500">
              Used to sign in from now on. An address that already has an account is refused here -
              sign in with it instead.
            </p>
          </div>

          <button
            type="submit"
            class="btn w-full justify-center bg-accent text-accent-foreground hover:bg-accent/90 focus:ring-accent"
            :disabled="orgBusy || busy || passkeyBusy"
          >
            <span v-if="orgBusy">Creating…</span>
            <span v-else>Create organisation</span>
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { apiBaseUrl, authApi, signupApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useBranding } from '@/composables/useBranding';
import { isPasskeyCancellation } from '@/composables/usePasskeys';
import type { AuthProviderSummary, SessionPolicy } from '@/types/api';

const route = useRoute();
const router = useRouter();
const { login, loginWithPasskey, refreshSession } = useAuth();
const branding = useBranding();

const email = ref('');
const password = ref('');
const busy = ref(false);
const passkeyBusy = ref(false);
const error = ref<string | null>(null);
const policy = ref<SessionPolicy | null>(null);
const providers = ref<AuthProviderSummary[]>([]);

// Organisation self-signup, offered only while the instance allows it.
const orgName = ref('');
const orgAdminName = ref('');
const orgEmail = ref('');
const orgPassword = ref('');
const orgBusy = ref(false);
const orgError = ref<string | null>(null);

/**
 * The OIDC callback redirects to /login?error=<code>, and a code in the address bar is not a
 * sentence. Each one gets the plain-English cause and, where there is one, the way out. An
 * unrecognised code still gets a sentence rather than the raw string - a literal `state_invalid`
 * on screen tells the person reading it nothing.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  state_invalid: 'That sign-in link expired or was already used. Try again.',
  token_invalid: "That sign-in could not be verified. Try again, or use your password.",
  email_unverified:
    'Your provider has not verified this email address yet. Verify it there, then try again.',
  provisioning_disabled:
    'No account exists for this address, and this provider may not create one. Ask an administrator to create an account for it, then sign in again.',
  provider_disabled:
    'This sign-in method has been turned off. Use your password, or ask an administrator.',
  provider_not_found: 'This sign-in method no longer exists. Reload the page and try again.',
};

const SIGN_IN_ERROR_FALLBACK =
  'Sign-in with that provider did not complete. Try again, or use your password.';

/**
 * A full page navigation, not a fetch: the endpoint answers 302 to the provider, and the flow
 * ends at the callback where the server sets the session cookie. An XHR would follow the redirect
 * itself, never leave the page, and hand the provider's HTML back as a response body.
 */
const startOidc = (provider: AuthProviderSummary) => {
  window.location.assign(`${apiBaseUrl}/auth/oidc/${encodeURIComponent(provider.id)}/start`);
};

onMounted(async () => {
  const code = route.query.error;
  if (typeof code === 'string' && code) {
    error.value = SIGN_IN_ERRORS[code] ?? SIGN_IN_ERROR_FALLBACK;
    // Take it out of the URL, or a reload would resurrect a message about an attempt that is
    // already over and there would be no way to dismiss it permanently.
    const query = { ...route.query };
    delete query.error;
    void router.replace({ query });
  }

  try {
    policy.value = await authApi.sessionPolicy();
  } catch {
    // The policy endpoint is a nicety; failing to read it must not block login.
  }

  try {
    providers.value = await authApi.listProviders();
  } catch {
    // No SSO, or an endpoint that is not there: either way the login page offers nothing extra.
    providers.value = [];
  }
});

const goToRedirect = async () => {
  const redirect = route.query.redirect;
  await router.push(typeof redirect === 'string' && redirect ? redirect : { name: 'Dashboard' });
};

const submit = async () => {
  busy.value = true;
  error.value = null;

  try {
    await login(email.value, password.value);
    await goToRedirect();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Sign in failed';
  } finally {
    busy.value = false;
  }
};

const submitPasskey = async () => {
  passkeyBusy.value = true;
  error.value = null;

  try {
    await loginWithPasskey();
    await goToRedirect();
  } catch (err) {
    // Dismissing the browser prompt is a choice, not a failure: dropping back to the form is
    // the whole response, and "Sign in failed" would be a lie about something the user did.
    if (!isPasskeyCancellation(err)) {
      error.value = err instanceof Error ? err.message : 'Passkey sign-in failed';
    }
  } finally {
    passkeyBusy.value = false;
  }
};

/**
 * The signup response already sets the session cookie, so the only thing left is to replace the
 * SPA's cached session - which is what tells the guards (and the org switcher) who this is. The
 * new organisation is the active one, so the dashboard opens on it rather than on nothing.
 */
const submitOrgSignup = async () => {
  orgBusy.value = true;
  orgError.value = null;

  try {
    await signupApi.organization({
      organizationName: orgName.value.trim(),
      name: orgAdminName.value.trim(),
      email: orgEmail.value.trim(),
      password: orgPassword.value,
    });
    await refreshSession();
    await router.push({ name: 'Dashboard' });
  } catch (err) {
    orgError.value = err instanceof Error ? err.message : 'Could not create the organisation';
  } finally {
    orgBusy.value = false;
  }
};
</script>
