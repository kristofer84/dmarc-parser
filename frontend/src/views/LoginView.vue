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
            :disabled="busy"
          >
            <span v-if="busy">Signing in…</span>
            <span v-else>Sign in</span>
          </button>

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
import type { SessionPolicy } from '@/types/api';

const route = useRoute();
const router = useRouter();
const { login } = useAuth();
const branding = useBranding();

const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const policy = ref<SessionPolicy | null>(null);

onMounted(async () => {
  try {
    policy.value = await authApi.sessionPolicy();
  } catch {
    // The policy endpoint is a nicety; failing to read it must not block login.
  }
});

const submit = async () => {
  busy.value = true;
  error.value = null;

  try {
    await login(email.value, password.value);
    const redirect = route.query.redirect;
    await router.push(typeof redirect === 'string' && redirect ? redirect : { name: 'Dashboard' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Sign in failed';
  } finally {
    busy.value = false;
  }
};
</script>
