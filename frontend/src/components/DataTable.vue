<template>
  <div class="card">
    <!-- Table header with filters -->
    <div class="card-header" v-if="title || $slots.filters">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 v-if="title" class="text-lg leading-6 font-medium text-gray-900">{{ title }}</h3>
          <p v-if="description" class="mt-1 text-sm text-gray-500">{{ description }}</p>
        </div>
        <div class="mt-3 sm:mt-0">
          <slot name="filters"></slot>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="overflow-hidden">
      <div class="overflow-x-auto">
        <table class="table">
          <thead class="table-header">
            <tr>
              <th
                v-for="column in columns"
                :key="column.key"
                class="table-header-cell"
                :class="{ 'cursor-pointer': column.sortable }"
                @click="column.sortable ? handleSort(column.key) : null"
              >
                <div class="flex items-center space-x-1">
                  <span>{{ column.label }}</span>
                  <div v-if="column.sortable" class="flex flex-col">
                    <svg 
                      class="w-3 h-3 text-gray-400"
                      :class="{ 'text-gray-700': sortBy === column.key && sortOrder === 'asc' }"
                      fill="currentColor" 
                      viewBox="0 0 20 20"
                    >
                      <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                    </svg>
                    <svg 
                      class="w-3 h-3 text-gray-400 -mt-1"
                      :class="{ 'text-gray-700': sortBy === column.key && sortOrder === 'desc' }"
                      fill="currentColor" 
                      viewBox="0 0 20 20"
                    >
                      <path d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" />
                    </svg>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody class="table-body">
            <!-- Loading rows -->
            <tr v-if="loading" v-for="n in 5" :key="`loading-${n}`">
              <td v-for="column in columns" :key="column.key" class="table-cell">
                <div class="animate-pulse bg-gray-200 h-4 rounded"></div>
              </td>
            </tr>

            <!-- Data rows -->
            <tr
              v-else-if="data && data.length > 0"
              v-for="(item, index) in data"
              :key="getRowKey(item, index)"
              class="table-row"
              @click="handleRowClick(item)"
            >
              <td v-for="column in columns" :key="column.key" class="table-cell">
                <slot 
                  :name="`cell-${column.key}`" 
                  :item="item" 
                  :value="getColumnValue(item, column.key)"
                  :column="column"
                >
                  <span v-if="column.type === 'badge'">
                    <span 
                      class="badge"
                      :class="getBadgeClass(getColumnValue(item, column.key))"
                    >
                      {{ formatValue(getColumnValue(item, column.key)) }}
                    </span>
                  </span>
                  <span v-else-if="column.type === 'date'">
                    {{ formatDate(getColumnValue(item, column.key)) }}
                  </span>
                  <span v-else-if="column.type === 'number'">
                    {{ formatNumber(getColumnValue(item, column.key)) }}
                  </span>
                  <span v-else-if="column.type === 'percentage'">
                    {{ getColumnValue(item, column.key) }}%
                  </span>
                  <span v-else>
                    {{ formatValue(getColumnValue(item, column.key)) }}
                  </span>
                </slot>
              </td>
            </tr>

            <!-- Empty state -->
            <tr v-else-if="!loading">
              <td :colspan="columns.length" class="table-cell text-center py-8">
                <div class="text-gray-400 mb-2">
                  <svg class="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p class="text-gray-500">{{ emptyMessage || 'No data available' }}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Pagination -->
    <div 
      v-if="pagination && pagination.pages > 1" 
      class="bg-white px-4 py-3 border-t border-gray-200 sm:px-6"
    >
      <div class="flex items-center justify-between">
        <div class="flex-1 flex justify-between sm:hidden">
          <button
            :disabled="pagination.page <= 1"
            @click="handlePageChange(pagination.page - 1)"
            class="btn btn-secondary"
            :class="{ 'opacity-50 cursor-not-allowed': pagination.page <= 1 }"
          >
            Previous
          </button>
          <button
            :disabled="pagination.page >= pagination.pages"
            @click="handlePageChange(pagination.page + 1)"
            class="btn btn-secondary ml-3"
            :class="{ 'opacity-50 cursor-not-allowed': pagination.page >= pagination.pages }"
          >
            Next
          </button>
        </div>
        <div class="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
          <div>
            <p class="text-sm text-gray-700">
              Showing
              <span class="font-medium">{{ (pagination.page - 1) * pagination.limit + 1 }}</span>
              to
              <span class="font-medium">{{ Math.min(pagination.page * pagination.limit, pagination.total) }}</span>
              of
              <span class="font-medium">{{ pagination.total }}</span>
              results
            </p>
          </div>
          <div>
            <nav class="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
              <button
                :disabled="pagination.page <= 1"
                @click="handlePageChange(pagination.page - 1)"
                class="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50"
                :class="{ 'opacity-50 cursor-not-allowed': pagination.page <= 1 }"
              >
                Previous
              </button>
              
              <button
                v-for="page in visiblePages"
                :key="page"
                @click="typeof page === 'number' ? handlePageChange(page) : null"
                :disabled="typeof page !== 'number'"
                class="relative inline-flex items-center px-4 py-2 border text-sm font-medium"
                :class="page === pagination.page 
                  ? 'z-10 bg-primary-50 border-primary-500 text-primary-600' 
                  : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'"
              >
                {{ page }}
              </button>
              
              <button
                :disabled="pagination.page >= pagination.pages"
                @click="handlePageChange(pagination.page + 1)"
                class="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50"
                :class="{ 'opacity-50 cursor-not-allowed': pagination.page >= pagination.pages }"
              >
                Next
              </button>
            </nav>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Column {
  key: string;
  label: string;
  sortable?: boolean;
  type?: 'text' | 'number' | 'date' | 'percentage' | 'badge';
  width?: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface Props {
  columns: Column[];
  data: any[];
  loading?: boolean;
  title?: string;
  description?: string;
  emptyMessage?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  pagination?: Pagination;
  rowKey?: string;
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  sortOrder: 'asc',
  rowKey: 'id',
});

