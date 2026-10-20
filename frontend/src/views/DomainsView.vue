<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Domains"
      description="DNS authentication status for every domain you monitor"
    >
      <template #actions>
        <button
          v-if="isOrgAdmin"
          @click="discover"
          :disabled="discovering"
          class="btn btn-secondary"
          :class="{ 'opacity-50 cursor-not-allowed': discovering }"
        >
          {{ discovering ? 'Discovering…' : 'Discover domains' }}
        </button>
        <button
          v-if="isOrgAdmin"
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
          <div v-if="isOrgAdmin" class="flex items-center space-x-2">
            <input
              v-model="newDomain"
              type="text"
              placeholder="example.com"
              class="px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
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

        <!-- A domain belongs to exactly one organisation; an unowned row is one discovered from
             a report and not claimed yet. -->
        <template #cell-organization="{ item }">
          <span v-if="item.organization" class="text-sm text-gray-700">
            {{ item.organization.name }}
          </span>
          <span v-else class="badge badge-gray">unowned</span>
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
              <p class="mt-1 text-sm text-gray-500">
                Organisation:
                <span v-if="detail.domain.organization" class="font-medium text-gray-700">
                  {{ detail.domain.organization.name }}
                </span>
                <span v-else class="text-gray-500">unowned</span>
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
            <div class="flex items-center gap-3">
              <button
                @click="checkNow"
                :disabled="checkingNow"
                class="btn btn-primary text-sm"
                :class="{ 'opacity-50 cursor-not-allowed': checkingNow }"
              >
                {{ checkingNow ? 'Checking…' : 'Check now' }}
              </button>
              <!-- Removal used to live only inside the edit form at the bottom of the panel,
                   which is why it looked as if a domain could be added but never removed. -->
              <button
                v-if="isOrgAdmin"
                type="button"
                class="btn btn-secondary text-sm text-danger-700"
                :disabled="removing"
                :class="{ 'opacity-50 cursor-not-allowed': removing }"
                @click="removeDomain"
              >
                <svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16"
                  />
                </svg>
                {{ removing ? 'Removing…' : 'Remove' }}
              </button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- Check results -->
          <div class="lg:col-span-2 card">
            <div class="card-header">
              <h3 class="text-lg leading-6 font-medium text-gray-900">Checks</h3>
              <p class="mt-1 text-sm text-gray-500">What the latest run found</p>
            </div>
            <!-- The statuses only mean something as a scale, and the quiet ones are the ones
                 most likely to be misread, so the scale is spelled out once here. -->
            <div class="border-b border-gray-100 bg-surface-muted px-4 py-3 sm:px-6">
              <p class="text-xs text-gray-500">
                Most findings on a healthy domain are <span class="font-medium">info</span> — an
                optional record that is simply not published, not a fault.
              </p>
              <ul class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                <li
                  v-for="entry in STATUS_LEGEND"
                  :key="entry.status"
                  class="flex items-start gap-2"
                >
                  <StatusBadge :status="entry.status" kind="domain" class="mt-0.5 shrink-0" />
                  <span class="text-xs text-gray-600">{{ entry.text }}</span>
                </li>
              </ul>
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
                <p v-if="result.purpose" class="mt-1 text-xs text-gray-500">{{ result.purpose }}</p>
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
            <div v-if="isOrgAdmin" class="card">
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
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p class="mt-1 text-xs text-gray-500">
                    The <span class="font-mono">s=</span> tag of your DKIM signature — the name in
                    front of <span class="font-mono">._domainkey</span>. Common ones:
                    <span class="font-mono">mailjet</span> (Mailjet),
                    <span class="font-mono">selector1</span>/<span class="font-mono">selector2</span>
                    (Microsoft 365), <span class="font-mono">google</span> (Google Workspace),
                    <span class="font-mono">default</span> (some providers). Leave it empty and the
                    DKIM check is skipped, so this is what switches that check on.
                  </p>
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
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p class="mt-1 text-xs text-gray-500">
                    Optional. When it is set, published MX hosts that are not in this list are
                    flagged, so a silent MX change (or a hijack) shows up as a diff instead of
                    passing unnoticed.
                  </p>
                </div>
                <div>
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
                  <p class="mt-1 text-xs text-gray-500">
                    Off keeps the domain and its history but leaves it out of the background check.
                  </p>
                </div>
                <!-- Applies on change rather than with the Save button below: it is a separate
                     decision from the check settings, and the plan underneath has to be re-read. -->
                <div>
                  <label for="dns-account" class="block text-sm font-medium text-gray-700 mb-1">
                    DNS account
                  </label>
                  <select
                    id="dns-account"
                    v-model="edit.dnsAccountId"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:text-gray-500"
                    :disabled="savingDnsAccount || orgDnsAccountsLoading || !detail.domain.organization"
                    @change="saveDnsAccount"
                  >
                    <option value="">
                      Auto — any enabled account of the organisation
                    </option>
                    <option
                      v-for="account in offerableDnsAccounts"
                      :key="account.id"
                      :value="account.id"
                    >
                      {{ account.label }} ({{ account.provider }}{{ account.enabled ? '' : ', disabled' }})
                    </option>
                  </select>
                  <p class="mt-1 text-xs text-gray-500">
                    Which credentials the DNS records panel reads and writes this domain's zone
                    with. Auto prefers a Cloudflare account and falls back to the instance
                    credentials in Settings → DNS when the organisation has none.
                  </p>
                  <p
                    v-if="!detail.domain.organization"
                    class="mt-1 text-xs text-warning-700"
                  >
                    This domain has no organisation yet, so there is no account to assign it to.
                  </p>
                  <p
                    v-else-if="!orgDnsAccountsLoading && enabledDnsAccounts.length === 0"
                    class="mt-1 text-xs text-gray-500"
                  >
                    This organisation has no enabled DNS account yet. Add one under
                    Organisation → DNS accounts.
                  </p>
                  <p v-if="savingDnsAccount" class="mt-1 text-xs text-gray-500">Saving…</p>
                </div>
                <div>
                  <label for="domain-notes" class="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    id="domain-notes"
                    v-model="edit.notes"
                    rows="2"
                    placeholder="Mailjet signs this domain"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  ></textarea>
                  <p class="mt-1 text-xs text-gray-500">
                    Free text for you — for example which provider signs this domain. It is shown
                    beside the domain in the list; nothing reads it automatically.
                  </p>
                </div>
                <div class="flex items-center space-x-3">
                  <button
                    class="btn btn-primary text-sm"
                    :disabled="savingEdit"
                    :class="{ 'opacity-50 cursor-not-allowed': savingEdit }"
                    @click="saveEdit"
                  >
                    {{ savingEdit ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- What has to be published for reports to arrive, and (admins) what this instance
             would change in the zone. Kept apart from the check results: the ingest address is
             the half of DMARC that lives in DNS but never shows up in a report. -->
        <div class="grid grid-cols-1 gap-6" :class="{ 'lg:grid-cols-3': isOrgAdmin }">
          <div class="card" :class="{ 'lg:col-span-1': isOrgAdmin }">
            <div class="card-header">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h3 class="text-lg leading-6 font-medium text-gray-900">Ingest address</h3>
                  <p class="mt-1 text-sm text-gray-500">
                    What a domain owner publishes so reports reach this instance
                  </p>
                </div>
                <StatusBadge
                  v-if="ingest"
                  :status="ingest.verified ? 'verified' : 'unverified'"
                  :label="ingest.verified ? 'Receiving' : 'No reports yet'"
                  icon
                />
              </div>
            </div>
            <div class="card-body space-y-3">
              <p v-if="ingestLoading && !ingest" class="text-sm text-gray-500">Loading…</p>
              <p v-else-if="ingestError" class="text-sm text-danger-700">{{ ingestError }}</p>
              <template v-else-if="ingest">
                <div
                  v-for="entry in ingestEntries"
                  :key="entry.key"
                  class="group flex items-start gap-2"
                >
                  <span
                    class="w-9 shrink-0 pt-0.5 text-xs font-medium uppercase tracking-wider text-gray-500"
                  >
                    {{ entry.key }}
                  </span>
                  <code
                    v-if="entry.value"
                    class="min-w-0 flex-1 break-all font-mono text-xs text-gray-700"
                    >{{ entry.value }}</code
                  >
                  <span v-else class="min-w-0 flex-1 text-xs text-gray-400">not configured</span>
                  <CopyButton
                    v-if="entry.value"
                    :value="entry.value"
                    :label="`${entry.key} address`"
                  />
                </div>

                <p class="text-sm text-gray-600">
                  <span class="nums font-medium text-gray-900">{{ ingest.reports30d ?? 0 }}</span>
                  report(s) in the last 30 days · last report
                  {{ formatRelative(ingest.lastReportAt) }}
                </p>

                <p
                  v-if="!ingest.configured"
                  class="rounded-md bg-warning-50 p-3 text-xs text-warning-800"
                >
                  No mailbox address is configured for this instance, so there is nothing to publish
                  yet. Set it under Settings → Mailbox.
                </p>

                <p class="text-xs text-gray-500">
                  Publish it as <code class="font-mono">rua=mailto:…</code> in the domain's
                  <code class="font-mono">_dmarc</code> TXT record. The counts only move once a report
                  for this domain actually arrives.
                </p>
              </template>
            </div>
          </div>

          <!-- Admin only: it reads and writes the provider's zone, which is a change outside this
               app. The plan is read on demand, not on every selection, because each read is
               several Cloudflare round-trips. -->
          <div v-if="isOrgAdmin" class="card lg:col-span-2">
            <div class="card-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 class="text-lg leading-6 font-medium text-gray-900">DNS records</h3>
                <p class="mt-1 text-sm text-gray-500">
                  What this instance would publish for {{ detail.domain.name }} through the
                  configured DNS provider (Cloudflare or Loopia). Nothing is written until you
                  press Apply.
                </p>
              </div>
              <button class="btn btn-secondary text-sm" :disabled="dnsLoading" @click="loadDnsPlan">
                {{ dnsLoading ? 'Reading zone…' : dnsPlan ? 'Re-check zone' : 'Check zone' }}
              </button>
            </div>

            <div class="card-body space-y-4">
              <p v-if="dnsError" class="rounded-md bg-danger-50 p-3 text-sm text-danger-700">
                {{ dnsError }}
              </p>
              <p v-else-if="dnsLoading && !dnsPlan" class="text-sm text-gray-500">
                Reading the zone from Cloudflare…
              </p>
              <p v-else-if="!dnsPlan" class="text-sm text-gray-500">
                The plan is read from the provider on demand: press
                <span class="font-medium">Check zone</span> to compare what is published with the
                suggested records. This needs a Cloudflare token or Loopia credentials in
                Settings → dns.
              </p>

              <template v-if="dnsPlan">
                <ul
                  v-if="(dnsPlan.warnings ?? []).length"
                  class="list-inside list-disc rounded-md bg-warning-50 p-3"
                >
                  <li
                    v-for="(warning, index) in dnsPlan.warnings"
                    :key="index"
                    class="text-xs text-warning-800"
                  >
                    {{ warning }}
                  </li>
                </ul>

                <p class="text-xs text-gray-500">
                  Provider <span class="font-medium capitalize">{{ dnsPlan.provider }}</span>
                  <span v-if="dnsPlan.account?.label">
                    · account <span class="font-medium">{{ dnsPlan.account.label }}</span>
                  </span>
                  <span v-if="dnsPlan.zone">
                    · zone <span class="font-mono">{{ dnsPlan.zone.name }}</span>
                  </span>
                  <span v-else>· no zone found, so nothing can be applied</span>
                </p>

                <div class="overflow-x-auto">
                  <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                      <tr>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Apply
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Record
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Type
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Name
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Value
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Published
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-200 bg-surface">
                      <tr v-for="record in dnsPlan.records" :key="record.key">
                        <td class="px-3 py-3 align-top">
                          <input
                            :id="`dns-key-${record.key}`"
                            type="checkbox"
                            class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            :checked="dnsSelected.includes(record.key)"
                            :disabled="!dnsSelectable(record) || dnsApplying"
                            :title="
                              dnsSelectable(record)
                                ? `Apply: ${record.action}`
                                : record.reason || 'This record cannot be applied here'
                            "
                            :aria-label="`Apply ${record.label || record.key}`"
                            @change="
                              toggleDnsKey(record.key, ($event.target as HTMLInputElement).checked)
                            "
                          />
                        </td>
                        <td class="px-3 py-3 align-top text-sm text-gray-900">
                          {{ record.label || record.key }}
                        </td>
                        <td class="px-3 py-3 align-top text-sm text-gray-600">
                          {{ record.type }}
                        </td>
                        <td class="px-3 py-3 align-top font-mono text-xs text-gray-700">
                          {{ record.name }}
                        </td>
                        <td class="px-3 py-3 align-top">
                          <code class="block max-w-md break-all font-mono text-xs text-gray-700">{{
                            record.value
                          }}</code>
                        </td>
                        <td class="px-3 py-3 align-top">
                          <p
                            v-if="(record.current ?? []).length === 0"
                            class="text-xs text-gray-400"
                          >
                            nothing published
                          </p>
                          <p
                            v-for="(current, index) in record.current ?? []"
                            :key="index"
                            class="max-w-md break-all font-mono text-xs text-gray-500"
                          >
                            {{ current }}
                          </p>
                        </td>
                        <td class="px-3 py-3 align-top">
                          <span class="badge" :class="dnsActionBadge(record.action)">
                            {{ dnsActionLabel(record.action) }}
                          </span>
                          <p v-if="record.reason" class="mt-1 max-w-xs text-xs text-gray-500">
                            {{ record.reason }}
                          </p>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div
                  class="flex flex-col gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <label class="inline-flex cursor-pointer items-center">
                      <input
                        v-model="dnsOverwrite"
                        type="checkbox"
                        class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        aria-describedby="dns-overwrite-hint"
                      />
                      <span class="ml-2 text-sm text-gray-700">Overwrite existing records</span>
                    </label>
                    <p id="dns-overwrite-hint" class="mt-1 max-w-lg text-xs text-gray-500">
                      Without it, only missing records are created and an existing one is skipped.
                      With it, the matching record is replaced — never anything else at the same
                      name.
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      class="btn btn-secondary text-sm"
                      :disabled="ruaAdding"
                      :class="{ 'opacity-50 cursor-not-allowed': ruaAdding }"
                      @click="addDmarcRua"
                    >
                      {{ ruaAdding ? 'Adding…' : 'Add rua to DMARC' }}
                    </button>
                    <button
                      class="btn btn-primary text-sm"
                      :disabled="dnsApplying || dnsSelected.length === 0"
                      :class="{ 'opacity-50 cursor-not-allowed': dnsApplying || dnsSelected.length === 0 }"
                      @click="applyDns"
                    >
                      {{ dnsApplying ? 'Applying…' : `Apply ${dnsSelected.length} record(s)` }}
                    </button>
                  </div>
                </div>

                <!-- The result is shown even after the plan is re-read, because "skipped" is the
                     answer an operator most needs to see. -->
                <div v-if="dnsResult" class="rounded-md bg-surface-muted p-3 text-sm">
                  <p class="font-medium text-gray-900">
                    {{ dnsResult.applied?.length ?? 0 }} applied,
                    {{ dnsResult.skipped?.length ?? 0 }} skipped
                  </p>
                  <ul class="mt-1 space-y-1">
                    <li
                      v-for="row in dnsResult.applied ?? []"
                      :key="`applied-${row.key}`"
                      class="text-xs text-gray-700"
                    >
                      <span class="badge badge-success mr-1">{{ row.action }}</span>
                      <span class="font-mono">{{ row.key }}</span>
                    </li>
                    <li
                      v-for="row in dnsResult.skipped ?? []"
                      :key="`skipped-${row.key}`"
                      class="text-xs text-gray-700"
                    >
                      <span class="badge badge-warning mr-1">{{ row.reason }}</span>
                      <span class="font-mono">{{ row.key }}</span>
                      <span v-if="currentText(row.current)" class="font-mono text-gray-500">
                        — {{ currentText(row.current) }}</span
                      >
                    </li>
                  </ul>
                </div>

                <div v-if="ruaResult" class="group rounded-md bg-surface-muted p-3">
                  <p class="text-xs text-gray-500">DMARC record now:</p>
                  <div class="flex items-start gap-2">
                    <code class="min-w-0 flex-1 break-all font-mono text-xs text-gray-700">{{
                      ruaResult.value
                    }}</code>
                    <CopyButton :value="ruaResult.value" label="DMARC record" />
                  </div>
                  <p v-if="ruaResult.previous" class="mt-1 break-all font-mono text-xs text-gray-400">
                    was: {{ ruaResult.previous }}
                  </p>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Read-only for everyone, admin or not: it is advice about DNS, not a change to this app. -->
        <RecordSuggestionsPanel
          :key="detail.domain.id"
          :domain-id="detail.domain.id"
          :domain-name="detail.domain.name"
        />
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
import RecordSuggestionsPanel from '@/components/RecordSuggestionsPanel.vue';
import Sparkline from '@/components/Sparkline.vue';
import { dnsAccountsApi, domainsApi } from '@/api/client';
import { useAsyncData } from '@/composables/useApi';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';
import { useQueryFilters } from '@/composables/useQueryFilters';
import type {
  DmarcRuaResult,
  DnsAccount,
  DnsApplyResult,
  DnsPlan,
  DnsPlanRecord,
  DomainCheckResult,
  DomainCheckStatus,
  DomainDetail,
  DomainHealthSummary,
  DomainSummary,
  IngestInfo,
} from '@/types/api';

const { isOrgAdmin } = useAuth();
const toast = useToast();

const columns = [
  { key: 'name', label: 'Domain' },
  { key: 'organization', label: 'Organisation' },
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

/** The status scale, in the order a reader meets it. Plain words, because no badge can say
 *  on its own that `info` is a nudge and `skipped` is not a fault. */
const STATUS_LEGEND: Array<{ status: DomainCheckStatus; text: string }> = [
  { status: 'ok', text: 'published and correct' },
  { status: 'warn', text: 'works, but weaker than recommended' },
  { status: 'error', text: 'broken, or missing where it is required' },
  { status: 'info', text: 'optional record that is not published — a nudge, not a fault' },
  {
    status: 'skipped',
    text: 'not checked, because something it needs is missing (e.g. no DKIM selectors configured)',
  },
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

const edit = reactive({
  dkimSelectors: '',
  expectedMx: '',
  monitored: true,
  notes: '',
  /** Empty string is "Auto": the server resolves the organisation's enabled accounts. */
  dnsAccountId: '',
});

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
    edit.notes = result.domain.notes ?? '';
    edit.dnsAccountId = result.domain.dnsAccount?.id ?? '';
    void loadOrgDnsAccounts(result.domain.organization?.id ?? null);

    // The ingest and DNS panels describe the domain, not the last check, so a re-run of the
    // check does not have to throw the loaded plan away - only a different domain does.
    if (dnsPlanDomain.value !== result.domain.name) {
      resetDnsPanel();
      dnsPlanDomain.value = result.domain.name;
    }
    void loadIngest(result.domain.name);
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

// ------------------------------------------------------------------ ingest address
const ingest = ref<IngestInfo | null>(null);
const ingestLoading = ref(false);
const ingestError = ref<string | null>(null);

const loadIngest = async (name: string) => {
  ingestLoading.value = true;
  ingestError.value = null;

  try {
    ingest.value = await domainsApi.ingest(name);
  } catch (err) {
    ingest.value = null;
    ingestError.value = err instanceof Error ? err.message : 'Could not read the ingest address';
  } finally {
    ingestLoading.value = false;
  }
};

/** Only the addresses the instance actually has; a missing ruf is normal, not an error. */
const ingestEntries = computed(() =>
  [
    { key: 'rua', value: ingest.value?.rua ?? '' },
    { key: 'ruf', value: ingest.value?.ruf ?? '' },
  ]
);

// ------------------------------------------------------------------ DNS accounts (organisation)
// The selector and the plan are both org-scoped now: a domain publishes through one of its
// organisation's accounts, or through the instance credentials when the org has none.
const orgDnsAccounts = ref<DnsAccount[]>([]);
const orgDnsAccountsLoading = ref(false);
const savingDnsAccount = ref(false);

const enabledDnsAccounts = computed(() => orgDnsAccounts.value.filter((account) => account.enabled));

/**
 * What the selector offers: every enabled account, plus the one already assigned even if it has
 * since been disabled. Leaving that one out would show "Auto" for a domain that is pinned to it,
 * which is the opposite of what the server would do.
 */
const offerableDnsAccounts = computed(() => {
  const assignedId = detail.value?.domain.dnsAccount?.id ?? null;
  return orgDnsAccounts.value.filter((account) => account.enabled || account.id === assignedId);
});

/**
 * Only an org admin can read the organisation's accounts, and only an org admin is offered the
 * selector, so a viewer never triggers this at all.
 */
const loadOrgDnsAccounts = async (organizationId: string | null) => {
  orgDnsAccounts.value = [];
  if (!organizationId || !isOrgAdmin.value) return;

  orgDnsAccountsLoading.value = true;
  try {
    orgDnsAccounts.value = await dnsAccountsApi.list(organizationId);
  } catch (err) {
    orgDnsAccounts.value = [];
    toast.error(err instanceof Error ? err.message : 'Could not load the organisation DNS accounts');
  } finally {
    orgDnsAccountsLoading.value = false;
  }
};

/**
 * Assigning an account is its own request, not part of the settings Save: the plan below is read
 * with that account, so both the plan and the list have to be re-read as soon as it changes.
 */
const saveDnsAccount = async () => {
  const current = detail.value;
  if (!current || savingDnsAccount.value) return;

  savingDnsAccount.value = true;
  const nextId = edit.dnsAccountId || null;

  try {
    const updated = await domainsApi.update(current.domain.id, { dnsAccountId: nextId });
    detail.value = { ...current, domain: updated };
    edit.dnsAccountId = updated.dnsAccount?.id ?? '';
    toast.success(nextId ? 'DNS account assigned' : 'DNS account set to automatic');
    // The loaded plan describes the previous account; it cannot be shown as if it still applied.
    resetDnsPanel();
    dnsPlanDomain.value = null;
    await load();
    void loadOrgDnsAccounts(updated.organization?.id ?? null);
  } catch (err) {
    // Put the select back on the stored value: the request was refused, nothing changed.
    edit.dnsAccountId = current.domain.dnsAccount?.id ?? '';
    toast.error(err instanceof Error ? err.message : 'Could not assign the DNS account');
  } finally {
    savingDnsAccount.value = false;
  }
};

// ------------------------------------------------------------------ DNS plan (Cloudflare)
const dnsPlan = ref<DnsPlan | null>(null);
const dnsPlanDomain = ref<string | null>(null);
const dnsLoading = ref(false);
const dnsError = ref<string | null>(null);
const dnsApplying = ref(false);
const dnsSelected = ref<string[]>([]);
const dnsOverwrite = ref(false);
const dnsResult = ref<DnsApplyResult | null>(null);
const ruaAdding = ref(false);
const ruaResult = ref<DmarcRuaResult | null>(null);

const resetDnsPanel = () => {
  dnsPlan.value = null;
  dnsError.value = null;
  dnsResult.value = null;
  ruaResult.value = null;
  dnsSelected.value = [];
  dnsOverwrite.value = false;
};

/** Only these two can be written; `unchanged` needs nothing and `unsupported` must not be sent. */
const dnsSelectable = (record: DnsPlanRecord): boolean =>
  record.action === 'create' || record.action === 'update';

const DNS_ACTION_LABELS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  unchanged: 'Unchanged',
  unsupported: 'Unsupported',
};

const dnsActionLabel = (action: string): string => DNS_ACTION_LABELS[action] ?? action;

const dnsActionBadge = (action: string): string => {
  if (action === 'create') return 'badge-success';
  if (action === 'update') return 'badge-warning';
  if (action === 'unsupported') return 'badge-danger';
  return 'badge-gray';
};

const toggleDnsKey = (key: string, checked: boolean) => {
  const next = new Set(dnsSelected.value);
  if (checked) {
    next.add(key);
  } else {
    next.delete(key);
  }
  dnsSelected.value = [...next];
};

const currentText = (current: string | string[] | null | undefined): string => {
  if (!current) return '';
  return Array.isArray(current) ? current.join(', ') : current;
};

const loadDnsPlan = async () => {
  const current = detail.value;
  if (!current) return;

  dnsLoading.value = true;
  dnsError.value = null;
  dnsResult.value = null;

  try {
    const plan = await domainsApi.dnsPlan(current.domain.name);
    dnsPlan.value = plan;
    // Preselect what Apply can actually do, so the common case is one click.
    dnsSelected.value = (plan.records ?? []).filter(dnsSelectable).map((record) => record.key);
  } catch (err) {
    dnsPlan.value = null;
    dnsSelected.value = [];
    dnsError.value = err instanceof Error ? err.message : 'Could not read the DNS plan';
  } finally {
    dnsLoading.value = false;
  }
};

const applyDns = async () => {
  const current = detail.value;
  if (!current || dnsSelected.value.length === 0) return;

  dnsApplying.value = true;
  dnsError.value = null;

  try {
    const result = await domainsApi.dnsApply(current.domain.name, {
      keys: [...dnsSelected.value],
      overwrite: dnsOverwrite.value,
    });
    const applied = result.applied?.length ?? 0;
    const skipped = result.skipped?.length ?? 0;
    const message = `${applied} record(s) applied, ${skipped} skipped`;
    if (skipped > 0) {
      toast.error(message);
    } else {
      toast.success(message);
    }

    // Re-read the zone so the table reflects what is published now, then show the run report.
    await loadDnsPlan();
    dnsResult.value = result;
  } catch (err) {
    dnsError.value = err instanceof Error ? err.message : 'Could not apply the records';
  } finally {
    dnsApplying.value = false;
  }
};

const addDmarcRua = async () => {
  const current = detail.value;
  if (!current) return;

  ruaAdding.value = true;
  dnsError.value = null;

  try {
    ruaResult.value = await domainsApi.dmarcRua(current.domain.name);
    toast.success('rua= added to the DMARC record');
    // The ingest card and the plan both change: the published value is what rua= is for.
    await Promise.all([loadDnsPlan(), loadIngest(current.domain.name)]);
  } catch (err) {
    dnsError.value = err instanceof Error ? err.message : 'Could not add the rua address';
  } finally {
    ruaAdding.value = false;
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
      // Sent even when empty, because a cleared box means "remove the note", not "keep it".
      notes: edit.notes.trim(),
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
  const confirmed = window.confirm(
    `Remove ${name} from monitoring?\n\n` +
      'Its check history is deleted. DMARC, forensic and TLS reports already ingested are kept - ' +
      'only the monitoring entry and its DNS check results go.',
  );
  if (!confirmed) return;

  removing.value = true;
  try {
    await domainsApi.remove(id);
    selectedId.value = null;
    detail.value = null;
    selection.domain = '';
    dnsPlanDomain.value = null;
    resetDnsPanel();
    ingest.value = null;
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
