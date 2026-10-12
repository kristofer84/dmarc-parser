import { computed, reactive } from 'vue';
import { apiClient } from '@/api/client';

/**
 * Instance name and brand colour, read once from the public /api/branding endpoint.
 *
 * It is also the thing that runs on the login screen, before any session exists, so a failure
 * here is never surfaced: the compiled-in defaults are what a fresh install shows anyway.
 */

interface Branding {
  name: string;
  accent: string;
}

const DEFAULTS: Branding = { name: 'DMARC Viewer', accent: '79 70 229' };

const state = reactive<Branding>({ ...DEFAULTS });
let inflight: Promise<void> | null = null;

/** '#4f46e5' / '#4f5' -> '79 70 229', the triplet form the CSS variables use. */
function hexToTriplet(hex: string): string | null {
  const value = hex.trim().replace(/^#/, '');
  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return null;
  }

  const int = parseInt(expanded, 16);
  return `${(int >> 16) & 255} ${(int >> 8) & 255} ${int & 255}`;
}

function apply({ name, accent }: Branding): void {
  state.name = name;

  const triplet = hexToTriplet(accent);
  if (triplet) {
    document.documentElement.style.setProperty('--accent', triplet);
  }
}

async function load(): Promise<void> {
  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    try {
      const response = await apiClient.getBranding();
      apply({
        name: response.name?.trim() || DEFAULTS.name,
        accent: response.accent?.trim() || DEFAULTS.accent,
      });
    } catch {
      // Keep whatever the CSS compiled in; a branded instance name is a nicety.
    }
  })();

  return inflight;
}

/** Read by the router's title hook, which may run before any component asks for branding. */
export const brandingName = computed(() => state.name);

export function useBranding() {
  return {
    name: brandingName,
    load,
  };
}
