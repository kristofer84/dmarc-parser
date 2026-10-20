<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Sources"
      description="Every IP that sent mail as your domains, and what the receivers decided about it"
    >
      <template #actions>
        <RangeSelector :model-value="range" @update:model-value="changeRange" />
        <button class="btn btn-secondary" :disabled="loading" @click="load">Refresh</button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- Totals for the selected window -->
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          title="Messages"
          :value="totals.messages"
          icon="messages"
          color="gray"
        />
        <SummaryCard
          title="Failures"
          :value="totals.failures"
          icon="warning"
          :color="totals.failures > 0 ? 'yellow' : 'green'"
        />
        <SummaryCard
          title="DMARC Pass Rate"
          :value="totals.dmarcPassRate"
          format="percentage"
          icon="shield"
          :color="
            totals.dmarcPassRate >= 90 ? 'green' : totals.dmarcPassRate >= 70 ? 'yellow' : 'red'
          "
        />
        <SummaryCard title="Source IPs" :value="totals.sourceCount" icon="reports" color="blue" />
      </div>

      <p v-if="data?.since" class="text-sm text-gray-500">
        Counting reports whose period ended on or after
        <span class="nums">{{ formatDateTime(data.since) }}</span>.
        <span v-if="range === 'all'"> (Everything ingested — no lower bound.)</span>
      </p>

      <div v-if="error" class="rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load the source list</h3>
        <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
        <button class="btn btn-secondary text-sm mt-3" @click="load">Try again</button>
      </div>

      <DataTable
        v-if="loading || sortedSources.length"
        :columns="columns"
        :data="sortedSources"
        :loading="loading && !data"
        :sort-by="sortBy"
        :sort-order="sortOrder"
        row-key="sourceIp"
        :row-class="rowClass"
        title="Sending sources"
        description="Sorted by message volume. Click a row for its organizations and dispositions."
        empty-message="No sources reported in this window"
        @sort="handleSort"
        @row-click="selectSource"
      >
        <template #cell-sourceIp="{ item }">
          <span class="font-mono text-sm text-gray-900">{{ item.sourceIp }}</span>
        </template>

        <template #cell-messages="{ item }">
          <span class="nums">{{ (item.messages ?? 0).toLocaleString() }}</span>
        </template>

        <template #cell-failures="{ item }">
          <div class="flex items-center gap-2">
            <span class="nums text-gray-900">{{ (item.failures ?? 0).toLocaleString() }}</span>
            <span class="badge" :class="failureBadge(item)">
              {{ failRate(item) }}% fail
            </span>
          </div>
        </template>

        <template #cell-dmarcPassRate="{ item }">
          <span class="badge" :class="passBadge(item.dmarcPassRate)">{{ item.dmarcPassRate }}%</span>
        </template>

        <template #cell-spfPassRate="{ item }">
          <span class="badge" :class="passBadge(item.spfPassRate)">{{ item.spfPassRate }}%</span>
        </template>

        <template #cell-dkimPassRate="{ item }">
          <span class="badge" :class="passBadge(item.dkimPassRate)">{{ item.dkimPassRate }}%</span>
        </template>

        <template #cell-domains="{ item }">
          <div class="flex flex-wrap gap-1">
            <span
              v-for="domain in (item.domains ?? []).slice(0, 2)"
              :key="domain"
              class="badge badge-gray"
            >
              {{ domain }}
            </span>
            <span
              v-if="(item.domains ?? []).length > 2"
              class="text-xs text-gray-500"
              :title="(item.domains ?? []).join(', ')"
            >
              +{{ (item.domains ?? []).length - 2 }}
            </span>
          </div>
        </template>

        <template #cell-lastSeen="{ item }">
          <span class="nums text-sm text-gray-600">{{ formatRelative(item.lastSeen) }}</span>
        </template>
      </DataTable>

      <!-- Row detail. Kept below the table so the columns never have to make room for it. -->
      <div v-if="selected" class="card">
        <div class="card-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="group flex items-center gap-2">
              <h3 class="font-mono text-lg leading-6 font-medium text-gray-900">
                {{ selected.sourceIp }}
              </h3>
              <CopyButton :value="selected.sourceIp" label="source IP" />
            </div>
            <p class="mt-1 text-sm text-gray-500">
              {{ (selected.messages ?? 0).toLocaleString() }} messages from
              {{ (selected.domains ?? []).length }} domain(s)
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <router-link
              :to="{ name: 'Reports', query: { sourceIp: selected.sourceIp } }"
              class="btn btn-secondary text-sm"
            >
              Reports from this IP
            </router-link>
            <button class="btn btn-secondary text-sm" @click="selectedIp = null">Close</button>
          </div>
        </div>

        <div class="card-body grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider">Organizations</h4>
            <div v-if="(selected.organizations ?? []).length" class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="org in selected.organizations"
                :key="org"
                class="badge badge-gray"
                :title="org"
              >
                {{ org }}
              </span>
            </div>
            <p v-else class="mt-2 text-sm text-gray-500">The reporter sent no organization name.</p>
          </div>

          <div>
            <h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider">Dispositions</h4>
            <ul v-if="dispositionEntries.length" class="mt-2 space-y-1">
              <li
                v-for="entry in dispositionEntries"
                :key="entry.key"
                class="flex items-center justify-between gap-2"
              >
                <StatusBadge :status="entry.key" kind="disposition" />
                <span class="nums text-sm text-gray-700">{{ entry.value.toLocaleString() }}</span>
              </li>
            </ul>
            <p v-else class="mt-2 text-sm text-gray-500">No disposition counts reported.</p>
          </div>

          <div>
            <h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider">Pass rates</h4>
            <dl class="mt-2 space-y-1 text-sm">
              <div class="flex items-center justify-between">
                <dt class="text-gray-600">DMARC</dt>
                <dd class="nums text-gray-900">{{ selected.dmarcPassRate }}%</dd>
              </div>
              <div class="flex items-center justify-between">
                <dt class="text-gray-600">SPF</dt>
                <dd class="nums text-gray-900">{{ selected.spfPassRate }}%</dd>
              </div>
              <div class="flex items-center justify-between">
                <dt class="text-gray-600">DKIM</dt>
                <dd class="nums text-gray-900">{{ selected.dkimPassRate }}%</dd>
              </div>
            </dl>
            <p class="mt-2 text-xs text-gray-500">
              Results as the receiver evaluated them, alignment included.
            </p>
          </div>

          <div>
            <h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider">Seen</h4>
            <dl class="mt-2 space-y-1 text-sm">
              <div class="flex items-center justify-between gap-2">
                <dt class="text-gray-600">First</dt>
                <dd class="nums text-gray-900">{{ formatDateTime(selected.firstSeen) }}</dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-gray-600">Last</dt>
                <dd class="nums text-gray-900">{{ formatDateTime(selected.lastSeen) }}</dd>
              </div>
            </dl>
            <p class="mt-2 text-xs text-gray-500">
              Over all time, not the selected range — that is what makes a new sender stand out.
            </p>
          </div>
        </div>
      </div>

      <EmptyState
        v-if="!loading && !error && !sortedSources.length"
        icon="inbox"
        title="No sending sources yet"
        :description="
          range === 'all'
            ? 'Nothing has been ingested for your domains yet.'
            : 'No report in this window contains a sending IP for your domains. Try a wider range.'
        "
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import DataTable from '@/components/DataTable.vue';
import SummaryCard from '@/components/SummaryCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import CopyButton from '@/components/CopyButton.vue';
import EmptyState from '@/components/EmptyState.vue';
import RangeSelector from '@/components/RangeSelector.vue';
import { sourcesApi } from '@/api/client';
import { useQueryFilters } from '@/composables/useQueryFilters';
import type { SourceRow, SourcesResponse, StatsRange } from '@/types/api';

