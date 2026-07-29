<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Billing</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-download" @click="exportCsv">Export CSV</v-btn>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Per-user monetization state: the one-time app unlock, the prepaid AI-credit balance, and
      the add-ons owned by the user's household (add-ons are household-wide).
      <strong>RevenueCat</strong> = state driven by real store purchases/webhooks;
      <strong>Manual</strong> = admin overrides. Payments are handled in the mobile app.
    </p>

    <div class="d-flex flex-wrap mb-4" style="gap: 12px">
      <v-chip variant="tonal">Users: {{ users.length }}</v-chip>
      <v-chip color="primary" variant="tonal">Unlocked: {{ stats.unlocked }}</v-chip>
      <v-chip color="success" variant="tonal">RevenueCat-linked: {{ stats.revenuecat }}</v-chip>
      <v-chip color="warning" variant="tonal">Negative balances: {{ stats.negative }}</v-chip>
      <v-chip color="secondary" variant="tonal">With add-ons: {{ stats.withAddons }}</v-chip>
    </div>

    <v-text-field
      v-model="search" placeholder="Search by name, email or add-on (e.g. Trips)" prepend-inner-icon="mdi-magnify"
      density="comfortable" variant="outlined" hide-details clearable class="mb-4" style="max-width: 420px"
      @update:model-value="syncQuery" />

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="loading" type="table-row@8" />
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th>User</th>
              <th>Unlock</th>
              <th class="text-right">Credits</th>
              <th>Add-ons</th>
              <th>Source</th>
              <th>RevenueCat ID</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in filtered" :key="u._id">
              <td>
                <div class="font-weight-medium">{{ u.name || '—' }}</div>
                <router-link :to="{ path: '/ai-usage', query: { q: u.email } }" class="cross-link text-caption text-medium-emphasis"
                  title="Open in AI usage">
                  {{ u.email }}
                </router-link>
              </td>
              <td>
                <v-chip size="small" :color="u.appUnlocked ? 'success' : 'default'" variant="tonal">
                  {{ u.appUnlocked ? 'Unlocked' : 'Locked' }}
                </v-chip>
              </td>
              <td class="text-right" :class="u.creditBalance < 0 ? 'text-error font-weight-bold' : 'font-weight-medium'">
                {{ u.creditBalance.toLocaleString() }}
              </td>
              <td>
                <!-- Household-owned set; paid purchases tinted, free claims neutral. -->
                <template v-if="u.addons?.length">
                  <v-chip v-for="a in sortAddons(u.addons)" :key="a" size="x-small"
                    :color="addonPaid(a) ? 'primary' : 'default'" variant="tonal" class="mr-1">
                    {{ addonLabel(a) }}
                  </v-chip>
                </template>
                <span v-else class="text-medium-emphasis text-caption">—</span>
              </td>
              <td>
                <v-chip size="small" :color="u.billingSource === 'revenuecat' ? 'success' : 'warning'" variant="tonal">
                  {{ u.billingSource === 'revenuecat' ? 'RevenueCat' : 'Manual' }}
                </v-chip>
              </td>
              <td class="text-caption">
                <code v-if="u.revenueCatId">{{ u.revenueCatId }}</code>
                <span v-else class="text-medium-emphasis">—</span>
              </td>
              <td class="text-right text-no-wrap">
                <v-btn size="small" variant="text" :loading="busyId === u._id + ':unlock'" @click="askToggleUnlock(u)">
                  {{ u.appUnlocked ? 'Revoke unlock' : 'Grant unlock' }}
                </v-btn>
                <v-btn size="small" variant="text" @click="openAdjust(u)">Adjust credits</v-btn>
              </td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="7" class="text-medium-emphasis py-4">
                No users found{{ search ? ' — try clearing the search' : '' }}.
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- Revoking takes away something the user paid for — always confirm. -->
    <ConfirmDialog
      v-model="revokeOpen" title="Revoke app unlock?" confirm-text="Revoke unlock" color="error"
      :loading="!!busyId" @confirm="applyToggleUnlock">
      <template v-if="revokeUser">
        <strong>{{ revokeUser.name || revokeUser.email }}</strong> will lose access to the app on their
        next launch.
        <span v-if="revokeUser.billingSource === 'revenuecat'">
          Their unlock is <strong>RevenueCat-linked</strong> (a real store purchase) — the next webhook
          sync may restore it.
        </span>
      </template>
    </ConfirmDialog>

    <!-- Credit adjustment dialog: ledgered (kind 'admin') + audited server-side. -->
    <v-dialog v-model="adjustOpen" max-width="420">
      <v-card v-if="adjustUser" rounded="lg">
        <v-card-title class="text-subtitle-1 font-weight-bold">Adjust credits — {{ adjustUser.name || adjustUser.email }}</v-card-title>
        <v-card-text>
          <p class="text-caption text-medium-emphasis mb-3">
            Current balance: <strong>{{ adjustUser.creditBalance.toLocaleString() }}</strong>.
            Positive adds, negative removes. Logged to the credit ledger and audit trail.
          </p>
          <v-text-field v-model.number="adjustAmount" label="Credits (±)" type="number" density="compact" variant="outlined" class="mb-2" hide-details />
          <v-text-field v-model="adjustNote" label="Note (why)" density="compact" variant="outlined" hide-details />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="adjustOpen = false">Cancel</v-btn>
          <v-btn color="primary" :loading="busyId === adjustUser._id + ':credits'"
            :disabled="!adjustAmount || !adjustNote.trim()" @click="submitAdjust">Apply</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { monetizationApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { downloadCsv } from '../lib/csv';
import { addonLabel, addonPaid, sortAddons } from '../lib/addons';
import SnackbarHost from '../components/SnackbarHost.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const route = useRoute();
const router = useRouter();
const { snack, success, fromError } = useSnackbar();
const loading = ref(true);
const users = ref([]);
const search = ref(typeof route.query.q === 'string' ? route.query.q : '');
const busyId = ref('');

const revokeOpen = ref(false);
const revokeUser = ref(null);

const adjustOpen = ref(false);
const adjustUser = ref(null);
const adjustAmount = ref(null);
const adjustNote = ref('');

const filtered = computed(() => {
  const q = (search.value || '').trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter(
    (u) => (u.name || '').toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q)
      || (u.addons || []).some((a) => a.includes(q) || addonLabel(a).toLowerCase().includes(q))
  );
});

