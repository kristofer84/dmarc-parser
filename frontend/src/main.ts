import { createApp, watch } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
// Self-hosted so the console does not reach out to a font CDN from an operator's browser.
import '@fontsource-variable/inter'
import './style.css'

// Import views
import DashboardView from './views/DashboardView.vue'
import ReportListView from './views/ReportListView.vue'
import ProcessingLogsView from './views/ProcessingLogsView.vue'
import ForensicsView from './views/ForensicsView.vue'
import DomainsView from './views/DomainsView.vue'
import LoginView from './views/LoginView.vue'
import AdminSettingsView from './views/AdminSettingsView.vue'
import AdminUsersView from './views/AdminUsersView.vue'
import AdminProvidersView from './views/AdminProvidersView.vue'
import GlossaryView from './views/GlossaryView.vue'
import AdminAuditView from './views/AdminAuditView.vue'
import TlsRptView from './views/TlsRptView.vue'
import AccountView from './views/AccountView.vue'
import { useAuth } from './composables/useAuth'
import { brandingName } from './composables/useBranding'
import { apiClient } from './api/client'

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without a session (the login page). */
    public?: boolean
    /** Requires role 'admin'. */
    admin?: boolean
    /** Page label used in the document title; falls back to the route name. */
    title?: string
  }
}

// Create router
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Dashboard',
      component: DashboardView,
      meta: { title: 'Dashboard' },
    },
    {
      path: '/reports',
      name: 'Reports',
      component: ReportListView,
      meta: { title: 'Reports' },
    },
    {
      // Missing until now: the report list and the processing log both push to /reports/:id,
      // and the nav already expected a 'ReportDetail' route name.
      path: '/reports/:id',
      name: 'ReportDetail',
      component: () => import('./views/ReportDetailView.vue'),
      props: true,
      meta: { title: 'Report' },
    },
    {
      path: '/forensics',
      name: 'Forensics',
      component: ForensicsView,
      meta: { title: 'Forensics' },
    },
    {
      path: '/forensics/:id',
      name: 'ForensicDetail',
      component: () => import('./views/ForensicDetailView.vue'),
      props: true,
      meta: { title: 'Forensic report' },
    },
    {
      path: '/processing-logs',
      name: 'ProcessingLogs',
      component: ProcessingLogsView,
      meta: { title: 'Processing logs' },
    },
    {
      path: '/domains',
      name: 'Domains',
      component: DomainsView,
      meta: { title: 'Domains' },
    },
    {
      path: '/admin/settings',
      name: 'AdminSettings',
      component: AdminSettingsView,
      meta: { admin: true, title: 'Settings' },
    },
    {
      path: '/admin/users',
      name: 'AdminUsers',
      component: AdminUsersView,
      meta: { admin: true, title: 'Users' },
    },
    {
      path: '/admin/providers',
      name: 'AdminProviders',
      component: AdminProvidersView,
      meta: { admin: true, title: 'Identity providers' },
    },
    {
      path: '/tls-reports',
      name: 'TlsRpt',
      component: TlsRptView,
      meta: { title: 'TLS reports' },
    },
    {
      path: '/glossary',
      name: 'Glossary',
      component: GlossaryView,
      meta: { title: 'Glossary' },
    },
    {
      path: '/admin/audit',
      name: 'AdminAudit',
      component: AdminAuditView,
      meta: { admin: true, title: 'Audit log' },
    },
    {
      path: '/account',
      name: 'Account',
      component: AccountView,
      meta: { title: 'Account' },
    },
    {
      path: '/login',
      name: 'Login',
      component: LoginView,
      meta: { public: true, title: 'Sign in' },
    },
  ],
})

const { state, fetchSession, clearSession } = useAuth()

// Any 401 from a data endpoint means the session went away (expired, revoked, or the
// password changed elsewhere): drop the local state so the guard sends the user to /login.
apiClient.setUnauthorizedHandler(() => {
  clearSession()
  if (router.currentRoute.value.name !== 'Login') {
    router.push({ name: 'Login', query: { redirect: router.currentRoute.value.fullPath } })
  }
})

router.beforeEach(async (to) => {
  if (!state.initialised) {
    await fetchSession()
  }

  if (to.meta.public) {
    return state.user ? { name: 'Dashboard' } : true
  }

  if (!state.user) {
    return { name: 'Login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }

  if (to.meta.admin && state.user.role !== 'admin') {
    return { name: 'Dashboard' }
  }

  // An administrator-issued password has to be replaced before the console is usable,
  // otherwise the reset flag on the account would never mean anything.
  if (state.user.mustChangePassword && to.name !== 'Account') {
    return { name: 'Account' }
  }

  return true
})

// The branding name may not have arrived yet (the fetch is async and may fail); the
// fallback matches what index.html ships so the title never flickers to something wrong.
const applyTitle = (to: { meta: { title?: unknown }; name?: unknown }): void => {
  const label = (to.meta.title as string | undefined) ?? (to.name as string | undefined)
  document.title = label ? `${label} · ${brandingName.value}` : brandingName.value
}

router.afterEach((to) => applyTitle(to))
// Branding resolves after the first navigation, so the suffix has to be re-applied when it does.
watch(brandingName, () => applyTitle(router.currentRoute.value))

const app = createApp(App)
app.use(router)
app.mount('#app')
