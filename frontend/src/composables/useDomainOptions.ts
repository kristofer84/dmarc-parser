import { ref } from 'vue';
import { domainsApi } from '@/api/client';

/**
 * The domains the signed-in user may filter by.
 *
 * `/api/domains` is already scoped server-side to the caller, so this list is exactly what a
 * non-admin is allowed to see - no client-side filtering here. It is loaded once per page load
 * and shared, because both report views mount the same select and the module-level promise makes
 * the second mount (or a remount on navigation) join the first request instead of firing another.
 */

const domainOptions = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

let inflight: Promise<void> | null = null;

async function load(): Promise<void> {
  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    loading.value = true;
    error.value = null;

    try {
      const domains = await domainsApi.list();
      domainOptions.value = [...new Set(domains.map((domain) => domain.name).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b),
      );
    } catch (err) {
      // A missing convenience list must not break the page: leave it empty and let the select
      // render with just "All domains" so the filter can still be cleared.
      error.value = err instanceof Error ? err.message : 'Failed to load domains';
    } finally {
      loading.value = false;
    }
  })();

  return inflight;
}

/** Bypasses the cached promise, e.g. after adding a domain elsewhere in the app. */
function refresh(): Promise<void> {
  inflight = null;
  return load();
}

export function useDomainOptions() {
  void load();

  return {
    domainOptions,
    loading,
    error,
    refresh,
  };
}