const emit = defineEmits<{
  sort: [{ sortBy: string; sortOrder: 'asc' | 'desc' }];
  rowClick: [item: any];
  pageChange: [page: number];
}>();

const getRowKey = (item: any, index: number): string => {
  return item[props.rowKey] || index.toString();
};

const getColumnValue = (item: any, key: string): any => {
  return key.split('.').reduce((obj, k) => obj?.[k], item);
};

const handleSort = (columnKey: string) => {
  const newSortOrder = props.sortBy === columnKey && props.sortOrder === 'asc' ? 'desc' : 'asc';
  emit('sort', { sortBy: columnKey, sortOrder: newSortOrder });
};

const handleRowClick = (item: any) => {
  emit('rowClick', item);
};

const handlePageChange = (page: number) => {
  emit('pageChange', page);
};

const formatValue = (value: any): string => {
  if (value === null || value === undefined) return '-';
  return value.toString();
};

const formatDate = (value: string | Date): string => {
  if (!value) return '-';
  const date = new Date(value);
  return date.toLocaleDateString();
};

const formatNumber = (value: number): string => {
  if (typeof value !== 'number') return '-';
  return value.toLocaleString();
};

const getBadgeClass = (value: string): string => {
  const lowerValue = value?.toLowerCase();
  
  if (lowerValue === 'pass' || lowerValue === 'none') {
    return 'badge-success';
  }
  if (lowerValue === 'quarantine' || lowerValue === 'warning') {
    return 'badge-warning';
  }
  if (lowerValue === 'fail' || lowerValue === 'reject') {
    return 'badge-danger';
  }
  
  return 'badge-gray';
};

const visiblePages = computed(() => {
  if (!props.pagination) return [];
  
  const { page, pages } = props.pagination;
  const delta = 2;
  const range = [];
  
  for (let i = Math.max(2, page - delta); i <= Math.min(pages - 1, page + delta); i++) {
    range.push(i);
  }
  
  if (page - delta > 2) {
    range.unshift('...');
  }
  if (page + delta < pages - 1) {
    range.push('...');
  }
  
  range.unshift(1);
  if (pages !== 1) {
    range.push(pages);
  }
  
  return range.filter((item, index, arr) => arr.indexOf(item) === index);
});
</script>