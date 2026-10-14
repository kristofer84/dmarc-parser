<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Identity providers"
      description="OpenID Connect sign-in, one entry per provider"
    >
      <template #actions>
        <button @click="load" class="btn btn-secondary">Refresh</button>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <DataTable
        :columns="columns"
        :data="providers"
        :loading="loading"
        title="Configured providers"
        description="Only enabled providers are offered as buttons on the sign-in page"
        empty-message="No identity providers configured"
      >
        <template #cell-name="{ item }">
          <div class="font-medium text-gray-900">{{ item.name }}</div>
          <div class="text-xs text-gray-500 font-mono">{{ item.clientId }}</div>
        </template>
        <template #cell-issuer="{ value }">
          <span class="font-mono text-xs text-gray-600 whitespace-normal break-all">{{ value }}</span>
        </template>
        <template #cell-enabled="{ item }">
          <StatusBadge
            :status="item.enabled ? 'active' : 'disabled'"
            :label="item.enabled ? 'Enabled' : 'Disabled'"
          />
        </template>
        <template #cell-clientSecretSet="{ item }">
          <span v-if="item.clientSecretSet" class="badge badge-success">stored</span>
          <span v-else class="badge badge-gray">not set</span>
        </template>
        <template #cell-actions="{ item }">
          <div class="flex items-center space-x-2">
            <button class="btn btn-secondary text-xs" :disabled="testing" @click="runTest(item)">
              Test connection
            </button>
            <button class="btn btn-secondary text-xs" @click="startEdit(item)">Edit</button>
            <button class="btn btn-secondary text-xs text-danger-700" @click="remove(item)">
              Delete
            </button>
          </div>
        </template>
      </DataTable>

      <!-- A refused test is information, not an error, so it gets a panel rather than a toast
           that would time out before it could be read. -->
      <div v-if="testTarget" class="card">
        <div class="card-header flex items-center justify-between">
          <div>
            <h2 class="text-lg leading-6 font-medium text-gray-900">
              Test result for {{ testTarget.name }}
            </h2>
            <p class="mt-1 text-sm text-gray-500">
              Reads the provider's discovery document. No account is created.
            </p>
          </div>
          <button class="btn btn-secondary text-sm" @click="closeTest">Close</button>
        </div>
        <div class="card-body space-y-3">
          <p v-if="testing" class="text-sm text-gray-500">Testing…</p>
          <p
            v-else-if="testResult"
            class="rounded-md px-3 py-2 text-sm"
            :class="
              testResult.ok
                ? 'bg-success-50 text-success-800'
                : 'bg-danger-50 text-danger-800'
            "
          >
            {{ testResult.message }}
          </p>
          <dl
            v-if="testResult?.endpoints"
            class="rounded-md border border-gray-200 bg-surface-muted p-3 text-xs font-mono space-y-1"
          >
            <div
              v-for="(value, key) in testResult.endpoints"
              :key="key"
              class="flex flex-wrap gap-x-2"
            >
              <dt class="text-gray-500">{{ key }}</dt>
              <dd class="text-gray-900 break-all">{{ value }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div class="card">
        <div class="card-header flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg leading-6 font-medium text-gray-900">
              {{ editingId ? `Edit ${form.name || 'provider'}` : 'Add a provider' }}
            </h2>
            <p v-if="editingId" class="mt-1 text-sm text-gray-500">
              Register this redirect URI with the provider:
              <span class="font-mono break-all">{{ callbackUrl }}</span>
            </p>
            <!-- The new provider has no id yet and the id is part of the URI, so anything shown
                 here would be a URL that answers nothing. -->
            <p v-else class="mt-1 text-sm text-gray-500">
              The redirect URI to register with the provider is built from this provider's ID,
              which is created on save. Create the provider first, then use Edit to copy the URI.
            </p>
          </div>
          <button v-if="editingId" class="btn btn-secondary text-sm shrink-0" @click="resetForm">
            Cancel
          </button>
        </div>

        <form class="card-body space-y-5" @submit.prevent="save">
          <!-- A preset only prefills fields, so the manual path below is unchanged for anything
               that is not in the catalog. -->
          <div class="rounded-md border border-gray-200 bg-surface-muted p-3">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span class="text-sm font-medium text-gray-700">Start from a preset</span>
              <span class="text-xs text-gray-500">
                Optional - it fills in the fields below. Nothing is saved until you submit.
              </span>
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                class="btn text-xs"
                :class="activePresetId ? 'btn-secondary' : 'btn-primary'"
                @click="clearPreset"
              >
                From scratch
              </button>
              <button
                v-for="preset in IDP_PRESETS"
                :key="preset.id"
                type="button"
                class="btn text-xs"
                :class="activePresetId === preset.id ? 'btn-primary' : 'btn-secondary'"
                @click="applyPreset(preset)"
              >
                {{ preset.label }}
              </button>
            </div>
            <p v-if="activePreset" class="mt-2 text-xs text-gray-600">
              {{ activePreset.consoleLabel }}:
              <a
                v-if="consoleLink"
                :href="consoleLink"
                target="_blank"
                rel="noopener"
                class="font-mono break-all text-primary-600 hover:underline"
              >
                {{ consoleLink }}
              </a>
              <span v-else class="text-gray-500">
                the link becomes usable once the placeholder in the issuer below is replaced.
              </span>
            </p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label for="provider-name" class="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                id="provider-name"
                v-model="form.name"
                type="text"
                required
                placeholder="Company SSO"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <p class="mt-1 text-xs text-gray-500">Shown on the sign-in button.</p>
            </div>

            <div>
              <label for="provider-issuer" class="block text-sm font-medium text-gray-700 mb-1">
                Issuer URL
              </label>
              <input
                id="provider-issuer"
                v-model="form.issuer"
                type="url"
                required
                placeholder="https://login.example.com/realms/main"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <!-- Driven by the field rather than by the preset, so a template pasted into a
                   hand-written provider is caught the same way. -->
              <p v-if="pendingPlaceholder" class="mt-1 text-xs text-danger-700">
                Replace <span class="font-mono">{{ pendingPlaceholder }}</span> with
                {{ pendingPlaceholderHint }}. A provider does not answer on a URL containing
                braces, so saving is blocked until it is replaced - otherwise the failure would
                surface later as an unrelated DNS or fetch error from the connection test.
              </p>
              <p v-else class="mt-1 text-xs text-gray-500">
                The provider's base URL. Endpoints are discovered from
                <span class="font-mono">&lt;issuer&gt;/.well-known/openid-configuration</span>.
              </p>
            </div>

            <div>
              <label for="provider-client-id" class="block text-sm font-medium text-gray-700 mb-1">
                Client ID
              </label>
              <input
                id="provider-client-id"
                v-model="form.clientId"
                type="text"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            <div>
              <label
                for="provider-client-secret"
                class="block text-sm font-medium text-gray-700 mb-1"
              >
                Client secret
              </label>
              <input
                id="provider-client-secret"
                v-model="form.clientSecret"
                type="password"
                autocomplete="new-password"
                :placeholder="secretPlaceholder"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <p class="mt-1 text-xs text-gray-500">
                <template v-if="editingSecretSet">
                  A secret is stored. Leaving this blank keeps it; typing a new one replaces it.
                </template>
                <template v-else>
                  Leave blank only if the provider accepts a public client with no secret.
                </template>
              </p>
            </div>

            <div>
              <label for="provider-scopes" class="block text-sm font-medium text-gray-700 mb-1">
                Scopes
              </label>
              <input
                id="provider-scopes"
                v-model="form.scopes"
                type="text"
                placeholder="openid profile email"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <p class="mt-1 text-xs text-gray-500">
                Space-separated. <span class="font-mono">openid</span> is always sent. Leave blank
                for the server default.
              </p>
            </div>

            <div>
              <label
                for="provider-default-domains"
                class="block text-sm font-medium text-gray-700 mb-1"
              >
                Default domains
              </label>
              <input
                id="provider-default-domains"
                v-model="form.defaultDomains"
                type="text"
                placeholder="example.com, example.org"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
              <p class="mt-1 text-xs text-gray-500">
                Comma-separated domains automatically assigned to users provisioned by this
                provider. Leave empty and each provisioned user sees no report data until an
                administrator assigns domains.
              </p>
            </div>
          </div>

          <!-- Under the fields it belongs to, and only while that preset is selected: a Google
               operator should not be reading Okta's traps. -->
          <div
            v-if="activePreset"
            class="rounded-md border border-gray-200 bg-surface-muted px-3 py-2"
          >
            <p class="text-xs font-medium text-gray-700">
              {{ activePreset.label }}: what wastes an evening
            </p>
            <ul class="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
              <li v-for="note in activePreset.notes" :key="note">{{ note }}</li>
            </ul>
          </div>

          <div class="flex flex-wrap gap-x-8 gap-y-4 border-t border-gray-200 pt-5">
            <div>
              <label class="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  v-model="form.enabled"
                  class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                />
                <span class="ml-2 text-sm font-medium text-gray-700">Enabled</span>
              </label>
              <p class="mt-1 text-xs text-gray-500 max-w-md">
                A disabled provider keeps its configuration but is not offered on the sign-in page,
                and a sign-in already in flight is refused.
              </p>
            </div>

            <div>
              <label class="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  v-model="form.allowAutoProvision"
                  class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                />
                <span class="ml-2 text-sm font-medium text-gray-700">
                  Automatically create accounts
                </span>
              </label>
              <p class="mt-1 text-xs text-gray-500 max-w-md">
                Creates a console account the first time a user signs in through this provider.
                Without it, the account has to exist already and the sign-in is refused.
              </p>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 border-t border-gray-200 pt-5">
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="saving"
              @click="resetForm"
            >
              {{ editingId ? 'Cancel editing' : 'Clear' }}
            </button>
            <button type="submit" class="btn btn-primary" :disabled="saving || !!pendingPlaceholder">
              {{ saving ? 'Saving…' : editingId ? 'Save changes' : 'Create provider' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { apiBaseUrl, providersApi } from '@/api/client';
import { IDP_PRESETS, type IdpPreset } from '@/data/idpPresets';
import { useToast } from '@/composables/useToast';
import type { ProviderConfig, ProviderInput, ProviderTestResult } from '@/types/api';

const toast = useToast();

const columns = [
  { key: 'name', label: 'Provider', sortable: false },
  { key: 'issuer', label: 'Issuer', sortable: false },
  { key: 'enabled', label: 'Status' },
  { key: 'clientSecretSet', label: 'Secret' },
  { key: 'actions', label: '' },
];

interface ProviderForm {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  defaultDomains: string;
  enabled: boolean;
  allowAutoProvision: boolean;
}

const emptyForm = (): ProviderForm => ({
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: '',
  defaultDomains: '',
  enabled: true,
  allowAutoProvision: false,
});

const providers = ref<ProviderConfig[]>([]);
const loading = ref(false);
const saving = ref(false);
const form = reactive<ProviderForm>(emptyForm());

/** Non-null means the form is editing that provider rather than creating a new one. */
const editingId = ref<string | null>(null);

const editingSecretSet = computed(
  () => providers.value.find((provider) => provider.id === editingId.value)?.clientSecretSet ?? false,
);

const secretPlaceholder = computed(() =>
  editingSecretSet.value ? '•••• stored — type to replace' : 'Not set',
);

/**
 * Derived from the same base the browser is sent to, so the URI an operator copies is the one
 * that will actually be called back - including a deployment served under a path prefix.
 */
const callbackUrl = computed(
  () => `${apiBaseUrl}/auth/oidc/${editingId.value ?? '<id>'}/callback`,
);

// ---------------------------------------------------------------- provider presets

/** `{name}` tokens in a preset template: exactly the part an operator has to replace. */
const PLACEHOLDER_TOKEN = /\{([a-z0-9_-]+)\}/gi;
const PLACEHOLDER_LEFT = /\{[a-z0-9_-]+\}/i;

const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads the values out of the issuer the operator typed, using the preset's template as the
 * pattern. That way the one thing they type for the issuer also completes the preset's console
 * URL, which is the same value on a different host. Null while the issuer does not have the
 * template's shape yet - which includes the untouched template itself.
 */
function readTemplateValues(template: string, value: string): Record<string, string> | null {
  let pattern = '^';
  let cursor = 0;
  const names: string[] = [];

  for (const token of template.matchAll(PLACEHOLDER_TOKEN)) {
    const at = token.index ?? cursor;
    pattern += `${escapeForRegExp(template.slice(cursor, at))}([^/]+)`;
    names.push(token[1]);
    cursor = at + token[0].length;
  }
  pattern += `${escapeForRegExp(template.slice(cursor))}$`;

  const match = new RegExp(pattern, 'i').exec(value);
  if (!match) {
    return null;
  }

  const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
  // An untouched template matches its own pattern, so a captured `{tenant}` has to count as no
  // value at all: otherwise the console link would be a URL with braces in it.
  return Object.values(values).some((captured) => PLACEHOLDER_LEFT.test(captured))
    ? null
    : values;
}

/** Fills `values` into `template`; null while any token still has no value. */
function fillTemplate(template: string, values: Record<string, string>): string | null {
  let complete = true;
  const filled = template.replace(PLACEHOLDER_TOKEN, (token: string, name: string) => {
    const value = values[name];
    if (!value) {
      complete = false;
      return token;
    }
    return value;
  });

  return complete ? filled : null;
}

/** Which preset the form started from; null is the from-scratch path and the default. */
const activePresetId = ref<string | null>(null);

const activePreset = computed<IdpPreset | null>(
  () => IDP_PRESETS.find((preset) => preset.id === activePresetId.value) ?? null,
);

/**
 * The `{token}` still left in the issuer, if any. Read from the field rather than from the
 * preset, so a template typed or pasted by hand is caught the same way. Saving is refused while
 * this is set: a discovery request to a URL containing braces fails as a DNS or fetch error that
 * says nothing about the actual mistake.
 */
const pendingPlaceholder = computed(() => form.issuer.match(PLACEHOLDER_LEFT)?.[0] ?? null);

const pendingPlaceholderHint = computed(
  () => activePreset.value?.placeholderHint ?? 'the value your provider expects',
);

/** The picked preset's console page, with the issuer's placeholders filled in where needed. */
const consoleLink = computed(() => {
  const preset = activePreset.value;
  if (!preset) {
    return null;
  }
  // Google, Entra, Apple, Auth0 and Clerk have a fixed console URL; the self-hosted providers
  // put the same value in the console host that the operator is typing into the issuer, so it
  // stays unreachable until they have typed it.
  if (![...preset.consoleUrl.matchAll(PLACEHOLDER_TOKEN)].length) {
    return preset.consoleUrl;
  }

  const values = readTemplateValues(preset.issuerTemplate, form.issuer);
  return values ? fillTemplate(preset.consoleUrl, values) : null;
});

/**
 * One pick, then one paste: the fields the preset owns are overwritten, the credentials the
 * operator has to copy out of the provider's console are left alone.
 */
const applyPreset = (preset: IdpPreset) => {
  activePresetId.value = preset.id;
  form.name = preset.label;
  // Inserted with its braces intact on purpose: the issuer field is where they get replaced, and
  // pendingPlaceholder blocks the save until they are.
  form.issuer = preset.issuerTemplate;
  form.scopes = preset.scopes;

  const link = consoleLink.value;
  if (link) {
    window.open(link, '_blank', 'noopener');
  }
};

/** Back to the from-scratch form: undo what a preset filled in and nothing else. */
const clearPreset = () => {
  activePresetId.value = null;
  form.name = '';
  form.issuer = '';
  form.scopes = '';
};

const testTarget = ref<ProviderConfig | null>(null);
const testing = ref(false);
const testResult = ref<ProviderTestResult | null>(null);

const load = async () => {
  loading.value = true;

  try {
    providers.value = await providersApi.list();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not load the providers');
  } finally {
    loading.value = false;
  }
};

/** Trailing commas and mixed case are what pasting a list produces; neither is a domain. */
const parseDomains = (value: string): string[] => [
  ...new Set(
    value
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/**
 * The form is the request: fields are sent as typed, so clearing one clears it on the server.
 * The one exception is the secret box, which the API can never fill in - a blank box there means
 * "keep the stored secret", because sending an empty string would wipe a working one.
 */
const buildPayload = (): ProviderInput => ({
  name: form.name.trim(),
  issuer: form.issuer.trim(),
  clientId: form.clientId.trim(),
  ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
  // Blank optional text is omitted rather than sent empty, so the server's own default applies.
  ...(form.scopes.trim() ? { scopes: form.scopes.trim() } : {}),
  enabled: form.enabled,
  allowAutoProvision: form.allowAutoProvision,
  defaultDomains: parseDomains(form.defaultDomains),
});

const resetForm = () => {
  editingId.value = null;
  activePresetId.value = null;
  Object.assign(form, emptyForm());
};

const save = async () => {
  // The button is disabled in this state, but Enter in a text field and a paste both reach here.
  if (pendingPlaceholder.value) {
    toast.error(`Replace ${pendingPlaceholder.value} in the issuer URL before saving`);
    return;
  }

  saving.value = true;
  const payload = buildPayload();

  try {
    if (editingId.value) {
      await providersApi.update(editingId.value, payload);
      toast.success(`${payload.name} updated`);
    } else {
      const created = await providersApi.create(payload);
      toast.success(`Created ${created.name}`);
    }
    resetForm();
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not save the provider');
  } finally {
    saving.value = false;
  }
};

const startEdit = (provider: ProviderConfig) => {
  editingId.value = provider.id;
  // Match the stored issuer back to a preset so its notes stay visible while editing, without
  // the operator having to pick it again.
  activePresetId.value =
    IDP_PRESETS.find((preset) => readTemplateValues(preset.issuerTemplate, provider.issuer))?.id ??
    null;
  form.name = provider.name;
  form.issuer = provider.issuer;
  form.clientId = provider.clientId;
  // Deliberately blank: the secret is never returned, so the only thing this box can mean is a
  // replacement.
  form.clientSecret = '';
  form.scopes = provider.scopes;
  form.defaultDomains = provider.defaultDomains.join(', ');
  form.enabled = provider.enabled;
  form.allowAutoProvision = provider.allowAutoProvision;
};

const remove = async (provider: ProviderConfig) => {
  const confirmed = window.confirm(
    `Delete the "${provider.name}" identity provider?\n\n` +
      'Anyone who can only sign in through this provider - for example someone with no password ' +
      'on their account - will not be able to sign in this way any more. A password still works ' +
      'for an account that has one.\n\nThis cannot be undone.'
  );

  if (!confirmed) {
    return;
  }

  try {
    await providersApi.remove(provider.id);
    toast.success(`Deleted ${provider.name}`);
    if (editingId.value === provider.id) {
      resetForm();
    }
    if (testTarget.value?.id === provider.id) {
      closeTest();
    }
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not delete the provider');
  }
};

const runTest = async (provider: ProviderConfig) => {
  testTarget.value = provider;
  testResult.value = null;
  testing.value = true;

  try {
    testResult.value = await providersApi.testProvider(provider.id);
  } catch (err) {
    // Reaching here means the endpoint or the network broke, not that the provider refused us.
    testResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : 'Could not run the test',
    };
  } finally {
    testing.value = false;
  }
};

const closeTest = () => {
  testTarget.value = null;
  testResult.value = null;
};

onMounted(load);
</script>
