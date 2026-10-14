<template>
  <div id="app">
    <a href="#main" class="skip-link">Skip to main content</a>

    <!-- Navigation -->
    <nav v-if="$route.name !== 'Login'" class="bg-surface shadow-sm border-b border-gray-200">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16 min-w-0 gap-4">
          <div class="flex min-w-0">
            <!-- Logo -->
            <div class="flex-shrink-0 flex items-center">
              <router-link to="/" class="flex items-center space-x-2">
                <BrandMark class="w-8 h-8 text-accent" />
                <span class="text-xl font-bold text-gray-900">{{ branding.name }}</span>
              </router-link>
            </div>

            <!-- Inline links are the daily working set, text only. The row used to hold
                 all seven links with an icon each, and the icons are what pushed it into
                 the right-hand group below ~1200px. -->
            <div class="hidden lg:flex lg:ml-6 lg:items-center lg:space-x-6 min-w-0">
              <router-link
                v-for="link in primaryNavLinks"
                :key="link.to"
                :to="link.to"
                class="nav-link"
                :class="{ 'nav-link-active': isActive(link) }"
                :aria-current="isActive(link) ? 'page' : undefined"
              >
                {{ link.label }}
              </router-link>
            </div>

            <!-- Anything that has not earned an inline slot lives one level down. -->
            <div
              v-if="moreNavLinks.length"
              ref="moreMenuRef"
              class="relative hidden lg:ml-6 lg:flex lg:items-center"
            >
              <button
                type="button"
                class="nav-link"
                aria-haspopup="true"
                aria-controls="more-menu"
                :aria-expanded="moreMenuOpen"
                :class="{ 'nav-link-active': moreMenuActive }"
                @click="moreMenuOpen = !moreMenuOpen"
              >
                More
                <component
                  :is="chevronDownIcon"
                  class="w-4 h-4 ml-1 transition-transform duration-200"
                  :class="{ 'rotate-180': moreMenuOpen }"
                />
              </button>

              <div
                v-if="moreMenuOpen"
                id="more-menu"
                class="absolute left-0 top-full z-30 mt-1 w-48 p-1 card"
              >
                <router-link
                  v-for="link in moreNavLinks"
                  :key="link.to"
                  :to="link.to"
                  class="block px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  :class="{ 'bg-primary-50 text-primary-700': isActive(link) }"
                  :aria-current="isActive(link) ? 'page' : undefined"
                  @click="moreMenuOpen = false"
                >
                  {{ link.label }}
                </router-link>
              </div>
            </div>
          </div>

          <!-- Right side -->
          <div class="flex flex-shrink-0 items-center gap-3 lg:gap-4">
            <!-- Health is a dot only: the wording sits in the title and an sr-only span,
                 so it can never widen the row. -->
            <div class="hidden lg:flex items-center" :title="healthLabel">
              <div
                class="w-2 h-2 rounded-full"
                :class="healthStatus === 'ok' ? 'bg-success-500' : 'bg-danger-500'"
              ></div>
              <span class="sr-only">{{ healthLabel }}</span>
            </div>

            <!-- Theme -->
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
              :aria-label="themeLabel"
              :title="themeLabel"
              @click="setNextTheme"
            >
              <component :is="themeIcon" class="h-5 w-5" />
            </button>

            <!-- Session -->
            <div class="hidden lg:flex items-center gap-3">
              <router-link
                :to="{ name: 'Account' }"
                class="text-right hover:opacity-80"
                title="Account settings"
                :aria-current="$route.name === 'Account' ? 'page' : undefined"
              >
                <p class="text-sm text-gray-900">{{ userEmail }}</p>
                <!-- The role line is the least informative part of the block, so it is
                     the first thing to drop when the header gets tight. -->
                <p class="hidden xl:block text-xs text-gray-500">
                  {{ isAdmin ? 'Administrator' : 'User' }} · Account
                </p>
              </router-link>
              <button @click="signOut" class="btn btn-secondary text-sm">Sign out</button>
            </div>

            <!-- Mobile menu button -->
            <div class="lg:hidden">
              <button
                @click="mobileMenuOpen = !mobileMenuOpen"
                class="inline-flex items-center justify-center p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500"
                :aria-expanded="mobileMenuOpen"
                aria-controls="mobile-menu"
                :aria-label="mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'"
              >
                <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path v-if="!mobileMenuOpen" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                  <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Mobile menu: the same link arrays as the desktop row, so the list only has to
           be maintained once. -->
      <div v-if="mobileMenuOpen" id="mobile-menu" class="lg:hidden">
        <div class="pt-2 pb-3 space-y-1">
          <router-link
            v-for="link in mobileNavLinks"
            :key="link.to"
            :to="link.to"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': isActive(link) }"
            :aria-current="isActive(link) ? 'page' : undefined"
            @click="mobileMenuOpen = false"
          >
            {{ link.label }}
          </router-link>
          <button type="button" class="mobile-nav-link w-full text-left" @click="signOut">
            Sign out
          </button>
        </div>
      </div>
    </nav>

    <!-- Main content -->
    <main id="main">
      <router-view />
    </main>

    <!-- Global loading overlay -->
    <div v-if="globalLoading" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-surface rounded-card p-6 flex items-center space-x-3">
        <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
        <span class="text-gray-700">Loading...</span>
      </div>
    </div>

    <ToastHost />
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { healthApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useBranding } from '@/composables/useBranding';
import { useTheme } from '@/composables/useTheme';
import BrandMark from '@/components/BrandMark.vue';
import ToastHost from '@/components/ToastHost.vue';

