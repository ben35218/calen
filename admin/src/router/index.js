import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/login', name: 'Login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
  { path: '/', redirect: '/monetization' },
  { path: '/insights', name: 'Insights', component: () => import('../views/InsightsView.vue') },
  { path: '/monetization', name: 'Monetization', component: () => import('../views/MonetizationConfigView.vue') },
  { path: '/households', name: 'Households', component: () => import('../views/HouseholdsView.vue') },
  { path: '/billing', name: 'Billing', component: () => import('../views/BillingView.vue') },
  { path: '/users', name: 'Users', component: () => import('../views/UsersView.vue') },
  { path: '/ai-usage', name: 'AiUsage', component: () => import('../views/AiUsageView.vue') },
  { path: '/support-inbox', name: 'SupportInbox', component: () => import('../views/SupportInboxView.vue') },
  { path: '/email-log', name: 'EmailLog', component: () => import('../views/EmailLogView.vue') },
  { path: '/email-lifecycle', name: 'EmailLifecycle', component: () => import('../views/EmailLifecycleView.vue') },
  // E2EE ops merged into Households once every household was born-encrypted;
  // keep the old path working for bookmarks.
  { path: '/e2ee', redirect: '/households' },
  { path: '/audit', name: 'Audit', component: () => import('../views/AuditLogView.vue') },
  { path: '/moderation', name: 'Moderation', component: () => import('../views/ModerationView.vue') },
  { path: '/do-not-call', name: 'DoNotCall', component: () => import('../views/DoNotCallView.vue') },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'Login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'Login' && auth.isLoggedIn) return { path: '/' };
  return true;
});

export default router;
