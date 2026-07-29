<template>
  <v-container class="py-6" style="max-width: 1200px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Insights</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="anyLoading" @click="reloadActive">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Content-blind product analytics — counts, timestamps, platforms. No household content is ever read,
      so these hold up under end-to-end encryption.
    </p>

    <v-tabs v-model="tab" class="mb-4" density="comfortable">
      <v-tab value="overview">Overview</v-tab>
      <v-tab value="adoption">Feature adoption</v-tab>
      <v-tab value="platforms">Platforms</v-tab>
      <v-tab value="retention">Retention</v-tab>
    </v-tabs>

    <!-- OVERVIEW -->
    <div v-if="tab === 'overview'">
      <div v-if="loading.overview" class="text-center py-10"><v-progress-circular indeterminate color="primary" /></div>
      <template v-else-if="overview">
        <div class="d-flex flex-wrap mb-4" style="gap: 12px">
          <StatCard label="Users" :value="overview.totals.users" />
          <StatCard label="Households" :value="overview.totals.households" />
          <StatCard label="Unlocked users" :value="overview.totals.unlockedUsers" color="primary" />
          <StatCard label="DAU" :value="overview.engagement.dau" />
          <StatCard label="WAU" :value="overview.engagement.wau" />
          <StatCard label="MAU" :value="overview.engagement.mau" />
          <StatCard label="Stickiness" :value="pct(overview.engagement.stickiness)" hint="DAU / MAU" />
          <StatCard label="Active households (7d)" :value="overview.activeHouseholds7d" color="success" />
          <StatCard label="New users (7d)" :value="overview.newUsers7d" />
          <StatCard label="New users (24h)" :value="overview.newUsers24h" />
        </div>
        <v-alert v-if="overview.engagement.mau === 0" type="info" variant="tonal" density="comfortable" class="mb-4">
          No engagement recorded yet — <code>lastActiveAt</code> is stamped as users make authenticated requests
          after this deploy, so DAU/WAU/MAU fill in from here.
        </v-alert>

        <v-card variant="outlined" rounded="lg" v-if="growth">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            New users per week
            <v-spacer />
            <v-btn-toggle v-model="weeks" density="compact" variant="outlined" mandatory @update:model-value="loadGrowth">
              <v-btn :value="8" size="small">8w</v-btn>
              <v-btn :value="12" size="small">12w</v-btn>
              <v-btn :value="26" size="small">26w</v-btn>
            </v-btn-toggle>
          </v-card-title>
          <v-card-text>
            <BarChart :values="growth.users.counts" :labels="weekLabels(growth.users.counts.length)" aria-label="new users per week" />
            <div class="text-caption text-medium-emphasis mt-2">
              Total users {{ growth.users.total }} · households {{ growth.households.total }} ·
              newest week: {{ growth.users.counts.at(-1) }} users, {{ growth.households.counts.at(-1) }} households
            </div>
          </v-card-text>
        </v-card>
      </template>
    </div>

    <!-- FEATURE ADOPTION -->
    <div v-else-if="tab === 'adoption'">
      <div v-if="loading.adoption" class="text-center py-10"><v-progress-circular indeterminate color="primary" /></div>
      <template v-else>
        <v-card variant="outlined" rounded="lg" class="mb-4" v-if="activity">
          <v-card-title class="text-subtitle-1">Feature adoption — households that ever used each feature</v-card-title>
          <v-card-text>
            <div v-for="a in activity.adoption" :key="a.action" class="mb-2">
              <div class="d-flex align-center text-body-2">
                <span style="width: 150px">{{ pretty(a.action) }}</span>
                <v-progress-linear :model-value="a.pct" height="18" rounded color="primary" class="flex-grow-1">
                  <span class="text-caption">{{ a.households }} ({{ a.pct }}%)</span>
                </v-progress-linear>
              </div>
            </div>
            <div class="text-caption text-medium-emphasis mt-2">Across {{ activity.households }} households.</div>
          </v-card-text>
        </v-card>

        <v-card variant="outlined" rounded="lg" class="mb-4" v-if="activity">
          <v-card-title class="text-subtitle-1">Feature activity — total actions per week</v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap" style="gap: 20px 28px">
              <div v-for="a in activity.actions" :key="a">
                <div class="text-caption font-weight-medium">{{ pretty(a) }} <span class="text-medium-emphasis">· {{ activity.totals[a] }}</span></div>
                <Sparkline :values="activity.series[a]" :width="120" />
              </div>
            </div>
          </v-card-text>
        </v-card>

        <v-card variant="outlined" rounded="lg" v-if="usage">
          <v-card-title class="text-subtitle-1">AI usage — fleet totals per week</v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap mb-3" style="gap: 20px 28px">
              <div v-for="a in usage.actions" :key="a">
                <div class="text-caption font-weight-medium">{{ a }} <span class="text-medium-emphasis">· {{ usage.totals[a] }}</span></div>
                <Sparkline :values="usage.series[a]" :width="120" color="#00838f" />
              </div>
            </div>
            <div v-if="usage.chatBySurface.length">
              <div class="text-caption font-weight-medium mb-1">Chat by surface (all weeks)</div>
              <v-chip v-for="b in usage.chatBySurface" :key="b.surface" size="small" variant="tonal" class="mr-2 mb-1">
                {{ b.surface }}: {{ b.count }}
              </v-chip>
            </div>
          </v-card-text>
        </v-card>
      </template>
    </div>

    <!-- PLATFORMS -->
    <div v-else-if="tab === 'platforms'">
      <div v-if="loading.platforms" class="text-center py-10"><v-progress-circular indeterminate color="primary" /></div>
      <template v-else-if="platforms">
        <v-row>
          <v-col cols="12" md="6">
            <v-card variant="outlined" rounded="lg">
              <v-card-title class="text-subtitle-1">Platform</v-card-title>
              <v-card-text>
                <BarChart :values="platforms.platforms.map(p => p.count)" :labels="platforms.platforms.map(p => p.key)"
                  :width="440" color="#388e3c" aria-label="platform distribution" />
              </v-card-text>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card variant="outlined" rounded="lg">
              <v-card-title class="text-subtitle-1">App version</v-card-title>
              <v-card-text>
                <BarChart :values="platforms.versions.map(v => v.count)" :labels="platforms.versions.map(v => v.key)"
                  :width="440" color="#7b1fa2" aria-label="version distribution" />
                <div class="text-caption text-medium-emphasis mt-2">
                  {{ platforms.reported }} / {{ platforms.total }} users reported a version
                  <span v-if="platforms.minAppVersion"> · E2EE min: {{ platforms.minAppVersion }}</span>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </template>
    </div>

    <!-- RETENTION -->
    <div v-else-if="tab === 'retention'">
      <div v-if="loading.retention" class="text-center py-10"><v-progress-circular indeterminate color="primary" /></div>
      <template v-else-if="retention">
        <v-card variant="outlined" rounded="lg">
          <v-card-title class="text-subtitle-1">Still-active by signup cohort</v-card-title>
          <v-card-text>
            <p class="text-caption text-medium-emphasis mb-3">
              Share of each signup week still active in the last 7 / 30 days (single-snapshot; a full
              return-by-week triangle needs per-period history).
            </p>
            <v-table density="comfortable">
              <thead>
                <tr>
                  <th>Signup cohort</th>
                  <th class="text-center">Signups</th>
                  <th class="text-center">Active 7d</th>
                  <th class="text-center">Active 30d</th>
                  <th style="min-width: 160px">7d retention</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in retention.cohorts" :key="c.weeksAgo">
                  <td>{{ cohortLabel(c.weeksAgo) }}</td>
                  <td class="text-center">{{ c.size }}</td>
                  <td class="text-center">{{ c.active7 }}</td>
                  <td class="text-center">{{ c.active30 }}</td>
                  <td>
                    <v-progress-linear :model-value="c.retention7" height="16" rounded color="success">
                      <span class="text-caption">{{ c.retention7 }}%</span>
                    </v-progress-linear>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </v-card-text>
        </v-card>
      </template>
    </div>

    <SnackbarHost :snack="snack" :timeout="3500" />
  </v-container>