const RANGES: StatsRange[] = ['7d', '30d', '90d', 'all'];

const columns = [
  { key: 'sourceIp', label: 'Source IP', sortable: true },
  { key: 'messages', label: 'Messages', sortable: true },
  { key: 'failures', label: 'Failures', sortable: true },
  { key: 'dmarcPassRate', label: 'DMARC', sortable: true },
  { key: 'spfPassRate', label: 'SPF', sortable: true },
  { key: 'dkimPassRate', label: 'DKIM', sortable: true },
  { key: 'domains', label: 'Domains' },
  { key: 'lastSeen', label: 'Last seen', sortable: true },
];

const data = ref<SourcesResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const sortBy = ref('messages');
const sortOrder = ref<'asc' | 'desc'>('desc');
const selectedIp = ref<string | null>(null);

// The window lives in the query string, so a prepared view can be linked to.
const query = reactive({ range: '30d' as StatsRange });

const range = computed<StatsRange>(() =>
  RANGES.includes(query.range) ? query.range : '30d'
);

const totals = computed(
  () =>
    data.value?.totals ?? { messages: 0, failures: 0, dmarcPassRate: 0, sourceCount: 0 }
);

const selected = computed(
  () => sortedSources.value.find((row) => row.sourceIp === selectedIp.value) ?? null
);

