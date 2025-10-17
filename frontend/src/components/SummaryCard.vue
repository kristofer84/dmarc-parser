<template>
  <div class="stat-card">
    <div class="stat-card-body">
      <div class="flex items-center">
        <div class="flex-shrink-0">
          <div class="w-8 h-8 flex items-center justify-center rounded-md" :class="iconBgClass">
            <component :is="iconComponent" class="w-5 h-5" :class="iconClass" />
          </div>
        </div>
        <div class="ml-5 w-0 flex-1">
          <dl>
            <dt class="stat-label truncate">{{ title }}</dt>
            <dd class="flex items-baseline">
              <div class="stat-value">{{ formattedValue }}</div>
              <div 
                v-if="trend !== undefined" 
                class="ml-2 flex items-baseline text-sm font-semibold"
                :class="trendClass"
              >
                <component :is="trendIcon" class="self-center flex-shrink-0 h-4 w-4" />
                <span class="sr-only">{{ trend > 0 ? 'Increased' : 'Decreased' }} by</span>
                {{ Math.abs(trend) }}%
              </div>
            </dd>
          </dl>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  title: string;
  value: number | string;
  icon?: 'reports' | 'messages' | 'shield' | 'check' | 'warning' | 'x';
  trend?: number;
  format?: 'number' | 'percentage' | 'text';
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
}

const props = withDefaults(defineProps<Props>(), {
  icon: 'reports',
  format: 'number',
  color: 'blue',
});

// Icon components (using simple SVG paths)
const iconComponents = {
  reports: {
    template: `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>`
  },
  messages: {
    template: `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>`
  },
  shield: {
    template: `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>`
  },
  check: {
    template: `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>`
  },
  warning: {
    template: `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>`
  },
  x: {
    template: `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>`
  }
};

const trendIcons = {
  up: {
    template: `<svg fill="currentColor" viewBox="0 0 20 20">
      <path fill-rule="evenodd" d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z" clip-rule="evenodd" />
    </svg>`
  },
  down: {
    template: `<svg fill="currentColor" viewBox="0 0 20 20">
      <path fill-rule="evenodd" d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 12.586V5a1 1 0 012 0v7.586l2.293-2.293a1 1 0 011.414 0z" clip-rule="evenodd" />
    </svg>`
  }
};

const iconComponent = computed(() => iconComponents[props.icon]);

const iconBgClass = computed(() => {
  const classes = {
    blue: 'bg-primary-500',
    green: 'bg-success-500',
    yellow: 'bg-warning-500',
    red: 'bg-danger-500',
    gray: 'bg-gray-500',
  };
  return classes[props.color];
});

const iconClass = computed(() => 'text-white');

const formattedValue = computed(() => {
  if (props.format === 'percentage') {
    return `${props.value}%`;
  }
  if (props.format === 'number' && typeof props.value === 'number') {
    return props.value.toLocaleString();
  }
  return props.value.toString();
});

const trendIcon = computed(() => {
  if (props.trend === undefined) return null;
  return props.trend > 0 ? trendIcons.up : trendIcons.down;
});

const trendClass = computed(() => {
  if (props.trend === undefined) return '';
  return props.trend > 0 ? 'text-success-600' : 'text-danger-600';
});
</script>