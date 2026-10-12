<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      :title="report?.domain || 'Forensic Report'"
      :description="report ? `Reported by ${report.reporter || 'unknown reporter'} • ${formatDateTime(report.arrivalDate || report.createdAt)}` : undefined"
      :back-to="{ name: 'Forensics' }"
      back-label="Back to Forensic Reports"
    />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div v-if="loading" class="flex items-center justify-center py-12">
        <div class="flex items-center space-x-3">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <span class="text-lg text-gray-600">Loading report…</span>
        </div>
      </div>

      <div v-else-if="error" class="rounded-md bg-danger-50 p-4">
        <h3 class="text-sm font-medium text-danger-800">Could not load this report</h3>
        <p class="mt-1 text-sm text-danger-700">{{ error }}</p>
        <button @click="load" class="btn btn-secondary text-sm mt-3">Try again</button>
      </div>

      <div v-else-if="report" class="space-y-6">
        <div
          v-if="!report.reportAuthenticated"
          class="rounded-md bg-warning-50 p-4"
        >
          <h3 class="text-sm font-medium text-warning-800">Unverified report</h3>
          <p class="mt-1 text-sm text-warning-700">
            The mailbox accepts mail from anyone, so this report is a claim rather than a fact.
            No Authentication-Results header on the report mail confirmed its sender.
          </p>
          <p v-if="report.reportAuthDetail" class="mt-2 text-xs text-warning-700 font-mono break-all">
            {{ report.reportAuthDetail }}
          </p>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- What failed -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">The failure</h3>
              <p class="mt-1 text-sm text-gray-500">What the receiver evaluated</p>
            </div>
            <div class="card-body">
              <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <dt class="stat-label">Source IP</dt>
                  <dd class="mt-1 flex items-center gap-1 font-mono text-gray-900">
                    <span class="group inline-flex items-center gap-1">
                      <span class="nums">{{ report.sourceIp || '-' }}</span>
                      <CopyButton v-if="report.sourceIp" :value="report.sourceIp" label="source IP" />
                    </span>
                  </dd>
                </div>
                <div>
                  <dt class="stat-label">Reported domain</dt>
                  <dd class="mt-1 text-gray-900">{{ report.reportedDomain || report.domain }}</dd>
                </div>
                <div>
                  <dt class="stat-label">SPF</dt>
                  <dd class="mt-1"><StatusBadge :status="report.spfResult" kind="auth" /></dd>
                </div>
                <div>
                  <dt class="stat-label">DKIM</dt>
                  <dd class="mt-1"><StatusBadge :status="report.dkimResult" kind="auth" /></dd>
                </div>
                <div>
                  <dt class="stat-label">DMARC</dt>
                  <dd class="mt-1"><StatusBadge :status="report.dmarcResult" kind="auth" /></dd>
                </div>
                <div>
                  <dt class="stat-label">Feedback type</dt>
                  <dd class="mt-1 text-gray-900">{{ report.feedbackType }}</dd>
                </div>
                <div>
                  <dt class="stat-label">Envelope from</dt>
                  <dd class="mt-1 font-mono text-gray-900 break-all">{{ report.originalMailFrom || '-' }}</dd>
                </div>
                <div>
                  <dt class="stat-label">Envelope to</dt>
                  <dd class="mt-1 font-mono text-gray-900 break-all">{{ report.originalRcptTo || '-' }}</dd>
                </div>
                <div>
                  <dt class="stat-label">DKIM domain / selector</dt>
                  <dd class="mt-1 font-mono text-gray-900">
                    {{ report.dkimDomain || '-' }} / {{ report.dkimSelector || '-' }}
                  </dd>
                </div>
                <div>
                  <dt class="stat-label">Identity alignment</dt>
                  <dd class="mt-1 text-gray-900 break-all">{{ report.identityAlignment || '-' }}</dd>
                </div>
                <div>
                  <dt class="stat-label">Reporting MTA</dt>
                  <dd class="mt-1 text-gray-900 break-all">{{ report.reportingMta || '-' }}</dd>
                </div>
                <div>
                  <dt class="stat-label">Reporter</dt>
                  <dd class="mt-1 text-gray-900 break-all">
                    {{ report.reporterEmail || report.reporter || '-' }}
                  </dd>
                </div>
              </dl>

              <div class="mt-6">
                <h4 class="stat-label">Authentication-Results</h4>
                <pre class="mt-2 text-xs bg-surface-muted rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">{{ report.authResults || '(none recorded)' }}</pre>
              </div>

              <div v-if="report.userAgent" class="mt-4">
                <h4 class="stat-label">Reported by</h4>
                <p class="mt-1 text-xs text-gray-600 break-all">{{ report.userAgent }}</p>
              </div>
            </div>
          </div>

          <!-- Reported message -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Reported message</h3>
              <p class="mt-1 text-sm text-gray-500">
                Identifying headers of the mail the receiver rejected
              </p>
            </div>
            <div class="card-body space-y-4">
              <p v-if="!report.reportedSubject && !report.reportedFrom && !report.reportedMessageId"
                 class="text-sm text-gray-500">
                The reporter did not include the failing message.
              </p>

              <dl class="grid grid-cols-1 gap-3 text-sm">
                <div v-if="report.reportedSubject">
                  <dt class="stat-label">Subject</dt>
                  <dd class="mt-1 text-gray-900 break-words">{{ report.reportedSubject }}</dd>
                </div>
                <div v-if="report.reportedFrom">
                  <dt class="stat-label">From</dt>
                  <dd class="mt-1 text-gray-900 break-all">{{ report.reportedFrom }}</dd>
                </div>
                <div v-if="report.reportedTo">
                  <dt class="stat-label">To</dt>
                  <dd class="mt-1 text-gray-900 break-all">{{ report.reportedTo }}</dd>
                </div>
                <div v-if="report.reportedDate">
                  <dt class="stat-label">Date</dt>
                  <dd class="mt-1 text-gray-900">{{ formatDateTime(report.reportedDate) }}</dd>
                </div>
                <div v-if="report.reportedMessageId">
                  <dt class="stat-label">Message-ID</dt>
                  <dd class="mt-1 flex items-start gap-1 font-mono text-gray-900 break-all">
                    <span class="group inline-flex items-start gap-1">
                      <span>{{ report.reportedMessageId }}</span>
                      <CopyButton :value="report.reportedMessageId" label="Message-ID" />
                    </span>
                  </dd>
                </div>
              </dl>

              <div v-if="report.reportedHeaders">
                <h4 class="stat-label">Full reported headers</h4>
                <pre class="mt-2 text-xs bg-surface-muted rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">{{ report.reportedHeaders }}</pre>
              </div>

              <div v-if="report.reportedBody">
                <h4 class="stat-label">Reported body (truncated, attacker-controlled)</h4>
                <pre class="mt-2 text-xs bg-surface-muted rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">{{ report.reportedBody }}</pre>
              </div>

              <p v-else class="text-xs text-gray-500">
                Storing the full headers or the body of the reported message is off by default and
                can be enabled by an administrator under Settings → Forensics.
              </p>
            </div>
          </div>
        </div>

        <!-- Raw report -->
        <div class="card">
          <div class="card-header">
            <h3 class="text-lg leading-6 font-medium text-gray-900">Raw feedback report</h3>
            <p class="mt-1 text-sm text-gray-500">
              The message/feedback-report fields as received
            </p>
          </div>
          <div class="card-body">
            <pre v-if="report.rawFeedback" class="text-xs bg-surface-muted rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">{{ report.rawFeedback }}</pre>
            <p v-else class="text-sm text-gray-500">
              Storing the raw report block is disabled (Settings → Forensics → store raw feedback).
            </p>
          </div>
        </div>

        <!-- Processing trail -->
        <div class="card">
          <div class="card-header">
            <h3 class="text-lg leading-6 font-medium text-gray-900">Processing trail</h3>
            <p class="mt-1 text-sm text-gray-500">
              Message UID {{ report.sourceMessageUid ?? '-' }} • {{ report.sourceMessageId || 'no Message-ID' }}
            </p>
          </div>
          <div class="overflow-x-auto">
            <table class="table">
              <thead class="table-header">
                <tr>
                  <th scope="col" class="table-header-cell">When</th>
                  <th scope="col" class="table-header-cell">Status</th>
                  <th scope="col" class="table-header-cell">Details</th>
                </tr>
              </thead>
              <tbody class="table-body">
                <tr v-if="report.processingLogs.length === 0">
                  <td class="table-cell text-gray-500" colspan="3">No processing entries recorded.</td>
                </tr>
                <tr v-for="log in report.processingLogs" :key="log.id" class="table-row">
                  <td class="table-cell whitespace-nowrap nums">{{ formatDateTime(log.createdAt) }}</td>
                  <td class="table-cell">
                    <StatusBadge :status="log.status" kind="processing" />
                  </td>
                  <td class="table-cell break-all">{{ log.details || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import CopyButton from '@/components/CopyButton.vue';
import { forensicsApi } from '@/api/client';
import type { ForensicReportDetail } from '@/types/api';

const props = defineProps<{ id: string }>();

const report = ref<ForensicReportDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const load = async () => {
  loading.value = true;
  error.value = null;

  try {
    report.value = await forensicsApi.getById(props.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load the report';
  } finally {
    loading.value = false;
  }
};

const formatDateTime = (value: string | null): string => {
  if (!value) return '-';
  return new Date(value).toLocaleString();
};

onMounted(load);
</script>
