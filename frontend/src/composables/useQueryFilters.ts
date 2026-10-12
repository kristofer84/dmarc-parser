import { watch } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';

/**
 * Makes a view's filter object the source of truth for the URL query, so a filtered table can
 * be linked to or reloaded and come back the same - and the browser's back button steps through
 * the filters the operator actually applied.
 *
 * Reading happens once at setup; after that the composable watches the query so a back/forward
 * navigation re-applies it and asks the view to reload via `onChange`.
 */
export function useQueryFilters<T extends object>(
  state: T,
  keys: (keyof T & string)[],
  onChange?: () => void,
) {
  const route = useRoute();
  const router = useRouter();
  const record = state as Record<string, unknown>;

  // Snapshot before the URL is read so back/forward can restore a key the query no longer
  // carries - otherwise a filter removed by going back would silently stick around.
  const defaults: Record<string, unknown> = {};
  for (const key of keys) defaults[key] = record[key];

  /** The managed query keys only, so unrelated params (e.g. ?redirect) never look like a change. */
  function readInto(query: Record<string, unknown>): void {
    for (const key of keys) {
      const raw = query[key];
      if (raw === undefined || raw === null || Array.isArray(raw)) {
        record[key] = defaults[key];
        continue;
      }

      // Numbers are stored as numbers in the filter object; strings keep the raw query value.
      if (typeof record[key] === 'number') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) record[key] = parsed;
      } else {
        record[key] = String(raw);
      }
    }
  }

  function managedQuery(): Record<string, string> {
    const query: Record<string, string> = {};
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && value !== '') {
        query[key] = String(value);
      }
    }
    return query;
  }

  readInto(route.query);

  watch(
    () => route.query,
    (query) => {
      const incoming = query as Record<string, unknown>;
      const next = managedQueryFromRaw(incoming);
      // A push from sync() arrives here too; only react when the query genuinely differs.
      if (JSON.stringify(next) === JSON.stringify(managedQuery())) return;

      readInto(incoming);
      onChange?.();
    },
  );

  function managedQueryFromRaw(query: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const raw = query[key];
      if (raw === undefined || raw === null || Array.isArray(raw) || raw === '') continue;
      result[key] = String(raw);
    }
    return result;
  }

  /** Pushes the current filter values into the query, dropping the ones that are unset. */
  function sync(): void {
    const query: LocationQueryRaw = { ...route.query };

    for (const key of keys) {
      const value = record[key];
      if (value === undefined || value === null || value === '') {
        delete query[key];
      } else {
        query[key] = String(value);
      }
    }

    // Re-pushing an identical query would add a useless history entry on every keystroke.
    if (JSON.stringify(managedQueryFromRaw(query)) === JSON.stringify(managedQuery())) {
      return;
    }

    void router.push({ query });
  }

  return { sync };
}
