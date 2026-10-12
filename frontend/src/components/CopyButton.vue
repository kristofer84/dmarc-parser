<template>
  <button
    type="button"
    class="inline-flex shrink-0 items-center justify-center rounded p-1 text-gray-400 transition-opacity hover:bg-gray-100 hover:text-gray-700 focus-visible:opacity-100 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
    :title="`Copy ${label}`"
    :aria-label="`Copy ${label}`"
    @click.stop="copy(value, label)"
  >
    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.8"
        d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m0 0h1.5m-1.5 0a1.125 1.125 0 0 1 1.125-1.125h1.5m0 0a1.125 1.125 0 0 1 1.125 1.125"
      />
    </svg>
  </button>
</template>

<script setup lang="ts">
import { useClipboard } from '@/composables/useClipboard';

/** Place next to something in a `.group` so the hover reveal has a target. */
withDefaults(
  defineProps<{
    value: string;
    label?: string;
  }>(),
  { label: 'value' },
);

const { copy } = useClipboard();
</script>
