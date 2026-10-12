<template>
  <div id="app">
    <a href="#main" class="skip-link">Skip to main content</a>

    <!-- Navigation -->
    <nav v-if="$route.name !== 'Login'" class="bg-surface shadow-sm border-b border-gray-200">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex">
            <!-- Logo -->
            <div class="flex-shrink-0 flex items-center">
              <router-link to="/" class="flex items-center space-x-2">
                <BrandMark class="w-8 h-8 text-accent" />
                <span class="text-xl font-bold text-gray-900">{{ branding.name }}</span>
              </router-link>
            </div>

            <!-- Navigation links -->
            <div class="hidden sm:ml-6 sm:flex sm:space-x-8">
              <router-link
                to="/"
                class="nav-link"
                :class="{ 'nav-link-active': $route.name === 'Dashboard' }"
                :aria-current="$route.name === 'Dashboard' ? 'page' : undefined"
              >
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                Dashboard
              </router-link>
              <router-link
                to="/reports"
                class="nav-link"
                :class="{ 'nav-link-active': $route.name === 'Reports' || $route.name === 'ReportDetail' }"
                :aria-current="
                  $route.name === 'Reports' || $route.name === 'ReportDetail' ? 'page' : undefined
                "
              >
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Reports
              </router-link>
              <router-link
                to="/processing-logs"
                class="nav-link"
                :class="{ 'nav-link-active': $route.name === 'ProcessingLogs' }"
                :aria-current="$route.name === 'ProcessingLogs' ? 'page' : undefined"
              >
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 17v-2h6v2a2 2 0 002 2h1a2 2 0 002-2V7a2 2 0 00-2-2h-1a2 2 0 00-2 2v2H9V7a2 2 0 00-2-2H6a2 2 0 00-2 2v10a2 2 0 002 2h1a2 2 0 002-2z"
                  />
                </svg>
                Processing Logs
              </router-link>
              <router-link
                to="/forensics"
                class="nav-link"
                :class="{ 'nav-link-active': $route.name === 'Forensics' || $route.name === 'ForensicDetail' }"
                :aria-current="
                  $route.name === 'Forensics' || $route.name === 'ForensicDetail' ? 'page' : undefined
                "
              >
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16a2 2 0 001.73 3z" />
                </svg>
                Forensics
              </router-link>
              <router-link
                to="/domains"
                class="nav-link"
                :class="{ 'nav-link-active': $route.name === 'Domains' }"
                :aria-current="$route.name === 'Domains' ? 'page' : undefined"
              >
                <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18a15 15 0 010-18z" />
                </svg>
                Domains
              </router-link>
              <template v-if="isAdmin">
                <router-link
                  to="/admin/settings"
                  class="nav-link"
                  :class="{ 'nav-link-active': $route.name === 'AdminSettings' }"
                  :aria-current="$route.name === 'AdminSettings' ? 'page' : undefined"
                >
                  <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Settings
                </router-link>
                <router-link
                  to="/admin/users"
                  class="nav-link"
                  :class="{ 'nav-link-active': $route.name === 'AdminUsers' }"
                  :aria-current="$route.name === 'AdminUsers' ? 'page' : undefined"
                >
                  <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  Users
                </router-link>
              </template>
            </div>
          </div>

          <!-- Right side -->
          <div class="flex items-center space-x-4">
            <!-- Health status -->
            <div class="hidden items-center space-x-2 sm:flex">
              <div
                class="w-2 h-2 rounded-full"
                :class="healthStatus === 'ok' ? 'bg-success-500' : 'bg-danger-500'"
              ></div>
              <span class="text-sm text-gray-600">
                {{ healthStatus === 'ok' ? 'Online' : 'Offline' }}
              </span>
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
            <div class="hidden items-center space-x-3 sm:flex">
              <router-link
                :to="{ name: 'Account' }"
                class="text-right hover:opacity-80"
                title="Account settings"
                :aria-current="$route.name === 'Account' ? 'page' : undefined"
              >
                <p class="text-sm text-gray-900">{{ userEmail }}</p>
                <p class="text-xs text-gray-500">
                  {{ isAdmin ? 'Administrator' : 'User' }} · Account
                </p>
              </router-link>
              <button @click="signOut" class="btn btn-secondary text-sm">Sign out</button>
            </div>

            <!-- Mobile menu button -->
            <div class="sm:hidden">
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

      <!-- Mobile menu -->
      <div v-if="mobileMenuOpen" id="mobile-menu" class="sm:hidden">
        <div class="pt-2 pb-3 space-y-1">
          <router-link
            to="/"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': $route.name === 'Dashboard' }"
            :aria-current="$route.name === 'Dashboard' ? 'page' : undefined"
            @click="mobileMenuOpen = false"
          >
            Dashboard
          </router-link>
          <router-link
            to="/reports"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': $route.name === 'Reports' || $route.name === 'ReportDetail' }"
            :aria-current="
              $route.name === 'Reports' || $route.name === 'ReportDetail' ? 'page' : undefined
            "
            @click="mobileMenuOpen = false"
          >
            Reports
          </router-link>
          <router-link
            to="/processing-logs"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': $route.name === 'ProcessingLogs' }"
            :aria-current="$route.name === 'ProcessingLogs' ? 'page' : undefined"
            @click="mobileMenuOpen = false"
          >
            Processing Logs
          </router-link>
          <router-link
            to="/forensics"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': $route.name === 'Forensics' || $route.name === 'ForensicDetail' }"
            :aria-current="
              $route.name === 'Forensics' || $route.name === 'ForensicDetail' ? 'page' : undefined
            "
            @click="mobileMenuOpen = false"
          >
            Forensics
          </router-link>
          <router-link
            to="/domains"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': $route.name === 'Domains' }"
            :aria-current="$route.name === 'Domains' ? 'page' : undefined"
            @click="mobileMenuOpen = false"
          >
            Domains
          </router-link>
          <router-link
            to="/account"
            class="mobile-nav-link"
            :class="{ 'mobile-nav-link-active': $route.name === 'Account' }"
            :aria-current="$route.name === 'Account' ? 'page' : undefined"
            @click="mobileMenuOpen = false"
          >
            Account
          </router-link>
          <template v-if="isAdmin">
            <router-link
              to="/admin/settings"
              class="mobile-nav-link"
              :class="{ 'mobile-nav-link-active': $route.name === 'AdminSettings' }"
              :aria-current="$route.name === 'AdminSettings' ? 'page' : undefined"
              @click="mobileMenuOpen = false"
            >
              Settings
            </router-link>
            <router-link
              to="/admin/users"
              class="mobile-nav-link"
              :class="{ 'mobile-nav-link-active': $route.name === 'AdminUsers' }"
              :aria-current="$route.name === 'AdminUsers' ? 'page' : undefined"
              @click="mobileMenuOpen = false"
            >
              Users
            </router-link>
          </template>
          <button
            type="button"
            class="mobile-nav-link w-full text-left"
            @click="signOut"
          >
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
import { computed, h, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { healthApi } from '@/api/client';
import { useAuth } from '@/composables/useAuth';
import { useBranding } from '@/composables/useBranding';
import { useTheme } from '@/composables/useTheme';
import BrandMark from '@/components/BrandMark.vue';
import ToastHost from '@/components/ToastHost.vue';

// State
const mobileMenuOpen = ref(false);
const healthStatus = ref<'ok' | 'error'>('ok');
const globalLoading = ref(false);

const router = useRouter();
const { state, isAdmin, logout } = useAuth();

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

const signOut = async () => {
  await logout();
  await router.push({ name: 'Login' });
};

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

onUnmounted(stopHealthChecks);
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
