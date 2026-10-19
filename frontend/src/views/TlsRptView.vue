<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="TLS reports"
      description="SMTP TLS outcomes reported by senders (TLS-RPT, RFC 8460) — the evidence for moving MTA-STS to enforce"
    >
      <template #actions>
        <button class="btn btn-secondary" @click="load">Refresh</button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div v-if="error" class="rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load TLS reports</h3>
        <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
      </div>

      <!-- Summary -->
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Reports" :value="summary?.reports ?? 0" icon="reports" color="blue" />
        <SummaryCard title="Sessions OK" :value="summary?.successful ?? 0" icon="check" color="green" />
        <SummaryCard
          title="Failed sessions"
          :value="summary?.failed ?? 0"
          icon="warning"
          :color="(summary?.failed ?? 0) > 0 ? 'red' : 'green'"
        />
        <SummaryCard
          title="Last report"
          :value="summary?.lastReportAt ? formatDate(summary.lastReportAt) : '—'"
          icon="reports"
          color="gray"
        />
      </div>

      <!-- Why sessions failed, when they did -->
      <div v-if="summary && summary.byResultType.length" class="card">
        <div class="card-header">
          <h2 class="text-lg leading-6 font-medium text-gray-900">Failure types</h2>
          <p class="mt-1 text-sm text-gray-500">
            Reported by senders. A certificate or validation failure here is what makes
            <code class="font-mono text-xs">mode: enforce</code> unsafe.
          </p>
        </div>
        <div class="p-4 sm:p-6 flex flex-wrap gap-2">
          <span
            v-for="entry in summary.byResultType"
            :key="entry.resultType"
            class="badge badge-danger font-mono"
            :title="explainResultType(entry.resultType)"
          >
            {{ entry.resultType }} · {{ entry.count }}
          </span>
        </div>
      </div>

      <!-- Filters -->
      <div class="bg-surface p-4 rounded-card shadow-card border border-gray-200">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label for="tls-domain" class="block text-sm font-medium text-gray-700 mb-1">
              Domain
            </label>
            <input
              id="tls-domain"
              v-model="filters.domain"
              type="text"
              placeholder="any domain"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>
          <div>
            <label for="tls-from" class="block text-sm font-medium text-gray-700 mb-1">From</label>
            <input
              id="tls-from"
              v-model="filters.from"
              type="date"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>
          <div>
            <label for="tls-to" class="block text-sm font-medium text-gray-700 mb-1">To</label>
            <input
              id="tls-to"
              v-model="filters.to"
              type="date"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @change="applyFilters"
            />
          </div>
          <div class="flex items-end gap-3">
            <label class="inline-flex items-center cursor-pointer">
              <input
                v-model="filters.failuresOnly"
                type="checkbox"
                class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                @change="applyFilters"
              />
              <span class="ml-2 text-sm text-gray-700">Failures only</span>
            </label>
            <button class="btn btn-secondary text-sm ml-auto" @click="clearFilters">Clear</button>
          </div>
        </div>
      </div>

      <DataTable
        :columns="columns"
        :data="reports"
        :loading="loading"
        :pagination="pagination || undefined"
        title="Reported sessions"
        description="One row per policy entry: a reporter can cover several domains and MX hosts in one report"
        empty-message="No TLS-RPT reports yet. They arrive by mail at the reports mailbox once _smtp._tls points there."
        @page-change="handlePageChange"
      >
        <template #cell-dateEnd="{ value }">
          <div class="text-sm text-gray-900 nums whitespace-nowrap">{{ formatDate(value) }}</div>
        </template>
        <template #cell-policyDomain="{ value }">
          <span class="font-medium text-gray-900">{{ value }}</span>
        </template>
        <template #cell-mxHost="{ value }">
          <span class="text-sm text-gray-700 font-mono">{{ value }}</span>
        </template>
        <template #cell-policyType="{ value }">
          <span class="badge badge-gray font-mono">{{ value }}</span>
        </template>
        <template #cell-successfulCount="{ value }">
          <span class="nums text-gray-900">{{ value }}</span>
        </template>
        <template #cell-failureCount="{ value }">
          <span class="nums" :class="value > 0 ? 'text-danger-700 font-medium' : 'text-gray-500'">{{ value }}</span>
        </template>
        <template #cell-failureDetails="{ item }">
          <div v-if="item.failureDetails.length" class="flex flex-wrap gap-1">
            <span
              v-for="detail in item.failureDetails"
              :key="detail.resultType + (detail.sendingMtaIp || '')"
              class="badge badge-danger font-mono"
              :title="`${detail.sendingMtaIp || 'unknown sender'} → ${detail.receivingMxHostname || item.mxHost}`"
            >
              {{ detail.resultType }} · {{ detail.count }}
            </span>
          </div>
          <span v-else class="text-gray-400">—</span>
        </template>
        <template #cell-orgName="{ value }">
          <span class="text-sm text-gray-600">{{ value || '—' }}</span>
        </template>
      </DataTable>

      <p class="text-xs text-gray-500">
        Reports are ingested from the mailbox, deduplicated by report-id + domain + MX, and kept
        for <span class="font-mono">data.tlsRptRetentionDays</span>.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import DataTable from '@/components/DataTable.vue';
