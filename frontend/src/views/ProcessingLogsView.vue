<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Processing Logs"
      description="Review each attachment processed by the DMARC ingestion pipeline"
    >
      <template #actions>
        <button @click="refreshData" class="btn btn-secondary">
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Refresh
        </button>
      </template>
    </PageHeader>

    <!-- Main content -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Filters -->
      <div class="mb-6">
        <div class="bg-surface p-4 rounded-card shadow-card border border-gray-200">
          <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label for="status-filter" class="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                id="status-filter"
                v-model="filters.status"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                @change="applyFilters"
              >
                <option v-for="option in statusOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div class="md:col-span-2">
              <label for="search-filter" class="block text-sm font-medium text-gray-700 mb-1">
                Search
              </label>
              <div class="relative">
                <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M21 21l-4.35-4.35M9.5 17a7.5 7.5 0 100-15 7.5 7.5 0 000 15z"
                    />
                  </svg>
                </div>
                <input
                  id="search-filter"
                  v-model="filters.search"
                  type="text"
                  placeholder="Search by attachment name, details, message UID, or report ID"
                  class="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  @input="debouncedFilter"
                />
              </div>
            </div>
            <div>
              <label for="limit-filter" class="block text-sm font-medium text-gray-700 mb-1">
                Per Page
              </label>
              <select
                id="limit-filter"
                v-model="filters.limit"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                @change="applyFilters"
              >
                <option :value="10">10</option>
                <option :value="25">25</option>
                <option :value="50">50</option>
              </select>
            </div>
          </div>
          <div class="mt-4 flex justify-end">
            <button @click="clearFilters" class="btn btn-secondary text-sm">
              Clear Filters
            </button>
          </div>
        </div>
      </div>

      <!-- Logs table -->
      <DataTable
        :columns="columns"
        :data="logs"
        :loading="loading"
        :pagination="pagination || undefined"
        :sort-by="filters.sortBy"
        :sort-order="filters.sortOrder"
        title="Processing History"
        description="Click a row to jump to the associated DMARC report when available"
        empty-message="No processing activity found. Trigger the email processor to populate logs."
        @sort="handleSort"
        @row-click="handleRowClick"
        @page-change="handlePageChange"
      >
        <template #cell-createdAt="{ value }">
          <div class="text-sm text-gray-900 nums">{{ formatDateTime(value) }}</div>
          <div class="text-xs text-gray-500">{{ formatRelativeTime(value) }}</div>
        </template>

        <template #cell-status="{ value }">
          <StatusBadge :status="value" kind="processing" />
        </template>

        <template #cell-attachmentName="{ value }">
          <span class="font-medium text-gray-900">{{ value || '—' }}</span>
        </template>

        <template #cell-messageUid="{ value }">
          <span class="nums">{{ value ?? '—' }}</span>
        </template>

        <template #cell-report.domain="{ item }">
          <div v-if="item.report" class="flex items-center space-x-2">
            <router-link
              :to="`/reports/${item.report.id}`"
              class="text-primary-600 hover:text-primary-700 font-medium"
              @click.stop
            >
              {{ item.report.domain }}
            </router-link>
            <span class="text-xs text-gray-400">{{ item.report.orgName }}</span>
          </div>
          <span v-else class="text-gray-400">—</span>
        </template>

        <template #cell-details="{ value }">
          <span v-if="value" class="block max-w-xl truncate" :title="value">
            {{ truncateDetails(value) }}
          </span>
          <span v-else class="text-gray-400">—</span>
        </template>
      </DataTable>

      <!-- Error state -->
      <div v-if="error" class="mt-6 rounded-md bg-danger-50 p-4">
        <div class="flex">
          <div class="shrink-0">
            <svg class="h-5 w-5 text-danger-400" viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clip-rule="evenodd"
              />
            </svg>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-danger-800">Error loading logs</h3>
            <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
            <div class="mt-3">
              <button @click="refreshData" class="btn btn-secondary text-sm">
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { processingLogsApi } from '@/api/client';
import { useQueryFilters } from '@/composables/useQueryFilters';
import type {
  ProcessingLogEntry,
  PaginatedResponse,
  ProcessingLogFilters,
  ProcessingStatus,
} from '@/types/api';

const router = useRouter();

const logs = ref<ProcessingLogEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const pagination = ref<PaginatedResponse<ProcessingLogEntry>['pagination'] | null>(null);

const filters = reactive({
  status: '' as ProcessingStatus | '',
  search: '',
  page: 1,
  limit: 25,
  sortBy: 'createdAt' as ProcessingLogFilters['sortBy'],
  sortOrder: 'desc' as ProcessingLogFilters['sortOrder'],
});

const statusOptions: Array<{ label: string; value: ProcessingStatus | '' }> = [
  { label: 'All statuses', value: '' },
  { label: 'Started', value: 'started' },
  { label: 'Success', value: 'success' },
  { label: 'Skipped', value: 'skipped' },
  { label: 'Error', value: 'error' },
];

const columns = [
  { key: 'createdAt', label: 'Timestamp', sortable: true },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'attachmentName', label: 'Attachment', sortable: true },
  { key: 'messageUid', label: 'Message UID', sortable: true },
  { key: 'report.domain', label: 'Report Domain' },
  { key: 'details', label: 'Details' },
];

let searchTimeout: number | undefined;

const fetchLogs = async () => {
  loading.value = true;
  error.value = null;

  try {
    const response = await processingLogsApi.getProcessingLogs({
      page: filters.page,
      limit: filters.limit,
      status: filters.status || undefined,
      search: filters.search.trim() || undefined,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
    });

    logs.value = response.data;
    pagination.value = response.pagination;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
};

const refreshData = () => {
  fetchLogs();
};

const applyFilters = () => {
  filters.page = 1;
  sync();
  fetchLogs();
};

const debouncedFilter = () => {
  filters.page = 1;

  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }

  searchTimeout = window.setTimeout(() => {
    sync();
    fetchLogs();
  }, 300);
};

const clearFilters = () => {
  filters.status = '';
  filters.search = '';
  filters.page = 1;
  filters.limit = 25;
  filters.sortBy = 'createdAt';
  filters.sortOrder = 'desc';
  sync();
  fetchLogs();
};

const handleSort = ({ sortBy: newSortBy, sortOrder: newSortOrder }: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
  filters.sortBy = (newSortBy as ProcessingLogFilters['sortBy']) || 'createdAt';
  filters.sortOrder = newSortOrder;
  sync();
  fetchLogs();
};

const handlePageChange = (page: number) => {
  filters.page = page;
  sync();
  fetchLogs();
};

const handleRowClick = (log: ProcessingLogEntry) => {
  if (log.reportId) {
    router.push(`/reports/${log.reportId}`);
  }
};

const formatDateTime = (value: string) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const formatRelativeTime = (value: string) => {
  if (!value) return '';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const truncateDetails = (details: string) => {
  if (!details) return '';
  return details.length > 120 ? `${details.slice(0, 117)}…` : details;
};

// Reads the query back into `filters` at setup, so a shared link loads already filtered.
const { sync } = useQueryFilters(
  filters,
  ['status', 'search', 'page', 'limit', 'sortBy', 'sortOrder'],
  fetchLogs,
);

onMounted(() => {
  fetchLogs();
});

onBeforeUnmount(() => {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
});
</script>