interface NavLink {
  label: string;
  to: string;
  /** Route names that keep this link highlighted - a detail route keeps its list lit. */
  activeFor: string[];
}

// State
const mobileMenuOpen = ref(false);
const moreMenuOpen = ref(false);
const moreMenuRef = ref<HTMLElement | null>(null);
const healthStatus = ref<'ok' | 'error'>('ok');
const globalLoading = ref(false);

const route = useRoute();
const router = useRouter();
const { state, isAdmin, logout } = useAuth();

// The desktop row carries only the daily working set; the rest goes behind "More".
const primaryNavLinks: NavLink[] = [
  { label: 'Dashboard', to: '/', activeFor: ['Dashboard'] },
  { label: 'Reports', to: '/reports', activeFor: ['Reports', 'ReportDetail'] },
  { label: 'Forensics', to: '/forensics', activeFor: ['Forensics', 'ForensicDetail'] },
  { label: 'Domains', to: '/domains', activeFor: ['Domains'] },
];

const accountNavLink: NavLink = { label: 'Account', to: '/account', activeFor: ['Account'] };

// Derived from isAdmin rather than declared per role, so a non-admin simply gets a
// shorter menu instead of a second hardcoded list.
const moreNavLinks = computed<NavLink[]>(() => [
  { label: 'Processing Logs', to: '/processing-logs', activeFor: ['ProcessingLogs'] },
  ...(isAdmin.value
    ? [
        { label: 'Settings', to: '/admin/settings', activeFor: ['AdminSettings'] },
        { label: 'Users', to: '/admin/users', activeFor: ['AdminUsers'] },
        { label: 'Identity providers', to: '/admin/providers', activeFor: ['AdminProviders'] },
      ]
    : []),
]);

// The mobile panel is the desktop row plus the overflow plus Account: below lg the
// session block is hidden, so Account has to be reachable from here.
const mobileNavLinks = computed<NavLink[]>(() => [
  ...primaryNavLinks,
  ...moreNavLinks.value,
  accountNavLink,
]);

const isActive = (link: NavLink) => link.activeFor.includes(String(route.name));

const moreMenuActive = computed(() => moreNavLinks.value.some(isActive));

const branding = useBranding();
branding.load();

const { theme, nextTheme, setNextTheme } = useTheme();

const userEmail = computed(() => state.user?.email ?? '');

const themeIcons = {
  system: () =>
    h('svg', { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
      h('path', { d: 'M8 20h8M12 16v4' }),
    ]),
  light: () =>
    h('svg', { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('circle', { cx: 12, cy: 12, r: 4 }),
      h('path', { d: 'M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4' }),
    ]),
  dark: () =>
    h('svg', { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('path', { d: 'M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z' }),
    ]),
};

const themeIcon = computed(() => themeIcons[theme.value]);
const themeLabel = computed(
  () => `Theme: ${theme.value}. Switch to ${nextTheme.value}.`,
);

// The chevron rotates via the template's class binding; declared with h() to match the
// theme icons rather than adding another inline svg to the header markup.
const chevronDownIcon = () =>
  h(
    'svg',
    {
      fill: 'none',
      viewBox: '0 0 24 24',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    [h('path', { d: 'm6 9 6 6 6-6' })],
  );

// Health wording lives in the dot's title/sr-only text, so status stays a two-line
// concern here rather than three copies of the ternary in the template.
const healthLabel = computed(() =>
  healthStatus.value === 'ok' ? 'Parser online' : 'Parser offline',
);

const signOut = async () => {
  await logout();
  await router.push({ name: 'Login' });
};

// Closing on route change means a click on a panel item can never leave the panel
// hanging over the page it just navigated to.
watch(
  () => route.fullPath,
  () => {
    moreMenuOpen.value = false;
  },
);

// The panel is a disclosure, not a focus trap, so pointer-outside and Escape both
// dismiss it. Bound on document because a click on the page body must close it too.
const onDocumentPointerDown = (event: MouseEvent) => {
  if (moreMenuRef.value && !moreMenuRef.value.contains(event.target as Node)) {
    moreMenuOpen.value = false;
  }
};

const onDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    moreMenuOpen.value = false;
  }
};

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
  stopHealthChecks();
});

// Health check
const checkHealth = async () => {
  if (!state.user) {
    return;
  }

  try {
    await healthApi.check();
    healthStatus.value = 'ok';
  } catch (error) {
    healthStatus.value = 'error';
    console.warn('Health check failed:', error);
  }
};

// Periodic health check
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;

const startHealthChecks = () => {
  stopHealthChecks();
  checkHealth();
  healthCheckInterval = setInterval(checkHealth, 30000);
};

const stopHealthChecks = () => {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = undefined;
  }
};

// Only poll while there is a session: /health is public, but an anonymous login page
// has no reason to report the parser's state, and it keeps the noise down.
watch(
  () => state.user,
  (user) => (user ? startHealthChecks() : stopHealthChecks()),
  { immediate: true }
);
</script>

<style scoped>
.nav-link {
  @apply inline-flex items-center px-1 pt-1 border-b-2 border-transparent text-sm font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors duration-200;
}

.nav-link-active {
  @apply border-primary-500 text-primary-600;
}

.mobile-nav-link {
  @apply block pl-3 pr-4 py-2 border-l-4 border-transparent text-base font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-50 hover:border-gray-300 transition-colors duration-200;
}

.mobile-nav-link-active {
  @apply bg-primary-50 border-primary-500 text-primary-700;
}
</style>
