<template>
  <div class="min-h-screen bg-gray-50">
    <!-- Header -->
    <div class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="py-6">
          <h1 class="text-3xl font-bold text-gray-900">DMARC Dashboard</h1>
          <p class="mt-2 text-sm text-gray-600">
            Monitor your email authentication status and security metrics
          </p>
        </div>
      </div>
    </div>

    <!-- Main content -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Loading state -->
      <div v-if="loading" class="flex items-center justify-center py-12">
        <div class="flex items-center space-x-3">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <span class="text-lg text-gray-600">Loading dashboard...</span>
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
            <h3 class="text-sm font-medium text-danger-800">Error loading dashboard</h3>
            <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
            <div class="mt-3">
              <button 
                @click="refresh" 
                class="btn btn-secondary text-sm"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Dashboard content -->
      <div v-else-if="data">
        <!-- Summary cards -->
        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          <SummaryCard
            title="Total Reports"
            :value="data.totalReports"
            icon="reports"
            color="blue"
          />
          <SummaryCard
            title="Total Messages"
            :value="data.totalMessages"
            icon="messages"
            color="gray"
          />
          <SummaryCard
            title="SPF Pass Rate"
            :value="data.avgSpfPassRate"
            format="percentage"
            icon="shield"
            :color="data.avgSpfPassRate >= 90 ? 'green' : data.avgSpfPassRate >= 70 ? 'yellow' : 'red'"
          />
          <SummaryCard
            title="DKIM Pass Rate"
            :value="data.avgDkimPassRate"
            format="percentage"
            icon="check"
            :color="data.avgDkimPassRate >= 90 ? 'green' : data.avgDkimPassRate >= 70 ? 'yellow' : 'red'"
          />
        </div>

        <!-- Charts grid -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <!-- Trends chart -->
          <ChartView
            type="line"
            title="Message Volume & Failure Trends"
            description="Daily message count and authentication failure rates over time"
            :data="trendsChartData"
            :height="350"
          />

          <!-- Policy distribution chart -->
          <ChartView
            type="doughnut"
            title="Policy Actions Distribution"
            description="Distribution of DMARC policy actions (none, quarantine, reject)"
            :data="policyChartData"
            :height="350"
          />
        </div>

        <!-- Additional insights -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- Top sources -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Top Report Sources</h3>
              <p class="mt-1 text-sm text-gray-500">Organizations sending the most reports</p>
            </div>
            <div class="card-body">
              <div class="space-y-3">
                <div 
                  v-for="source in data.topSources.slice(0, 5)" 
                  :key="source.orgName"
                  class="flex items-center justify-between"
                >
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-gray-900 truncate">
                      {{ source.orgName }}
                    </p>
                    <p class="text-sm text-gray-500">
                      {{ source.reportCount }} reports
                    </p>
                  </div>
                  <div class="text-right">
                    <p class="text-sm font-medium text-gray-900">
                      {{ source.messageCount.toLocaleString() }}
                    </p>
                    <p class="text-sm text-gray-500">messages</p>
                  </div>
                </div>
                <div v-if="data.topSources.length === 0" class="text-center py-4">
                  <p class="text-sm text-gray-500">No data available</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Top IPs -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Top Source IPs</h3>
              <p class="mt-1 text-sm text-gray-500">IP addresses with highest message volume</p>
            </div>
            <div class="card-body">
              <div class="space-y-3">
                <div 
                  v-for="ip in data.topIPs.slice(0, 5)" 
                  :key="ip.sourceIp"
                  class="flex items-center justify-between"
                >
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-gray-900 font-mono">
                      {{ ip.sourceIp }}
                    </p>
                    <p class="text-sm text-gray-500">
                      {{ ip.messageCount.toLocaleString() }} messages
                    </p>
                  </div>
                  <div class="text-right">
                    <span 
                      class="badge"
                      :class="ip.failureRate === 0 ? 'badge-success' : ip.failureRate < 10 ? 'badge-warning' : 'badge-danger'"
                    >
                      {{ ip.failureRate }}% fail
                    </span>
                  </div>
                </div>
                <div v-if="data.topIPs.length === 0" class="text-center py-4">
                  <p class="text-sm text-gray-500">No data available</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Refresh info -->
        <div class="mt-8 text-center">
          <p class="text-sm text-gray-500">
            Last updated: {{ new Date().toLocaleString() }}
            <button @click="refresh" class="ml-2 text-primary-600 hover:text-primary-500">
              Refresh
            </button>
          </p>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="text-center py-12">
        <div class="text-gray-400 mb-4">
          <svg class="mx-auto h-16 w-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <h3 class="text-lg font-medium text-gray-900 mb-2">No DMARC data available</h3>
        <p class="text-gray-500 mb-4">
          Start by processing some DMARC reports to see your dashboard metrics.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import SummaryCard from '@/components/SummaryCard.vue';
import ChartView from '@/components/ChartView.vue';
import { useAsyncData } from '@/composables/useApi';
import { summaryApi } from '@/api/client';

// Fetch dashboard data
const { data, loading, error, refresh } = useAsyncData(() => summaryApi.getSummary());

// Transform data for charts
const trendsChartData = computed(() => {
  if (!data.value?.trendsData) return [];
  
  return data.value.trendsData.map(item => ({
    date: new Date(item.date).toLocaleDateString(),
    messageCount: item.messageCount,
    failureRate: item.failureRate,
  }));
});

const policyChartData = computed(() => {
  if (!data.value?.policyDistribution) return [];
  
  const distribution = data.value.policyDistribution;
  return [
    { label: 'None', value: distribution.none },
    { label: 'Quarantine', value: distribution.quarantine },
    { label: 'Reject', value: distribution.reject },
  ].filter(item => item.value > 0);
});
</script>