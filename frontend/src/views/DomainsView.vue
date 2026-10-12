<template>
  <div class="min-h-screen bg-gray-50">
    <!-- Header -->
    <div class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="py-6">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-3xl font-bold text-gray-900">Domains</h1>
              <p class="mt-2 text-sm text-gray-600">
                DNS authentication status for every domain you monitor
              </p>
            </div>
            <div class="flex items-center space-x-2">
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
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <p
        v-if="feedback"
        class="rounded-md p-4 text-sm"
        :class="feedback.error ? 'bg-danger-50 text-danger-800' : 'bg-success-50 text-success-800'"
      >
        {{ feedback.text }}
      </p>

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
          <div>
            <p class="font-medium text-gray-900">{{ item.name }}</p>
            <p v-if="item.notes" class="text-xs text-gray-500">{{ item.notes }}</p>
          </div>
        </template>

        <template #cell-status="{ item }">
          <span class="badge" :class="statusBadge(item.lastCheck?.status)">
            {{ item.lastCheck?.status ?? 'not checked' }}
          </span>
        </template>

        <template #cell-checks="{ item }">
          <div class="flex flex-wrap gap-1">
            <template v-for="check in checkBadges(item)" :key="check.id">
              <span v-if="check.status" class="badge" :class="statusBadge(check.status)" :title="check.title">
                {{ check.label }}
              </span>
              <span v-else class="text-xs text-gray-300" :title="check.title">{{ check.label }} –</span>
            </template>
          </div>
        </template>

        <template #cell-lastChecked="{ item }">
          {{ formatRelative(item.lastCheck?.runAt ?? null) }}
        </template>

        <template #cell-monitored="{ item }">
          <span class="badge" :class="item.monitored ? 'badge-success' : 'badge-gray'">
            {{ item.monitored ? 'Monitored' : 'Paused' }}
          </span>
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
              <div class="flex items-center space-x-2">
                <h2 class="text-lg leading-6 font-medium text-gray-900">{{ detail.domain.name }}</h2>
                <span class="badge" :class="statusBadge(detail.domain.lastCheck?.status)">
                  {{ detail.domain.lastCheck?.status ?? 'not checked' }}
                </span>
              </div>
              <p class="mt-1 text-sm text-gray-500">
                Last checked {{ formatRelative(detail.domain.lastCheck?.runAt ?? null) }}
                <span v-if="detail.domain.lastCheck"> in {{ detail.domain.lastCheck.durationMs }} ms</span>
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
                  <span class="badge" :class="statusBadge(result.status)">{{ result.status }}</span>
                </div>
                <p class="mt-2 text-sm text-gray-700">{{ result.summary }}</p>
                <pre
                  v-if="result.details?.length"
                  class="mt-2 text-xs bg-gray-50 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all"
                >{{ result.details.join('\n') }}</pre>
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
                <p
                  v-if="editMessage"
                  class="text-sm"
                  :class="editMessage.error ? 'text-danger-700' : 'text-success-700'"
                >
                  {{ editMessage.text }}
                </p>
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
import { domainsApi } from '@/api/client';
import { useAsyncData } from '@/composables/useApi';
import { useAuth } from '@/composables/useAuth';
import type {
  DomainCheckResult,
  DomainCheckStatus,
  DomainDetail,
  DomainHealthSummary,
  DomainSummary,
} from '@/types/api';

const { isAdmin } = useAuth();

const columns = [
  { key: 'name', label: 'Domain' },
  { key: 'status', label: 'Status' },
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

const feedback = ref<{ text: string; error: boolean } | null>(null);
const editMessage = ref<{ text: string; error: boolean } | null>(null);
const edit = reactive({ dkimSelectors: '', expectedMx: '', monitored: true });

const statusBadge = (status: string | undefined): string => {
  if (status === 'ok') return 'badge-success';
  if (status === 'warn') return 'badge-warning';
  if (status === 'error') return 'badge-danger';
  return 'badge-gray';
};

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

const selectDomain = (domain: DomainSummary) => {
  if (selectedId.value === domain.id) {
    selectedId.value = null;
    detail.value = null;
    return;
  }

  selectedId.value = domain.id;
  editMessage.value = null;
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
    feedback.value = { text: `Added ${created.name}`, error: false };
    await load();
    refreshSummary();
  } catch (err) {
    feedback.value = { text: err instanceof Error ? err.message : 'Could not add the domain', error: true };
  } finally {
    adding.value = false;
  }
};

const discover = async () => {
  discovering.value = true;
  try {
    const result = await domainsApi.discover();
    feedback.value = {
      text:
        result.added.length > 0
          ? `Added ${result.added.length} domain(s): ${result.added.join(', ')}`
          : `No new domains found (${result.existing} already tracked)`,
      error: false,
    };
    await load();
    refreshSummary();
  } catch (err) {
    feedback.value = { text: err instanceof Error ? err.message : 'Could not discover domains', error: true };
  } finally {
    discovering.value = false;
  }
};

const checkAll = async () => {
  checkingAll.value = true;
  try {
    const result = await domainsApi.checkAll();
    feedback.value = {
      text: `Checked ${result.checked} domain(s), ${result.failed} failed`,
      error: result.failed > 0,
    };
    await load();
    refreshSummary();
    if (selectedId.value) {
      await loadDetail(selectedId.value);
    }
  } catch (err) {
    feedback.value = { text: err instanceof Error ? err.message : 'Check-all failed', error: true };
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
    feedback.value = {
      text: `${report.domain}: ${report.status} in ${report.durationMs} ms`,
      error: report.status === 'error',
    };
    await loadDetail(id);
    await load();
    refreshSummary();
  } catch (err) {
    feedback.value = { text: err instanceof Error ? err.message : 'Check failed', error: true };
  } finally {
    checkingNow.value = false;
  }
};

const saveEdit = async () => {
  const current = detail.value;
  if (!current) return;

  savingEdit.value = true;
  editMessage.value = null;
  try {
    const updated = await domainsApi.update(current.domain.id, {
      dkimSelectors: splitList(edit.dkimSelectors),
      expectedMx: splitList(edit.expectedMx),
      monitored: edit.monitored,
    });
    detail.value = { ...current, domain: updated };
    editMessage.value = { text: 'Saved', error: false };
    await load();
    refreshSummary();
  } catch (err) {
    editMessage.value = { text: err instanceof Error ? err.message : 'Could not save', error: true };
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
  editMessage.value = null;
  try {
    await domainsApi.remove(id);
    selectedId.value = null;
    detail.value = null;
    feedback.value = { text: `Removed ${name}`, error: false };
    await load();
    refreshSummary();
  } catch (err) {
    editMessage.value = { text: err instanceof Error ? err.message : 'Could not remove the domain', error: true };
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

onMounted(load);
</script>
