<template>
  <!-- The page's own title band: every view used to repeat this markup with small drifts. -->
  <div class="bg-surface shadow-xs border-b border-gray-200">
    <div :class="containerClass">
      <div class="py-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center space-x-4 min-w-0">
            <router-link v-if="backTo" :to="backTo" class="btn btn-secondary shrink-0">
              <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              {{ backLabel }}
            </router-link>
            <div class="min-w-0">
              <h1 class="text-2xl sm:text-3xl font-bold text-gray-900 truncate">{{ title }}</h1>
              <p v-if="description" class="mt-2 text-sm text-gray-600">{{ description }}</p>
              <slot name="meta" />
            </div>
          </div>

          <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2 shrink-0">
            <slot name="actions" />
          </div>
        </div>

        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    backTo?: RouteLocationRaw;
    backLabel?: string;
    /** Account pages are narrower than the table views. */
    containerClass?: string;
  }>(),
  {
    backLabel: 'Back',
    containerClass: 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8',
  },
);
</script>