const stats = computed(() => ({
  unlocked: users.value.filter((u) => u.appUnlocked).length,
  revenuecat: users.value.filter((u) => u.billingSource === 'revenuecat').length,
  negative: users.value.filter((u) => u.creditBalance < 0).length,
  withAddons: users.value.filter((u) => (u.addons || []).length).length,
}));

function syncQuery() {
  const query = { ...route.query };
  if (search.value) query.q = search.value; else delete query.q;
  router.replace({ query });
}

async function load() {
  loading.value = true;
  try {
    const { data } = await monetizationApi.users();
    users.value = data;
  } catch (e) {
    fromError(e, 'Failed to load billing data');
  } finally {
    loading.value = false;
  }
}

// Granting is additive and instantly visible; revoking gets a confirm.
function askToggleUnlock(u) {
  if (u.appUnlocked) {
    revokeUser.value = u;
    revokeOpen.value = true;
  } else {
    toggleUnlock(u);
  }
}

async function applyToggleUnlock() {
  await toggleUnlock(revokeUser.value);
  revokeOpen.value = false;
}

async function toggleUnlock(u) {
  busyId.value = u._id + ':unlock';
  try {
    const { data } = await monetizationApi.setUnlock(u._id, !u.appUnlocked);
    u.appUnlocked = data.appUnlocked;
    success(`${u.name || u.email}: unlock ${data.appUnlocked ? 'granted' : 'revoked'}`);
  } catch (e) {
    fromError(e, 'Failed to update unlock');
  } finally {
    busyId.value = '';
  }
}

function openAdjust(u) {
  adjustUser.value = u;
  adjustAmount.value = null;
  adjustNote.value = '';
  adjustOpen.value = true;
}

async function submitAdjust() {
  const u = adjustUser.value;
  busyId.value = u._id + ':credits';
  try {
    const { data } = await monetizationApi.adjustCredits(u._id, adjustAmount.value, adjustNote.value);
    if (data.creditBalance != null) u.creditBalance = data.creditBalance;
    adjustOpen.value = false;
    success(`${u.name || u.email}: credits adjusted`);
  } catch (e) {
    fromError(e, 'Failed to adjust credits');
  } finally {
    busyId.value = '';
  }
}

function exportCsv() {
  downloadCsv('billing.csv', [
    { label: 'Email', key: 'email' },
    { label: 'Name', key: 'name' },
    { label: 'Unlocked', value: (u) => (u.appUnlocked ? 'yes' : 'no') },
    { label: 'Credits', key: 'creditBalance' },
    { label: 'Add-ons', value: (u) => sortAddons(u.addons).map(addonLabel).join('; ') },
    { label: 'Source', key: 'billingSource' },
    { label: 'RevenueCat ID', key: 'revenueCatId' },
    { label: 'Created', key: 'createdAt' },
  ], filtered.value);
}

onMounted(load);
</script>

<style scoped>
.cross-link { color: inherit; text-decoration: none; }
.cross-link:hover { text-decoration: underline; }
</style>