import SummaryCard from '@/components/SummaryCard.vue';
import { tlsRptApi } from '@/api/client';
import type {
  PaginatedResponse,
  TlsRptFilters,
  TlsRptReport,
  TlsRptSummary,
} from '@/types/api';

const reports = ref<TlsRptReport[]>([]);
const summary = ref<TlsRptSummary | null>(null);
const pagination = ref<PaginatedResponse<TlsRptReport>['pagination'] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const filters = reactive({
  domain: '',
  failuresOnly: false,
  from: '',
  to: '',
  page: 1,
  limit: 50,
});

const columns = [
  { key: 'dateEnd', label: 'Period end' },
  { key: 'policyDomain', label: 'Domain' },
  { key: 'mxHost', label: 'MX' },
  { key: 'policyType', label: 'Policy' },
  { key: 'successfulCount', label: 'Sessions OK' },
  { key: 'failureCount', label: 'Failed' },
  { key: 'failureDetails', label: 'Failure types' },
  { key: 'orgName', label: 'Reporter' },
];

const buildFilters = (): TlsRptFilters => ({
  ...(filters.domain.trim() ? { domain: filters.domain.trim() } : {}),
  ...(filters.failuresOnly ? { failuresOnly: true } : {}),
  ...(filters.from ? { from: new Date(`${filters.from}T00:00:00`).toISOString() } : {}),
  ...(filters.to ? { to: new Date(`${filters.to}T23:59:59`).toISOString() } : {}),
});

const load = async () => {
  loading.value = true;
  error.value = null;

  try {
    const [page, summaryData] = await Promise.all([
      tlsRptApi.list({ ...buildFilters(), page: filters.page, limit: filters.limit }),
      tlsRptApi.summary(),
    ]);
    reports.value = page.data;
    pagination.value = page.pagination;
    summary.value = summaryData;
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

const clearFilters = () => {
  filters.domain = '';
  filters.failuresOnly = false;
  filters.from = '';
  filters.to = '';
  filters.page = 1;
  load();
};

const handlePageChange = (page: number) => {
  filters.page = page;
  load();
};

const formatDate = (value: string): string => (value ? new Date(value).toLocaleDateString() : '—');

/** One line per result type the RFC defines, plus a fallback for anything new. */
const explainResultType = (resultType: string): string => {
  const known: Record<string, string> = {
    'starttls-not-supported': 'The MX did not offer STARTTLS.',
    'certificate-host-mismatch': 'The certificate did not cover the MX hostname.',
    'certificate-expired': 'The MX certificate had expired.',
    'certificate-not-trusted': 'The certificate chain was not trusted.',
    'certificate-invalid': 'The certificate was invalid.',
    'tlsa-invalid': 'DANE/TLSA validation failed.',
    'dnssec-invalid': 'DNSSEC validation failed.',
    'validation-failure': 'Generic validation failure.',
    'sts-policy-fetch-error': 'The sender could not fetch the MTA-STS policy.',
    'sts-policy-invalid': 'The published MTA-STS policy was invalid.',
    'sts-webpki-invalid': 'The policy required a PKIX path that failed.',
  };
  return known[resultType] ?? 'Reported by the sending server.';
};

onMounted(load);
</script>
