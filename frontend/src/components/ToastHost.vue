<template>
  <!-- Mounted once in App.vue; the queue itself is module state, see useToast(). -->
  <div
    class="fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    role="status"
    aria-live="polite"
  >
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="flex items-start gap-3 rounded-card border border-gray-200 bg-surface p-3 shadow-pop"
    >
      <component :is="ICONS[toast.kind]" class="mt-0.5 h-4 w-4 shrink-0" :class="ICON_CLASSES[toast.kind]" />
      <p class="flex-1 text-sm text-gray-900 break-words">{{ toast.message }}</p>
      <button
        type="button"
        class="-m-1 rounded p-1 text-gray-400 hover:text-gray-600"
        aria-label="Dismiss notification"
        @click="dismiss(toast.id)"
      >
        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { h } from 'vue';
import { useToast, type ToastKind } from '@/composables/useToast';

const { toasts, dismiss } = useToast();

const icon = (paths: string[]) =>
  () =>
    h(
      'svg',
      {
        fill: 'none',
        viewBox: '0 0 24 24',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      paths.map((d) => h('path', { d })),
    );

const ICONS = {
  success: icon(['M9 12.75 11.25 15 15 9.75', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z']),
  error: icon(['M12 9v3.75m0 3.75h.008', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z']),
  info: icon(['M12 9v3.75m0 3.75h.008', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z']),
};

const ICON_CLASSES: Record<ToastKind, string> = {
  success: 'text-success-600',
  error: 'text-danger-600',
  info: 'text-primary-600',
};
</script>
