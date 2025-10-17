<template>
  <div class="min-h-screen bg-gray-50">
    <!-- Header -->
    <div class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="py-6">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-4">
              <button 
                @click="goBack" 
                class="btn btn-secondary"
              >
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Back to Reports
              </button>
              <div>
                <h1 class="text-3xl font-bold text-gray-900">
                  {{ data?.domain || 'Report Details' }}
                </h1>
                <p v-if="data" class="mt-2 text-sm text-gray-600">
                  Report from {{ data.orgName }} • {{ formatDateRange(data.startDate, data.endDate) }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main content -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Loading state -->
      <div v-if="loading" class="flex items-center justify-center py-12">
        <div class="flex items-center space-x-3">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <span class="text-lg text-gray-600">Loading report details...</span>
        </div>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="rounded-md bg-danger-50 p-4">
        <div class="flex">
          <div class="flex-shrink-0">
            <svg class="h-5 w-5 text-danger-400" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
            </svg>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-danger-800">Error loading report</h3>
            <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
            <div class="mt-3">
              <button @click="refresh" class="btn btn-secondary text-sm">
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Report content -->
      <div v-else-if="data" class="space-y-6">
        <!-- Summary cards -->
        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            title="Total Messages"
            :value="data.totalMessages"
            icon="messages"
            color="blue"
          />
          <SummaryCard
            title="SPF Pass Rate"
            :value="data.spfPassRate"
            format="percentage"
            icon="shield"
            :color="data.spfPassRate >= 90 ? 'green' : data.spfPassRate >= 70 ? 'yellow' : 'red'"
          />
          <SummaryCard
            title="DKIM Pass Rate"
            :value="data.dkimPassRate"
            format="percentage"
            icon="check"
            :color="data.dkimPassRate >= 90 ? 'green' : data.dkimPassRate >= 70 ? 'yellow' : 'red'"
          />
          <SummaryCard
            title="Policy Action"
            :value="data.policyAction"
            format="text"
            icon="warning"
            :color="data.policyAction === 'none' ? 'green' : data.policyAction === 'quarantine' ? 'yellow' : 'red'"
          />
        </div>

        <!-- Report metadata -->
        <div class="card">
          <div class="card-header">
            <h3 class="text-lg leading-6 font-medium text-gray-900">Report Information</h3>
          </div>
          <div class="card-body">
            <dl class="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <div>
                <dt class="text-sm font-medium text-gray-500">Domain</dt>
                <dd class="mt-1 text-sm text-gray-900 font-medium">{{ data.domain }}</dd>
              </div>
              <div>
                <dt class="text-sm font-medium text-gray-500">Reporting Organization</dt>
                <dd class="mt-1 text-sm text-gray-900">{{ data.orgName }}</dd>
              </div>
              <div>
                <dt class="text-sm font-medium text-gray-500">Report Period</dt>
                <dd class="mt-1 text-sm text-gray-900">
                  {{ formatDate(data.startDate) }} - {{ formatDate(data.endDate) }}
                </dd>
              </div>
              <div>
                <dt class="text-sm font-medium text-gray-500">Total Records</dt>
                <dd class="mt-1 text-sm text-gray-900">{{ data.records.length }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <!-- Records table -->
        <DataTable
          :columns="recordColumns"
          :data="data.records"
          title="Authentication Records"
          description="Detailed breakdown of email authentication results by source IP"
          empty-message="No records found in this report"
        >
          <!-- Custom cell templates -->
          <template #cell-sourceIp="{ value }">
            <span class="font-mono text-sm">{{ value }}</span>
          </template>

          <template #cell-count="{ value }">
            <span class="font-medium">{{ value.toLocaleString() }}</span>
          </template>

          <template #cell-disposition="{ value }">
            <span 
              class="badge"
              :class="value === 'none' ? 'badge-success' : value === 'quarantine' ? 'badge-warning' : 'badge-danger'"
            >
              {{ value }}
            </span>
          </template>

          <template #cell-dkim="{ value }">
            <span 
              class="badge"
              :class="value === 'pass' ? 'badge-success' : 'badge-danger'"
            >
              {{ value }}
            </span>
          </template>

          <template #cell-spf="{ value }">
            <span 
              class="badge"
              :class="value === 'pass' ? 'badge-success' : 'badge-danger'"
            >
              {{ value }}
            </span>
          </template>

          <template #cell-headerFrom="{ value }">
            <span class="text-gray-600">{{ value }}</span>
          </template>
        </DataTable>

        <!-- Analysis insights -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- Authentication summary -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Authentication Summary</h3>
            </div>
            <div class="card-body">
              <div class="space-y-4">
                <div class="flex justify-between items-center">
                  <span class="text-sm text-gray-600">SPF Passing Messages</span>
                  <span class="font-medium">{{ spfPassingMessages.toLocaleString() }} / {{ data.totalMessages.toLocaleString() }}</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-sm text-gray-600">DKIM Passing Messages</span>
                  <span class="font-medium">{{ dkimPassingMessages.toLocaleString() }} / {{ data.totalMessages.toLocaleString() }}</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-sm text-gray-600">Fully Aligned Messages</span>
                  <span class="font-medium">{{ fullyAlignedMessages.toLocaleString() }} / {{ data.totalMessages.toLocaleString() }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Top source IPs -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Top Source IPs</h3>
            </div>
            <div class="card-body">
              <div class="space-y-3">
                <div 
                  v-for="ip in topSourceIPs" 
                  :key="ip.sourceIp"
                  class="flex items-center justify-between"
                >
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-gray-900 font-mono">
                      {{ ip.sourceIp }}
                    </p>
                    <p class="text-sm text-gray-500">
                      {{ ((ip.count / data.totalMessages) * 100).toFixed(1) }}% of traffic
                    </p>
                  </div>
                  <div class="text-right">
                    <p class="text-sm font-medium text-gray-900">
                      {{ ip.count.toLocaleString() }}
                    </p>
                    <p class="text-sm text-gray-500">messages</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import SummaryCard from '@/components/SummaryCard.vue';
import DataTable from '@/components/DataTable.vue';
import { useAsyncData } from '@/composables/useApi';
import { reportsApi } from '@/api/client';

interface Props {
  id: string;
}

const props = defineProps<Props>();
const router = useRouter();

// Fetch report data
const { data, loading, error, refresh } = useAsyncData(() => reportsApi.getReportById(props.id));

// Table columns for records
const recordColumns = [
  { key: 'sourceIp', label: 'Source IP', sortable: true },
  { key: 'count', label: 'Messages', sortable: true, type: 'number' },
  { key: 'disposition', label: 'Disposition', sortable: true, type: 'badge' },
  { key: 'dkim', label: 'DKIM', sortable: true, type: 'badge' },
  { key: 'spf', label: 'SPF', sortable: true, type: 'badge' },
  { key: 'headerFrom', label: 'Header From', sortable: true },
];

// Computed analytics
const spfPassingMessages = computed(() => {
  if (!data.value) return 0;
  return data.value.records
    .filter(record => record.spf === 'pass')
    .reduce((sum, record) => sum + record.count, 0);
});

const dkimPassingMessages = computed(() => {
  if (!data.value) return 0;
  return data.value.records
    .filter(record => record.dkim === 'pass')
    .reduce((sum, record) => sum + record.count, 0);
});

const fullyAlignedMessages = computed(() => {
  if (!data.value) return 0;
  return data.value.records
    .filter(record => record.spf === 'pass' && record.dkim === 'pass')
    .reduce((sum, record) => sum + record.count, 0);
});

const topSourceIPs = computed(() => {
  if (!data.value) return [];
  return [...data.value.records]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
});

// Utility functions
const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString();
};

const formatDateRange = (startDate: string, endDate: string): string => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (start.toDateString() === end.toDateString()) {
    return start.toLocaleDateString();
  }
  
  return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
};

const goBack = () => {
  router.push('/reports');
};
</script>