<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader title="Organisation" :description="pageDescription">
      <template #actions>
        <button v-if="orgId" class="btn btn-secondary" :disabled="loadingAny" @click="loadAll">
          {{ loadingAny ? 'Refreshing…' : 'Refresh' }}
        </button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- A superadmin who is looking at "All organisations" has no tenant to administer, and
           the org endpoints need one. The switcher in the header is the way in. -->
      <div v-if="!orgId" class="card">
        <div class="card-body">
          <h2 class="text-lg leading-6 font-medium text-gray-900">Pick an organisation first</h2>
          <p class="mt-1 text-sm text-gray-500">
            Members, mailboxes and DNS accounts belong to one organisation. Choose one in the
            organisation switcher in the header, then come back to this page.
          </p>
          <p v-if="orgs.length === 0" class="mt-3 text-sm text-gray-500">
            This account is not a member of any organisation yet. An administrator has to add it
            to one.
          </p>
        </div>
      </div>

      <template v-else>
        <!-- ============================================================ members -->
        <div class="card">
          <div class="card-header flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 class="text-lg leading-6 font-medium text-gray-900">Members</h2>
              <p class="mt-1 text-sm text-gray-500">
                Who can read this organisation's reports, and who may also change things
              </p>
            </div>
            <span class="badge badge-gray shrink-0">{{ members.length }} member(s)</span>
          </div>

          <div class="overflow-x-auto">
            <table class="table">
              <thead class="table-header">
                <tr>
                  <th scope="col" class="table-header-cell">Member</th>
                  <th scope="col" class="table-header-cell">Role</th>
                  <th scope="col" class="table-header-cell">Joined</th>
                  <th scope="col" class="table-header-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="table-body">
                <template v-if="membersLoading">
                  <tr v-for="n in 3" :key="`member-loading-${n}`">
                    <td v-for="column in 4" :key="column" class="table-cell">
                      <div class="animate-pulse bg-gray-200 h-4 rounded"></div>
                    </td>
                  </tr>
                </template>
                <tr v-else-if="members.length === 0">
                  <td colspan="4" class="px-6 py-6 text-sm text-gray-500">
                    No members yet. Add the first one below.
                  </td>
                </tr>
                <tr v-for="member in members" v-else :key="member.userId">
                  <td class="table-cell">
                    <div class="font-medium text-gray-900">{{ member.email }}</div>
                    <div v-if="member.name" class="text-xs text-gray-500">{{ member.name }}</div>
                  </td>
                  <td class="table-cell">
                    <select
                      class="rounded-md border border-gray-300 bg-surface px-2 py-1 text-sm text-gray-700 focus:outline-hidden focus:ring-2 focus:ring-primary-500"
                      :value="member.role"
                      :disabled="busyMember === member.userId"
                      :aria-label="`Role of ${member.email}`"
                      @change="changeRole(member, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="admin">Admin</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </td>
                  <td class="table-cell nums text-gray-600">{{ formatDateTime(member.createdAt) }}</td>
                  <td class="table-cell text-right">
                    <button
                      type="button"
                      class="btn btn-secondary text-xs text-danger-700"
                      :disabled="busyMember === member.userId"
                      @click="removeMember(member)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card-body space-y-4 border-t border-gray-200">
            <div>
              <h3 class="text-sm font-medium text-gray-900">Add a member</h3>
              <p class="mt-1 text-xs text-gray-500">
                An existing account is attached to this organisation. An address without an account
                needs a name and a password; that person is asked to change the password on first
                sign-in.
              </p>
            </div>

            <div v-if="memberError" class="rounded-md bg-danger-50 p-3">
              <p class="text-sm text-danger-700">{{ memberError }}</p>
            </div>

            <form class="grid grid-cols-1 gap-4 md:grid-cols-2" @submit.prevent="addMember">
              <div>
                <label for="member-email" class="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  id="member-email"
                  v-model="memberForm.email"
                  type="email"
                  required
                  autocomplete="off"
                  placeholder="colleague@example.com"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="member-role" class="block text-sm font-medium text-gray-700 mb-1">
                  Role
                </label>
                <select
                  id="member-role"
                  v-model="memberForm.role"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="viewer">Viewer — read only</option>
                  <option value="admin">Admin — can change settings and members</option>
                </select>
              </div>
              <div>
                <label for="member-name" class="block text-sm font-medium text-gray-700 mb-1">
                  Name <span class="font-normal text-gray-500">(new accounts only)</span>
                </label>
                <input
                  id="member-name"
                  v-model="memberForm.name"
                  type="text"
                  autocomplete="off"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="member-password" class="block text-sm font-medium text-gray-700 mb-1">
                  Password <span class="font-normal text-gray-500">(new accounts only)</span>
                </label>
                <input
                  id="member-password"
                  v-model="memberForm.password"
                  type="password"
                  autocomplete="new-password"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>

              <div class="md:col-span-2 flex justify-end">
                <button type="submit" class="btn btn-primary" :disabled="addingMember">
                  {{ addingMember ? 'Adding…' : 'Add member' }}
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- ============================================================ mailboxes -->
        <div class="card">
          <div class="card-header flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 class="text-lg leading-6 font-medium text-gray-900">Mailboxes</h2>
              <p class="mt-1 text-sm text-gray-500">
                The IMAP mailboxes this organisation's reports are fetched from
              </p>
            </div>
            <span class="badge badge-gray shrink-0">
              {{ mailboxes.filter((row) => row.enabled).length }} enabled of {{ mailboxes.length }}
            </span>
          </div>

          <div class="overflow-x-auto">
            <table class="table">
              <thead class="table-header">
                <tr>
                  <th scope="col" class="table-header-cell">Mailbox</th>
                  <th scope="col" class="table-header-cell">Status</th>
                  <th scope="col" class="table-header-cell">Last run</th>
                  <th scope="col" class="table-header-cell">Password</th>
                  <th scope="col" class="table-header-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="table-body">
                <template v-if="mailboxesLoading">
                  <tr v-for="n in 3" :key="`mailbox-loading-${n}`">
                    <td v-for="column in 5" :key="column" class="table-cell">
                      <div class="animate-pulse bg-gray-200 h-4 rounded"></div>
                    </td>
                  </tr>
                </template>
                <tr v-else-if="mailboxes.length === 0">
                  <td colspan="5" class="px-6 py-6 text-sm text-gray-500">
                    No mailbox yet. Until one is added, this organisation receives no reports.
                  </td>
                </tr>
                <tr v-for="mailbox in mailboxes" v-else :key="mailbox.id">
                  <td class="table-cell align-top">
                    <div class="font-medium text-gray-900">{{ mailbox.label }}</div>
                    <div class="font-mono text-xs text-gray-500">
                      {{ mailbox.user }} @ {{ mailbox.host }}:{{ mailbox.port }}
                    </div>
                    <p v-if="mailbox.lastError" class="mt-1 max-w-md whitespace-normal text-xs text-danger-700">
                      {{ mailbox.lastError }}
                    </p>
                  </td>
                  <td class="table-cell align-top">
                    <StatusBadge
                      :status="mailbox.enabled ? 'active' : 'disabled'"
                      :label="mailbox.enabled ? 'Enabled' : 'Disabled'"
                    />
                    <div class="mt-1 text-xs text-gray-500">
                      {{ mailbox.verifyTls ? 'TLS verified' : 'TLS not verified' }}
                    </div>
                  </td>
                  <td class="table-cell align-top nums text-gray-600">
                    {{ formatRelative(mailbox.lastRunAt) }}
                  </td>
                  <td class="table-cell align-top">
                    <span v-if="mailbox.passwordSet" class="badge badge-success">stored</span>
                    <span v-else class="badge badge-warning">not set</span>
                  </td>
                  <td class="table-cell align-top text-right">
                    <div class="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        class="btn btn-secondary text-xs"
                        :disabled="testingMailboxId === mailbox.id"
                        @click="testMailbox(mailbox)"
                      >
                        {{ testingMailboxId === mailbox.id ? 'Testing…' : 'Test connection' }}
                      </button>
                      <button type="button" class="btn btn-secondary text-xs" @click="startMailboxEdit(mailbox)">
                        Edit
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary text-xs text-danger-700"
                        @click="removeMailbox(mailbox)"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- A refused connection is a result, not an error: it stays on the page instead of
               disappearing with a toast. -->
          <div v-if="mailboxTest" class="border-t border-gray-200 bg-surface-muted px-4 py-3 sm:px-6">
            <div class="flex items-start justify-between gap-3">
              <p
                class="text-sm"
                :class="mailboxTest.result.ok ? 'text-success-800' : 'text-danger-800'"
              >
                <span class="font-medium">{{ mailboxTest.label }}:</span>
                {{ mailboxTest.result.message || (mailboxTest.result.ok ? 'Connected' : 'Connection failed') }}
              </p>
              <button type="button" class="btn btn-secondary text-xs" @click="mailboxTest = null">
                Close
              </button>
            </div>
          </div>

          <div class="card-body space-y-4 border-t border-gray-200">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 class="text-sm font-medium text-gray-900">
                  {{ editingMailboxId ? `Edit ${mailboxForm.label || 'mailbox'}` : 'Add a mailbox' }}
                </h3>
                <p class="mt-1 text-xs text-gray-500">
                  The password is stored on the server and never sent back. Leaving the field blank
                  keeps the one that is already stored.
                </p>
              </div>
              <button
                v-if="editingMailboxId"
                type="button"
                class="btn btn-secondary text-xs shrink-0"
                @click="resetMailboxForm"
              >
                Cancel
              </button>
            </div>

            <p v-if="mailboxError" class="rounded-md bg-danger-50 p-3 text-sm text-danger-700">
              {{ mailboxError }}
            </p>

            <form class="grid grid-cols-1 gap-4 md:grid-cols-2" @submit.prevent="saveMailbox">
              <div>
                <label for="mailbox-label" class="block text-sm font-medium text-gray-700 mb-1">
                  Label
                </label>
                <input
                  id="mailbox-label"
                  v-model="mailboxForm.label"
                  type="text"
                  required
                  placeholder="DMARC reports"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="mailbox-host" class="block text-sm font-medium text-gray-700 mb-1">
                  IMAP host
                </label>
                <input
                  id="mailbox-host"
                  v-model="mailboxForm.host"
                  type="text"
                  required
                  placeholder="imap.example.com"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="mailbox-port" class="block text-sm font-medium text-gray-700 mb-1">
                  Port
                </label>
                <input
                  id="mailbox-port"
                  v-model.number="mailboxForm.port"
                  type="number"
                  min="1"
                  max="65535"
                  required
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="mailbox-user" class="block text-sm font-medium text-gray-700 mb-1">
                  Username
                </label>
                <input
                  id="mailbox-user"
                  v-model="mailboxForm.user"
                  type="text"
                  required
                  autocomplete="off"
                  placeholder="dmarc@example.com"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="mailbox-password" class="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  id="mailbox-password"
                  v-model="mailboxForm.password"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="mailboxPasswordPlaceholder"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div class="flex flex-col justify-center gap-2">
                <label class="inline-flex items-center cursor-pointer">
                  <input
                    v-model="mailboxForm.verifyTls"
                    type="checkbox"
                    class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <span class="ml-2 text-sm text-gray-700">Verify the TLS certificate</span>
                </label>
                <label class="inline-flex items-center cursor-pointer">
                  <input
                    v-model="mailboxForm.enabled"
                    type="checkbox"
                    class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <span class="ml-2 text-sm text-gray-700">Enabled for the scheduled run</span>
                </label>
              </div>

              <div
                v-if="mailboxFormTest"
                class="md:col-span-2 rounded-md p-3"
                :class="mailboxFormTest.ok ? 'bg-success-50' : 'bg-danger-50'"
              >
                <p
                  class="text-sm"
                  :class="mailboxFormTest.ok ? 'text-success-800' : 'text-danger-800'"
                >
                  <span class="font-medium">
                    {{ mailboxFormTest.ok ? 'Connected' : 'Connection failed' }}:
                  </span>
                  {{ mailboxFormTest.message }}
                </p>
                <p v-if="mailboxFormTest.greeting" class="mt-1 break-all font-mono text-xs text-gray-600">
                  {{ mailboxFormTest.greeting }}
                </p>
              </div>

              <div class="md:col-span-2 flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  class="btn btn-secondary"
                  :disabled="testingMailboxForm"
                  @click="testMailboxForm"
                >
                  {{ testingMailboxForm ? 'Testing…' : 'Test connection' }}
                </button>
                <button type="submit" class="btn btn-primary" :disabled="savingMailbox">
                  {{ savingMailbox ? 'Saving…' : editingMailboxId ? 'Save changes' : 'Add mailbox' }}
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- ============================================================ hosted addresses -->
        <!-- A plus alias on a mailbox the organisation already ingests: no MX, no catch-all and
             no DNS work. The API generates the address; the admin only names it. -->
        <div class="card">
          <div class="card-header flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 class="text-lg leading-6 font-medium text-gray-900">Hosted addresses</h2>
              <p class="mt-1 text-sm text-gray-500">
                Each one is a plus alias on a mailbox this organisation already ingests
                (<span class="font-mono">dmarc+&lt;token&gt;@example.com</span>), so it needs no MX
                or catch-all and no DNS work — publish it as <span class="font-mono">rua=</span> and
                reports are routed by the token in the address.
              </p>
            </div>
            <span class="badge badge-gray shrink-0">
              {{ hostedAddresses.filter((row) => row.enabled).length }} enabled of
              {{ hostedAddresses.length }}
            </span>
          </div>

          <div class="overflow-x-auto">
            <table class="table">
              <thead class="table-header">
                <tr>
                  <th scope="col" class="table-header-cell">Address</th>
                  <th scope="col" class="table-header-cell">Base mailbox</th>
                  <th scope="col" class="table-header-cell">Last report</th>
                  <th scope="col" class="table-header-cell">Status</th>
                  <th scope="col" class="table-header-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="table-body">
                <template v-if="hostedLoading">
                  <tr v-for="n in 2" :key="`hosted-loading-${n}`">
                    <td v-for="column in 5" :key="column" class="table-cell">
                      <div class="animate-pulse bg-gray-200 h-4 rounded"></div>
                    </td>
                  </tr>
                </template>
                <tr v-else-if="hostedAddresses.length === 0">
                  <td colspan="5" class="px-6 py-6 text-sm text-gray-500">
                    No hosted address yet. Add one below and publish it as the domain's
                    <span class="font-mono">rua=</span> target.
                  </td>
                </tr>
                <tr v-for="hosted in hostedAddresses" v-else :key="hosted.id">
                  <td class="table-cell align-top">
                    <div class="font-medium text-gray-900">{{ hosted.label }}</div>
                    <div class="group flex items-center gap-1">
                      <code class="break-all font-mono text-xs text-gray-600">{{ hosted.address }}</code>
                      <CopyButton :value="hosted.address" label="hosted address" />
                    </div>
                  </td>
                  <td class="table-cell align-top text-sm text-gray-700">
                    <template v-if="hosted.baseMailbox">{{ hosted.baseMailbox.label }}</template>
                    <span v-else class="text-gray-500">Legacy settings</span>
                  </td>
                  <td class="table-cell align-top nums text-gray-600">
                    {{ hosted.lastReportAt ? formatRelative(hosted.lastReportAt) : 'not receiving yet' }}
                  </td>
                  <td class="table-cell align-top">
                    <div class="flex flex-col gap-1">
                      <StatusBadge
                        :status="hosted.enabled ? 'active' : 'disabled'"
                        :label="hosted.enabled ? 'Enabled' : 'Disabled'"
                      />
                      <label class="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          :checked="hosted.enabled"
                          :disabled="busyHostedId === hosted.id"
                          :aria-label="`Enable ${hosted.label}`"
                          @change="
                            toggleHostedAddress(
                              hosted,
                              ($event.target as HTMLInputElement).checked
                            )
                          "
                        />
                        <span class="text-xs text-gray-600">
                          {{ busyHostedId === hosted.id ? 'Saving…' : 'Enabled' }}
                        </span>
                      </label>
                    </div>
                  </td>
                  <td class="table-cell align-top text-right">
                    <button
                      type="button"
                      class="btn btn-secondary text-xs text-danger-700"
                      :disabled="busyHostedId === hosted.id"
                      @click="removeHostedAddress(hosted)"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card-body space-y-4 border-t border-gray-200">
            <div>
              <h3 class="text-sm font-medium text-gray-900">Add a hosted address</h3>
              <p class="mt-1 text-xs text-gray-500">
                The address itself is generated from the base mailbox's domain, so a mailbox has to
                exist first. Leaving the base on automatic uses the first enabled mailbox.
              </p>
            </div>

            <p v-if="hostedError" class="rounded-md bg-danger-50 p-3 text-sm text-danger-700">
              {{ hostedError }}
            </p>

            <div
              v-if="!mailboxesLoading && enabledMailboxCount === 0"
              class="rounded-md bg-warning-50 p-3 text-xs text-warning-800"
            >
              This organisation has no enabled mailbox, so an alias has no mailbox to be delivered
              into. Add and enable a mailbox above first; only the Default organisation can fall
              back to the legacy mailbox configured in Settings → Mailbox.
            </div>

            <form class="grid grid-cols-1 gap-4 md:grid-cols-2" @submit.prevent="addHostedAddress">
              <div>
                <label for="hosted-label" class="block text-sm font-medium text-gray-700 mb-1">
                  Label
                </label>
                <input
                  id="hosted-label"
                  v-model="hostedForm.label"
                  type="text"
                  required
                  placeholder="DMARC reports — example.com"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="hosted-base" class="block text-sm font-medium text-gray-700 mb-1">
                  Base mailbox <span class="font-normal text-gray-500">(optional)</span>
                </label>
                <select
                  id="hosted-base"
                  v-model="hostedForm.baseMailboxId"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Automatic — first enabled mailbox</option>
                  <option v-for="mailbox in mailboxes" :key="mailbox.id" :value="mailbox.id">
                    {{ mailbox.label }} — {{ mailbox.user }}{{ mailbox.enabled ? '' : ' (disabled)' }}
                  </option>
                </select>
              </div>

              <div class="md:col-span-2 flex justify-end">
                <button type="submit" class="btn btn-primary" :disabled="addingHosted">
                  {{ addingHosted ? 'Adding…' : 'Add hosted address' }}
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- ============================================================ DNS accounts -->
        <div class="card">
          <div class="card-header flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 class="text-lg leading-6 font-medium text-gray-900">DNS accounts</h2>
              <p class="mt-1 text-sm text-gray-500">
                Provider credentials this organisation's domains can publish their records with
              </p>
            </div>
            <span class="badge badge-gray shrink-0">{{ dnsAccounts.length }} account(s)</span>
          </div>

          <div class="overflow-x-auto">
            <table class="table">
              <thead class="table-header">
                <tr>
                  <th scope="col" class="table-header-cell">Account</th>
                  <th scope="col" class="table-header-cell">Provider</th>
                  <th scope="col" class="table-header-cell">Status</th>
                  <th scope="col" class="table-header-cell">Credentials</th>
                  <th scope="col" class="table-header-cell">Domains</th>
                  <th scope="col" class="table-header-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="table-body">
                <template v-if="dnsLoading">
                  <tr v-for="n in 3" :key="`dns-loading-${n}`">
                    <td v-for="column in 6" :key="column" class="table-cell">
                      <div class="animate-pulse bg-gray-200 h-4 rounded"></div>
                    </td>
                  </tr>
                </template>
                <tr v-else-if="dnsAccounts.length === 0">
                  <td colspan="6" class="px-6 py-6 text-sm text-gray-500">
                    No DNS account yet. Domains of this organisation fall back to the instance
                    credentials in Settings → DNS.
                  </td>
                </tr>
                <tr v-for="account in dnsAccounts" v-else :key="account.id">
                  <td class="table-cell">
                    <div class="font-medium text-gray-900">{{ account.label }}</div>
                  </td>
                  <td class="table-cell capitalize text-gray-600">{{ account.provider }}</td>
                  <td class="table-cell">
                    <StatusBadge
                      :status="account.enabled ? 'active' : 'disabled'"
                      :label="account.enabled ? 'Enabled' : 'Disabled'"
                    />
                  </td>
                  <td class="table-cell">
                    <span v-if="account.credentialSet" class="badge badge-success">stored</span>
                    <span v-else class="badge badge-warning">not set</span>
                  </td>
                  <td class="table-cell nums text-gray-600">{{ account.domainCount ?? 0 }}</td>
                  <td class="table-cell text-right">
                    <div class="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        class="btn btn-secondary text-xs"
                        :disabled="verifyingAccountId === account.id"
                        @click="verifyAccount(account)"
                      >
                        {{ verifyingAccountId === account.id ? 'Verifying…' : 'Verify' }}
                      </button>
                      <button type="button" class="btn btn-secondary text-xs" @click="startDnsEdit(account)">
                        Edit
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary text-xs text-danger-700"
                        @click="removeAccount(account)"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="dnsVerification" class="border-t border-gray-200 bg-surface-muted px-4 py-3 sm:px-6">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p
                  class="text-sm"
                  :class="dnsVerification.result.ok ? 'text-success-800' : 'text-danger-800'"
                >
                  <span class="font-medium">{{ dnsVerification.label }}:</span>
                  {{ dnsVerification.result.ok ? 'Credentials accepted' : 'Credentials refused' }}
                  <span v-if="dnsVerification.result.message">
                    — {{ dnsVerification.result.message }}
                  </span>
                </p>
                <div v-if="(dnsVerification.result.visible ?? []).length" class="mt-2">
                  <p class="text-xs font-medium text-gray-700">
                    Visible at the provider ({{ (dnsVerification.result.visible ?? []).length }}):
                  </p>
                  <p class="mt-1 break-all font-mono text-xs text-gray-600">
                    {{ (dnsVerification.result.visible ?? []).join(', ') }}
                  </p>
                </div>
                <p
                  v-else-if="dnsVerification.result.ok"
                  class="mt-2 text-xs text-gray-600"
                >
                  The credentials work, but no zone or domain is visible to them.
                </p>
              </div>
              <button type="button" class="btn btn-secondary text-xs" @click="dnsVerification = null">
                Close
              </button>
            </div>
          </div>

          <div class="card-body space-y-4 border-t border-gray-200">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 class="text-sm font-medium text-gray-900">
                  {{ editingAccountId ? `Edit ${accountForm.label || 'DNS account'}` : 'Add a DNS account' }}
                </h3>
                <p class="mt-1 text-xs text-gray-500">
                  Cloudflare needs an API token; Loopia needs the API user and password. Credentials
                  are stored on the server and never sent back, so blank means "keep the stored ones".
                  The provider cannot be changed afterwards.
                </p>
              </div>
              <button
                v-if="editingAccountId"
                type="button"
                class="btn btn-secondary text-xs shrink-0"
                @click="resetAccountForm"
              >
                Cancel
              </button>
            </div>

            <p v-if="accountError" class="rounded-md bg-danger-50 p-3 text-sm text-danger-700">
              {{ accountError }}
            </p>

            <form class="grid grid-cols-1 gap-4 md:grid-cols-2" @submit.prevent="saveAccount">
              <div>
                <label for="dns-account-label" class="block text-sm font-medium text-gray-700 mb-1">
                  Label
                </label>
                <input
                  id="dns-account-label"
                  v-model="accountForm.label"
                  type="text"
                  required
                  placeholder="Cloudflare — example.com"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label for="dns-account-provider" class="block text-sm font-medium text-gray-700 mb-1">
                  Provider
                </label>
                <select
                  id="dns-account-provider"
                  v-model="accountForm.provider"
                  :disabled="!!editingAccountId"
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:text-gray-500"
                >
                  <option value="cloudflare">Cloudflare</option>
                  <option value="loopia">Loopia</option>
                </select>
                <p v-if="editingAccountId" class="mt-1 text-xs text-gray-500">
                  Fixed after creation, because the credential shape depends on it.
                </p>
              </div>

              <template v-if="accountForm.provider === 'cloudflare'">
                <div class="md:col-span-2">
                  <label for="dns-account-token" class="block text-sm font-medium text-gray-700 mb-1">
                    API token
                  </label>
                  <input
                    id="dns-account-token"
                    v-model="accountForm.token"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="accountSecretPlaceholder"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p class="mt-1 text-xs text-gray-500">
                    A token with <span class="font-mono">Zone.Zone:Read</span> and
                    <span class="font-mono">Zone.DNS:Edit</span> on the zone that holds the domain.
                  </p>
                </div>
              </template>
              <template v-else>
                <div>
                  <label for="dns-account-username" class="block text-sm font-medium text-gray-700 mb-1">
                    API username
                  </label>
                  <input
                    id="dns-account-username"
                    v-model="accountForm.username"
                    type="text"
                    autocomplete="off"
                    :placeholder="editingAccountId ? 'unchanged' : 'user@example.com'"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div>
                  <label for="dns-account-password" class="block text-sm font-medium text-gray-700 mb-1">
                    API password
                  </label>
                  <input
                    id="dns-account-password"
                    v-model="accountForm.password"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="accountSecretPlaceholder"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
              </template>

              <div class="md:col-span-2">
                <label class="inline-flex items-center cursor-pointer">
                  <input
                    v-model="accountForm.enabled"
                    type="checkbox"
                    class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <span class="ml-2 text-sm text-gray-700">
                    Enabled — a domain may be assigned to this account
                  </span>
                </label>
              </div>

              <div
                v-if="dnsFormTest"
                class="md:col-span-2 rounded-md p-3"
                :class="dnsFormTest.ok ? 'bg-success-50' : 'bg-danger-50'"
              >
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p
                      class="text-sm"
                      :class="dnsFormTest.ok ? 'text-success-800' : 'text-danger-800'"
                    >
                      <span class="font-medium">
                        {{ dnsFormTest.ok ? 'Credentials accepted' : 'Credentials refused' }}:
                      </span>
                      {{ dnsFormTest.message || (dnsFormTest.ok ? 'The provider answered' : 'The provider refused the credentials') }}
                    </p>
                    <div v-if="(dnsFormTest.visible ?? []).length" class="mt-2">
                      <p class="text-xs font-medium text-gray-700">
                        Visible at the provider ({{ (dnsFormTest.visible ?? []).length }}):
                      </p>
                      <p class="mt-1 break-all font-mono text-xs text-gray-600">
                        {{ (dnsFormTest.visible ?? []).join(', ') }}
                      </p>
                    </div>
                    <p v-else-if="dnsFormTest.ok" class="mt-2 text-xs text-gray-600">
                      The credentials work, but no zone or domain is visible to them.
                    </p>
                  </div>
                  <button type="button" class="btn btn-secondary text-xs" @click="dnsFormTest = null">
                    Close
                  </button>
                </div>
              </div>

              <div class="md:col-span-2 flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  class="btn btn-secondary"
                  :disabled="testingDnsForm"
                  @click="testAccountForm"
                >
                  {{ testingDnsForm ? 'Testing…' : 'Test & fetch hosts' }}
                </button>
                <button type="submit" class="btn btn-primary" :disabled="savingAccount">
                  {{ savingAccount ? 'Saving…' : editingAccountId ? 'Save changes' : 'Add account' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import CopyButton from '@/components/CopyButton.vue';
import { dnsAccountsApi, hostedAddressesApi, mailboxesApi, organizationsApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useToast } from '@/composables/useToast';
import type {
  DnsAccount,
  DnsAccountCredentials,
  DnsAccountProvider,
  DnsAccountTestResult,
  DnsAccountVerification,
  HostedAddress,
  MailboxTestResult,
  OrgMailbox,
  OrganizationMember,
} from '@/types/api';

const toast = useToast();
const { activeOrganizationId, organizations: orgs } = useAuth();

/**
 * Everything on this page is per-organisation, and the org endpoints need an id in the path. A
 * superadmin browsing "All organisations" has none, so the page asks for a choice instead of
 * guessing one.
 */
const orgId = computed(() => activeOrganizationId.value);
const orgName = computed(
  () => orgs.value.find((org) => org.id === orgId.value)?.name ?? ''
);
const pageDescription = computed(() =>
  orgName.value
    ? `Members, mailboxes and DNS accounts of ${orgName.value}`
    : 'Members, mailboxes and DNS accounts of the active organisation'
);

// ------------------------------------------------------------------ members
const members = ref<OrganizationMember[]>([]);
const membersLoading = ref(false);
const addingMember = ref(false);
const busyMember = ref<string | null>(null);
const memberError = ref<string | null>(null);
const memberForm = reactive<{ email: string; role: 'admin' | 'viewer'; name: string; password: string }>({
  email: '',
  role: 'viewer',
  name: '',
  password: '',
});

const loadMembers = async () => {
  if (!orgId.value) return;
  membersLoading.value = true;
  memberError.value = null;
  try {
    const result = await organizationsApi.members(orgId.value);
    members.value = result.data ?? [];
  } catch (err) {
    memberError.value = err instanceof Error ? err.message : 'Could not load the members';
  } finally {
    membersLoading.value = false;
  }
};

const addMember = async () => {
  if (!orgId.value) return;
  addingMember.value = true;
  memberError.value = null;

  try {
    // Optional fields are only sent when filled in: an existing account must not be handed a
    // blank password, and a name is only meaningful for a new one.
    await organizationsApi.addMember(orgId.value, {
      email: memberForm.email.trim(),
      role: memberForm.role,
      ...(memberForm.name.trim() ? { name: memberForm.name.trim() } : {}),
      ...(memberForm.password ? { password: memberForm.password } : {}),
    });
    toast.success(`Added ${memberForm.email.trim()}`);
    Object.assign(memberForm, { email: '', role: 'viewer', name: '', password: '' });
    await loadMembers();
  } catch (err) {
    // The last-admin refusals and duplicate accounts surface here, in full.
    memberError.value = err instanceof Error ? err.message : 'Could not add the member';
  } finally {
    addingMember.value = false;
  }
};

const changeRole = async (member: OrganizationMember, role: string) => {
  if (!orgId.value || (role !== 'admin' && role !== 'viewer') || role === member.role) return;
  busyMember.value = member.userId;
  memberError.value = null;

  try {
    await organizationsApi.setRole(orgId.value, member.userId, role);
    toast.success(`${member.email} is now ${role === 'admin' ? 'an admin' : 'a viewer'}`);
    await loadMembers();
  } catch (err) {
    // A refused demotion (the last admin) has to leave the select showing the stored role, so
    // the list is reloaded rather than patched locally.
    memberError.value = err instanceof Error ? err.message : 'Could not change the role';
    await loadMembers();
  } finally {
    busyMember.value = null;
  }
};

const removeMember = async (member: OrganizationMember) => {
  if (!orgId.value) return;
  const confirmed = window.confirm(
    `Remove ${member.email} from ${orgName.value || 'this organisation'}?\n\n` +
      'The account itself is kept; only its access to this organisation is removed. Removing the ' +
      'last admin is refused by the server.'
  );
  if (!confirmed) return;

  busyMember.value = member.userId;
  memberError.value = null;
  try {
    await organizationsApi.removeMember(orgId.value, member.userId);
    toast.success(`Removed ${member.email}`);
    await loadMembers();
  } catch (err) {
    memberError.value = err instanceof Error ? err.message : 'Could not remove the member';
  } finally {
    busyMember.value = null;
  }
};

// ------------------------------------------------------------------ mailboxes
const mailboxes = ref<OrgMailbox[]>([]);
const mailboxesLoading = ref(false);
const savingMailbox = ref(false);
const mailboxError = ref<string | null>(null);
const editingMailboxId = ref<string | null>(null);
const testingMailboxId = ref<string | null>(null);
const mailboxTest = ref<{ label: string; result: MailboxTestResult } | null>(null);
const mailboxFormTest = ref<MailboxTestResult | null>(null);
const testingMailboxForm = ref(false);

interface MailboxForm {
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  verifyTls: boolean;
  enabled: boolean;
}

const emptyMailboxForm = (): MailboxForm => ({
  label: '',
  host: '',
  port: 993,
  user: '',
  password: '',
  verifyTls: true,
  enabled: true,
});

const mailboxForm = reactive<MailboxForm>(emptyMailboxForm());

/** The stored password is never returned, so this box can only ever mean a replacement. */
const mailboxPasswordPlaceholder = computed(() =>
  editingMailboxId.value
    ? mailboxes.value.find((row) => row.id === editingMailboxId.value)?.passwordSet
      ? '•••• stored — leave blank to keep'
      : 'Not set'
    : 'Not set'
);

const loadMailboxes = async () => {
  if (!orgId.value) return;
  mailboxesLoading.value = true;
  try {
    mailboxes.value = await mailboxesApi.list(orgId.value);
  } catch (err) {
    mailboxError.value = err instanceof Error ? err.message : 'Could not load the mailboxes';
  } finally {
    mailboxesLoading.value = false;
  }
};

const resetMailboxForm = () => {
  editingMailboxId.value = null;
  mailboxFormTest.value = null;
  Object.assign(mailboxForm, emptyMailboxForm());
};

const startMailboxEdit = (mailbox: OrgMailbox) => {
  editingMailboxId.value = mailbox.id;
  mailboxError.value = null;
  mailboxFormTest.value = null;
  Object.assign(mailboxForm, {
    label: mailbox.label,
    host: mailbox.host,
    port: mailbox.port,
    user: mailbox.user,
    // Deliberately blank: a blank box means "keep the stored password".
    password: '',
    verifyTls: mailbox.verifyTls,
    enabled: mailbox.enabled,
  });
};

const saveMailbox = async () => {
  if (!orgId.value) return;
  savingMailbox.value = true;
  mailboxError.value = null;

  const payload = {
    label: mailboxForm.label.trim(),
    host: mailboxForm.host.trim(),
    port: Number(mailboxForm.port),
    user: mailboxForm.user.trim(),
    verifyTls: mailboxForm.verifyTls,
    enabled: mailboxForm.enabled,
    ...(mailboxForm.password ? { password: mailboxForm.password } : {}),
  };

  try {
    if (editingMailboxId.value) {
      await mailboxesApi.update(orgId.value, editingMailboxId.value, payload);
      toast.success(`${payload.label} updated`);
    } else {
      await mailboxesApi.create(orgId.value, payload);
      toast.success(`Added ${payload.label}`);
    }
    resetMailboxForm();
    await loadMailboxes();
  } catch (err) {
    mailboxError.value = err instanceof Error ? err.message : 'Could not save the mailbox';
  } finally {
    savingMailbox.value = false;
  }
};

const testMailbox = async (mailbox: OrgMailbox) => {
  if (!orgId.value) return;
  testingMailboxId.value = mailbox.id;
  mailboxTest.value = null;

  try {
    const result = await mailboxesApi.test(orgId.value, mailbox.id);
    mailboxTest.value = { label: mailbox.label, result };
  } catch (err) {
    // Reaching here means the endpoint or the network broke, not that the mailbox refused us.
    mailboxTest.value = {
      label: mailbox.label,
      result: { ok: false, message: err instanceof Error ? err.message : 'Could not run the test' },
    };
  } finally {
    testingMailboxId.value = null;
  }
};

const testMailboxForm = async () => {
  if (!orgId.value) return;
  testingMailboxForm.value = true;
  mailboxFormTest.value = null;

  try {
    // The same values the form would save. On edit the id lets the server fall back to the
    // stored password, so a blank box does not mean "no password".
    mailboxFormTest.value = await mailboxesApi.testValues(orgId.value, {
      ...(editingMailboxId.value ? { id: editingMailboxId.value } : {}),
      host: mailboxForm.host.trim(),
      port: Number(mailboxForm.port),
      user: mailboxForm.user.trim(),
      verifyTls: mailboxForm.verifyTls,
      ...(mailboxForm.password ? { password: mailboxForm.password } : {}),
    });
  } catch (err) {
    // Reaching here means the request broke (a missing host, an unreachable server), not that
    // the mailbox refused us - but it is still information for the form, never a save error.
    mailboxFormTest.value = {
      ok: false,
      message: err instanceof Error ? err.message : 'Could not run the test',
    };
  } finally {
    testingMailboxForm.value = false;
  }
};

const removeMailbox = async (mailbox: OrgMailbox) => {
  if (!orgId.value) return;
  const confirmed = window.confirm(
    `Delete the mailbox "${mailbox.label}"?\n\n` +
      'Reports already ingested from it are kept and stay with this organisation. Ingestion from ' +
      'it stops immediately. This cannot be undone.'
  );
  if (!confirmed) return;

  mailboxError.value = null;
  try {
    await mailboxesApi.remove(orgId.value, mailbox.id);
    toast.success(`Deleted ${mailbox.label}`);
    if (editingMailboxId.value === mailbox.id) {
      resetMailboxForm();
    }
    if (mailboxTest.value?.label === mailbox.label) {
      mailboxTest.value = null;
    }
    await loadMailboxes();
  } catch (err) {
    mailboxError.value = err instanceof Error ? err.message : 'Could not delete the mailbox';
  }
};

// ------------------------------------------------------------------ hosted addresses
const hostedAddresses = ref<HostedAddress[]>([]);
const hostedLoading = ref(false);
const addingHosted = ref(false);
const busyHostedId = ref<string | null>(null);
const hostedError = ref<string | null>(null);
const hostedForm = reactive<{ label: string; baseMailboxId: string }>({
  label: '',
  baseMailboxId: '',
});

/** An address can only be derived from a mailbox, so this is what blocks the form. */
const enabledMailboxCount = computed(
  () => mailboxes.value.filter((mailbox) => mailbox.enabled).length
);

const loadHostedAddresses = async () => {
  if (!orgId.value) return;
  hostedLoading.value = true;
  try {
    hostedAddresses.value = await hostedAddressesApi.list(orgId.value);
  } catch (err) {
    hostedAddresses.value = [];
    hostedError.value = err instanceof Error ? err.message : 'Could not load the hosted addresses';
  } finally {
    hostedLoading.value = false;
  }
};

const addHostedAddress = async () => {
  if (!orgId.value) return;
  addingHosted.value = true;
  hostedError.value = null;

  try {
    // An empty select means "let the server pick", so the id is only sent when chosen.
    const created = await hostedAddressesApi.create(orgId.value, {
      label: hostedForm.label.trim(),
      ...(hostedForm.baseMailboxId ? { baseMailboxId: hostedForm.baseMailboxId } : {}),
    });
    toast.success(`Added ${created.address}`);
    hostedForm.label = '';
    hostedForm.baseMailboxId = '';
    await loadHostedAddresses();
  } catch (err) {
    // The 409s (no base mailbox, duplicate label) carry the reason the admin needs.
    hostedError.value = err instanceof Error ? err.message : 'Could not add the hosted address';
  } finally {
    addingHosted.value = false;
  }
};

const toggleHostedAddress = async (hosted: HostedAddress, enabled: boolean) => {
  if (!orgId.value || enabled === hosted.enabled) return;
  busyHostedId.value = hosted.id;
  hostedError.value = null;

  try {
    await hostedAddressesApi.update(orgId.value, hosted.id, { enabled });
    toast.success(`${hosted.label} ${enabled ? 'enabled' : 'disabled'}`);
    await loadHostedAddresses();
  } catch (err) {
    hostedError.value = err instanceof Error ? err.message : 'Could not change the address';
    // The checkbox shows the stored value, so a refusal has to re-read the row.
    await loadHostedAddresses();
  } finally {
    busyHostedId.value = null;
  }
};

const removeHostedAddress = async (hosted: HostedAddress) => {
  if (!orgId.value) return;
  const confirmed = window.confirm(
    `Delete the hosted address "${hosted.label}"?\n\n` +
      `Reports already sent to ${hosted.address} keep their organisation, but the address stops ` +
      'routing new ones immediately. A published rua= pointing at it will bounce. This cannot be ' +
      'undone.'
  );
  if (!confirmed) return;

  hostedError.value = null;
  try {
    await hostedAddressesApi.remove(orgId.value, hosted.id);
    toast.success(`Deleted ${hosted.label}`);
    await loadHostedAddresses();
  } catch (err) {
    hostedError.value = err instanceof Error ? err.message : 'Could not delete the hosted address';
  }
};

// ------------------------------------------------------------------ DNS accounts
const dnsAccounts = ref<DnsAccount[]>([]);
const dnsLoading = ref(false);
const savingAccount = ref(false);
const accountError = ref<string | null>(null);
const editingAccountId = ref<string | null>(null);
const verifyingAccountId = ref<string | null>(null);
const dnsVerification = ref<{ label: string; result: DnsAccountVerification } | null>(null);
const dnsFormTest = ref<DnsAccountTestResult | null>(null);
const testingDnsForm = ref(false);

interface AccountForm {
  label: string;
  provider: DnsAccountProvider;
  token: string;
  username: string;
  password: string;
  enabled: boolean;
}

const emptyAccountForm = (): AccountForm => ({
  label: '',
  provider: 'cloudflare',
  token: '',
  username: '',
  password: '',
  enabled: true,
});

const accountForm = reactive<AccountForm>(emptyAccountForm());

const accountSecretPlaceholder = computed(() =>
  editingAccountId.value ? '•••• stored — leave blank to keep' : 'Not set'
);

const loadAccounts = async () => {
  if (!orgId.value) return;
  dnsLoading.value = true;
  try {
    dnsAccounts.value = await dnsAccountsApi.list(orgId.value);
  } catch (err) {
    accountError.value = err instanceof Error ? err.message : 'Could not load the DNS accounts';
  } finally {
    dnsLoading.value = false;
  }
};

const resetAccountForm = () => {
  editingAccountId.value = null;
  dnsFormTest.value = null;
  Object.assign(accountForm, emptyAccountForm());
};

const startDnsEdit = (account: DnsAccount) => {
  editingAccountId.value = account.id;
  accountError.value = null;
  dnsFormTest.value = null;
  Object.assign(accountForm, {
    label: account.label,
    provider: account.provider,
    // Both credential boxes start blank: the API never returns them, so blank is "keep".
    token: '',
    username: '',
    password: '',
    enabled: account.enabled,
  });
};

/**
 * The credential payload for the selected provider, or null when nothing was typed. On create
 * null is a validation error (the API requires credentials); on edit it means "keep the stored
 * set", which is what a blank box has to mean because the value cannot be filled in.
 */
const readCredentials = (): DnsAccountCredentials | null => {
  if (accountForm.provider === 'cloudflare') {
    const token = accountForm.token.trim();
    return token ? { token } : null;
  }
  const username = accountForm.username.trim();
  return username && accountForm.password ? { username, password: accountForm.password } : null;
};

const saveAccount = async () => {
  if (!orgId.value) return;
  accountError.value = null;

  const credentials = readCredentials();
  const editing = editingAccountId.value;

  if (!editing && !credentials) {
    accountError.value =
      accountForm.provider === 'cloudflare'
        ? 'An API token is required for a new Cloudflare account.'
        : 'An API user and password are required for a new Loopia account.';
    return;
  }

  savingAccount.value = true;
  try {
    if (editing) {
      await dnsAccountsApi.update(orgId.value, editing, {
        label: accountForm.label.trim(),
        enabled: accountForm.enabled,
        ...(credentials ? { credentials } : {}),
      });
      toast.success(`${accountForm.label.trim()} updated`);
    } else {
      await dnsAccountsApi.create(orgId.value, {
        label: accountForm.label.trim(),
        provider: accountForm.provider,
        enabled: accountForm.enabled,
        ...(credentials ? { credentials } : {}),
      });
      toast.success(`Added ${accountForm.label.trim()}`);
    }
    resetAccountForm();
    await loadAccounts();
  } catch (err) {
    accountError.value = err instanceof Error ? err.message : 'Could not save the DNS account';
  } finally {
    savingAccount.value = false;
  }
};

/**
 * Test the form's credentials without saving them. On edit with both secret boxes blank the
 * stored set is what needs checking, so the saved-account verify endpoint is used instead:
 * there are no typed credentials to send. Either way a refusal is a result, not a form error.
 */
const testAccountForm = async () => {
  if (!orgId.value) return;
  const credentials = readCredentials();
  const editing = editingAccountId.value;

  if (!credentials && !editing) {
    dnsFormTest.value = {
      ok: false,
      message:
        accountForm.provider === 'cloudflare'
          ? 'Enter an API token to test it.'
          : 'Enter the API user and password to test them.',
    };
    return;
  }

  testingDnsForm.value = true;
  dnsFormTest.value = null;

  try {
    dnsFormTest.value = credentials
      ? await dnsAccountsApi.test(orgId.value, {
          provider: accountForm.provider,
          credentials,
        })
      : await dnsAccountsApi.verify(orgId.value, editing!);
  } catch (err) {
    // A 404/429 or a transport failure lands here; it is still shown beside the button.
    dnsFormTest.value = {
      ok: false,
      message: err instanceof Error ? err.message : 'Could not run the check',
    };
  } finally {
    testingDnsForm.value = false;
  }
};

const verifyAccount = async (account: DnsAccount) => {
  if (!orgId.value) return;
  verifyingAccountId.value = account.id;
  dnsVerification.value = null;

  try {
    const result = await dnsAccountsApi.verify(orgId.value, account.id);
    dnsVerification.value = { label: account.label, result };
  } catch (err) {
    dnsVerification.value = {
      label: account.label,
      result: { ok: false, message: err instanceof Error ? err.message : 'Could not run the check' },
    };
  } finally {
    verifyingAccountId.value = null;
  }
};

const removeAccount = async (account: DnsAccount) => {
  if (!orgId.value) return;
  const confirmed = window.confirm(
    `Delete the DNS account "${account.label}"?\n\n` +
      `${account.domainCount ?? 0} domain(s) are assigned to it. They fall back to automatic ` +
      'selection, but their records can no longer be published through these credentials until ' +
      'another account is assigned. This cannot be undone.'
  );
  if (!confirmed) return;

  accountError.value = null;
  try {
    await dnsAccountsApi.remove(orgId.value, account.id);
    toast.success(`Deleted ${account.label}`);
    if (editingAccountId.value === account.id) {
      resetAccountForm();
    }
    if (dnsVerification.value?.label === account.label) {
      dnsVerification.value = null;
    }
    await loadAccounts();
  } catch (err) {
    accountError.value = err instanceof Error ? err.message : 'Could not delete the DNS account';
  }
};

// ------------------------------------------------------------------ wiring
const loadingAny = computed(
  () => membersLoading.value || mailboxesLoading.value || hostedLoading.value || dnsLoading.value
);

const loadAll = async () => {
  await Promise.all([loadMembers(), loadMailboxes(), loadHostedAddresses(), loadAccounts()]);
};

const formatDateTime = (value: string | null): string => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
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

onMounted(loadAll);
</script>
