<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Forensic Reports"
      description="Per-message authentication failures reported to your ruf= address"
    >
      <template #actions>
        <button @click="refreshAll" class="btn btn-secondary">
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

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- Summary -->
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Forensic Reports" :value="summary?.total ?? 0" icon="reports" color="blue" />
        <SummaryCard title="Last 24 Hours" :value="summary?.last24h ?? 0" icon="messages" color="gray" />
        <SummaryCard
          title="Unverified Senders"
          :value="summary?.unverified ?? 0"
          icon="warning"
          :color="(summary?.unverified ?? 0) > 0 ? 'yellow' : 'green'"
        />
        <SummaryCard title="Domains Affected" :value="summary?.domains ?? 0" icon="shield" color="red" />
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div class="lg:col-span-2">
          <ChartView
            type="bar"
            title="Failures per day"
            description="Reported authentication failures over the last 14 days"
            :data="trendChartData"
            :loading="summaryLoading"
            :error="summaryError"
            :height="260"
          />
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="text-lg leading-6 font-medium text-gray-900">Top source IPs</h3>
            <p class="mt-1 text-sm text-gray-500">Where the failing mail came from</p>
          </div>
          <div class="card-body">
            <p v-if="!summary?.topSources?.length" class="text-sm text-gray-500">
              Nothing reported yet.
            </p>
            <ul v-else class="divide-y divide-gray-100">
              <li
                v-for="source in summary.topSources"
                :key="source.sourceIp"
                class="py-2 flex items-center justify-between text-sm"
              >
                <span class="font-mono text-gray-800">{{ source.sourceIp }}</span>
                <span class="badge badge-gray">{{ source.count }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Filters -->
      <div class="bg-surface p-4 rounded-card shadow-card border border-gray-200">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label for="domain-filter" class="block text-sm font-medium text-gray-700 mb-1">Domain</label>
            <DomainSelect id="domain-filter" v-model="filters.domain" @change="applyFilters" />
          </div>
          <div>
            <label for="ip-filter" class="block text-sm font-medium text-gray-700 mb-1">Source IP</label>
            <input
              id="ip-filter"
              v-model="filters.sourceIp"
              type="text"
              placeholder="203.0.113..."
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              @input="debouncedFilter"
            />
          </div>
          <div>
            <label for="reporter-filter" class="block text-sm font-medium text-gray-700 mb-1">Reporter</label>
            <input
              id="reporter-filter"
              v-model="filters.reporter"
              type="text"
              placeholder="outlook.com"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              @input="debouncedFilter"
            />
          </div>
          <div>
            <label for="verified-filter" class="block text-sm font-medium text-gray-700 mb-1">
              Sender verification
            </label>
            <select
              id="verified-filter"
              v-model="filters.verified"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            >
              <option value="">All reports</option>
              <option value="true">Authenticated only</option>
              <option value="false">Unverified only</option>
            </select>
          </div>
          <div class="md:col-span-2">
            <label for="search-filter" class="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              id="search-filter"
              v-model="filters.search"
              type="text"
              placeholder="Envelope from/to, subject, Message-ID, Authentication-Results..."
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              @input="debouncedFilter"
            />
          </div>
          <div>
            <label for="from-filter" class="block text-sm font-medium text-gray-700 mb-1">Arrived after</label>
            <input
              id="from-filter"
              v-model="filters.from"
              type="date"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>
          <div>
            <label for="to-filter" class="block text-sm font-medium text-gray-700 mb-1">Arrived before</label>
            <input
              id="to-filter"
              v-model="filters.to"
              type="date"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>
        </div>
        <div class="mt-4 flex justify-end">
          <button @click="clearFilters" class="btn btn-secondary text-sm">Clear Filters</button>
        </div>
      </div>

      <!-- Table -->
      <DataTable
        :columns="columns"
        :data="rows"
        :loading="loading"
        :sort-by="filters.sortBy"
        :sort-order="filters.sortOrder"
        :pagination="pagination"
        title="Reported failures"
        description="Click a row to see the reported message and the raw report"
        empty-message="No forensic reports match these filters"
        @sort="handleSort"
        @row-click="openReport"
        @page-change="handlePageChange"
      >
        <template #cell-arrivalDate="{ value }">
          {{ formatDateTime(value) }}
        </template>
        <template #cell-reportedSubject="{ item }">
          <div class="max-w-md">
            <p class="truncate text-gray-900">{{ item.reportedSubject || '(no subject)' }}</p>
            <p class="truncate text-xs text-gray-500">{{ item.reportedFrom || item.originalMailFrom || '-' }}</p>
          </div>
        </template>
        <template #cell-spfResult="{ value }">
          <StatusBadge :status="value" kind="auth" />
        </template>
        <template #cell-dkimResult="{ value }">
          <StatusBadge :status="value" kind="auth" />
        </template>
        <template #cell-dmarcResult="{ value }">
          <StatusBadge :status="value" kind="auth" />
        </template>
        <template #cell-reportAuthenticated="{ value }">
          <StatusBadge :status="value ? 'verified' : 'unverified'" />
        </template>
      </DataTable>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import DataTable from '@/components/DataTable.vue';
import DomainSelect from '@/components/DomainSelect.vue';
import SummaryCard from '@/components/SummaryCard.vue';
import ChartView from '@/components/ChartView.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { forensicsApi } from '@/api/client';
import { useAsyncData } from '@/composables/useApi';
import { useQueryFilters } from '@/composables/useQueryFilters';
import { useToast } from '@/composables/useToast';
import type { ForensicFilters, ForensicReportSummary, ForensicSummary } from '@/types/api';

const router = useRouter();
const toast = useToast();

const columns = [
  { key: 'arrivalDate', label: 'Arrived', sortable: true, type: 'date' as const },
  { key: 'domain', label: 'Domain', sortable: true },
  { key: 'sourceIp', label: 'Source IP', sortable: true },
  { key: 'reportedSubject', label: 'Reported message' },
  { key: 'spfResult', label: 'SPF' },
  { key: 'dkimResult', label: 'DKIM' },
  { key: 'dmarcResult', label: 'DMARC' },
  { key: 'reporter', label: 'Reporter', sortable: true },
  { key: 'reportAuthenticated', label: 'Report mail' },
];

const filters = reactive<ForensicFilters>({
  domain: '',
  sourceIp: '',
  reporter: '',
  verified: '',
  from: '',
  to: '',
  search: '',
  page: 1,
  limit: 25,
  sortBy: 'arrivalDate',
  sortOrder: 'desc',
});

const rows = ref<ForensicReportSummary[]>([]);
const total = ref(0);
const loading = ref(false);

const pagination = computed(() => ({
  page: filters.page ?? 1,
  limit: filters.limit ?? 25,
  total: total.value,
  pages: Math.ceil(total.value / (filters.limit ?? 25)),
}));

const {
  data: summary,
  loading: summaryLoading,
  error: summaryError,
  refresh: refreshSummary,
} = useAsyncData<ForensicSummary>(() => forensicsApi.summary());

const trendChartData = computed(() =>
  (summary.value?.trendsData ?? []).map((day) => ({
    label: day.date.slice(5),
    count: day.count,
  }))
);

const load = async () => {
  loading.value = true;

  try {
    const result = await forensicsApi.list(filters);
    rows.value = result.data;
    total.value = result.pagination.total;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to load forensic reports');
  } finally {
    loading.value = false;
  }
};

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const debouncedFilter = () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, 300);
};

const applyFilters = () => {
  filters.page = 1;
  sync();
  load();
};

const clearFilters = () => {
  Object.assign(filters, {
    domain: '',
    sourceIp: '',
    reporter: '',
    verified: '',
    from: '',
    to: '',
    search: '',
    page: 1,
  });
  sync();
  load();
};

const handleSort = ({ sortBy, sortOrder }: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
  filters.sortBy = sortBy as ForensicFilters['sortBy'];
  filters.sortOrder = sortOrder;
  sync();
  load();
};

const handlePageChange = (page: number) => {
  filters.page = page;
  sync();
  load();
};

const openReport = (item: ForensicReportSummary) => {
  router.push({ name: 'ForensicDetail', params: { id: item.id } });
};

const refreshAll = () => {
  load();
  refreshSummary();
};

const formatDateTime = (value: string | null): string => {
  if (!value) return '-';
  return new Date(value).toLocaleString();
};

// Reads the query back into `filters` at setup, so a shared link loads already filtered.
const { sync } = useQueryFilters(
  filters,
  ['domain', 'sourceIp', 'reporter', 'verified', 'from', 'to', 'search', 'page', 'limit', 'sortBy', 'sortOrder'],
  load,
);

onMounted(load);
</script>