</template>

<script setup>
import { ref, computed, watch, onMounted, h } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { analyticsApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import SnackbarHost from '../components/SnackbarHost.vue';
import BarChart from '../components/BarChart.vue';
import Sparkline from '../components/Sparkline.vue';

// Tiny inline stat card (kept local to avoid another file for a 6-line component).
const StatCard = (props) => h('div', { class: 'pa-3 rounded-lg', style: 'border:1px solid rgba(var(--v-theme-on-surface),0.16); min-width:130px' }, [
  h('div', { class: 'text-caption text-medium-emphasis' }, props.label),
  h('div', { class: `text-h6 font-weight-bold ${props.color ? 'text-' + props.color : ''}` }, String(props.value)),
  props.hint ? h('div', { class: 'text-caption text-medium-emphasis' }, props.hint) : null,
]);
StatCard.props = ['label', 'value', 'color', 'hint'];

const route = useRoute();
const router = useRouter();
const { snack, fromError } = useSnackbar();
const TABS = ['overview', 'adoption', 'platforms', 'retention'];
const tab = ref(TABS.includes(route.query.tab) ? route.query.tab : 'overview');
const weeks = ref(12);

const overview = ref(null);
const growth = ref(null);
const activity = ref(null);
const usage = ref(null);
const platforms = ref(null);
const retention = ref(null);

const loading = ref({ overview: false, adoption: false, platforms: false, retention: false });
const anyLoading = computed(() => Object.values(loading.value).some(Boolean));

function pct(x) { return `${Math.round((x || 0) * 100)}%`; }
function pretty(a) { return a.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()); }
function weekLabels(n) { return Array.from({ length: n }, (_, i) => (i === n - 1 ? 'now' : `-${n - 1 - i}w`)); }
function cohortLabel(w) { return w === 0 ? 'This week' : `${w}w ago`; }

