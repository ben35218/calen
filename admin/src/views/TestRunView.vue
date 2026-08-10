<template>
  <v-container class="py-6" style="max-width: 1100px">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" :to="backTo" class="mb-2">Release</v-btn>

    <v-skeleton-loader v-if="loading" type="article, list-item-two-line@6" />
    <template v-else>
      <div class="d-flex align-center flex-wrap mb-1" style="gap: 12px">
        <h1 class="text-h5 font-weight-bold">{{ run.name || run.environment?.device || 'Test run' }}</h1>
        <v-chip size="small" variant="tonal" :color="run.status === 'complete' ? 'success' : 'info'">
          {{ run.status.replace('_', ' ') }}
        </v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">{{ saveLabel }}</span>
        <v-btn
          v-if="run.status === 'in_progress'" size="small" variant="flat" color="primary"
          prepend-icon="mdi-check" :loading="completing" @click="complete">Complete run</v-btn>
      </div>
      <p class="text-caption text-medium-emphasis mb-3">
        {{ [release?.version && `${release.version} (${release.buildNumber})`,
            run.environment?.osVersion, run.environment?.tester].filter(Boolean).join(' · ') }}
      </p>

      <v-progress-linear :model-value="progress" color="success" height="8" rounded class="mb-1" />
      <p class="text-caption text-medium-emphasis mb-4">
        {{ answered }} of {{ cases.length }} answered ·
        <span class="text-success">{{ counts.pass }} pass</span> ·
        <span :class="counts.fail ? 'text-error' : ''">{{ counts.fail }} fail</span> ·
        {{ counts.blocked }} blocked · {{ counts.skipped + counts.na }} skipped/NA
      </p>

      <div class="d-flex flex-wrap mb-4" style="gap: 12px">
        <v-text-field
          v-model="q" label="Search" density="comfortable" variant="outlined" prepend-inner-icon="mdi-magnify"
          hide-details clearable style="max-width: 300px" />
        <v-select
          v-model="section" :items="sections" label="Section" density="comfortable" variant="outlined"
          hide-details clearable style="max-width: 320px" />
        <v-btn-toggle v-model="scope" density="comfortable" variant="outlined" mandatory>
          <v-btn value="all" size="small">All</v-btn>
          <v-btn value="todo" size="small">Unanswered</v-btn>
          <v-btn value="blockers" size="small">Blockers</v-btn>
        </v-btn-toggle>
      </div>

      <v-card
        v-for="group in grouped" :key="group.section" rounded="lg" variant="outlined" class="mb-4">
        <v-card-title class="text-subtitle-2 font-weight-bold py-3">{{ group.section }}</v-card-title>
        <v-divider />
        <v-card-text class="pa-0">
          <div v-for="c in group.cases" :key="c.caseId" class="case-row px-4 py-3">
            <div class="d-flex align-start flex-wrap" style="gap: 12px">
              <div style="flex: 1 1 340px; min-width: 260px">
                <div class="d-flex align-center flex-wrap mb-1" style="gap: 6px">
                  <span class="font-weight-bold text-mono">{{ c.caseId }}</span>
                  <v-chip v-if="c.priority === 'blocker'" size="x-small" color="error" variant="tonal">blocker</v-chip>
                  <v-chip v-else-if="c.priority === 'critical'" size="x-small" color="warning" variant="tonal">risk</v-chip>
                </div>
                <div class="text-body-2">{{ c.steps || c.title }}</div>
                <div v-if="c.expected" class="text-body-2 text-medium-emphasis mt-1">
                  <v-icon icon="mdi-arrow-right-thin" size="14" /> {{ c.expected }}
                </div>
              </div>

              <div class="d-flex flex-column align-end" style="gap: 6px">
                <v-btn-toggle
                  :model-value="results[c.caseId]?.status" density="comfortable" variant="outlined"
                  :disabled="run.status !== 'in_progress'"
                  @update:model-value="(v) => setStatus(c.caseId, v)">
                  <v-btn value="pass" size="small" color="success">Pass</v-btn>
                  <v-btn value="fail" size="small" color="error">Fail</v-btn>
                  <v-btn value="blocked" size="small" color="warning">Blocked</v-btn>
                  <v-btn value="na" size="small">N/A</v-btn>
                </v-btn-toggle>
                <v-text-field
                  v-if="needsNote(c.caseId)"
                  :model-value="results[c.caseId]?.note" label="What happened?" density="compact"
                  variant="outlined" hide-details style="min-width: 320px"
                  :disabled="run.status !== 'in_progress'"
                  @update:model-value="(v) => setNote(c.caseId, v)" />
              </div>
            </div>
          </div>
        </v-card-text>
      </v-card>

      <p v-if="!grouped.length" class="text-medium-emphasis py-6 text-center">
        Nothing matches this filter.
        <span v-if="scope === 'todo'">Every case in view has an answer.</span>
      </p>
    </template>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { qaApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import SnackbarHost from '../components/SnackbarHost.vue';

const route = useRoute();
const router = useRouter();
const { snack, fromError, success } = useSnackbar();

const loading = ref(true);
const run = ref({ status: 'in_progress', environment: {} });
const release = ref(null);
const cases = ref([]);
const results = ref({});          // caseId → { status, note }
const completing = ref(false);

const q = ref('');
const section = ref('');
const scope = ref('all');

const backTo = computed(() => (release.value
  ? { name: 'Release', params: { id: release.value._id } }
  : { name: 'Releases' }));

// The library is bigger than one page, and a tester must see all of it — so it
// is pulled page by page rather than silently truncated at the first 500.
async function loadAllCases() {
  const out = [];
  const pageSize = 500;
  for (let page = 1; page <= 20; page += 1) {
    const res = await qaApi.cases({ active: 'true', page, pageSize });
    out.push(...res.data.items);
    if (out.length >= res.data.total || !res.data.items.length) break;
  }
  return out;
}

async function load() {
  loading.value = true;
  try {
    const [runRes, allCases] = await Promise.all([qaApi.run(route.params.id), loadAllCases()]);
    run.value = runRes.data.run;
    release.value = runRes.data.release;
    cases.value = allCases;
    results.value = Object.fromEntries(
      runRes.data.results.map((r) => [r.caseId, { status: r.status, note: r.note || '' }]),
    );
  } catch (e) {
    fromError(e, 'Failed to load the run');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const sections = computed(() => [...new Set(cases.value.map((c) => c.section).filter(Boolean))].sort());

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return cases.value.filter((c) => {
    if (section.value && c.section !== section.value) return false;
    if (scope.value === 'todo' && results.value[c.caseId]) return false;
    if (scope.value === 'blockers' && c.priority !== 'blocker') return false;
    if (needle) {
      const hay = `${c.caseId} ${c.title} ${c.steps} ${c.expected}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
});

const grouped = computed(() => {
  const map = new Map();
  for (const c of filtered.value) {
    const key = c.section || 'Uncategorised';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.entries()].map(([s, list]) => ({ section: s, cases: list }));
});

const answered = computed(() => cases.value.filter((c) => results.value[c.caseId]).length);
const progress = computed(() => (cases.value.length ? (answered.value / cases.value.length) * 100 : 0));
const counts = computed(() => {
  const acc = { pass: 0, fail: 0, blocked: 0, skipped: 0, na: 0 };
  for (const c of cases.value) {
    const s = results.value[c.caseId]?.status;
    if (s && acc[s] !== undefined) acc[s] += 1;
  }
  return acc;
});

const needsNote = (caseId) => ['fail', 'blocked'].includes(results.value[caseId]?.status);

// --- Autosave ---------------------------------------------------------------
// Taps are fast and frequent, so results are queued and flushed on a short
// debounce as ONE upsert batch. The server upserts on (run, case), so a replayed
// or reordered flush converges rather than duplicating.
const pending = ref(new Set());
const saving = ref(false);
const savedAt = ref(null);
let timer = null;

const saveLabel = computed(() => {
  if (saving.value) return 'Saving…';
  if (pending.value.size) return 'Unsaved changes';
  if (savedAt.value) return 'All changes saved';
  return '';
});

function queue(caseId) {
  pending.value.add(caseId);
  clearTimeout(timer);
  timer = setTimeout(flush, 600);
}

async function flush() {
  if (!pending.value.size || saving.value) return;
  const batch = [...pending.value];
  pending.value = new Set();
  saving.value = true;
  try {
    await qaApi.saveResults(route.params.id, batch.map((caseId) => ({
      caseId,
      status: results.value[caseId].status,
      note: results.value[caseId].note || '',
    })));
    savedAt.value = new Date();
  } catch (e) {
    // Put them back so the next flush retries rather than losing the answer.
    batch.forEach((c) => pending.value.add(c));
    fromError(e, 'Could not save results — they will be retried');
  } finally {
    saving.value = false;
    if (pending.value.size) queue([...pending.value][0]);
  }
}

function setStatus(caseId, status) {
  if (!status) return; // the toggle emits null when deselecting; keep the answer
  results.value = { ...results.value, [caseId]: { status, note: results.value[caseId]?.note || '' } };
  queue(caseId);
}

function setNote(caseId, note) {
  const existing = results.value[caseId];
  if (!existing) return;
  results.value = { ...results.value, [caseId]: { ...existing, note } };
  queue(caseId);
}

// Never leave the page with a queued answer unsaved.
onBeforeUnmount(() => {
  clearTimeout(timer);
  if (pending.value.size) flush();
});

async function complete() {
  completing.value = true;
  try {
    await flush();
    await qaApi.completeRun(route.params.id, 'complete');
    success('Run completed.');
    router.push(backTo.value);
  } catch (e) {
    fromError(e, 'Could not complete the run');
  } finally {
    completing.value = false;
  }
}
</script>

<style scoped>
.case-row + .case-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.text-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
