import { computed, ref, watch } from 'vue';

/**
 * Theme state for the whole app.
 *
 * `system` is the default and the only mode that keeps listening: it resolves to the OS
 * preference at call time and re-resolves when that preference changes. The resolved value is
 * exposed as a computed so charts (which bake colours into a canvas) can rebuild on change.
 */

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'dmarc-theme';

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // Private mode / storage disabled: fall through to the default.
  }
  return 'system';
}

const preference = ref<Theme>(readStored());
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const systemPrefersDark = ref(media?.matches ?? false);

media?.addEventListener('change', (event) => {
  systemPrefersDark.value = event.matches;
});

const resolvedTheme = computed<'light' | 'dark'>(() => {
  if (preference.value === 'system') {
    return systemPrefersDark.value ? 'dark' : 'light';
  }
  return preference.value;
});

function apply(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

// The class has to be on <html> before first paint, otherwise a dark-mode operator sees a
// white flash on every load. This runs at module import, which App.vue does before mount.
apply(resolvedTheme.value);

watch(resolvedTheme, (theme) => apply(theme), { flush: 'sync' });

function setTheme(theme: Theme): void {
  preference.value = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persisting is best-effort; the session still honours the choice.
  }
}

export function useTheme() {
  // Cycle order is the order they appear in the button's title.
  const ORDER: Theme[] = ['system', 'light', 'dark'];
  const next = computed<Theme>(() => ORDER[(ORDER.indexOf(preference.value) + 1) % ORDER.length]);

  return {
    theme: computed(() => preference.value),
    nextTheme: next,
    resolvedTheme,
    setTheme,
    setNextTheme: () => setTheme(next.value),
  };
}
