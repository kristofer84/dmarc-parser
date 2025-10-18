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
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-white bg-opacity-75">
          <div class="flex items-center space-x-2">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
            <span class="text-sm text-gray-600">Loading chart...</span>
          </div>
        </div>

        <!-- Error state -->
        <div v-if="error" class="absolute inset-0 flex items-center justify-center bg-white">
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
          class="absolute inset-0 flex items-center justify-center bg-white">
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

const defaultColors = {
  primary: '#3b82f6',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  gray: '#6b7280',
};

const createChartData = (): ChartData => {
  if (!props.data || props.data.length === 0) {
    return { labels: [], datasets: [] };
  }

  switch (props.type) {
    case 'line':
      return createLineChartData();
    case 'bar':
      return createBarChartData();
    case 'pie':
    case 'doughnut':
      return createPieChartData();
    default:
      return { labels: [], datasets: [] };
  }
};

const createLineChartData = (): ChartData => {
  const labels = props.data.map(item => item.date || item.label);

  return {
    labels,
    datasets: [
      {
        label: 'Message Count',
        data: props.data.map(item => item.messageCount || item.value),
        borderColor: defaultColors.primary,
        backgroundColor: defaultColors.primary + '20',
        tension: 0.1,
      },
      {
        label: 'Failure Rate (%)',
        data: props.data.map(item => item.failureRate || item.secondaryValue || 0),
        borderColor: defaultColors.danger,
        backgroundColor: defaultColors.danger + '20',
        tension: 0.1,
        yAxisID: 'y1',
      },
    ],
  };
};

const createBarChartData = (): ChartData => {
  const labels = props.data.map(item => item.label || item.name);

  return {
    labels,
    datasets: [
      {
        label: 'Count',
        data: props.data.map(item => item.value || item.count),
        backgroundColor: [
          defaultColors.primary,
          defaultColors.success,
          defaultColors.warning,
          defaultColors.danger,
          defaultColors.gray,
        ],
      },
    ],
  };
};

const createPieChartData = (): ChartData => {
  const labels = props.data.map(item => item.label || item.name);

  return {
    labels,
    datasets: [
      {
        data: props.data.map(item => item.value || item.count),
        backgroundColor: [
          defaultColors.success,
          defaultColors.warning,
          defaultColors.danger,
          defaultColors.primary,
          defaultColors.gray,
        ],
      },
    ],
  };
};

const createChartOptions = (): ChartOptions => {
  const baseOptions: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
      },
      tooltip: {
        mode: 'index',
        intersect: false,
      },
    },
    ...props.options,
  };

  if (props.type === 'line') {
    return {
      ...baseOptions,
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: {
            drawOnChartArea: false,
          },
        },
      },
    };
  }

  if (props.type === 'bar') {
    return {
      ...baseOptions,
      scales: {
        y: {
          beginAtZero: true,
        },
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