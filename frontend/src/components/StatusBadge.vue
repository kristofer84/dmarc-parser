<template>
  <span class="badge" :class="toneClass">
    <component :is="iconComponent" v-if="showIcon" class="w-3 h-3 mr-1 shrink-0" />
    {{ resolvedLabel }}
  </span>
</template>

<script setup lang="ts">
import { computed, h } from 'vue';

/**
 * The single mapping from a status string to a chip. Colour alone is not a signal, so an
 * optional inline severity icon can ride along (the Domains page turns it on).
 *
 * `kind` exists because the same word means different things per screen: a `skipped` optional
 * DNS check is neutral, but a `skipped` processing run is a warning. The default covers the
 * ok/warn/error vocabulary used elsewhere.
 */

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'gray';
export type StatusKind = 'generic' | 'auth' | 'disposition' | 'domain' | 'processing' | 'user';

const TONES: Record<Tone, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-gray',
  gray: 'badge-gray',
};

const MAPS: Record<StatusKind, Record<string, Tone>> = {
  generic: {
    ok: 'success',
    pass: 'success',
    success: 'success',
    active: 'success',
    monitored: 'success',
    verified: 'success',
    none: 'success',
    warn: 'warning',
    warning: 'warning',
    quarantine: 'warning',
    locked: 'warning',
    skipped: 'warning',
    error: 'danger',
    fail: 'danger',
    reject: 'danger',
    disabled: 'danger',
    unverified: 'danger',
    info: 'info',
    started: 'info',
  },
  auth: { pass: 'success', fail: 'danger', none: 'gray' },
  disposition: { none: 'success', quarantine: 'warning', reject: 'danger' },
  domain: { ok: 'success', warn: 'warning', error: 'danger', info: 'info', skipped: 'gray' },
  processing: { started: 'info', success: 'success', skipped: 'warning', error: 'danger' },
  user: { admin: 'success', user: 'gray', active: 'success', disabled: 'danger', locked: 'warning' },
};

const props = withDefaults(
  defineProps<{
    status: string | null | undefined;
    kind?: StatusKind;
    label?: string;
    icon?: boolean;
  }>(),
  { kind: 'generic', icon: false },
);

const normalised = computed(() => (props.status ?? '').trim().toLowerCase());
const tone = computed<Tone>(() => MAPS[props.kind][normalised.value] ?? 'gray');

const resolvedLabel = computed(() => {
  if (props.label !== undefined) return props.label;
  if (!props.status) return '—';
  return props.status.charAt(0).toUpperCase() + props.status.slice(1);
});

const toneClass = computed(() => TONES[tone.value]);

/** Builds a tiny stroke icon from its path data; a functional component keeps it inline. */
const icon = (paths: string[]) =>
  () =>
    h(
      'svg',
      {
        fill: 'none',
        viewBox: '0 0 20 20',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      paths.map((d) => h('path', { d })),
    );

const ICONS = {
  success: icon(['m4 10 4 4 8-8']),
  warning: icon(['M10 3 18 17H2L10 3Z', 'M10 8v4', 'M10 15h.01']),
  danger: icon(['M5 5l10 10', 'M15 5 5 15']),
  info: icon(['M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M10 9v5', 'M10 6h.01']),
};

const showIcon = computed(() => props.icon && tone.value !== 'gray');
const iconComponent = computed(() => ICONS[tone.value === 'gray' ? 'info' : tone.value]);
</script>
