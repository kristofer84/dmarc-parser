<template>
  <select
    :id="id"
    :value="modelValue"
    :disabled="disabled || isLoading"
    :aria-label="label"
    :aria-busy="isLoading ? 'true' : undefined"
    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
    @change="onChange"
  >
    <option value="">All domains</option>
    <option v-for="option in options" :key="option" :value="option">
      {{ option }}
    </option>
  </select>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDomainOptions } from '@/composables/useDomainOptions';

const props = withDefaults(
  defineProps<{
    // The views' filter objects type `domain` as optional, so the model accepts undefined and
    // treats it like the empty string: both mean "all domains".
    modelValue?: string;
    label?: string;
    disabled?: boolean;
    loading?: boolean;
    id?: string;
  }>(),
  {
    modelValue: '',
    label: 'Domain',
    disabled: false,
    loading: false,
    id: undefined,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  change: [value: string];
}>();

const { domainOptions, loading: optionsLoading } = useDomainOptions();

const isLoading = computed(() => props.loading || optionsLoading.value);

const options = computed(() => {
  const base = domainOptions.value;

  // The filter is deep-linked to the URL, so the current value can name a domain the fetch has
  // not returned yet (or no longer does). Keep it as an option so a bookmarked link does not
  // silently snap the filter back to "All domains".
  if (props.modelValue && !base.includes(props.modelValue)) {
    return [props.modelValue, ...base];
  }

  return base;
});

const onChange = (event: Event): void => {
  const value = (event.target as HTMLSelectElement).value;
  emit('update:modelValue', value);
  emit('change', value);
};
</script>
