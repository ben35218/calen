<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Households</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Identity, membership, owned add-ons, and encryption health. Household names are E2EE content
      (sealed at the plaintext drop), so encrypted households are identified by owner + id. Add-ons
      are owned household-wide; AI usage and credits are per-user — see
      <router-link to="/ai-usage">AI usage</router-link> and
      <router-link to="/billing">Billing</router-link>.
    </p>

    <div class="d-flex flex-wrap mb-4" style="gap: 12px">
      <v-chip color="success" variant="tonal">E2EE live: {{ stats.live }}</v-chip>
      <v-chip v-if="stats.attention" color="warning" variant="tonal">Needs attention: {{ stats.attention }}</v-chip>
    </div>

    <v-text-field
      v-model="search" placeholder="Search by household, member email or add-on (e.g. Trips)" prepend-inner-icon="mdi-magnify"
      density="comfortable" variant="outlined" hide-details clearable class="mb-4" style="max-width: 420px"
      @update:model-value="syncQuery" />

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="loading" type="table-row@6" />
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th style="width: 40px"></th>
              <th>Household</th>
              <th class="text-center">Members</th>
              <th>Add-ons</th>
              <th class="text-center">E2EE</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="h in filtered" :key="h._id">
              <tr>
                <td>
                  <v-btn :icon="expanded === h._id ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    size="x-small" variant="text" @click="toggle(h._id)" />
                </td>
                <td>
                  <div class="font-weight-medium">{{ displayName(h) }}</div>
                  <div class="text-caption text-medium-emphasis">
                    <span :title="String(h._id)">{{ shortId(h._id) }}</span>
                    <v-icon v-if="!h.name" icon="mdi-lock" size="x-small" class="ml-1" title="Name is E2EE content" />
                  </div>
                </td>
                <td class="text-center">{{ h.memberCount }}</td>
                <td>
                  <!-- Household-owned set; paid purchases tinted, free claims neutral. -->
                  <template v-if="h.addons?.length">
                    <v-chip v-for="a in sortAddons(h.addons)" :key="a" size="x-small"
                      :color="addonPaid(a) ? 'primary' : 'default'" variant="tonal" class="mr-1">
                      {{ addonLabel(a) }}
                    </v-chip>
                  </template>
                  <span v-else class="text-medium-emphasis text-caption">—</span>
                </td>
                <td class="text-center">
                  <v-chip v-if="h.e2eeActive" size="x-small" color="success" variant="tonal">Live</v-chip>
                  <v-chip v-else-if="h.ready" size="x-small" color="primary" variant="tonal">Ready</v-chip>
                  <v-chip v-else-if="h.blockers != null" size="x-small" color="warning" variant="tonal">
                    {{ h.blockers }} blocker{{ h.blockers === 1 ? '' : 's' }}
                  </v-chip>
                  <span v-else class="text-medium-emphasis text-caption">off</span>
                  <div v-if="h.total" class="text-caption text-medium-emphasis">{{ h.enrolled }}/{{ h.total }} keys</div>
                </td>
                <td class="text-caption">{{ fmtDate(h.createdAt) }}</td>
                <td class="text-right">
                  <v-btn size="small" variant="text" @click="openDetail(h)">Encryption</v-btn>
                </td>
              </tr>
              <!-- Member roster: who's in the household + their per-user billing state. -->
              <tr v-if="expanded === h._id">
                <td colspan="7" class="expanded-cell">
                  <v-table density="compact" class="bg-transparent my-1">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Name</th>
                        <th>Role</th>
                        <th>Unlock</th>
                        <th class="text-right">Credits</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="m in h.members" :key="m._id">
                        <td>
                          {{ m.email }}
                          <v-chip v-if="m.isOwner" size="x-small" variant="tonal" class="ml-1">owner</v-chip>
                        </td>
                        <td>{{ m.name || '—' }}</td>
                        <td><v-chip size="x-small" :color="m.role === 'admin' ? 'primary' : 'default'" variant="tonal">{{ m.role }}</v-chip></td>
                        <td>
                          <v-chip size="x-small" :color="m.appUnlocked ? 'success' : 'default'" variant="tonal">
                            {{ m.appUnlocked ? 'Unlocked' : 'Locked' }}
                          </v-chip>
                        </td>
                        <td class="text-right" :class="m.creditBalance < 0 ? 'text-error font-weight-bold' : ''">
                          {{ m.creditBalance.toLocaleString() }}
                        </td>
                        <td class="text-right text-no-wrap">
                          <v-btn size="x-small" variant="text" :to="{ path: '/billing', query: { q: m.email } }">Billing</v-btn>
                          <v-btn size="x-small" variant="text" :to="{ path: '/ai-usage', query: { q: m.email } }">AI usage</v-btn>
                        </td>
                      </tr>
                      <tr v-if="!h.members.length">
                        <td colspan="6" class="text-medium-emphasis text-caption py-2">No members.</td>
                      </tr>
                    </tbody>
                  </v-table>
                </td>
              </tr>
            </template>
            <tr v-if="!filtered.length">
              <td colspan="7" class="text-medium-emphasis py-4">
                No households found{{ search ? ' — try clearing the search' : '' }}.
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- Per-member encryption health. -->
    <v-dialog v-model="detail.show" max-width="720">
      <v-card rounded="lg">
        <v-card-title class="d-flex align-center">
          {{ detail.household ? displayName(detail.household) : '' }}
          <v-spacer />
          <v-chip v-if="detail.household?.e2eeActive" size="small" color="success" variant="tonal">Live</v-chip>
          <v-chip v-else-if="detail.data?.ready" size="small" color="primary" variant="tonal">Ready</v-chip>
          <v-chip v-else-if="detail.data" size="small" color="warning" variant="tonal">Not ready</v-chip>
        </v-card-title>
        <v-card-text>
          <div v-if="detail.loading" class="text-center py-6"><v-progress-circular indeterminate color="primary" /></div>
          <template v-else-if="detail.data">
            <v-table density="compact" class="mb-4">
              <thead>
                <tr><th>Member</th><th class="text-center">Enrolled</th><th class="text-center">Key</th><th>App</th></tr>
              </thead>
              <tbody>
                <tr v-for="m in detail.data.members" :key="m._id">
                  <td>
                    {{ m.email }}
                    <v-chip v-if="m.isOwner" size="x-small" variant="tonal" class="ml-1">owner</v-chip>
                  </td>
                  <td class="text-center">
                    <v-icon :icon="m.enrolled ? 'mdi-check-circle' : 'mdi-close-circle'"
                      :color="m.enrolled ? 'success' : 'error'" size="small" />
                  </td>
                  <td class="text-center">
                    <v-icon :icon="m.keyCurrent ? 'mdi-check-circle' : 'mdi-alert-circle'"
                      :color="m.keyCurrent ? 'success' : 'warning'" size="small" />
                    <span class="text-caption ml-1">{{ m.keyVersion ?? '—' }}</span>
                  </td>
                  <td class="text-caption">{{ m.clientVersion || '—' }}<span v-if="m.clientPlatform" class="text-medium-emphasis"> ({{ m.clientPlatform }})</span></td>
                </tr>
              </tbody>
            </v-table>
            <div v-if="detail.data.reasons?.length">
              <div class="text-subtitle-2 mb-1">Blockers</div>
              <v-alert v-for="(r, i) in detail.data.reasons" :key="i" type="warning" variant="tonal" density="compact" class="mb-1">
                {{ r }}
              </v-alert>
            </div>
            <v-alert v-else type="success" variant="tonal" density="compact">All members enrolled and current.</v-alert>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-btn v-if="detail.data && !detail.data.ready" color="primary" variant="tonal"
            prepend-icon="mdi-bell-ring" :loading="nudging" @click="nudge">
            Nudge blocking members
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="detail.show = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" :timeout="3500" />
  </v-container>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { monetizationApi, adminApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { fmtDate } from '../lib/format';
import { addonLabel, addonPaid, sortAddons } from '../lib/addons';
import SnackbarHost from '../components/SnackbarHost.vue';

const route = useRoute();
const router = useRouter();
const { snack, notify, success, fromError } = useSnackbar();

const loading = ref(true);
const households = ref([]);
const search = ref(typeof route.query.q === 'string' ? route.query.q : '');
const expanded = ref(typeof route.query.h === 'string' ? route.query.h : null);
const detail = ref({ show: false, loading: false, data: null, household: null });
const nudging = ref(false);

// Encrypted households have no plaintext name — identify by owner, per the C2
// runbook ("admin/support identify households by id").
function displayName(h) {
  if (h.name) return h.name;
  if (h.ownerEmail) return `${h.ownerEmail}'s household`;
  return `Household ${shortId(h._id)}`;
}
function shortId(id) {
  return `${String(id).slice(0, 6)}…${String(id).slice(-4)}`;
}

const filtered = computed(() => {
  const q = (search.value || '').trim().toLowerCase();
  if (!q) return households.value;
  return households.value.filter((h) =>
    (h.name || '').toLowerCase().includes(q)
    || (h.ownerEmail || '').toLowerCase().includes(q)
    || h.members.some((m) => m.email.toLowerCase().includes(q))
    || (h.addons || []).some((a) => a.includes(q) || addonLabel(a).toLowerCase().includes(q)));
});

const stats = computed(() => ({
  live: households.value.filter((h) => h.e2eeActive).length,
  attention: households.value.filter((h) => !h.e2eeActive || (h.blockers || 0) > 0).length,
}));

function syncQuery() {
  const query = { ...route.query };
  if (search.value) query.q = search.value; else delete query.q;
  if (expanded.value) query.h = expanded.value; else delete query.h;
  router.replace({ query });
}

function toggle(id) {
  expanded.value = expanded.value === id ? null : id;
  syncQuery();
}

async function load() {
  loading.value = true;
  try {
    // Identity/membership and encryption readiness come from two surfaces; join on id.
    const [meta, e2ee] = await Promise.all([monetizationApi.households(), adminApi.e2ee()]);
    const readinessById = Object.fromEntries(e2ee.data.map((h) => [String(h._id), h]));
    households.value = meta.data.map((h) => {
      const r = readinessById[String(h._id)] || {};
      return { ...h, ready: r.ready, enrolled: r.enrolled, total: r.total, blockers: r.blockers };
    });
  } catch (e) {
    fromError(e, 'Failed to load households');
  } finally {
    loading.value = false;
  }
}

async function openDetail(h) {
  detail.value = { show: true, loading: true, data: null, household: h };
  try {
    const { data } = await adminApi.e2eeDetail(h._id);
    detail.value.data = data;
  } catch (e) {
    fromError(e, 'Failed to load encryption details');
    detail.value.show = false;
  } finally {
    detail.value.loading = false;
  }
}

async function nudge() {
  const h = detail.value.household;
  if (!h) return;
  nudging.value = true;
  try {
    const { data } = await adminApi.nudge(h._id);
    if (data.blocking === 0) notify('No blocking members to nudge.', 'info');
    else if (data.notified === 0) notify(`${data.blocking} blocking, but none had push enabled.`, 'warning');
    else success(`Nudged ${data.notified} of ${data.blocking} blocking member(s).`);
  } catch (e) {
    fromError(e, 'Failed to send nudge');
  } finally {
    nudging.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.expanded-cell {
  background: rgba(var(--v-theme-on-surface), 0.05);
}
</style>
