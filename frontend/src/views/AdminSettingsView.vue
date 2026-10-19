<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Application settings"
      description="Options the app reads at runtime — no restart or rebuild needed"
    >
      <template #actions>
        <button @click="load" class="btn btn-secondary">Refresh</button>
      </template>
    </PageHeader>

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
          <p v-if="category === 'mailbox'" class="px-4 py-5 sm:px-6 text-sm text-gray-600 border-b border-gray-200">
            If the mailbox was configured through the container's environment, those values seeded
            it on first start. A value saved below takes over for the mailbox specifically; the
            environment values are still used for everything else.
          </p>
          <div class="divide-y divide-gray-100">
            <div v-for="setting in settingsByCategory(category)" :key="setting.key" class="p-4 sm:p-6">
              <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div class="sm:max-w-xl">
                  <div class="flex items-center space-x-2">
                    <h3 class="text-sm font-medium text-gray-900">{{ setting.label }}</h3>
                    <StatusBadge v-if="setting.dangerous" status="warn" label="careful" />
                    <StatusBadge v-if="setting.secret && setting.isSet" status="ok" label="stored" />
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

                  <!-- secret: the API returns no value, so the box is always blank and typing replaces -->
                  <input
                    v-else-if="setting.secret"
                    v-model="draft[setting.key]"
                    type="password"
                    autocomplete="new-password"
                    :disabled="!isAdmin"
                    :placeholder="setting.isSet ? '•••• stored — type to replace' : 'Not set'"
                    class="w-56 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
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

            </div>
          </div>

          <div v-if="category === 'mailbox'" class="px-4 py-5 sm:px-6 bg-surface-muted border-t border-gray-200">
            <div class="flex flex-wrap items-center gap-3">
              <button class="btn btn-secondary text-sm" :disabled="testing" @click="runMailboxTest">
                <span
                  v-if="testing"
                  class="inline-block h-3 w-3 mr-2 rounded-full border-2 border-gray-400 border-t-transparent animate-spin"
                ></span>
                {{ testing ? 'Testing…' : 'Test connection' }}
              </button>
              <span class="text-xs text-gray-500">
                Uses the values above, including unsaved edits; a blank box falls back to the stored value.
              </span>
            </div>

            <div v-if="testResult" class="mt-3">
              <p
                class="rounded-md px-3 py-2 text-sm"
                :class="testResult.ok ? 'bg-success-50 text-success-800' : 'bg-danger-50 text-danger-800'"
              >
                {{ testResult.message }}
              </p>
              <p v-if="testResult.greeting" class="mt-1 text-xs font-mono text-gray-500">{{ testResult.greeting }}</p>
            </div>
          </div>

          <!-- Retention: the policy is the settings above; this is what it would do today. -->
          <div v-if="category === 'data'" class="px-4 py-5 sm:px-6 bg-surface-muted border-t border-gray-200">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 class="text-sm font-medium text-gray-900">What a run would delete now</h3>
                <p class="mt-1 text-sm text-gray-600 max-w-2xl">
                  Runs automatically every six hours and once shortly after start. Deleting is
                  irreversible, and a backup taken earlier still contains the rows.
                </p>
              </div>
              <div class="flex items-center gap-3">
                <button class="btn btn-secondary text-sm" :disabled="retentionLoading" @click="loadRetention">
                  Recalculate
                </button>
                <button
                  class="btn btn-primary text-sm"
                  :disabled="!isAdmin || runningRetention || !retentionTotal"
                  @click="runRetentionNow"
                >
                  {{ runningRetention ? 'Running…' : 'Run now' }}
                </button>
              </div>
            </div>

            <div v-if="retention" class="mt-4 overflow-x-auto">
              <table class="table">
                <thead class="table-header">
                  <tr>
                    <th class="table-header-cell">Data</th>
                    <th class="table-header-cell">Keep</th>
                    <th class="table-header-cell">Older than</th>
                    <th class="table-header-cell text-right">Rows affected</th>
                  </tr>
                </thead>
                <tbody class="table-body">
                  <tr v-for="rule in retention.rules" :key="rule.key" class="table-row">
                    <td class="table-cell">{{ retentionLabel(rule.key) }}</td>
                    <td class="table-cell">
                      {{ rule.retentionDays === 0 ? 'Forever' : `${rule.retentionDays} days` }}
                    </td>
                    <td class="table-cell">
                      {{ rule.cutoff ? formatDateTime(rule.cutoff) : '—' }}
                    </td>
                    <td class="table-cell text-right nums">{{ rule.pending }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p v-if="retentionError" class="mt-3 rounded-md px-3 py-2 text-sm bg-danger-50 text-danger-800">
              {{ retentionError }}
            </p>
            <p v-else-if="retention && retentionTotal === 0" class="mt-3 text-xs text-gray-500">
              Nothing is currently past its retention window.
            </p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { settingsApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';
import type { AppSetting, MailboxTestResult, RetentionPlan, RetentionRuleKey } from '@/types/api';

const { isAdmin } = useAuth();
const toast = useToast();

const settings = ref<AppSetting[]>([]);
const categories = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const savingKey = ref<string | null>(null);
const draft = reactive<Record<string, string>>({});
const testing = ref(false);
const testResult = ref<MailboxTestResult | null>(null);
const retention = ref<RetentionPlan | null>(null);
const retentionLoading = ref(false);
const retentionError = ref<string | null>(null);
const runningRetention = ref(false);

const retentionTotal = computed(() =>
  (retention.value?.rules ?? []).reduce((sum, rule) => sum + rule.pending, 0)
);

const retentionLabels: Record<RetentionRuleKey, string> = {
  reports: 'Aggregate reports',
  forensics: 'Forensic reports',
  audit: 'Audit log',
};

const retentionLabel = (key: RetentionRuleKey): string => retentionLabels[key] ?? key;

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
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load settings';
  } finally {
    loading.value = false;
  }
};

