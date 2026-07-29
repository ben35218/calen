<template>
  <v-container class="py-6" style="max-width: 1200px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">AI usage</h1>
      <v-spacer />
      <v-select
        v-model="weeks" :items="[4, 8, 12, 26]" label="Weeks" density="compact" variant="outlined"
        hide-details style="max-width: 110px" @update:model-value="load" />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>
    <p class="text-caption text-medium-emphasis mb-4" v-if="resetAt">
      Current analytics week resets {{ new Date(resetAt).toLocaleString() }}. Token counts are per
      user; enforcement is each user's prepaid credit balance.
    </p>

    <v-row dense class="mb-4">
      <v-col cols="12" sm="6" md="3">
        <v-card rounded="lg" variant="tonal" color="primary">
          <v-card-text>
            <div class="text-overline">Tokens this week (fleet)</div>
            <div class="text-h4 font-weight-bold">{{ fmt(fleet.tokensThisPeriod) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <v-card rounded="lg" variant="tonal" color="primary">
          <v-card-text>
            <div class="text-overline">Call time this week (fleet)</div>
            <div class="text-h4 font-weight-bold">{{ mins(fleet.callSecondsThisPeriod) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <v-card rounded="lg" variant="tonal" :color="fleet.blockedThisPeriod ? 'warning' : 'default'">
          <v-card-text>
            <div class="text-overline">Blocked attempts this week</div>
            <div class="text-h4 font-weight-bold">{{ fmt(fleet.blockedThisPeriod) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <v-card rounded="lg" variant="tonal" :color="fleet.flaggedUsers ? 'error' : 'default'">
          <v-card-text>
            <div class="text-overline">Flagged users</div>
            <div class="text-h4 font-weight-bold">{{ fleet.flaggedUsers }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-alert v-if="flagged.length" type="warning" variant="tonal" rounded="lg" class="mb-4" density="comfortable">
      <div class="font-weight-medium mb-1">Possible abuse — worth a look</div>
      <div v-for="u in flagged" :key="u._id" class="text-body-2">
        {{ u.email }} —
        <v-chip v-for="f in u.flags" :key="f" size="x-small" :color="flagColor(f)" variant="flat" class="mr-1">
          {{ flagLabel(f) }}
        </v-chip>
        <span class="text-medium-emphasis">
          {{ fmt(u.tokens) }} tokens this week<span v-if="u.blocked">, {{ u.blocked }} blocked attempts</span>
        </span>
      </div>
    </v-alert>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-text-field
          v-model="search" placeholder="Filter by email, name, or household" prepend-inner-icon="mdi-magnify"
          density="comfortable" variant="outlined" hide-details clearable class="mb-3" style="max-width: 420px"
          @update:model-value="syncQuery" />

        <div v-if="loading" class="text-center py-8"><v-progress-circular indeterminate color="primary" /></div>
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th>User</th>
              <th>Household</th>
              <th class="text-right">Credits</th>
              <th class="text-right">Tokens (week)</th>
              <th>Trend ({{ weeks }}w)</th>
              <th style="min-width: 130px">Call time (week)</th>
              <th class="text-right">Blocked</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in filtered" :key="u._id" :class="{ 'flagged-row': u.flags.length }">
              <td>
                <router-link :to="{ path: '/billing', query: { q: u.email } }" class="cross-link font-weight-medium"
                  title="Open in Billing">
                  {{ u.email }}
                </router-link>
                <div class="text-caption text-medium-emphasis">{{ u.name || '—' }}</div>
              </td>
              <td>{{ u.householdName || '—' }}</td>
              <td class="text-right" :class="u.creditBalance < 0 ? 'text-error font-weight-bold' : 'font-weight-medium'">
                {{ u.creditBalance?.toLocaleString?.() ?? '—' }}
              </td>
              <td class="text-right font-weight-medium">{{ fmt(u.tokens) }}</td>
              <td><Sparkline :values="u.series" /></td>
              <td class="text-caption text-medium-emphasis">{{ mins(u.callSeconds) }}</td>
              <td class="text-right" :class="{ 'text-warning font-weight-bold': u.blocked > 0 }">
                {{ u.blocked || '—' }}
              </td>
              <td>
                <v-chip v-for="f in u.flags" :key="f" size="x-small" :color="flagColor(f)" variant="flat" class="mr-1">
                  {{ flagLabel(f) }}
                </v-chip>
              </td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="8" class="text-medium-emphasis py-4">
                No users match{{ search ? ' — try clearing the filter' : '' }}.
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { analyticsApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import Sparkline from '../components/Sparkline.vue';
import SnackbarHost from '../components/SnackbarHost.vue';

const route = useRoute();
const router = useRouter();
const { snack, fromError } = useSnackbar();

const loading = ref(true);
const weeks = ref([4, 8, 12, 26].includes(Number(route.query.weeks)) ? Number(route.query.weeks) : 8);
const search = ref(typeof route.query.q === 'string' ? route.query.q : '');

function syncQuery() {
  const query = { ...route.query };
  if (search.value) query.q = search.value; else delete query.q;
  if (weeks.value !== 8) query.weeks = String(weeks.value); else delete query.weeks;
  router.replace({ query });
}
const items = ref([]);
const fleet = ref({ tokensThisPeriod: 0, callSecondsThisPeriod: 0, blockedThisPeriod: 0, flaggedUsers: 0 });
const resetAt = ref(null);

// Server sorts by current-week tokens desc; flagged users float to the top.
const filtered = computed(() => {
  const q = (search.value || '').trim().toLowerCase();
  const rows = q
    ? items.value.filter((u) =>
        [u.email, u.name, u.householdName].some((s) => s && s.toLowerCase().includes(q)))
    : items.value;
  return [...rows].sort((a, b) => (b.flags.length - a.flags.length) || (b.tokens - a.tokens));
});

const flagged = computed(() => items.value.filter((u) => u.flags.length));

const FLAGS = {
  hammering: { label: 'hammering', color: 'error' },
  spike: { label: 'usage spike', color: 'warning' },
};
const flagLabel = (f) => FLAGS[f]?.label || f;
const flagColor = (f) => FLAGS[f]?.color || 'warning';

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Call-time budget is in seconds; admins read minutes. Sub-minute stays in
// seconds so a small value isn't shown as "0m".
function mins(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
}

async function load() {
  loading.value = true;
  syncQuery();
  try {
    const { data } = await analyticsApi.tokens(weeks.value);
    items.value = data.items;
    fleet.value = data.fleet;
    resetAt.value = data.resetAt;
  } catch (e) {
    fromError(e, 'Failed to load AI usage');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/* Theme-aware flag tint (the old bg-red-lighten-5 was unreadable in dark mode). */
.flagged-row {
  background: rgba(var(--v-theme-error), 0.08);
}
.cross-link { color: inherit; text-decoration: none; }
.cross-link:hover { text-decoration: underline; }
</style>
