import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

// Import views
import DashboardView from './views/DashboardView.vue'
import ReportListView from './views/ReportListView.vue'
import ProcessingLogsView from './views/ProcessingLogsView.vue'
import ForensicsView from './views/ForensicsView.vue'
import LoginView from './views/LoginView.vue'
import AdminSettingsView from './views/AdminSettingsView.vue'
import AdminUsersView from './views/AdminUsersView.vue'
import AccountView from './views/AccountView.vue'
import { useAuth } from './composables/useAuth'
import { apiClient } from './api/client'

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without a session (the login page). */
    public?: boolean
    /** Requires role 'admin'. */
    admin?: boolean
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
    },
    {
      path: '/reports',
      name: 'Reports',
      component: ReportListView,
    },
    {
      path: '/forensics',
      name: 'Forensics',
      component: ForensicsView,
    },
    {
      path: '/forensics/:id',
      name: 'ForensicDetail',
      component: () => import('./views/ForensicDetailView.vue'),
      props: true,
    },
    {
      path: '/processing-logs',
      name: 'ProcessingLogs',
      component: ProcessingLogsView,
    },
    {
      path: '/admin/settings',
      name: 'AdminSettings',
      component: AdminSettingsView,
      meta: { admin: true },
    },
    {
      path: '/admin/users',
      name: 'AdminUsers',
      component: AdminUsersView,
      meta: { admin: true },
    },
    {
      path: '/account',
      name: 'Account',
      component: AccountView,
    },
    {
      path: '/login',
      name: 'Login',
      component: LoginView,
      meta: { public: true },
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

const app = createApp(App)
app.use(router)
app.mount('#app')
