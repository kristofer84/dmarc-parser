<template>
  <div class="min-h-screen bg-gray-50">
    <!-- Header -->
    <div class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="py-6">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-3xl font-bold text-gray-900">DMARC Reports</h1>
              <p class="mt-2 text-sm text-gray-600">
                View and analyze detailed DMARC report data
              </p>
            </div>
            <div class="flex space-x-3">
              <button @click="refreshData" class="btn btn-secondary">
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main content -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Filters -->
      <div class="mb-6">
        <div class="bg-white p-4 rounded-lg shadow">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label for="domain-filter" class="block text-sm font-medium text-gray-700 mb-1">
                Domain
              </label>
              <input
                id="domain-filter"
                v-model="filters.domain"
                type="text"
                placeholder="Filter by domain..."
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                @input="debouncedFilter"
              />
            </div>
            <div>
              <label for="org-filter" class="block text-sm font-medium text-gray-700 mb-1">
                Organization
              </label>
              <input
                id="org-filter"
                v-model="filters.orgName"
                type="text"
                placeholder="Filter by organization..."
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                @input="debouncedFilter"
              />
            </div>
            <div>
              <label for="limit-filter" class="block text-sm font-medium text-gray-700 mb-1">
                Per Page
              </label>
              <select
                id="limit-filter"
                v-model="filters.limit"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                @change="applyFilters"
              >
                <option :value="10">10</option>
                <option :value="25">25</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
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

      <!-- Reports table -->
      <DataTable
        :columns="columns"
        :data="reports"
        :loading="loading"
        :pagination="pagination || undefined"
        :sort-by="sortBy"
        :sort-order="sortOrder"
        title="DMARC Reports"
        description="Click on a report to view detailed information"
        empty-message="No DMARC reports found. Try adjusting your filters or check if reports have been processed."
        @sort="handleSort"
        @row-click="handleRowClick"
        @page-change="handlePageChange"
      >
        <!-- Custom cell templates -->
        <template #cell-domain="{ value }">
          <span class="font-medium text-gray-900">{{ value }}</span>
        </template>

        <template #cell-orgName="{ value }">
          <span class="text-gray-600">{{ value }}</span>
        </template>

        <template #cell-dateRange="{ item }">
          <div class="text-sm">
            <div class="text-gray-900">{{ formatDate(item.startDate) }}</div>
            <div class="text-gray-500">to {{ formatDate(item.endDate) }}</div>
          </div>
        </template>

        <template #cell-totalMessages="{ value }">
          <span class="font-medium">{{ value.toLocaleString() }}</span>
        </template>

        <template #cell-spfPassRate="{ value }">
          <div class="flex items-center">
            <span 
              class="badge"
              :class="value >= 90 ? 'badge-success' : value >= 70 ? 'badge-warning' : 'badge-danger'"
            >
              {{ value }}%
            </span>
          </div>
        </template>

        <template #cell-dkimPassRate="{ value }">
          <div class="flex items-center">
            <span 
              class="badge"
              :class="value >= 90 ? 'badge-success' : value >= 70 ? 'badge-warning' : 'badge-danger'"
            >
              {{ value }}%
            </span>
          </div>
        </template>

        <template #cell-policyAction="{ value }">
          <span 
            class="badge"
            :class="value === 'none' ? 'badge-success' : value === 'quarantine' ? 'badge-warning' : 'badge-danger'"
          >
            {{ value }}
          </span>
        </template>
      </DataTable>

      <!-- Error state -->
      <div v-if="error" class="mt-6 rounded-md bg-danger-50 p-4">
        <div class="flex">
          <div class="flex-shrink-0">
            <svg class="h-5 w-5 text-danger-400" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
            </svg>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-danger-800">Error loading reports</h3>
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
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import DataTable from '@/components/DataTable.vue';
import { reportsApi } from '@/api/client';
import type { ReportSummary, PaginatedResponse, ReportsFilters } from '@/types/api';

const router = useRouter();

// State
const reports = ref<ReportSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const sortBy = ref('startDate');
const sortOrder = ref<'asc' | 'desc'>('desc');

const filters = reactive<ReportsFilters>({
  domain: '',
  orgName: '',
  page: 1,
  limit: 25,
});

const pagination = ref<PaginatedResponse<ReportSummary>['pagination'] | null>(null);

// Table columns configuration
const columns = [
  { key: 'domain', label: 'Domain', sortable: true },
  { key: 'orgName', label: 'Organization', sortable: true },
  { key: 'dateRange', label: 'Report Period', sortable: false },
  { key: 'totalMessages', label: 'Messages', sortable: true, type: 'number' as const },
  { key: 'spfPassRate', label: 'SPF Pass Rate', sortable: true, type: 'percentage' as const },
  { key: 'dkimPassRate', label: 'DKIM Pass Rate', sortable: true, type: 'percentage' as const },
  { key: 'policyAction', label: 'Policy Action', sortable: true, type: 'badge' as const },
];

// Debounced filter function
let filterTimeout: NodeJS.Timeout;
const debouncedFilter = () => {
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => {
    applyFilters();
  }, 500);
};

// Load reports data
const loadReports = async () => {
  loading.value = true;
  error.value = null;

  try {
    const filterParams: ReportsFilters = {
      ...filters,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
    };

    // Remove empty filters
    Object.keys(filterParams).forEach(key => {
      const value = filterParams[key as keyof ReportsFilters];
      if (value === '' || value === null || value === undefined) {
        delete filterParams[key as keyof ReportsFilters];
      }
    });

    const response = await reportsApi.getReports(filterParams);
    reports.value = response.data;
    pagination.value = response.pagination;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load reports';
    reports.value = [];
    pagination.value = null;
  } finally {
    loading.value = false;
  }
};

// Event handlers
const handleSort = ({ sortBy: newSortBy, sortOrder: newSortOrder }: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
  sortBy.value = newSortBy;
  sortOrder.value = newSortOrder;
  loadReports();
};

const handleRowClick = (report: ReportSummary) => {
  router.push(`/reports/${report.id}`);
};

const handlePageChange = (page: number) => {
  filters.page = page;
  loadReports();
};

const applyFilters = () => {
  filters.page = 1; // Reset to first page when filtering
  loadReports();
};

const clearFilters = () => {
  filters.domain = '';
  filters.orgName = '';
  filters.page = 1;
  filters.limit = 25;
  loadReports();
};

const refreshData = () => {
  loadReports();
};

// Utility functions
const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString();
};

// Load data on mount
onMounted(() => {
  loadReports();
});
</script>