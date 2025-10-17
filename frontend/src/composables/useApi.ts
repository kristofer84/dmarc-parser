import { ref, reactive } from 'vue';
import type { LoadingState } from '@/types/api';

export function useApiCall<T>(apiFunction: () => Promise<T>) {
  const data = ref<T | null>(null);
  const state = reactive<LoadingState>({
    loading: false,
    error: null,
  });

  const execute = async (): Promise<T | null> => {
    state.loading = true;
    state.error = null;

    try {
      const result = await apiFunction();
      data.value = result;
      return result;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'An unexpected error occurred';
      console.error('API call failed:', error);
      return null;
    } finally {
      state.loading = false;
    }
  };

  const reset = () => {
    data.value = null;
    state.loading = false;
    state.error = null;
  };

  return {
    data,
    loading: state.loading,
    error: state.error,
    execute,
    reset,
  };
}

export function useAsyncData<T>(apiFunction: () => Promise<T>, immediate = true) {
  const { data, loading, error, execute, reset } = useApiCall(apiFunction);

  if (immediate) {
    execute();
  }

  const refresh = () => execute();

  return {
    data,
    loading,
    error,
    refresh,
    reset,
  };
}