<template>
  <div class="card">
    <div class="card-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 class="text-lg leading-6 font-medium text-gray-900">Records to publish</h3>
        <p class="mt-1 text-sm text-gray-500">
          What to publish in DNS for {{ domainName }}. Read-only advice — nothing is applied for
          you, and the values are copied as-is.
        </p>
        <p v-if="result" class="mt-1 nums text-xs text-gray-400">
          Generated {{ formatDateTime(result.generatedAt) }}
        </p>
      </div>
      <button class="btn btn-secondary text-sm" :disabled="loading" @click="rebuild">
        {{ loading ? 'Building…' : 'Rebuild records' }}
      </button>
    </div>

    <div class="card-body space-y-6">
      <p v-if="loading && !result" class="text-sm text-gray-500">Building suggestions…</p>

      <p v-if="error" class="rounded-md bg-danger-50 p-3 text-sm text-danger-700">{{ error }}</p>

      <template v-if="result">
        <!-- SPF builder -->
        <section>
          <h4 class="text-sm font-medium text-gray-900">SPF providers</h4>
          <p class="mt-1 text-xs text-gray-500">
            Tick every service that sends mail as this domain; each one adds an
            <span class="font-mono">include:</span> to the SPF record below, and the record is
            rebuilt after each change.
          </p>

          <p v-if="result.providers.length === 0" class="mt-2 text-xs text-gray-500">
            This instance returned no provider catalogue, so the SPF record is the server's default.
          </p>
          <ul v-else class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
            <li
              v-for="provider in result.providers"
              :key="provider.id"
              class="flex items-center gap-2"
            >
              <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  :checked="draft.providers.includes(provider.id)"
                  @change="toggleProvider(provider.id, ($event.target as HTMLInputElement).checked)"
                />
                {{ provider.label }}
              </label>
              <span class="group inline-flex min-w-0 items-center">
                <code class="truncate font-mono text-xs text-gray-500">{{ includeToken(provider) }}</code>
                <CopyButton :value="includeToken(provider)" label="SPF include" />
              </span>
              <a
                :href="provider.docs"
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 text-xs text-primary-600 hover:text-primary-700"
              >
                docs
              </a>
            </li>
          </ul>

          <p v-if="ownDomains.length > 0" class="mt-2 text-xs text-gray-500">
            Not in the catalogue, so the builder does not add them: if you also send mail through
            these domains, add one include each.
            <span
              v-for="domain in ownDomains"
              :key="domain"
              class="group ml-1 inline-flex items-center"
            >
              <code class="font-mono text-gray-700">include:{{ domain }}</code>
              <CopyButton :value="`include:${domain}`" label="SPF include" />
            </span>
          </p>

          <div
            v-if="spfRecord"
            class="group mt-2 flex items-start gap-2 rounded bg-surface-muted p-2"
          >
            <code class="min-w-0 flex-1 break-all font-mono text-xs text-gray-700">{{
              spfRecord.value
            }}</code>
            <CopyButton :value="spfRecord.value" label="SPF value" />
          </div>
          <!-- The lookup limit is the one note that changes what a provider selection may contain. -->
          <ul v-if="spfRecord && spfRecord.notes.length > 0" class="mt-2 list-inside list-disc rounded-md bg-warning-50 p-3">
            <li
              v-for="(note, index) in spfRecord.notes"
              :key="index"
              class="text-xs text-warning-800"
            >
              {{ note }}
            </li>
          </ul>
        </section>

        <!-- Options that feed the generated records -->
        <section>
          <h4 class="text-sm font-medium text-gray-900">Record options</h4>
          <p class="mt-1 text-xs text-gray-500">
            Shown as the server would generate them by itself; changing one rebuilds the records.
          </p>
          <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label for="records-policy" class="mb-1 block text-xs font-medium text-gray-700">
                DMARC policy
              </label>
              <select
                id="records-policy"
                v-model="draft.dmarcPolicy"
                class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-xs text-sm focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                @change="schedule"
              >
                <option value="">Server default</option>
                <option value="none">none — watch only</option>
                <option value="quarantine">quarantine — junk folder</option>
                <option value="reject">reject — refuse it</option>
              </select>
              <p class="mt-1 text-xs text-gray-500">
                What a receiver does with mail that fails DMARC. Tighten it once the reports look clean.
              </p>
            </div>

            <div>
              <label for="records-rua" class="mb-1 block text-xs font-medium text-gray-700">
                Aggregate reports (rua)
              </label>
              <input
                id="records-rua"
                v-model="draft.rua"
                type="text"
                class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-xs font-mono text-sm focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                @input="schedule"
              />
              <p class="mt-1 text-xs text-gray-500">
                Where daily XML summaries go, e.g. <span class="font-mono">mailto:dmarc@…</span>.
                The generated address is the app's own mailbox.
              </p>
            </div>

            <div>
              <label for="records-ruf" class="mb-1 block text-xs font-medium text-gray-700">
                Failure reports (ruf)
              </label>
              <input
                id="records-ruf"
                v-model="draft.ruf"
                type="text"
                class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-xs font-mono text-sm focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                @input="schedule"
              />
              <p class="mt-1 text-xs text-gray-500">
                Optional per-message forensics; leave empty to publish none.
              </p>
            </div>

            <div>
              <label for="records-mta-sts" class="mb-1 block text-xs font-medium text-gray-700">
                MTA-STS mode
              </label>
              <select
                id="records-mta-sts"
                v-model="draft.mtaStsMode"
                class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-xs text-sm focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                @change="schedule"
              >
                <option value="">Server default</option>
                <option value="testing">testing — verify first</option>
                <option value="enforce">enforce — require TLS</option>
              </select>
              <p class="mt-1 text-xs text-gray-500">
                How strict the MTA-STS policy is. <span class="font-mono">testing</span> lets you
                watch for breakage before locking TLS in.
              </p>
            </div>
          </div>
        </section>

        <!-- Generated records -->
        <section class="space-y-3">
          <h4 class="text-sm font-medium text-gray-900">Records</h4>

          <article
            v-for="record in result.records"
            :key="record.id"
            class="rounded-md border border-gray-200 p-3 sm:p-4"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h5 class="text-sm font-medium text-gray-900">{{ record.label }}</h5>
              <div class="flex items-center gap-2">
                <span class="nums text-xs text-gray-400">TTL {{ record.ttl }}</span>
                <StatusBadge
                  :status="BADGE_STATUS[record.status]"
                  :label="record.status"
                  icon
                />
              </div>
            </div>
            <p class="mt-1 text-xs text-gray-500">{{ record.purpose }}</p>

            <div class="mt-3 space-y-1.5">
              <div class="group flex items-start gap-2">
                <span class="w-14 shrink-0 pt-0.5 text-xs uppercase tracking-wide text-gray-400">
                  Host
                </span>
                <code class="min-w-0 flex-1 break-all font-mono text-xs text-gray-800">{{
                  record.host
                }}</code>
                <CopyButton :value="record.host" label="host" />
              </div>
              <div class="group flex items-start gap-2">
                <span class="w-14 shrink-0 pt-0.5 text-xs uppercase tracking-wide text-gray-400">
                  Type
                </span>
                <code class="min-w-0 flex-1 font-mono text-xs text-gray-800">{{ record.type }}</code>
              </div>
              <div class="group flex items-start gap-2">
                <span class="w-14 shrink-0 pt-0.5 text-xs uppercase tracking-wide text-gray-400">
                  Value
                </span>
                <pre
                  class="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-gray-800"
                >{{ record.value }}</pre>
                <CopyButton :value="record.value" label="value" />
              </div>
              <div class="group flex items-start gap-2">
                <span class="w-14 shrink-0 pt-0.5 text-xs uppercase tracking-wide text-gray-400">
                  Line
                </span>
                <code class="min-w-0 flex-1 break-all font-mono text-xs text-gray-500">{{
                  lineForm(record)
                }}</code>
                <CopyButton :value="lineForm(record)" label="record" />
              </div>
            </div>

            <p
              v-if="record.providerHint"
              class="mt-3 rounded-md bg-primary-50 p-3 text-xs text-primary-800"
            >
              {{ record.providerHint }}
            </p>

            <ul v-if="record.notes.length > 0" class="mt-3 list-inside list-disc rounded-md bg-warning-50 p-3">
              <li v-for="(note, index) in record.notes" :key="index" class="text-xs text-warning-800">
                {{ note }}
              </li>
            </ul>

            <div
              v-if="record.companionFile"
              class="mt-3 rounded-md border border-gray-200 bg-surface-muted p-3"
            >
              <p class="text-xs font-medium text-gray-700">
                Serve this file, or the MTA-STS TXT record above is a promise you do not keep
              </p>
              <div class="group mt-2 flex items-start gap-2">
                <span class="w-14 shrink-0 pt-0.5 text-xs uppercase tracking-wide text-gray-400">
                  Path
                </span>
                <code class="min-w-0 flex-1 break-all font-mono text-xs text-gray-800">{{
                  record.companionFile.path
                }}</code>
                <CopyButton :value="record.companionFile.path" label="policy path" />
              </div>
              <div class="group mt-2 flex items-start gap-2">
                <pre
                  class="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-xs text-gray-800"
                >{{ record.companionFile.content }}</pre>
                <CopyButton :value="record.companionFile.content" label="policy file" />
              </div>
            </div>
          </article>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import CopyButton from '@/components/CopyButton.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { domainsApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';