const save = async (setting: AppSetting) => {
  // A blank secret box means "keep the stored credential", never "clear it".
  if (setting.secret && !draft[setting.key]) return;

  savingKey.value = setting.key;

  try {
    const updated = await settingsApi.update(setting.key, draft[setting.key] ?? '');
    const index = settings.value.findIndex((s) => s.key === updated.key);
    if (index !== -1) {
      const merged = { ...settings.value[index], ...updated };
      // Sending a value for a secret always leaves one stored, even if the response omits isSet.
      settings.value[index] = merged.secret ? { ...merged, isSet: true } : merged;
    }
    draft[setting.key] = updated.value;
    toast.success(`${updated.label} saved`);

    // A retention setting changes what the next run would delete, and nothing else here does.
    if (updated.key.startsWith('data.')) {
      await loadRetention();
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not save');
  } finally {
    savingKey.value = null;
  }
};

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

/**
 * Tests the mailbox with the current drafts. Fields left blank are sent as absent so the server
 * falls back to the stored or environment value - that is what makes an untyped password test
 * the saved credential rather than replace it.
 */
const runMailboxTest = async () => {
  testing.value = true;
  testResult.value = null;

  const port = draft['mailbox.port'];

  try {
    testResult.value = await settingsApi.testMailbox({
      host: draft['mailbox.host'] || undefined,
      port: port ? Number(port) : undefined,
      user: draft['mailbox.user'] || undefined,
      password: draft['mailbox.password'] || undefined,
    });
  } catch (err) {
    // Reaching here means the endpoint or the network broke, not that the mailbox refused us.
    testResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : 'Could not run the mailbox test',
    };
  } finally {
    testing.value = false;
  }
};

onMounted(load);

const loadRetention = async () => {
  retentionLoading.value = true;
  retentionError.value = null;

  try {
    retention.value = await settingsApi.retention();
  } catch (err) {
    retentionError.value = err instanceof Error ? err.message : 'Could not read the retention policy';
  } finally {
    retentionLoading.value = false;
  }
};

/**
 * Irreversible, so it asks first and states the number it is about to delete. `confirm` is
 * deliberate rather than a modal: this is an administrator-only screen and a second click is
 * the whole safeguard the operation needs.
 */
const runRetentionNow = async () => {
  const total = retentionTotal.value;
  if (!total) return;

  const confirmed = window.confirm(
    `Permanently delete ${total} row(s) that are past their retention window?\n\n` +
      'This cannot be undone. A backup taken earlier still contains them.'
  );
  if (!confirmed) return;

  runningRetention.value = true;
  retentionError.value = null;

  try {
    const result = await settingsApi.runRetention();
    const { reports, forensics, audit } = result.deleted;
    toast.success(
      `Removed ${reports} report(s), ${forensics} forensic report(s), ${audit} audit row(s)`
    );
  } catch (err) {
    retentionError.value = err instanceof Error ? err.message : 'Retention run failed';
  } finally {
    runningRetention.value = false;
    await loadRetention();
  }
};

onMounted(loadRetention);
</script>
