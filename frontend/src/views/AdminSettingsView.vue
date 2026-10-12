<template>
  <div class="min-h-screen bg-gray-50">
    <div class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="py-6 flex items-center justify-between">
          <div>
            <h1 class="text-3xl font-bold text-gray-900">Application settings</h1>
            <p class="mt-2 text-sm text-gray-600">
              Options the app reads at runtime — no restart or rebuild needed
            </p>
          </div>
          <button @click="load" class="btn btn-secondary">Refresh</button>
        </div>
      </div>
    </div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div v-if="loading" class="flex items-center justify-center py-12">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>

      <div v-else-if="error" class="rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load settings</h3>
        <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
      </div>

      <template v-else>
        <div v-if="!isAdmin" class="rounded-md bg-warning-50 p-4 text-sm text-warning-800">
          Settings are read-only for your account.
        </div>

        <div v-for="category in categories" :key="category" class="card">
          <div class="card-header">
            <h2 class="text-lg leading-6 font-medium text-gray-900 capitalize">{{ category }}</h2>
          </div>
          <div class="divide-y divide-gray-100">
            <div v-for="setting in settingsByCategory(category)" :key="setting.key" class="p-4 sm:p-6">
              <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div class="sm:max-w-xl">
                  <div class="flex items-center space-x-2">
                    <h3 class="text-sm font-medium text-gray-900">{{ setting.label }}</h3>
                    <span v-if="setting.dangerous" class="badge badge-warning">careful</span>
                  </div>
                  <p class="mt-1 text-sm text-gray-600">{{ setting.description }}</p>
                  <p class="mt-2 text-xs text-gray-400 font-mono">{{ setting.key }}</p>
                  <p v-if="setting.updatedAt" class="mt-1 text-xs text-gray-400">
                    Last changed {{ formatDateTime(setting.updatedAt) }}
                    <span v-if="setting.updatedBy"> by {{ setting.updatedBy }}</span>
                  </p>
                </div>

                <div class="flex items-center space-x-3">
                  <!-- boolean -->
                  <label v-if="setting.type === 'boolean'" class="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                      :checked="draft[setting.key] === 'true'"
                      :disabled="!isAdmin || savingKey === setting.key"
                      @change="draft[setting.key] = ($event.target as HTMLInputElement).checked ? 'true' : 'false'"
                    />
                    <span class="ml-2 text-sm text-gray-700">
                      {{ draft[setting.key] === 'true' ? 'On' : 'Off' }}
                    </span>
                  </label>

                  <!-- number -->
                  <input
                    v-else-if="setting.type === 'number'"
                    v-model="draft[setting.key]"
                    type="number"
                    :min="setting.min"
                    :max="setting.max"
                    :disabled="!isAdmin"
                    class="w-28 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                  />

                  <!-- string -->
                  <input
                    v-else
                    v-model="draft[setting.key]"
                    type="text"
                    :disabled="!isAdmin"
                    class="w-56 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                  />

                  <button
                    v-if="isAdmin"
                    class="btn btn-primary text-sm"
                    :disabled="!isDirty(setting) || savingKey === setting.key"
                    @click="save(setting)"
                  >
                    {{ savingKey === setting.key ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </div>

              <p v-if="messages[setting.key]" class="mt-2 text-sm" :class="messages[setting.key].error ? 'text-danger-700' : 'text-success-700'">
                {{ messages[setting.key].text }}
              </p>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { settingsApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import type { AppSetting } from '@/types/api';

const { isAdmin } = useAuth();

const settings = ref<AppSetting[]>([]);
const categories = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const savingKey = ref<string | null>(null);
const draft = reactive<Record<string, string>>({});
const messages = reactive<Record<string, { text: string; error: boolean }>>({});

const settingsByCategory = (category: string) =>
  settings.value.filter((setting) => setting.category === category);

const isDirty = (setting: AppSetting): boolean => draft[setting.key] !== setting.value;

const load = async () => {
  loading.value = true;
  error.value = null;

  try {
    const result = await settingsApi.list();
    settings.value = result.data;
    categories.value = result.categories;
    for (const setting of result.data) {
      draft[setting.key] = setting.value;
      delete messages[setting.key];
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load settings';
  } finally {
    loading.value = false;
  }
};

const save = async (setting: AppSetting) => {
  savingKey.value = setting.key;
  delete messages[setting.key];

  try {
    const updated = await settingsApi.update(setting.key, draft[setting.key] ?? '');
    const index = settings.value.findIndex((s) => s.key === updated.key);
    if (index !== -1) {
      settings.value[index] = updated;
    }
    draft[setting.key] = updated.value;
    messages[setting.key] = { text: 'Saved', error: false };
  } catch (err) {
    messages[setting.key] = {
      text: err instanceof Error ? err.message : 'Could not save',
      error: true,
    };
  } finally {
    savingKey.value = null;
  }
};

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

onMounted(load);
</script>
