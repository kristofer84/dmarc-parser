<template>
  <!-- A segmented control rather than a `<select>`: four options, all worth seeing at once,
       and the current window stays visible after the click. -->
  <div class="inline-flex items-stretch" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="relative -ml-px inline-flex items-center border border-gray-300 px-3 py-2 text-sm font-medium first:ml-0 first:rounded-l-md last:rounded-r-md focus:z-10 focus:outline-hidden focus:ring-2 focus:ring-primary-500"
      :class="
        option.value === modelValue
          ? 'z-10 border-primary-500 bg-primary-50 text-primary-700'
          : 'bg-surface text-gray-600 hover:bg-gray-50'
      "
      :aria-pressed="option.value === modelValue"
      :title="option.title"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { StatsRange } from '@/types/api';

/**
 * The one window picker shared by the dashboard and the sources view, so `?range=` means the
 * same thing on both pages.
 */
withDefaults(
  defineProps<{
    modelValue: StatsRange;
    label?: string;
  }>(),
  { label: 'Time range' }
);

const emit = defineEmits<{ 'update:modelValue': [value: StatsRange] }>();

const options = [
  { value: '7d' as StatsRange, label: '7d', title: 'Last 7 days' },
  { value: '30d' as StatsRange, label: '30d', title: 'Last 30 days' },
  { value: '90d' as StatsRange, label: '90d', title: 'Last 90 days' },
  { value: 'all' as StatsRange, label: 'All', title: 'Everything ever ingested' },
];
</script>
