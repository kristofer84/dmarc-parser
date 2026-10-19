<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Account"
      description="Your sign-in details, passkeys and password"
      container-class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8"
    />

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!--
        The first-login invitation. It is a banner and not a gate on purpose: the password is a
        complete way in, so "Not now" has to be a real answer and the server remembers it.
        bg-primary-100/text-primary-800 because both ends of that pair are re-mapped for the dark
        theme, unlike the 50 step, which stays light.
      -->
      <div
        v-if="showPasskeyPrompt"
        class="rounded-md bg-primary-100 p-4 sm:flex sm:items-start sm:justify-between sm:space-x-4"
      >
        <div>
          <h3 class="text-sm font-medium text-primary-800">Sign in without a password</h3>
          <p class="mt-1 text-sm text-primary-800">
            A passkey uses this device's fingerprint, face or PIN. Your password keeps working, so
            nothing is lost if you lose the device.
          </p>
        </div>
        <div class="mt-3 flex items-center space-x-2 sm:mt-0 shrink-0">
          <button class="btn btn-primary text-sm" :disabled="addingPasskey" @click="addPasskey">
            {{ addingPasskey ? 'Waiting…' : 'Add a passkey' }}
          </button>
          <button
            class="btn btn-secondary text-sm"
            :disabled="dismissingPrompt"
            @click="dismissPrompt"
          >
            Not now
          </button>
        </div>
      </div>

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

      <!-- Passkeys -->
      <div v-if="passkeysEnabled" class="card">
        <div class="card-header sm:flex sm:items-start sm:justify-between sm:space-x-4">
          <div>
            <h2 class="text-lg leading-6 font-medium text-gray-900">Your passkeys</h2>
            <p class="mt-1 text-sm text-gray-500">
              Every device you can sign in with, and when it was last used. The first one is worth
              adding before you need it.
            </p>
          </div>
          <button
            class="btn btn-primary mt-3 sm:mt-0 shrink-0"
            :disabled="addingPasskey"
            @click="addPasskey"
          >
            {{ addingPasskey ? 'Waiting for your device…' : 'Add a passkey' }}
          </button>
        </div>
        <div class="card-body">
          <p v-if="loadingPasskeys" class="text-sm text-gray-500">Loading…</p>

          <ul v-else-if="passkeys.length" class="divide-y divide-gray-200">
            <li
              v-for="passkey in passkeys"
              :key="passkey.id"
              class="py-3 first:pt-0 last:pb-0 flex items-center justify-between space-x-4"
            >
              <div class="min-w-0">
                <p class="text-sm font-medium text-gray-900 truncate">
                  {{ passkey.label || 'Passkey' }}
                </p>
                <p class="mt-0.5 text-xs text-gray-500">
                  {{ describePasskeyDevice(passkey.deviceType) }}
                  <span class="nums">· added {{ formatDate(passkey.createdAt) }}</span>
                  <span v-if="passkey.lastUsedAt" class="nums">
                    · last used {{ formatDateTime(passkey.lastUsedAt) }}
                  </span>
                  <span v-else>· never used</span>
                </p>
              </div>
              <button
                class="btn btn-secondary text-xs text-danger-700 shrink-0"
                :disabled="removingId === passkey.id"
                @click="removePasskey(passkey)"
              >
                {{ removingId === passkey.id ? 'Removing…' : 'Remove' }}
              </button>
            </li>
          </ul>

          <p v-else class="text-sm text-gray-600">
            No passkeys yet. Adding one lets you sign in without typing your password.
          </p>
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
                class="w-full sm:w-96 px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
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
                class="w-full sm:w-96 px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
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
                class="w-full sm:w-96 px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
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
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { authApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import {
  describePasskeyDevice,
  isPasskeyCancellation,
  registerPasskey,
} from '@/composables/usePasskeys';
import { useToast } from '@/composables/useToast';
import type { PasskeySummary } from '@/types/api';

const router = useRouter();
const toast = useToast();
const { state, isAdmin, logout, refreshSession } = useAuth();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const busy = ref(false);

/** Defaults on: a policy read that fails must not hide a feature that actually works. */
const passkeysEnabled = ref(true);
const passkeys = ref<PasskeySummary[]>([]);
const loadingPasskeys = ref(false);
const addingPasskey = ref(false);
const removingId = ref<string | null>(null);
const dismissingPrompt = ref(false);

const user = computed(() => state.user);
const domains = computed(() => state.domains);
const showPasskeyPrompt = computed(
  () =>
    passkeysEnabled.value &&
    user.value?.passkeyCount === 0 &&
    !user.value?.passkeyPromptDismissed
);
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
    await refreshSession();

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

const formatDate = (value: string): string => new Date(value).toLocaleDateString();

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

const loadPasskeys = async () => {
  loadingPasskeys.value = true;

  try {
    passkeys.value = await authApi.listPasskeys();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not load your passkeys');
  } finally {
    loadingPasskeys.value = false;
  }
};

const addPasskey = async () => {
  addingPasskey.value = true;

  try {
    await registerPasskey();
    toast.success('Passkey added. You can now sign in with it.');
    await loadPasskeys();
    // The count and the dismissed flag live on the cached user, and the header reads them too.
    await refreshSession();
  } catch (error) {
    // Closing the browser's prompt is a normal way to change one's mind, so it says nothing.
    if (!isPasskeyCancellation(error)) {
      toast.error(error instanceof Error ? error.message : 'Could not add the passkey');
    }
  } finally {
    addingPasskey.value = false;
  }
};

const removePasskey = async (passkey: PasskeySummary) => {
  const label = passkey.label || 'this passkey';
  if (
    !window.confirm(
      `Remove ${label}? You can still sign in with your password, and add a new passkey here.`
    )
  ) {
    return;
  }

  removingId.value = passkey.id;

  try {
    await authApi.removePasskey(passkey.id);
    toast.success('Passkey removed');
    await loadPasskeys();
    await refreshSession();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not remove the passkey');
  } finally {
    removingId.value = null;
  }
};

const dismissPrompt = async () => {
  dismissingPrompt.value = true;

  try {
    await authApi.dismissPasskeyPrompt();
    // Mirrored locally so the banner goes at once; the server holds the same flag.
    if (state.user) {
      state.user.passkeyPromptDismissed = true;
    }
    toast.info('You can add a passkey from this page whenever you want one.');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not dismiss the prompt');
  } finally {
    dismissingPrompt.value = false;
  }
};

onMounted(async () => {
  try {
    passkeysEnabled.value = (await authApi.sessionPolicy()).passkeysEnabled;
  } catch {
    // Leave the default; see the declaration.
  }

  if (passkeysEnabled.value) {
    await loadPasskeys();
  }
});
</script>