/** Only the dispositions the report actually carried, so an empty bucket never shows as 0. */
const dispositionEntries = computed(() => {
  const dispositions = selected.value?.dispositions ?? {};
  return Object.entries(dispositions)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => ({ key, value: Number(count) }));
});

const sortValue = (row: SourceRow, key: string): string | number => {
  switch (key) {
    case 'messages':
      return row.messages ?? 0;
    case 'failures':
      return row.failures ?? 0;
    case 'dmarcPassRate':
      return row.dmarcPassRate ?? 0;
    case 'spfPassRate':
      return row.spfPassRate ?? 0;
    case 'dkimPassRate':
      return row.dkimPassRate ?? 0;
    case 'lastSeen':
      return row.lastSeen ? new Date(row.lastSeen).getTime() : 0;
    default:
      return row.sourceIp ?? '';
  }
};

// Sorting is client-side: the endpoint already returns the whole (limit-bounded) set.
const sortedSources = computed<SourceRow[]>(() => {
  const rows = [...(data.value?.sources ?? [])];
  const direction = sortOrder.value === 'asc' ? 1 : -1;

  return rows.sort((a, b) => {
    const left = sortValue(a, sortBy.value);
    const right = sortValue(b, sortBy.value);
    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * direction;
    }
    return String(left).localeCompare(String(right)) * direction;
  });
});

const load = async () => {
  loading.value = true;
  error.value = null;

  try {
    data.value = await sourcesApi.list(range.value);
  } catch (err) {
    data.value = null;
    error.value = err instanceof Error ? err.message : 'Failed to load sources';
  } finally {
    loading.value = false;
  }
};

const changeRange = (value: StatsRange) => {
  if (query.range === value) return;
  query.range = value;
  // The selected row belongs to the old window; keeping it would show stale numbers.
  selectedIp.value = null;
  sync();
  load();
};

const handleSort = ({ sortBy: by, sortOrder: order }: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
  sortBy.value = by;
  sortOrder.value = order;
};

const selectSource = (row: SourceRow) => {
  selectedIp.value = selectedIp.value === row.sourceIp ? null : row.sourceIp;
};

const rowClass = (row: SourceRow): string =>
  row.sourceIp === selectedIp.value ? 'bg-primary-50' : '';

const failRate = (row: SourceRow): number => {
  const messages = row.messages ?? 0;
  if (messages === 0) return 0;
  // One decimal: a 0.4% failure rate is a different thing from 0%.
  return Math.round(((row.failures ?? 0) / messages) * 1000) / 10;
};

const passBadge = (value: number | undefined): string => {
  const rate = value ?? 0;
  if (rate >= 90) return 'badge-success';
  if (rate >= 70) return 'badge-warning';
  return 'badge-danger';
};

const failureBadge = (row: SourceRow): string => {
  const rate = failRate(row);
  if (rate === 0) return 'badge-success';
  return rate < 10 ? 'badge-warning' : 'badge-danger';
};

const formatDateTime = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : 'never';

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

const { sync } = useQueryFilters(query, ['range'], load);

load();
</script>
