import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

// Import views
import DashboardView from './views/DashboardView.vue'
import ReportListView from './views/ReportListView.vue'
import ProcessingLogsView from './views/ProcessingLogsView.vue'

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
      path: '/processing-logs',
      name: 'ProcessingLogs',
      component: ProcessingLogsView,
    },
    {
      path: '/reports/:id',
      name: 'ReportDetail',
      component: () => import('./views/ReportDetailView.vue'),
      props: true,
    },
  ],
})

const app = createApp(App)
app.use(router)
app.mount('#app')