<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Account"
      description="Your sign-in details and password"
      container-class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8"
    />

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- An administrator-issued password must be replaced before anything else. -->
      <div v-if="user?.mustChangePassword" class="rounded-md bg-warning-50 p-4">
        <h3 class="text-sm font-medium text-warning-800">Choose a new password</h3>
        <p class="mt-1 text-sm text-warning-700">
          This password was set by an administrator. Pick your own to finish setting up the
          account.
        </p>
      </div>

      <!-- Who you are -->
      <div class="card">
        <div class="card-header">
          <h2 class="text-lg leading-6 font-medium text-gray-900">Signed in as</h2>
        </div>
        <div class="card-body">
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt class="stat-label">Email</dt>
              <dd class="mt-1 text-gray-900 break-all">{{ user?.email || '-' }}</dd>
            </div>
            <div>
              <dt class="stat-label">Role</dt>
              <dd class="mt-1">
                <StatusBadge
                  :status="isAdmin ? 'admin' : 'user'"
                  kind="user"
                  :label="isAdmin ? 'Administrator' : 'User'"
                />
              </dd>
            </div>
          </dl>

          <div class="mt-6">
            <h3 class="stat-label">Domains you can see</h3>
            <p v-if="isAdmin" class="mt-1 text-sm text-gray-600">
              As an administrator you can see every domain, and you manage users and settings
              under Administration.
            </p>
            <template v-else>
              <div v-if="domains.length" class="mt-2 flex flex-wrap gap-1">
                <span v-for="domain in domains" :key="domain" class="badge badge-gray font-mono">
                  {{ domain }}
                </span>
              </div>
              <p v-else class="mt-1 text-sm text-gray-600">
                No domains are assigned to your account yet — an administrator has to add one
                before report data appears.
              </p>
            </template>
          </div>
        </div>
      </div>

      <!-- Password -->
      <div class="card">
        <div class="card-header">
          <h2 class="text-lg leading-6 font-medium text-gray-900">Change password</h2>
          <p class="mt-1 text-sm text-gray-500">
            At least 12 characters. Changing it signs out every other device you are signed in
            on; this one stays.
          </p>
        </div>
        <div class="card-body">
          <form class="space-y-4" @submit.prevent="submit">
            <div>
              <label for="current-password" class="block text-sm font-medium text-gray-700 mb-1">
                Current password
              </label>
              <input
                id="current-password"
                v-model="currentPassword"
                type="password"
                autocomplete="current-password"
                required
                class="w-full sm:w-96 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            <div>
              <label for="new-password" class="block text-sm font-medium text-gray-700 mb-1">
                New password
              </label>
              <input
                id="new-password"
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
                class="w-full sm:w-96 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            <div>
              <label for="confirm-password" class="block text-sm font-medium text-gray-700 mb-1">
                Repeat new password
              </label>
              <input
                id="confirm-password"
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
                class="w-full sm:w-96 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <p v-if="mismatch" class="mt-1 text-sm text-danger-700">
                The two new passwords do not match.
              </p>
            </div>

            <div class="flex items-center space-x-3">
              <button type="submit" class="btn btn-primary" :disabled="busy || !canSubmit">
                {{ busy ? 'Saving…' : 'Change password' }}
              </button>
              <button type="button" class="btn btn-secondary" @click="signOut">Sign out</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { authApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';

const router = useRouter();
const toast = useToast();
const { state, isAdmin, logout, setDomains } = useAuth();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const busy = ref(false);

const user = computed(() => state.user);
const domains = computed(() => state.domains);
const mismatch = computed(
  () => confirmPassword.value.length > 0 && newPassword.value !== confirmPassword.value
);
const canSubmit = computed(
  () =>
    currentPassword.value.length > 0 &&
    newPassword.value.length >= 12 &&
    newPassword.value === confirmPassword.value
);

const submit = async () => {
  if (newPassword.value !== confirmPassword.value) {
    return;
  }

  busy.value = true;

  try {
    await authApi.changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';

    // The server rotated the session cookie and cleared the reset flag; refresh the local
    // view of the account so the warning banner disappears.
    const session = await authApi.me();
    state.user = session.user;
    setDomains(session.domains);

    toast.success('Password changed. Every other signed-in device has been signed out.');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not change the password');
  } finally {
    busy.value = false;
  }
};

const signOut = async () => {
  await logout();
  await router.push({ name: 'Login' });
};
</script>
