import axios from 'axios';

// Mirrors the consumer client's axios pattern, but:
//   - baseURL is env-driven (absolute in prod, proxied '/api' in dev)
//   - token lives under a distinct key so it never collides with the consumer
//     web app on the same machine.
const api = axios.create({ baseURL: (import.meta.env.VITE_API_BASE_URL || '') + '/api' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('hc_admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => {
    // Sliding session: the server reissues the JWT past its half-life via this
    // header (exposed through CORS); persist it so active admins stay signed in.
    const refreshed = res.headers['x-refreshed-token'];
    if (refreshed) localStorage.setItem('hc_admin_token', refreshed);
    return res;
  },
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('hc_admin_token');
      if (window.location.pathname !== '/login') {
        // Preserve where the admin was so login can bounce them straight back.
        const here = window.location.pathname + window.location.search;
        window.location.href = '/login?redirect=' + encodeURIComponent(here);
      }
    }
    return Promise.reject(err);
  }
);

export default api;

export const authApi = {
  login: (data) => api.post('/auth/login', data),
  me: () => api.get('/auth/me'),
};

// Admin-gated monetization surfaces (requireAuth + requireAdmin on the server).
export const monetizationApi = {
  get: () => api.get('/monetization-config'),
  update: (data) => api.put('/monetization-config', data),
  households: () => api.get('/monetization-config/households'),
  users: () => api.get('/monetization-config/users'),
  setUnlock: (userId, unlocked) => api.post('/monetization-config/unlock', { userId, unlocked }),
  adjustCredits: (userId, credits, note) => api.post('/monetization-config/credits', { userId, credits, note }),
};

// Admin ops surfaces: users, E2EE readiness, audit log (requireAdmin-gated).
// `users` and `audit` return { items, total, page, pageSize }.
export const adminApi = {
  users: (params) => api.get('/admin/users', { params }),
  setRole: (id, role) => api.post(`/admin/users/${id}/role`, { role }),
  e2ee: () => api.get('/admin/e2ee'),
  e2eeDetail: (householdId) => api.get(`/admin/e2ee/${householdId}`),
  nudge: (householdId) => api.post(`/admin/e2ee/${householdId}/nudge`),
  audit: (params) => api.get('/admin/audit', { params }),
  moderation: (params) => api.get('/admin/moderation', { params }),
  setReportStatus: (id, status) => api.post(`/admin/moderation/${id}/status`, { status }),
  // In-app feedback triage queue (questions / bugs / ideas). `feedback` returns
  // { items, total, newCount, page, pageSize }.
  feedback: (params) => api.get('/admin/feedback', { params }),
  setFeedbackStatus: (id, status) => api.post(`/admin/feedback/${id}/status`, { status }),
  // Do-not-call list for outbound AI calls. `dnc` returns { items, total, page, pageSize }.
  dnc: (params) => api.get('/admin/dnc', { params }),
  addDnc: (phone, note) => api.post('/admin/dnc', { phone, note }),
  releaseDnc: (id) => api.delete(`/admin/dnc/${id}`),
};

// Email surfaces: the outbound no-reply@ send log and the live support@
// mailbox (requireAdmin-gated). Support calls hit IMAP on the server, so they
// are noticeably slower than the Mongo-backed endpoints.
export const emailApi = {
  log: (params) => api.get('/admin/email/log', { params }),
  logStats: () => api.get('/admin/email/log/stats'),
  retry: (id) => api.post(`/admin/email/log/${id}/retry`),
  cancel: (id) => api.post(`/admin/email/log/${id}/cancel`),
  reconcile: () => api.post('/admin/email/reconcile'),
  // Lifecycle catalog (the send map + admin-editable metadata).
  catalog: () => api.get('/admin/email/catalog'),
  saveCatalog: (data) => api.put('/admin/email/catalog', data),
  preview: (key) => api.get(`/admin/email/catalog/${key}/preview`),
  // Suppression list. `suppressions` returns { items, total, page, pageSize }.
  suppressions: (params) => api.get('/admin/email/suppressions', { params }),
  addSuppression: (email, note) => api.post('/admin/email/suppressions', { email, note }),
  releaseSuppression: (id) => api.delete(`/admin/email/suppressions/${id}`),
  supportStatus: () => api.get('/admin/email/support/status'),
  supportMessages: (params) => api.get('/admin/email/support/messages', { params }),
  supportMessage: (uid, mailbox) => api.get(`/admin/email/support/messages/${uid}`, { params: { mailbox } }),
  supportReply: (uid, payload) => api.post(`/admin/email/support/messages/${uid}/reply`, payload),
  supportMove: (uid, payload) => api.post(`/admin/email/support/messages/${uid}/move`, payload),
  supportSeen: (uid, payload) => api.post(`/admin/email/support/messages/${uid}/seen`, payload),
};

// Release QA: test-case library, releases, runs and sign-off (requireAdmin-gated).
// The repo is the source of truth for cases — `importCases` uploads a plan
// document's TEXT (read client-side), and is called twice: once with
// dryRun:true to show the diff, then again to commit it.
// Spec: specs/features/release-qa.md.
export const qaApi = {
  releases: (params) => api.get('/admin/qa/releases', { params }),
  createRelease: (data) => api.post('/admin/qa/releases', data),
  release: (id) => api.get(`/admin/qa/releases/${id}`),
  updateRelease: (id, data) => api.put(`/admin/qa/releases/${id}`, data),
  summary: (id) => api.get(`/admin/qa/releases/${id}/summary`),
  signOff: (id, note) => api.post(`/admin/qa/releases/${id}/sign-off`, { note }),

  cases: (params) => api.get('/admin/qa/cases', { params }),
  createCase: (data) => api.post('/admin/qa/cases', data),
  updateCase: (id, data) => api.put(`/admin/qa/cases/${id}`, data),
  importCases: (data) => api.post('/admin/qa/cases/import', data),

  runs: (params) => api.get('/admin/qa/runs', { params }),
  createRun: (data) => api.post('/admin/qa/runs', data),
  run: (id) => api.get(`/admin/qa/runs/${id}`),
  saveResults: (id, results) => api.post(`/admin/qa/runs/${id}/results`, { results }),
  completeRun: (id, status) => api.post(`/admin/qa/runs/${id}/complete`, { status }),
};

// Content-blind product-usage analytics (requireAdmin-gated).
export const analyticsApi = {
  overview: () => api.get('/admin/analytics/overview'),
  growth: (weeks) => api.get('/admin/analytics/growth', { params: { weeks } }),
  platforms: () => api.get('/admin/analytics/platforms'),
  usage: (weeks) => api.get('/admin/analytics/usage', { params: { weeks } }),
  activity: (weeks) => api.get('/admin/analytics/activity', { params: { weeks } }),
  retention: (weeks) => api.get('/admin/analytics/retention', { params: { weeks } }),
  tokens: (weeks) => api.get('/admin/analytics/tokens', { params: { weeks } }),
};