async function loadOverview() {
  loading.value.overview = true;
  try {
    const [o, g] = await Promise.all([analyticsApi.overview(), analyticsApi.growth(weeks.value)]);
    overview.value = o.data;
    growth.value = g.data;
  } catch (e) { fromError(e, 'Failed to load overview'); }
  finally { loading.value.overview = false; }
}
async function loadGrowth() {
  try { growth.value = (await analyticsApi.growth(weeks.value)).data; }
  catch (e) { fromError(e, 'Failed to load growth'); }
}
async function loadAdoption() {
  loading.value.adoption = true;
  try {
    const [a, u] = await Promise.all([analyticsApi.activity(weeks.value), analyticsApi.usage(weeks.value)]);
    activity.value = a.data;
    usage.value = u.data;
  } catch (e) { fromError(e, 'Failed to load adoption'); }
  finally { loading.value.adoption = false; }
}
async function loadPlatforms() {
  loading.value.platforms = true;
  try { platforms.value = (await analyticsApi.platforms()).data; }
  catch (e) { fromError(e, 'Failed to load platforms'); }
  finally { loading.value.platforms = false; }
}
async function loadRetention() {
  loading.value.retention = true;
  try { retention.value = (await analyticsApi.retention(weeks.value)).data; }
  catch (e) { fromError(e, 'Failed to load retention'); }
  finally { loading.value.retention = false; }
}

// Lazy-load each tab's data the first time it's opened.
const loaders = { overview: loadOverview, adoption: loadAdoption, platforms: loadPlatforms, retention: loadRetention };
const loadedOnce = ref({});
function ensureLoaded(t) {
  if (loadedOnce.value[t]) return;
  loadedOnce.value[t] = true;
  loaders[t]();
}
function reloadActive() { loaders[tab.value](); }

// The weeks toggle drives growth AND the adoption/retention series — mark the
// other tabs stale so they refetch with the new window when (re)visited.
watch(weeks, () => {
  for (const t of ['adoption', 'retention']) {
    if (t === tab.value) loaders[t]();
    else delete loadedOnce.value[t];
  }
});

watch(tab, (t) => {
  ensureLoaded(t);
  router.replace({ query: { ...route.query, ...(t === 'overview' ? { tab: undefined } : { tab: t }) } });
});
onMounted(() => ensureLoaded(tab.value));
</script>