import type {
  GeneratedRecord,
  GeneratedRecordStatus,
  RecordSuggestions,
  RecordSuggestionOptions,
  SpfProvider,
} from '@/types/api';

/**
 * The record builder's own vocabulary for the same badge tones the rest of the page uses:
 * a missing required record is a fault, an outdated one is weak, and `needs-input` is a
 * question for the operator rather than a defect.
 */
const BADGE_STATUS: Record<GeneratedRecordStatus, 'ok' | 'warn' | 'error' | 'info'> = {
  ok: 'ok',
  missing: 'error',
  outdated: 'warn',
  'needs-input': 'info',
};

type DmarcPolicy = NonNullable<RecordSuggestionOptions['dmarcPolicy']>;
type MtaStsMode = NonNullable<RecordSuggestionOptions['mtaStsMode']>;

const DMARC_POLICIES: DmarcPolicy[] = ['none', 'quarantine', 'reject'];
const MTA_STS_MODES: MtaStsMode[] = ['testing', 'enforce'];

const props = defineProps<{ domainId: string; domainName: string }>();

const toast = useToast();
const { state } = useAuth();

const result = ref<RecordSuggestions | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** `''` is the "let the server decide" position for the selects, which the types have no room for. */
const draft = reactive({
  providers: [] as string[],
  dmarcPolicy: '',
  rua: '',
  ruf: '',
  mtaStsMode: '',
});

