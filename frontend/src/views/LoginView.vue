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
          <div v-if="error" class="rounded-md bg-danger-50 p-3">
            <p class="text-sm text-danger-700">{{ error }}</p>
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
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
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
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
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
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { authApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useBranding } from '@/composables/useBranding';
import { isPasskeyCancellation } from '@/composables/usePasskeys';
import type { SessionPolicy } from '@/types/api';

const route = useRoute();
const router = useRouter();
const { login, loginWithPasskey } = useAuth();
const branding = useBranding();

const email = ref('');
const password = ref('');
const busy = ref(false);
const passkeyBusy = ref(false);
const error = ref<string | null>(null);
const policy = ref<SessionPolicy | null>(null);

onMounted(async () => {
  try {
    policy.value = await authApi.sessionPolicy();
  } catch {
    // The policy endpoint is a nicety; failing to read it must not block login.
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
</script>
