<template>
  <div class="min-h-screen bg-gray-50">
    <PageHeader
      title="Glossary"
      description="The vocabulary DMARC reports are written in, in the order you meet it"
    >
      <template #meta>
        <p class="mt-2 nums text-xs text-gray-500">
          {{ GLOSSARY.length }} terms in {{ GLOSSARY_CATEGORIES.length }} categories
        </p>
      </template>
    </PageHeader>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- Filters. The category select and the chips are the same filter: the chips are the
           fast path, the select stays usable when the list grows. -->
      <div class="bg-surface p-4 rounded-card shadow-card border border-gray-200 space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="md:col-span-2">
            <label for="glossary-search" class="block text-sm font-medium text-gray-700 mb-1">
              Search
            </label>
            <div class="relative">
              <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M21 21l-4.35-4.35M9.5 17a7.5 7.5 0 100-15 7.5 7.5 0 000 15z"
                  />
                </svg>
              </div>
              <input
                id="glossary-search"
                v-model="query"
                type="search"
                placeholder="alignment, rua, selector, MTA-STS, reportAuthenticated…"
                class="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <p class="mt-1 text-xs text-gray-500">
              Matches the term, its expansion, its aliases and the definition text.
            </p>
          </div>
          <div>
            <label for="glossary-category" class="block text-sm font-medium text-gray-700 mb-1">
              Category
            </label>
            <select
              id="glossary-category"
              v-model="category"
              class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-xs focus:outline-hidden focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="all">All categories ({{ GLOSSARY.length }})</option>
              <option v-for="group in GLOSSARY_CATEGORIES" :key="group.id" :value="group.id">
                {{ group.label }} ({{ countByCategory[group.id] ?? 0 }})
              </option>
            </select>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn text-xs"
            :class="category === 'all' ? 'btn-primary' : 'btn-secondary'"
            :aria-pressed="category === 'all'"
            @click="category = 'all'"
          >
            All <span class="ml-1 nums opacity-80">{{ GLOSSARY.length }}</span>
          </button>
          <button
            v-for="group in GLOSSARY_CATEGORIES"
            :key="group.id"
            type="button"
            class="btn text-xs"
            :class="category === group.id ? 'btn-primary' : 'btn-secondary'"
            :aria-pressed="category === group.id"
            @click="category = group.id"
          >
            {{ group.label }}
            <span class="ml-1 nums opacity-80">{{ countByCategory[group.id] ?? 0 }}</span>
          </button>
        </div>

        <p class="nums text-xs text-gray-500" role="status" aria-live="polite">
          Showing {{ filtered.length }} of {{ GLOSSARY.length }} terms
          <span v-if="query.trim()"> matching "{{ query.trim() }}"</span>.
        </p>
      </div>

      <!-- Empty state: a search that matches nothing, not an empty glossary. -->
      <div v-if="filtered.length === 0" class="card">
        <div class="card-body">
          <EmptyState
            icon="search"
            title="No term matches"
            :description="`Nothing matches “${query.trim()}” in this category. Try a shorter word, or clear the category filter.`"
          >
            <template #action>
              <button type="button" class="btn btn-secondary text-sm" @click="resetFilters">
                Clear filters
              </button>
            </template>
          </EmptyState>
        </div>
      </div>

      <!-- Results, grouped by category. Each entry is its own anchor. -->
      <section v-for="group in groups" :key="group.id" class="space-y-4">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 class="text-lg font-medium text-gray-900">{{ group.label }}</h2>
          <p class="nums text-xs text-gray-500">{{ group.terms.length }} shown</p>
        </div>
        <p class="text-sm text-gray-600">{{ group.description }}</p>

        <article
          v-for="term in group.terms"
          :id="term.id"
          :key="term.id"
          class="card scroll-mt-24"
        >
          <div class="card-header">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-base font-semibold text-gray-900">
                  {{ term.term }}
                  <span v-if="term.expansion" class="text-sm font-normal text-gray-500">
                    — {{ term.expansion }}
                  </span>
                </h3>
                <p v-if="term.aliases.length > 0" class="mt-1 text-xs text-gray-500">
                  Also
                  <template v-for="(alias, index) in term.aliases" :key="alias">
                    <span v-if="index > 0">, </span>
                    <code class="font-mono text-gray-700">{{ alias }}</code>
                  </template>
                </p>
              </div>
              <a
                :href="`#${term.id}`"
                class="shrink-0 font-mono text-xs text-accent hover:underline"
                :aria-label="`Permalink to ${term.term}`"
              >
                #{{ term.id }}
              </a>
            </div>
          </div>

          <div class="card-body space-y-3">
            <p class="text-sm font-medium text-gray-800">{{ term.short }}</p>
            <p class="text-sm text-gray-600">{{ term.detail }}</p>

            <div class="rounded-md bg-surface-muted p-3">
              <h4 class="text-xs font-medium uppercase tracking-wide text-gray-500">
                Where you meet it here
              </h4>
              <p class="mt-1 text-sm text-gray-700">{{ term.whyItMatters }}</p>
            </div>

            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <p v-if="term.reference" class="text-xs text-gray-500">
                <span class="font-medium text-gray-600">Reference:</span> {{ term.reference }}
              </p>
              <p v-if="term.related.length > 0" class="text-xs text-gray-500">
                <span class="font-medium text-gray-600">Related:</span>
                <template v-for="(id, index) in term.related" :key="id">
                  <span v-if="index > 0">, </span>
                  <a :href="`#${id}`" class="text-accent hover:underline">{{ labelOf(id) }}</a>
                </template>
              </p>
            </div>
          </div>
        </article>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import {
  GLOSSARY,
  GLOSSARY_CATEGORIES,
  type GlossaryCategory,
  type GlossaryTerm,
} from '@/data/glossary';

