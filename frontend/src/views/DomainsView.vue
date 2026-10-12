<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Domains"
      description="DNS authentication status for every domain you monitor"
    >
      <template #actions>
        <button
          v-if="isAdmin"
          @click="discover"
          :disabled="discovering"
          class="btn btn-secondary"
          :class="{ 'opacity-50 cursor-not-allowed': discovering }"
        >
          {{ discovering ? 'Discovering…' : 'Discover domains' }}
        </button>
        <button
          v-if="isAdmin"
          @click="checkAll"
          :disabled="checkingAll"
          class="btn btn-primary"
          :class="{ 'opacity-50 cursor-not-allowed': checkingAll }"
        >
          {{ checkingAll ? 'Checking…' : 'Check all' }}
        </button>
        <button @click="refreshAll" class="btn btn-secondary">Refresh</button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- Summary -->
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Domains" :value="summary?.total ?? 0" icon="reports" color="blue" />
        <SummaryCard title="OK" :value="summary?.ok ?? 0" icon="check" color="green" />
        <SummaryCard
          title="Warnings"
          :value="summary?.warn ?? 0"
          icon="warning"
          :color="(summary?.warn ?? 0) > 0 ? 'yellow' : 'green'"
        />
        <SummaryCard
          title="Errors"
          :value="summary?.error ?? 0"
          icon="x"
          :color="(summary?.error ?? 0) > 0 ? 'red' : 'green'"
        />
      </div>

      <!-- Domain list -->
      <DataTable
        :columns="columns"
        :data="rows"
        :loading="loading"
        title="Monitored domains"
        description="Click a row to see its checks and history"
        empty-message="No domains are tracked yet"
        @row-click="selectDomain"
      >
        <template #filters>
          <div v-if="isAdmin" class="flex items-center space-x-2">
            <input
              v-model="newDomain"
              type="text"
              placeholder="example.com"
              class="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              @keyup.enter="addDomain"
            />
            <button
              class="btn btn-primary text-sm"
              :disabled="adding || !newDomain.trim()"
              :class="{ 'opacity-50 cursor-not-allowed': adding || !newDomain.trim() }"
              @click="addDomain"
            >
              {{ adding ? 'Adding…' : 'Add domain' }}
            </button>
          </div>
        </template>

        <template #cell-name="{ item }">
          <div class="group">
            <div class="flex items-center gap-1">
              <p class="font-medium text-gray-900">{{ item.name }}</p>
              <CopyButton :value="item.name" label="domain" />
            </div>
            <p v-if="item.notes" class="text-xs text-gray-500">{{ item.notes }}</p>
          </div>
        </template>

        <template #cell-status="{ item }">
          <StatusBadge :status="item.lastCheck?.status" kind="domain" icon />
        </template>

        <template #cell-trend="{ item }">
          <Sparkline :points="item.recent ?? []" />
        </template>

        <template #cell-checks="{ item }">
          <div class="flex flex-wrap gap-1">
            <template v-for="check in checkBadges(item)" :key="check.id">
              <StatusBadge
                v-if="check.status"
                :status="check.status"
                kind="domain"
                :label="check.label"
                icon
              />
              <span v-else class="text-xs text-gray-300" :title="check.title">{{ check.label }} –</span>
            </template>
          </div>
        </template>

        <template #cell-lastChecked="{ item }">
          <span class="nums">{{ formatRelative(item.lastCheck?.runAt ?? null) }}</span>
        </template>

        <template #cell-monitored="{ item }">
          <StatusBadge
            :status="item.monitored ? 'monitored' : 'paused'"
            :label="item.monitored ? 'Monitored' : 'Paused'"
          />
        </template>
      </DataTable>

      <p v-if="loadError" class="rounded-md bg-danger-50 p-4 text-sm text-danger-700">{{ loadError }}</p>

      <!-- Selected domain detail -->
      <div v-if="detailLoading" class="flex items-center justify-center py-12">
        <div class="flex items-center space-x-3">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <span class="text-lg text-gray-600">Loading domain…</span>
        </div>
      </div>

      <div v-else-if="detailError" class="rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load this domain</h3>
        <p class="mt-1 text-sm text-danger-700">{{ detailError }}</p>
        <button @click="retryDetail" class="btn btn-secondary text-sm mt-3">Try again</button>
      </div>

      <template v-else-if="detail">
        <div class="card">
          <div class="card-body flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div class="group flex items-center space-x-2">
                <h2 class="text-lg leading-6 font-medium text-gray-900">{{ detail.domain.name }}</h2>
                <CopyButton :value="detail.domain.name" label="domain" />
                <StatusBadge :status="detail.domain.lastCheck?.status" kind="domain" icon />
              </div>
              <p class="mt-1 text-sm text-gray-500">
                Last checked {{ formatRelative(detail.domain.lastCheck?.runAt ?? null) }}
                <span v-if="detail.domain.lastCheck"> in {{ detail.domain.lastCheck.durationMs }} ms</span>
              </p>
              <p v-if="latestChange" class="mt-1 text-sm" :class="latestChange.changed ? 'text-warning-700' : 'text-gray-500'">
                <template v-if="latestChange.changed">
                  Status changed from {{ latestChange.from }} to {{ latestChange.to }} at the previous
                  check on {{ formatDateTime(latestChange.at) }}.
                </template>
                <template v-else>
                  Unchanged since the previous check on {{ formatDateTime(latestChange.at) }}.
                </template>
              </p>
            </div>
            <button
              @click="checkNow"
              :disabled="checkingNow"
              class="btn btn-primary text-sm"
              :class="{ 'opacity-50 cursor-not-allowed': checkingNow }"
            >
              {{ checkingNow ? 'Checking…' : 'Check now' }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- Check results -->
          <div class="lg:col-span-2 card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Checks</h3>
              <p class="mt-1 text-sm text-gray-500">What the latest run found</p>
            </div>
            <div class="divide-y divide-gray-100">
              <p v-if="latestResults.length === 0" class="p-6 text-sm text-gray-500">
                This domain has not been checked yet.
              </p>
              <div v-for="result in latestResults" :key="result.id" class="p-4 sm:p-6">
                <div class="flex items-center justify-between">
                  <h4 class="text-sm font-medium text-gray-900">{{ result.label }}</h4>
                  <StatusBadge :status="result.status" kind="domain" icon />
                </div>
                <p class="mt-2 text-sm text-gray-700">{{ result.summary }}</p>
                <div
                  v-if="result.details?.length"
                  class="mt-2 flex items-start justify-between gap-2 rounded bg-surface-muted p-3"
                >
                  <div class="font-mono text-xs text-gray-700 whitespace-pre-wrap break-all">
                    <p v-for="(line, index) in result.details" :key="index">{{ line }}</p>
                  </div>
                  <CopyButton :value="result.details.join('\n')" label="records" />
                </div>
                <div v-if="result.fix" class="mt-2 rounded-md bg-warning-50 p-3">
                  <p class="text-sm text-warning-800">{{ result.fix }}</p>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-6">
            <!-- History strip -->
            <div class="card">
              <div class="card-header">
                <h3 class="text-lg leading-6 font-medium text-gray-900">History</h3>
                <p class="mt-1 text-sm text-gray-500">
                  Last {{ historyDots.length }} run(s), oldest first
                </p>
              </div>
              <div class="card-body">
                <p v-if="historyDots.length === 0" class="text-sm text-gray-500">No runs recorded yet.</p>
                <div v-else class="flex items-center space-x-1">
                  <span
                    v-for="run in historyDots"
                    :key="run.runAt"
                    class="w-3 h-3 rounded-full"
                    :class="statusDot(run.status)"
                    :title="`${run.status} — ${formatDateTime(run.runAt)}`"
                    :aria-label="`${run.status} — ${formatDateTime(run.runAt)}`"
                  ></span>
                </div>
              </div>
            </div>

            <ChartView
              type="bar"
              title="Overall status over time"
              description="0 = OK, 1 = warning, 2 = error"
              :data="statusChartData"
              :height="220"
            />

            <!-- Admin controls -->
            <div v-if="isAdmin" class="card">
              <div class="card-header">
                <h3 class="text-lg leading-6 font-medium text-gray-900">Settings</h3>
                <p class="mt-1 text-sm text-gray-500">Only administrators can change these</p>
              </div>
              <div class="card-body space-y-4">
                <div>
                  <label for="dkim-selectors" class="block text-sm font-medium text-gray-700 mb-1">
                    DKIM selectors
                  </label>
                  <input
                    id="dkim-selectors"
                    v-model="edit.dkimSelectors"
                    type="text"
                    placeholder="selector1, selector2"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div>
                  <label for="expected-mx" class="block text-sm font-medium text-gray-700 mb-1">
                    Expected MX
                  </label>
                  <input
                    id="expected-mx"
                    v-model="edit.expectedMx"
                    type="text"
                    placeholder="mx1.example.com, mx2.example.com"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <label class="inline-flex items-center cursor-pointer">
                  <input
                    v-model="edit.monitored"
                    type="checkbox"
                    class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <span class="ml-2 text-sm text-gray-700">
                    Monitored by the scheduled check
                  </span>
                </label>
                <div class="flex items-center space-x-3">
                  <button
                    class="btn btn-primary text-sm"
                    :disabled="savingEdit"
                    :class="{ 'opacity-50 cursor-not-allowed': savingEdit }"
                    @click="saveEdit"
                  >
                    {{ savingEdit ? 'Saving…' : 'Save' }}
                  </button>
                  <button
                    class="btn btn-secondary text-sm text-danger-700"
                    :disabled="removing"
                    :class="{ 'opacity-50 cursor-not-allowed': removing }"
                    @click="removeDomain"
                  >
                    {{ removing ? 'Removing…' : 'Delete' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <p v-else class="text-sm text-gray-500">Select a domain to see its checks and history.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import DataTable from '@/components/DataTable.vue';
import SummaryCard from '@/components/SummaryCard.vue';
import ChartView from '@/components/ChartView.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import CopyButton from '@/components/CopyButton.vue';
import Sparkline from '@/components/Sparkline.vue';
import { domainsApi } from '@/api/client';
import { useAsyncData } from '@/composables/useApi';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';
import { useQueryFilters } from '@/composables/useQueryFilters';
import type {
  DomainCheckResult,
  DomainCheckStatus,
  DomainDetail,
  DomainHealthSummary,
  DomainSummary,
} from '@/types/api';

const { isAdmin } = useAuth();
const toast = useToast();

const columns = [
  { key: 'name', label: 'Domain' },
  { key: 'status', label: 'Status' },
  { key: 'trend', label: 'Trend' },
  { key: 'checks', label: 'Checks' },
  { key: 'lastChecked', label: 'Last checked' },
  { key: 'monitored', label: 'Monitored' },
];

/** The compact per-check badges; DKIM is collapsed across its per-selector results. */
const CHECK_COLUMNS = [
  { id: 'mx', label: 'MX' },
  { id: 'spf', label: 'SPF' },
  { id: 'dmarc', label: 'DMARC' },
  { id: 'dkim', label: 'DKIM' },
  { id: 'mta-sts', label: 'MTA-STS' },
  { id: 'tls-rpt', label: 'TLS-RPT' },
  { id: 'bimi', label: 'BIMI' },
];

const STATUS_SEVERITY: Record<DomainCheckStatus, number> = {
  error: 4,
  warn: 3,
  info: 2,
  ok: 1,
  skipped: 0,
};

const STATUS_SCORE: Record<DomainCheckStatus, number> = {
  ok: 0,
  warn: 1,
  error: 2,
  info: 0,
  skipped: 0,
};

const rows = ref<DomainSummary[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

const { data: summary, refresh: refreshSummary } = useAsyncData<DomainHealthSummary>(() =>
  domainsApi.summary()
);

const selectedId = ref<string | null>(null);
const detail = ref<DomainDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const checkingNow = ref(false);

const newDomain = ref('');
const adding = ref(false);
const discovering = ref(false);
const checkingAll = ref(false);
const savingEdit = ref(false);
const removing = ref(false);

const edit = reactive({ dkimSelectors: '', expectedMx: '', monitored: true });

const statusDot = (status: string): string => {
  if (status === 'ok') return 'bg-success-500';
  if (status === 'warn') return 'bg-warning-500';
  if (status === 'error') return 'bg-danger-500';
  return 'bg-gray-400';
};

/** DKIM results carry the selector in their id ('dkim:selector'), so match on the slug. */
const worstStatus = (results: DomainCheckResult[], checkId: string): DomainCheckStatus | null => {
  const matches = results.filter((result) => result.id.split(':')[0] === checkId);
  if (matches.length === 0) return null;
  return matches.reduce(
    (worst, result) => (STATUS_SEVERITY[result.status] > STATUS_SEVERITY[worst] ? result.status : worst),
    matches[0].status
  );
};

const checkBadges = (domain: DomainSummary) =>
  CHECK_COLUMNS.map((check) => {
    const status = worstStatus(domain.lastCheck?.results ?? [], check.id);
    // A skipped optional check is not a state worth colouring, so it renders like an absent one.
    const shown = status && status !== 'skipped' ? status : null;
    return {
      id: check.id,
      label: check.label,
      status: shown,
      title: status ? `${check.label}: ${status}` : `${check.label}: not checked`,
    };
  });

const latestResults = computed<DomainCheckResult[]>(
  () => detail.value?.history[0]?.results ?? detail.value?.domain.lastCheck?.results ?? []
);

const historyDots = computed(() => detail.value?.history.slice(0, 15).reverse() ?? []);

/** Newest two runs, so the detail can say whether anything actually moved. */
const latestChange = computed(() => {
  const history = detail.value?.history ?? [];
  if (history.length < 2) return null;
  const [latest, previous] = history;
  return {
    from: previous.status,
    to: latest.status,
    at: previous.runAt,
    changed: latest.status !== previous.status,
  };
});

const statusChartData = computed(() =>
  (detail.value?.history ?? [])
    .slice(0, 15)
    .reverse()
    .map((run) => ({
      label: new Date(run.runAt).toLocaleDateString(),
      value: STATUS_SCORE[run.status],
      count: STATUS_SCORE[run.status],
    }))
);

const load = async () => {
  loading.value = true;
  loadError.value = null;

  try {
    rows.value = await domainsApi.list();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load domains';
  } finally {
    loading.value = false;
  }
};

const loadDetail = async (id: string) => {
  detailLoading.value = true;
  detailError.value = null;

  try {
    const result = await domainsApi.getById(id);
    detail.value = result;
    edit.dkimSelectors = result.domain.dkimSelectors.join(', ');
    edit.expectedMx = result.domain.expectedMx.join(', ');
    edit.monitored = result.domain.monitored;
  } catch (err) {
    detail.value = null;
    detailError.value = err instanceof Error ? err.message : 'Failed to load this domain';
  } finally {
    detailLoading.value = false;
  }
};

// The selected domain is part of the URL, so an expanded row can be linked to.
const selection = reactive({ domain: '' });
const openSelection = () => {
  if (selection.domain) {
    selectedId.value = selection.domain;
    loadDetail(selection.domain);
  } else {
    selectedId.value = null;
    detail.value = null;
  }
};
const { sync } = useQueryFilters(selection, ['domain'], openSelection);

const selectDomain = (domain: DomainSummary) => {
  if (selectedId.value === domain.id) {
    selectedId.value = null;
    detail.value = null;
    selection.domain = '';
    sync();
    return;
  }

  selectedId.value = domain.id;
  selection.domain = domain.id;
  sync();
  loadDetail(domain.id);
};

const refreshAll = () => {
  load();
  refreshSummary();
};

const retryDetail = () => {
  if (selectedId.value) {
    loadDetail(selectedId.value);
  }
};

const splitList = (value: string): string[] =>
  value.split(',').map((entry) => entry.trim()).filter(Boolean);

const addDomain = async () => {
  const name = newDomain.value.trim();
  if (!name) return;

  adding.value = true;
  try {
    const created = await domainsApi.create({ name });
    newDomain.value = '';
    toast.success(`Added ${created.name}`);
    await load();
    refreshSummary();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not add the domain');
  } finally {
    adding.value = false;
  }
};

const discover = async () => {
  discovering.value = true;
  try {
    const result = await domainsApi.discover();
    toast.success(
      result.added.length > 0
        ? `Added ${result.added.length} domain(s): ${result.added.join(', ')}`
        : `No new domains found (${result.existing} already tracked)`,
    );
    await load();
    refreshSummary();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not discover domains');
  } finally {
    discovering.value = false;
  }
};

const checkAll = async () => {
  checkingAll.value = true;
  try {
    const result = await domainsApi.checkAll();
    const message = `Checked ${result.checked} domain(s), ${result.failed} failed`;
    if (result.failed > 0) {
      toast.error(message);
    } else {
      toast.success(message);
    }
    await load();
    refreshSummary();
    if (selectedId.value) {
      await loadDetail(selectedId.value);
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Check-all failed');
  } finally {
    checkingAll.value = false;
  }
};

const checkNow = async () => {
  const current = detail.value;
  if (!current) return;

  const id = current.domain.id;
  checkingNow.value = true;
  try {
    const report = await domainsApi.check(id);
    const message = `${report.domain}: ${report.status} in ${report.durationMs} ms`;
    if (report.status === 'error') {
      toast.error(message);
    } else {
      toast.success(message);
    }
    await loadDetail(id);
    await load();
    refreshSummary();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Check failed');
  } finally {
    checkingNow.value = false;
  }
};

const saveEdit = async () => {
  const current = detail.value;
  if (!current) return;

  savingEdit.value = true;
  try {
    const updated = await domainsApi.update(current.domain.id, {
      dkimSelectors: splitList(edit.dkimSelectors),
      expectedMx: splitList(edit.expectedMx),
      monitored: edit.monitored,
    });
    detail.value = { ...current, domain: updated };
    toast.success('Saved');
    await load();
    refreshSummary();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not save');
  } finally {
    savingEdit.value = false;
  }
};

const removeDomain = async () => {
  const current = detail.value;
  if (!current) return;

  const { id, name } = current.domain;
  if (!window.confirm(`Remove ${name} from monitoring? Its check history is deleted too.`)) return;

  removing.value = true;
  try {
    await domainsApi.remove(id);
    selectedId.value = null;
    detail.value = null;
    selection.domain = '';
    sync();
    toast.success(`Removed ${name}`);
    await load();
    refreshSummary();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not remove the domain');
  } finally {
    removing.value = false;
  }
};

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

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

// A shared ?domain=<id> link opens the same row's detail once the list has loaded.
if (selection.domain) {
  selectedId.value = selection.domain;
  loadDetail(selection.domain);
}

onMounted(load);
</script>
