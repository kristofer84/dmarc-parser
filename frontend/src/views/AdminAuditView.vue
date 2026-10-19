<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Audit log"
      description="Who changed what, when, from where — and whether it worked"
    >
      <template #actions>
        <button class="btn btn-secondary" @click="load">Refresh</button>
        <button class="btn btn-secondary" :disabled="exporting !== null" @click="download('csv')">
          {{ exporting === 'csv' ? 'Exporting…' : 'Export CSV' }}
        </button>
        <button class="btn btn-primary" :disabled="exporting !== null" @click="download('json')">
          {{ exporting === 'json' ? 'Exporting…' : 'Export JSON' }}
        </button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="mb-6 bg-surface p-4 rounded-card shadow-card border border-gray-200">
        <div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div>
            <label for="audit-actor" class="block text-sm font-medium text-gray-700 mb-1">
              Actor
            </label>
            <input
              id="audit-actor"
              v-model="filters.actor"
              type="text"
              placeholder="someone@example.com"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @input="debouncedApply"
            />
          </div>

          <div>
            <label for="audit-action" class="block text-sm font-medium text-gray-700 mb-1">
              Action
            </label>
            <select
              id="audit-action"
              v-model="filters.action"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            >
              <option value="">All actions</option>
              <option v-for="entry in actions" :key="entry.action" :value="entry.action">
                {{ entry.action }} ({{ entry.count }})
              </option>
            </select>
          </div>

          <div>
            <label for="audit-outcome" class="block text-sm font-medium text-gray-700 mb-1">
              Outcome
            </label>
            <select
              id="audit-outcome"
              v-model="filters.outcome"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            >
              <option value="">Any</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          </div>

          <div>
            <label for="audit-from" class="block text-sm font-medium text-gray-700 mb-1">
              From
            </label>
            <input
              id="audit-from"
              v-model="filters.from"
              type="date"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>

          <div>
            <label for="audit-to" class="block text-sm font-medium text-gray-700 mb-1">
              To
            </label>
            <input
              id="audit-to"
              v-model="filters.to"
              type="date"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-gray-500">
            Newest first. A row is written when the response finishes, so its outcome always
            matches what the request actually did. Exporting is itself recorded.
          </p>
          <button class="btn btn-secondary text-sm" @click="clearFilters">Clear filters</button>
        </div>
      </div>

      <DataTable
        :columns="columns"
        :data="events"
        :loading="loading"
        :pagination="pagination || undefined"
        title="Recorded activity"
        description="Passwords, secrets and session tokens are redacted at write time, never here"
        empty-message="No audit entries match these filters."
        @page-change="handlePageChange"
      >
        <template #cell-createdAt="{ value }">
          <div class="text-sm text-gray-900 nums whitespace-nowrap">{{ formatDateTime(value) }}</div>
        </template>

        <template #cell-actor="{ value }">
          <span class="text-sm text-gray-900 break-all">{{ value }}</span>
        </template>

        <template #cell-action="{ value }">
          <code class="text-xs text-gray-700">{{ value }}</code>
        </template>

        <template #cell-outcome="{ value }">
          <StatusBadge
            :status="value === 'failure' ? 'error' : 'ok'"
            :label="value === 'failure' ? 'failed' : 'ok'"
          />
        </template>

        <template #cell-target="{ value }">
          <span v-if="value" class="text-sm text-gray-700 break-all">{{ value }}</span>
          <span v-else class="text-gray-400">—</span>
        </template>

        <template #cell-ip="{ value }">
          <span v-if="value" class="text-xs text-gray-600 nums">{{ value }}</span>
          <span v-else class="text-gray-400">—</span>
        </template>

        <template #cell-detail="{ value }">
          <span v-if="value" class="block max-w-md truncate text-xs text-gray-600 font-mono" :title="value">
            {{ value }}
          </span>
          <span v-else class="text-gray-400">—</span>
        </template>
      </DataTable>

      <div v-if="error" class="mt-6 rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load the audit trail</h3>
        <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
        <button class="btn btn-secondary text-sm mt-3" @click="load">Try again</button>
      </div>

      <p v-if="lastExport" class="mt-4 text-xs text-gray-500">
        Exported {{ lastExport.rows }} row(s).
        <span class="font-mono break-all">sha256:{{ lastExport.digest }}</span> — keep it with the
        file; it proves the copy was not altered after export.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import DataTable from '@/components/DataTable.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { auditApi } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type {
  AuditActionCount,
  AuditEvent,
  AuditFilters,
  AuditOutcome,
  PaginatedResponse,
} from '@/types/api';

const toast = useToast();

const events = ref<AuditEvent[]>([]);
const actions = ref<AuditActionCount[]>([]);
const pagination = ref<PaginatedResponse<AuditEvent>['pagination'] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const exporting = ref<'csv' | 'json' | null>(null);
const lastExport = ref<{ rows: number; digest: string } | null>(null);

const filters = reactive({
  actor: '',
  action: '',
  outcome: '' as AuditOutcome | '',
  from: '',
  to: '',
  page: 1,
  limit: 50,
});

const columns = [
  { key: 'createdAt', label: 'Time' },
  { key: 'actor', label: 'Actor' },
  { key: 'action', label: 'Action' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'target', label: 'Target' },
  { key: 'ip', label: 'IP' },
  { key: 'detail', label: 'Detail' },
];

/**
 * Date inputs are calendar days in the operator's timezone. `from` becomes the start of that
 * day and `to` the start of the next one, which is why the server's window is [from, to).
 */
const toBounds = (): Pick<AuditFilters, 'from' | 'to'> => {
  const bounds: Pick<AuditFilters, 'from' | 'to'> = {};
  if (filters.from) {
    bounds.from = new Date(`${filters.from}T00:00:00`).toISOString();
  }
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    bounds.to = end.toISOString();
  }
  return bounds;
};

const buildFilters = (): AuditFilters => ({
  ...(filters.actor.trim() ? { actor: filters.actor.trim() } : {}),
  ...(filters.action ? { action: filters.action } : {}),
  ...(filters.outcome ? { outcome: filters.outcome } : {}),
  ...toBounds(),
});

const load = async () => {
  loading.value = true;
  error.value = null;

  try {
    const [page, actionList] = await Promise.all([
      auditApi.list({ ...buildFilters(), page: filters.page, limit: filters.limit }),
      auditApi.actions(),
    ]);
    events.value = page.data;
    pagination.value = page.pagination;
    actions.value = actionList;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
};

const applyFilters = () => {
  filters.page = 1;
  load();
};

let debounceTimer: number | undefined;
const debouncedApply = () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(applyFilters, 300);
};

const clearFilters = () => {
  filters.actor = '';
  filters.action = '';
  filters.outcome = '';
  filters.from = '';
  filters.to = '';
  filters.page = 1;
  load();
};

const handlePageChange = (page: number) => {
  filters.page = page;
  load();
};

const download = async (format: 'csv' | 'json') => {
  exporting.value = format;

  try {
    const result = await auditApi.export(buildFilters(), format);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename ?? `dmarc-audit.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    if (result.digest) {
      lastExport.value = {
        rows: result.rows ?? 0,
        // The header carries `sha256:<hex>`; the UI shows the hex once, not twice.
        digest: result.digest.replace(/^sha256:/, ''),
      };
    }
    toast.success(`Exported ${result.rows ?? 0} audit row(s)`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not export the audit trail');
  } finally {
    exporting.value = null;
  }
};

const formatDateTime = (value: string): string => (value ? new Date(value).toLocaleString() : '—');

onMounted(load);
</script>
