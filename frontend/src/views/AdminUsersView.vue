<template>
  <div class="min-h-screen bg-gray-50">
    <div class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="py-6 flex items-center justify-between">
          <div>
            <h1 class="text-3xl font-bold text-gray-900">Users</h1>
            <p class="mt-2 text-sm text-gray-600">
              Accounts and the domains each of them may see
            </p>
          </div>
          <button @click="load" class="btn btn-secondary">Refresh</button>
        </div>
      </div>
    </div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div v-if="notice" class="rounded-md p-3" :class="noticeError ? 'bg-danger-50' : 'bg-success-50'">
        <p class="text-sm" :class="noticeError ? 'text-danger-700' : 'text-success-700'">{{ notice }}</p>
      </div>

      <!-- Create user -->
      <div class="card">
        <div class="card-header">
          <h2 class="text-lg leading-6 font-medium text-gray-900">Create a user</h2>
          <p class="mt-1 text-sm text-gray-500">
            An account with no domains assigned can sign in but sees no report data.
          </p>
        </div>
        <div class="card-body">
          <form class="grid grid-cols-1 md:grid-cols-4 gap-4" @submit.prevent="createUser">
            <div>
              <label for="new-email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                id="new-email"
                v-model="form.email"
                type="email"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label for="new-name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                id="new-name"
                v-model="form.name"
                type="text"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label for="new-role" class="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select
                id="new-role"
                v-model="form.role"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="user">User (assigned domains)</option>
                <option value="admin">Administrator (everything)</option>
              </select>
            </div>
            <div>
              <label for="new-password" class="block text-sm font-medium text-gray-700 mb-1">
                Initial password
              </label>
              <input
                id="new-password"
                v-model="form.password"
                type="password"
                required
                minlength="12"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <p class="mt-1 text-xs text-gray-500">At least 12 characters.</p>
            </div>

            <div class="md:col-span-4">
              <span class="block text-sm font-medium text-gray-700 mb-1">Domains</span>
              <div class="flex flex-wrap gap-3">
                <label
                  v-for="option in domainOptions"
                  :key="option"
                  class="inline-flex items-center text-sm text-gray-700"
                >
                  <input
                    type="checkbox"
                    class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                    :value="option"
                    v-model="form.domains"
                  />
                  <span class="ml-2 font-mono">{{ option }}</span>
                </label>
                <p v-if="domainOptions.length === 0" class="text-sm text-gray-500">
                  No domains seen yet — they appear here once reports arrive.
                </p>
              </div>
            </div>

            <div class="md:col-span-4 flex justify-end">
              <button type="submit" class="btn btn-primary" :disabled="creating">
                {{ creating ? 'Creating…' : 'Create user' }}
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Users -->
      <DataTable
        :columns="columns"
        :data="users"
        :loading="loading"
        title="Accounts"
        description="Deactivating an account ends its sessions immediately"
        empty-message="No users"
      >
        <template #cell-role="{ value }">
          <span class="badge" :class="value === 'admin' ? 'badge-success' : 'badge-gray'">{{ value }}</span>
        </template>
        <template #cell-isActive="{ value, item }">
          <span class="badge" :class="value ? 'badge-success' : 'badge-danger'">
            {{ value ? 'Active' : 'Disabled' }}
          </span>
          <span v-if="item.lockedUntil" class="badge badge-warning ml-1">locked</span>
        </template>
        <template #cell-domains="{ value }">
          <div class="flex flex-wrap gap-1">
            <span v-for="domain in value" :key="domain" class="badge badge-gray font-mono">{{ domain }}</span>
            <span v-if="!value.length" class="text-xs text-gray-500">none</span>
          </div>
        </template>
        <template #cell-lastLoginAt="{ value }">
          {{ value ? formatDateTime(value) : 'never' }}
        </template>
        <template #cell-actions="{ item }">
          <div class="flex items-center space-x-2">
            <button class="btn btn-secondary text-xs" @click="editDomains(item)">Domains</button>
            <button class="btn btn-secondary text-xs" @click="startPasswordReset(item)">Password</button>
            <button class="btn btn-secondary text-xs" @click="toggleActive(item)">
              {{ item.isActive ? 'Disable' : 'Enable' }}
            </button>
            <button class="btn btn-secondary text-xs text-danger-700" @click="removeUser(item)">Delete</button>
          </div>
        </template>
      </DataTable>

      <!-- Domain assignment -->
      <div v-if="editing" class="card">
        <div class="card-header flex items-center justify-between">
          <div>
            <h2 class="text-lg leading-6 font-medium text-gray-900">
              Domains for {{ editing.email }}
            </h2>
            <p class="mt-1 text-sm text-gray-500">Only these domains' reports are visible to them.</p>
          </div>
          <button class="btn btn-secondary text-sm" @click="editing = null">Close</button>
        </div>
        <div class="card-body space-y-4">
          <div class="flex flex-wrap gap-3">
            <label
              v-for="option in allDomainOptions"
              :key="option"
              class="inline-flex items-center text-sm text-gray-700"
            >
              <input
                type="checkbox"
                class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                :value="option"
                v-model="domainDraft"
              />
              <span class="ml-2 font-mono">{{ option }}</span>
            </label>
          </div>

          <div class="flex items-end space-x-3">
            <div>
              <label for="add-domain" class="block text-sm font-medium text-gray-700 mb-1">
                Add a domain by hand
              </label>
              <input
                id="add-domain"
                v-model="newDomain"
                type="text"
                placeholder="example.com"
                class="w-56 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <button class="btn btn-secondary" @click="addDomain">Add</button>
          </div>

          <div class="flex justify-end">
            <button class="btn btn-primary" :disabled="savingDomains" @click="saveDomains">
              {{ savingDomains ? 'Saving…' : 'Save domains' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Password reset -->
      <div v-if="resetting" class="card">
        <div class="card-header flex items-center justify-between">
          <div>
            <h2 class="text-lg leading-6 font-medium text-gray-900">
              Reset password for {{ resetting.email }}
            </h2>
            <p class="mt-1 text-sm text-gray-500">
              Their existing sessions are signed out, and they must change it at next login.
            </p>
          </div>
          <button class="btn btn-secondary text-sm" @click="resetting = null">Close</button>
        </div>
        <div class="card-body flex items-end space-x-3">
          <div>
            <label for="reset-password" class="block text-sm font-medium text-gray-700 mb-1">
              New password
            </label>
            <input
              id="reset-password"
              v-model="newPassword"
              type="password"
              minlength="12"
              class="w-64 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <button class="btn btn-primary" :disabled="resettingPassword" @click="resetPassword">
            {{ resettingPassword ? 'Saving…' : 'Set password' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import DataTable from '@/components/DataTable.vue';
import { usersApi } from '@/api/client';
import type { ManagedUser } from '@/types/api';

const columns = [
  { key: 'email', label: 'Email', sortable: false },
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'isActive', label: 'Status' },
  { key: 'domains', label: 'Domains' },
  { key: 'lastLoginAt', label: 'Last login' },
  { key: 'activeSessions', label: 'Sessions', type: 'number' as const },
  { key: 'actions', label: '' },
];

const users = ref<ManagedUser[]>([]);
const availableDomains = ref<string[]>([]);
const loading = ref(false);
const creating = ref(false);
const notice = ref<string | null>(null);
const noticeError = ref(false);

const form = reactive<{ email: string; name: string; role: 'admin' | 'user'; password: string; domains: string[] }>({
  email: '',
  name: '',
  role: 'user',
  password: '',
  domains: [],
});

const editing = ref<ManagedUser | null>(null);
const domainDraft = ref<string[]>([]);
const newDomain = ref('');
const savingDomains = ref(false);

const resetting = ref<ManagedUser | null>(null);
const newPassword = ref('');
const resettingPassword = ref(false);

const domainOptions = computed(() => availableDomains.value);

// Domains already assigned to someone, plus anything an admin adds by hand.
const allDomainOptions = computed(() => {
  const names = new Set<string>(availableDomains.value);
  for (const user of users.value) {
    for (const domain of user.domains) {
      names.add(domain);
    }
  }
  for (const domain of domainDraft.value) {
    names.add(domain);
  }
  return [...names].sort();
});

const setNotice = (text: string, isError = false) => {
  notice.value = text;
  noticeError.value = isError;
  window.setTimeout(() => {
    notice.value = null;
  }, 5000);
};

const load = async () => {
  loading.value = true;

  try {
    const [userList, domains] = await Promise.all([usersApi.list(), usersApi.availableDomains()]);
    users.value = userList;
    availableDomains.value = domains.map((d) => d.domain);
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Failed to load users', true);
  } finally {
    loading.value = false;
  }
};

const createUser = async () => {
  creating.value = true;

  try {
    await usersApi.create({
      email: form.email,
      password: form.password,
      name: form.name || undefined,
      role: form.role,
      domains: form.domains,
    });
    setNotice(`Created ${form.email}`);
    form.email = '';
    form.name = '';
    form.password = '';
    form.domains = [];
    form.role = 'user';
    await load();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Could not create the user', true);
  } finally {
    creating.value = false;
  }
};

const toggleActive = async (user: ManagedUser) => {
  try {
    await usersApi.update(user.id, { isActive: !user.isActive });
    setNotice(`${user.isActive ? 'Disabled' : 'Enabled'} ${user.email}`);
    await load();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Could not update the user', true);
  }
};

const removeUser = async (user: ManagedUser) => {
  if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) {
    return;
  }

  try {
    await usersApi.remove(user.id);
    setNotice(`Deleted ${user.email}`);
    await load();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Could not delete the user', true);
  }
};

const editDomains = (user: ManagedUser) => {
  editing.value = user;
  domainDraft.value = [...user.domains];
  newDomain.value = '';
};

const addDomain = () => {
  const domain = newDomain.value.trim().toLowerCase();
  if (domain && !domainDraft.value.includes(domain)) {
    domainDraft.value = [...domainDraft.value, domain];
  }
  newDomain.value = '';
};

const saveDomains = async () => {
  if (!editing.value) {
    return;
  }

  savingDomains.value = true;

  try {
    const applied = await usersApi.setDomains(editing.value.id, domainDraft.value);
    setNotice(`Saved ${applied.length} domain(s) for ${editing.value.email}`);
    editing.value = null;
    await load();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Could not save the domains', true);
  } finally {
    savingDomains.value = false;
  }
};

const startPasswordReset = (user: ManagedUser) => {
  resetting.value = user;
  newPassword.value = '';
};

const resetPassword = async () => {
  if (!resetting.value) {
    return;
  }

  resettingPassword.value = true;

  try {
    await usersApi.resetPassword(resetting.value.id, newPassword.value);
    setNotice(`Password set for ${resetting.value.email}`);
    resetting.value = null;
    newPassword.value = '';
    await load();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : 'Could not set the password', true);
  } finally {
    resettingPassword.value = false;
  }
};

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

onMounted(load);
</script>