/**
 * The in-app glossary. The data lives in src/data/glossary.ts so that the long-form
 * docs/dictionary.md and this page cannot drift apart silently; this file only filters,
 * groups and renders it, and turns every term id into an anchor so the entries can be linked
 * from the checks and reports views.
 */

const query = ref('');
const category = ref<GlossaryCategory | 'all'>('all');

const termsById = new Map(GLOSSARY.map((term) => [term.id, term]));

const countByCategory = GLOSSARY_CATEGORIES.reduce<Record<string, number>>((counts, group) => {
  counts[group.id] = GLOSSARY.filter((term) => term.category === group.id).length;
  return counts;
}, {});

/** Every whitespace-separated token must appear somewhere, so "spf limit" narrows quickly. */
function matches(term: GlossaryTerm, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const haystack = [
    term.term,
    term.expansion ?? '',
    ...term.aliases,
    term.short,
    term.detail,
    term.whyItMatters,
  ]
    .join(' ')
    .toLowerCase();
  return needle
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => haystack.includes(token));
}

const filtered = computed<GlossaryTerm[]>(() => {
  const needle = query.value.trim().toLowerCase();
  return GLOSSARY.filter(
    (term) =>
      (category.value === 'all' || term.category === category.value) && matches(term, needle),
  );
});

/** Categories keep their declared order, and a category with no matches is dropped. */
const groups = computed(() =>
  GLOSSARY_CATEGORIES.map((group) => ({
    ...group,
    terms: filtered.value.filter((term) => term.category === group.id),
  })).filter((group) => group.terms.length > 0),
);

function labelOf(id: string): string {
  return termsById.get(id)?.term ?? id;
}

function resetFilters(): void {
  query.value = '';
  category.value = 'all';
}

/**
 * Deep links such as /glossary#dkim-selector arrive after the component has rendered, and the
 * browser may scroll before the cards exist, so the position is re-applied once here.
 */
onMounted(async () => {
  const id = window.location.hash.replace(/^#/, '');
  if (id.length === 0) {
    return;
  }
  await nextTick();
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
});
</script>
