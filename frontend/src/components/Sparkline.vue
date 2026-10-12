<template>
  <!-- Fixed 14 slots so the column keeps its width whether a domain has one run or fourteen. -->
  <div class="flex h-4 items-end gap-0.5" :aria-label="`${points.length} recent checks`">
    <span
      v-for="(slot, index) in slots"
      :key="index"
      class="w-1 rounded-sm"
      :class="slot ? [HEIGHTS[slot.status], COLORS[slot.status]] : 'h-1 bg-gray-200'"
      :title="slot ? `${slot.status} — ${new Date(slot.runAt).toLocaleString()}` : 'no run recorded'"
    ></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DomainCheckStatus, DomainRecentCheck } from '@/types/api';

const props = defineProps<{ points: DomainRecentCheck[] }>();

const HEIGHTS: Record<DomainCheckStatus, string> = {
  ok: 'h-2',
  warn: 'h-3',
  error: 'h-4',
  info: 'h-2',
  skipped: 'h-1',
};

// Colour is an echo of the height, not the only signal (the row's badge carries an icon too).
const COLORS: Record<DomainCheckStatus, string> = {
  ok: 'bg-success-500',
  warn: 'bg-warning-500',
  error: 'bg-danger-500',
  info: 'bg-gray-400',
  skipped: 'bg-gray-300',
};

const slots = computed<(DomainRecentCheck | null)[]>(() => {
  const recent = props.points.slice(-14);
  const padding = Array<null>(14 - recent.length).fill(null);
  return [...padding, ...recent];
});
</script>