/**
 * Until the first response says which providers the server picked, the provider list is sent as
 * absent rather than empty - an empty list would be read as "no includes at all".
 */
const providersChosen = ref(false);

/** The other domains this session can see: candidate SPF includes the catalogue does not know. */
const ownDomains = computed(() =>
  state.domains.filter((name) => name.toLowerCase() !== props.domainName.toLowerCase()),
);

const spfRecord = computed<GeneratedRecord | null>(
  () => result.value?.records.find((record) => record.id === 'spf') ?? null,
);

const includeToken = (provider: SpfProvider): string =>
  provider.include.startsWith('include:') ? provider.include : `include:${provider.include}`;

/** DMARC is a `;`-separated tag list, so a default can be read back out of the generated value. */
const tagValue = (value: string, tag: string): string => {
  const match = value.match(new RegExp(`(?:^|;)\\s*${tag}\\s*=\\s*([^;]*)`, 'i'));
  return match ? match[1].trim() : '';
};

/** Only the keys the operator actually set are sent; the rest keep the server's default. */
const requestOptions = (): RecordSuggestionOptions => {
  const options: RecordSuggestionOptions = {};

  if (providersChosen.value) options.providers = [...draft.providers];

  const policy = DMARC_POLICIES.find((candidate) => candidate === draft.dmarcPolicy);
  if (policy) options.dmarcPolicy = policy;

  const mode = MTA_STS_MODES.find((candidate) => candidate === draft.mtaStsMode);
  if (mode) options.mtaStsMode = mode;

  // A cleared box falls back to the generated default instead of publishing an empty tag.
  if (draft.rua.trim()) options.rua = draft.rua.trim();
  if (draft.ruf.trim()) options.ruf = draft.ruf.trim();

  return options;
};

/**
 * The first request carries no options, so its response *is* the server's default configuration.
 * Reading it back keeps the controls showing real values rather than a guess of our own.
 */
const applyServerDefaults = (response: RecordSuggestions): void => {
  const spf = response.records.find((record) => record.id === 'spf');
  draft.providers = spf
    ? response.providers
        .filter((provider) => spf.value.includes(includeToken(provider)))
        .map((provider) => provider.id)
    : [];
  providersChosen.value = true;

  const dmarc = response.records.find((record) => record.id === 'dmarc');
  if (!dmarc) return;

  draft.dmarcPolicy = tagValue(dmarc.value, 'p').toLowerCase();
  draft.rua = tagValue(dmarc.value, 'rua');
  draft.ruf = tagValue(dmarc.value, 'ruf');
};

/**
 * `notify` is for changes the operator made. The initial load is not an action they took, so a
 * failure stays inline rather than interrupting the page with a toast.
 */
const fetchRecords = async (notify = false): Promise<void> => {
  loading.value = true;
  error.value = null;

  try {
    const response = await domainsApi.suggestRecords(props.domainId, requestOptions());
    result.value = response;
    if (!providersChosen.value) applyServerDefaults(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not build the records';
    error.value = message;
    if (notify) toast.error(message);
  } finally {
    loading.value = false;
  }
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** A checkbox click is a burst of intent, so the request waits for the pointer to settle. */
const schedule = (): void => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void fetchRecords(true), 400);
};

const toggleProvider = (id: string, checked: boolean): void => {
  draft.providers = checked
    ? [...draft.providers, id]
    : draft.providers.filter((provider) => provider !== id);
  schedule();
};

const rebuild = (): void => void fetchRecords(true);

/** Host, type and value on one line for a zone file or a registrar that asks for a single field. */
const lineForm = (record: GeneratedRecord): string =>
  `${record.host} ${record.type} ${record.value}`;

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

onMounted(() => void fetchRecords());

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>
