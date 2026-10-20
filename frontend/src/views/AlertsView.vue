<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Alerts"
      description="New senders and failure spikes the parser noticed for your domains"
    >
      <template #actions>
        <RangeSelector :model-value="range" @update:model-value="changeRange" />
        <button class="btn btn-secondary" :disabled="loading" @click="load">Refresh</button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- Filter bar: open/all is the only filter that changes what the list means. -->
      <div class="bg-surface p-4 rounded-card shadow-card border border-gray-200">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span id="alert-status-label" class="block text-sm font-medium text-gray-700 mb-1">
              Show
            </span>
            <div class="inline-flex items-stretch" role="group" aria-labelledby="alert-status-label">
              <button
                v-for="option in STATUS_OPTIONS"
                :key="option.value"
                type="button"
                class="relative -ml-px inline-flex items-center border border-gray-300 px-3 py-2 text-sm font-medium first:ml-0 first:rounded-l-md last:rounded-r-md focus:z-10 focus:outline-hidden focus:ring-2 focus:ring-primary-500"
                :class="
                  status === option.value
                    ? 'z-10 border-primary-500 bg-primary-50 text-primary-700'
                    : 'bg-surface text-gray-600 hover:bg-gray-50'
                "
                :aria-pressed="status === option.value"
                @click="changeStatus(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <p class="text-sm text-gray-500">
            <span class="nums font-medium text-gray-700">{{ total }}</span>
            {{ total === 1 ? 'alert' : 'alerts' }}
            <span v-if="status === 'open'">still open</span>
            <span v-else>in total</span>
            <span v-if="range !== 'all'"> in the last {{ range }}</span>
          </p>
        </div>
      </div>

      <div v-if="error" class="rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load alerts</h3>
        <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
        <button class="btn btn-secondary text-sm mt-3" @click="load">Try again</button>
      </div>

      <div v-if="loading && !alerts.length" class="card">
        <div class="card-body flex items-center space-x-3">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
          <span class="text-gray-600">Loading alerts…</span>
        </div>
      </div>

      <div v-else-if="alerts.length" class="card">
        <div class="card-header">
          <h3 class="text-lg leading-6 font-medium text-gray-900">
            {{ status === 'open' ? 'Open alerts' : 'All alerts' }}
          </h3>
          <p class="mt-1 text-sm text-gray-500">
            Newest first. An alert is raised once per finding; acknowledging it only hides it from
            the open list.
          </p>
        </div>
        <ul class="divide-y divide-gray-200">
          <li
            v-for="alert in alerts"
            :key="alert.id"
            class="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6"
          >
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="badge" :class="severityBadge(alert.severity)">
                  {{ severityLabel(alert.severity) }}
                </span>
                <span class="text-xs font-medium text-gray-500">{{ kindLabel(alert.kind) }}</span>
                <span class="nums text-xs text-gray-400">{{ formatRelative(alert.createdAt) }}</span>
                <span v-if="alert.acknowledgedAt" class="badge badge-gray">Acknowledged</span>
              </div>

              <h4 class="text-sm font-medium text-gray-900">{{ alert.title }}</h4>

              <p class="text-sm text-gray-600">
                <span class="font-medium text-gray-800">{{ alert.domain }}</span>
                <span v-if="alert.sourceIp" class="font-mono text-gray-600">
                  · {{ alert.sourceIp }}
                </span>
              </p>

              <dl
                v-if="detailEntries(alert.detail).length"
                class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"
              >
                <div
                  v-for="entry in detailEntries(alert.detail)"
                  :key="entry.key"
                  class="flex items-center gap-1"
                >
                  <dt>{{ entry.key }}:</dt>
                  <dd class="font-mono text-gray-700">{{ entry.value }}</dd>
                </div>
              </dl>

              <p v-if="alert.acknowledgedAt" class="text-xs text-gray-500">
                Acknowledged {{ formatRelative(alert.acknowledgedAt) }}
                <span v-if="alert.acknowledgedBy"> by {{ alert.acknowledgedBy }}</span>
              </p>
            </div>

            <div v-if="isOrgAdmin && !alert.acknowledgedAt" class="shrink-0">
              <button
                class="btn btn-secondary text-sm"
                :disabled="acking === alert.id"
                :class="{ 'opacity-50 cursor-not-allowed': acking === alert.id }"
                @click="acknowledge(alert)"
              >
                {{ acking === alert.id ? 'Acknowledging…' : 'Acknowledge' }}
              </button>
            </div>
          </li>
        </ul>
      </div>

      <EmptyState
        v-else-if="!loading"
        icon="shield"
        :title="status === 'open' ? 'Nothing needs attention' : 'No alerts yet'"
        :description="
          status === 'open'
            ? 'Every alert has been acknowledged. Switch to “All” to see the history.'
            : 'Alerts appear when a new IP starts sending as one of your domains, or when failures spike.'
        "
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import RangeSelector from '@/components/RangeSelector.vue';
import { alertsApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';
import { useQueryFilters } from '@/composables/useQueryFilters';
import type { AlertRow, AlertsResponse, StatsRange } from '@/types/api';

const { isOrgAdmin } = useAuth();
const toast = useToast();

const STATUS_OPTIONS: Array<{ value: 'open' | 'all'; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
];

const RANGES: StatsRange[] = ['7d', '30d', '90d', 'all'];

const alerts = ref<AlertsResponse['data']>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const acking = ref<string | null>(null);

// `all` by default: an alert does not stop being interesting because it is old, and narrowing
// the window is an explicit choice.
const query = reactive({ status: 'open' as 'open' | 'all', range: 'all' as StatsRange });

const range = computed<StatsRange>(() => (RANGES.includes(query.range) ? query.range : 'all'));
const status = computed<'open' | 'all'>(() =>
  STATUS_OPTIONS.some((option) => option.value === query.status) ? query.status : 'open'
);

const load = async () => {
  loading.value = true;
  error.value = null;

  try {
    const result = await alertsApi.list({ status: status.value, range: range.value, limit: 100 });
    alerts.value = result.data;
    total.value = result.total;
  } catch (err) {
    alerts.value = [];
    total.value = 0;
    error.value = err instanceof Error ? err.message : 'Failed to load alerts';
  } finally {
    loading.value = false;
  }
};

const changeStatus = (value: 'open' | 'all') => {
  if (query.status === value) return;
  query.status = value;
  sync();
  load();
};

const changeRange = (value: StatsRange) => {
  if (query.range === value) return;
  query.range = value;
  sync();
  load();
};

const acknowledge = async (alert: AlertRow) => {
  acking.value = alert.id;

  try {
    await alertsApi.ack(alert.id);
    toast.success(`Acknowledged: ${alert.title}`);
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not acknowledge this alert');
  } finally {
    acking.value = null;
  }
};

const SEVERITY_LABELS: Record<string, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

const severityLabel = (severity: string | null | undefined): string => {
  const key = (severity ?? '').toLowerCase();
  return SEVERITY_LABELS[key] ?? (severity ? severity : 'Notice');
};

const severityBadge = (severity: string | null | undefined): string => {
  const key = (severity ?? '').toLowerCase();
  if (key === 'critical' || key === 'high' || key === 'error') return 'badge-danger';
  if (key === 'warning' || key === 'medium' || key === 'warn') return 'badge-warning';
  return 'badge-gray';
};

const KIND_LABELS: Record<string, string> = {
  new_source: 'New source',
  failure_spike: 'Failure spike',
};

const kindLabel = (kind: string | null | undefined): string =>
  (kind && KIND_LABELS[kind]) || kind || 'Alert';

/** `detail` is parsed by the API, but a plain string is still rendered rather than hidden. */
const detailEntries = (detail: AlertRow['detail']): Array<{ key: string; value: string }> => {
  if (!detail) return [];
  if (typeof detail === 'string') return [{ key: 'detail', value: detail }];

  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => ({ key, value: String(value) }));
};

const formatRelative = (value: string | null): string => {
  if (!value) return 'never';

  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  return `${Math.round(hours / 24)} d ago`;
};

const { sync } = useQueryFilters(query, ['status', 'range'], load);

load();
</script>
