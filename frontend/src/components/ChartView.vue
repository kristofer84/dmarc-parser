<template>
  <div class="card">
    <div class="card-header" v-if="title">
      <h3 class="text-lg leading-6 font-medium text-gray-900">{{ title }}</h3>
      <p v-if="description" class="mt-1 text-sm text-gray-500">{{ description }}</p>
    </div>
    <div class="card-body">
      <div class="relative" :style="{ height: `${height}px` }">
        <canvas ref="chartCanvas"></canvas>

        <!-- Loading state -->
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-surface/75">
          <div class="flex items-center space-x-2">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
            <span class="text-sm text-gray-600">Loading chart...</span>
          </div>
        </div>

        <!-- Error state -->
        <div v-if="error" class="absolute inset-0 flex items-center justify-center bg-surface">
          <div class="text-center">
            <div class="text-danger-500 mb-2">
              <svg class="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <p class="text-sm text-gray-600">{{ error }}</p>
          </div>
        </div>

        <!-- Empty state -->
        <div v-if="!loading && !error && (!data || data.length === 0)"
          class="absolute inset-0 flex items-center justify-center bg-surface">
          <div class="text-center">
            <div class="text-gray-400 mb-2">
              <svg class="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <p class="text-sm text-gray-600">No data available</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import {
  Chart,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  LineController,
  DoughnutController,
  PieController,
  BarController,
  type ChartConfiguration,
  type ChartData,
  type ChartOptions,
} from 'chart.js';
import { useTheme } from '@/composables/useTheme';

// Register Chart.js components
Chart.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  LineController,
  DoughnutController,
  PieController,
  BarController
);

interface Props {
  type: 'line' | 'bar' | 'pie' | 'doughnut';
  data: any[];
  title?: string;
  description?: string;
  height?: number;
  loading?: boolean;
  error?: string | null;
  options?: Partial<ChartOptions>;
}

const props = withDefaults(defineProps<Props>(), {
  height: 300,
  loading: false,
  error: null,
});

const chartCanvas = ref<HTMLCanvasElement>();
let chartInstance: Chart | null = null;

const { resolvedTheme } = useTheme();

/**
 * Resolve a design token at chart-build time. Chart.js bakes colours into the canvas, so it
 * cannot follow a CSS variable the way the DOM does - the chart has to be rebuilt when the
 * theme flips (see the watch below).
 */
const token = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '0 0 0';

const rgb = (name: string, alpha?: number): string =>
  alpha === undefined ? `rgb(${token(name)})` : `rgb(${token(name)} / ${alpha})`;

const themeColors = () => ({
  primary: rgb('--ramp-primary-600'),
  primarySoft: rgb('--ramp-primary-600', 0.18),
  danger: rgb('--ramp-danger-500'),
  dangerSoft: rgb('--ramp-danger-500', 0.18),
  success: rgb('--ramp-success-500'),
  warning: rgb('--ramp-warning-500'),
  gray: rgb('--ramp-gray-400'),
  grid: rgb('--ramp-gray-200'),
  tick: rgb('--ramp-gray-500'),
  text: rgb('--ramp-gray-700'),
  surface: rgb('--surface'),
});

const createChartData = (): ChartData => {
  if (!props.data || props.data.length === 0) {
    return { labels: [], datasets: [] };
  }

  const colors = themeColors();

  switch (props.type) {
    case 'line':
      return {
        labels: props.data.map((item) => item.date || item.label),
        datasets: [
          {
            label: 'Message Count',
            data: props.data.map((item) => item.messageCount || item.value),
            borderColor: colors.primary,
            backgroundColor: colors.primarySoft,
            tension: 0.1,
          },
          {
            label: 'Failure Rate (%)',
            data: props.data.map((item) => item.failureRate || item.secondaryValue || 0),
            borderColor: colors.danger,
            backgroundColor: colors.dangerSoft,
            tension: 0.1,
            yAxisID: 'y1',
          },
        ],
      };
    case 'bar':
      return {
        labels: props.data.map((item) => item.label || item.name),
        datasets: [
          {
            label: 'Count',
            data: props.data.map((item) => item.value || item.count),
            backgroundColor: colors.primary,
          },
        ],
      };
    case 'pie':
    case 'doughnut':
      return {
        labels: props.data.map((item) => item.label || item.name),
        datasets: [
          {
            data: props.data.map((item) => item.value || item.count),
            backgroundColor: [colors.success, colors.warning, colors.danger, colors.primary, colors.gray],
            borderColor: colors.surface,
            borderWidth: 2,
          },
        ],
      };
    default:
      return { labels: [], datasets: [] };
  }
};

const createChartOptions = (): ChartOptions => {
  const colors = themeColors();

  const baseOptions: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: colors.text },
      },
      tooltip: {
        mode: 'index',
        intersect: false,
      },
    },
    ...props.options,
  };

  const axis = {
    grid: { color: colors.grid },
    ticks: { color: colors.tick },
  };

  if (props.type === 'line') {
    return {
      ...baseOptions,
      scales: {
        x: { ...axis },
        y: { type: 'linear', display: true, position: 'left', beginAtZero: true, ...axis },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: { color: colors.tick },
        },
      },
    };
  }

  if (props.type === 'bar') {
    return {
      ...baseOptions,
      scales: {
        x: { ...axis },
        y: { beginAtZero: true, ...axis },
      },
    };
  }

  return baseOptions;
};

const createChart = async () => {
  if (!chartCanvas.value) return;

  // Destroy existing chart
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  // Wait for next tick to ensure canvas is ready
  await nextTick();

  const config: ChartConfiguration = {
    type: props.type,
    data: createChartData(),
    options: createChartOptions(),
  };

  chartInstance = new Chart(chartCanvas.value, config);
};

const updateChart = () => {
  if (!chartInstance) return;

  chartInstance.data = createChartData();
  chartInstance.options = createChartOptions();
  chartInstance.update();
};

// Watch for data changes
watch(
  () => [props.data, props.type, props.options],
  () => {
    if (chartInstance) {
      updateChart();
    } else {
      createChart();
    }
  },
  { deep: true }
);

// A theme flip changes every colour the canvas baked in, so a data update is not enough.
watch(resolvedTheme, () => {
  if (!props.loading && !props.error && props.data?.length > 0) {
    createChart();
  }
});

onMounted(() => {
  if (!props.loading && !props.error && props.data?.length > 0) {
    createChart();
  }
});

onUnmounted(() => {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
});

// Watch loading state
watch(
  () => props.loading,
  (newLoading) => {
    if (!newLoading && !props.error && props.data?.length > 0) {
      createChart();
    }
  }
);
</script>
