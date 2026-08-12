<template>
  <v-container class="py-6" style="max-width: 1200px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Test cases</h1>
      <v-chip v-if="blockerCount" size="small" color="error" variant="tonal">{{ blockerCount }} blockers</v-chip>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-download" @click="exportCsv">Export CSV</v-btn>
      <v-btn color="primary" variant="flat" prepend-icon="mdi-upload" @click="openImport">Import</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      The library every release is tested against. Cases are authored in the repo
      (<code>docs/PRE-RELEASE-TEST-PLAN.md</code>) and imported here — edit them there and re-import.
      A case dropped from the document is retired, never deleted, so its past results survive.
    </p>

    <div class="d-flex flex-wrap mb-4" style="gap: 12px">
      <v-text-field
        v-model="list.filters.value.q" label="Search" density="comfortable" variant="outlined"
        prepend-inner-icon="mdi-magnify" hide-details clearable style="max-width: 320px"
        @update:model-value="list.onSearch" />
      <v-select
        v-model="list.filters.value.section" :items="sections" label="Section" density="comfortable"
        variant="outlined" hide-details clearable style="max-width: 320px" @update:model-value="list.reload" />
      <v-select
        v-model="list.filters.value.priority" :items="PRIORITIES" label="Priority" density="comfortable"
        variant="outlined" hide-details clearable style="max-width: 180px" @update:model-value="list.reload" />
      <v-select
        v-model="list.filters.value.active" :items="ACTIVE_OPTIONS" item-title="label" item-value="value"
        label="Status" density="comfortable" variant="outlined" hide-details
        style="max-width: 180px" @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="table-row@6" />
        <template v-else>
          <div
            v-for="c in list.items.value" :key="c._id" class="tc-row py-3"
            role="button" tabindex="0" @click="openCase(c)" @keyup.enter="openCase(c)">
            <div class="d-flex align-center flex-wrap mb-1" style="gap: 8px">
              <span class="font-weight-bold text-mono">{{ c.caseId }}</span>
              <v-chip size="x-small" variant="tonal" :color="priorityColor(c.priority)">{{ c.priority }}</v-chip>
              <v-chip v-if="!c.active" size="x-small" variant="tonal">retired</v-chip>
              <v-chip v-if="c.source === 'manual'" size="x-small" variant="tonal" color="info">portal</v-chip>
              <span class="text-caption text-medium-emphasis">{{ c.section }}</span>
              <v-spacer />
              <span v-if="c.specPath" class="text-caption text-medium-emphasis">{{ specLabel(c.specPath) }}</span>
              <v-icon icon="mdi-chevron-right" size="16" class="text-medium-emphasis" />
            </div>
            <div class="text-body-2">{{ c.steps || c.title }}</div>
            <div v-if="c.expected" class="text-body-2 text-medium-emphasis mt-1">
              <v-icon icon="mdi-arrow-right-thin" size="14" /> {{ c.expected }}
            </div>
          </div>
          <p v-if="!list.items.value.length" class="text-medium-emphasis py-4">
            No cases match. Import a plan document to populate the library.
          </p>
        </template>

        <div v-if="list.total.value" class="d-flex align-center mt-3">
          <span class="text-caption text-medium-emphasis">{{ list.rangeLabel.value }}</span>
          <v-spacer />
          <v-pagination v-model="list.page.value" :length="list.pageCount.value" :total-visible="5" density="comfortable" />
        </div>
      </v-card-text>
    </v-card>

    <!--
      Import: pick a file, preview the diff, then commit. The dry run is not
      optional — an import can retire hundreds of cases at once, and the four
      counts are the only place that is visible before it happens.
    -->
    <v-dialog v-model="importOpen" max-width="720" persistent>
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1 font-weight-bold">Import test cases</v-card-title>
        <v-card-text>
          <v-file-input
            v-model="file" label="Plan document (.md or .csv)" accept=".md,.markdown,.csv,text/plain"
            density="comfortable" variant="outlined" prepend-icon="" prepend-inner-icon="mdi-file-document-outline"
            :disabled="!!preview" @update:model-value="onPick" />
          <v-text-field
            v-model="sourceDoc" label="Source document" density="comfortable" variant="outlined"
            hint="Cases are matched to this document — retiring only ever affects its own cases."
            persistent-hint :disabled="!!preview" class="mb-2" />

          <v-alert v-if="error" type="error" variant="tonal" density="comfortable" class="mb-3">{{ error }}</v-alert>

          <template v-if="preview">
            <div class="d-flex flex-wrap mb-3" style="gap: 8px">
              <v-chip color="success" variant="tonal">{{ preview.counts.added }} added</v-chip>
              <v-chip color="info" variant="tonal">{{ preview.counts.updated }} updated</v-chip>
              <v-chip variant="tonal">{{ preview.counts.unchanged }} unchanged</v-chip>
              <v-chip :color="preview.counts.missing ? 'warning' : undefined" variant="tonal">
                {{ preview.counts.missing }} retired
              </v-chip>
            </div>

            <v-alert v-if="preview.counts.missing" type="warning" variant="tonal" density="comfortable" class="mb-3">
              {{ preview.counts.missing }} case(s) are in the portal but not in this document. They will be marked
              retired — their past results are kept.
              <div class="text-caption mt-1 text-mono">{{ preview.missing.join(', ') }}</div>
            </v-alert>

            <v-alert v-if="preview.warnings.length" type="info" variant="tonal" density="comfortable" class="mb-3">
              <div v-for="(w, i) in preview.warnings.slice(0, 8)" :key="i" class="text-caption">{{ w }}</div>
              <div v-if="preview.warnings.length > 8" class="text-caption">
                …and {{ preview.warnings.length - 8 }} more.
              </div>
            </v-alert>

            <v-expansion-panels v-if="preview.added.length || preview.updated.length" variant="accordion">
              <v-expansion-panel v-if="preview.added.length" :title="`Added (${preview.added.length})`">
                <v-expansion-panel-text>
                  <div v-for="c in preview.added.slice(0, 200)" :key="c.caseId" class="text-caption py-1">
                    <span class="text-mono font-weight-bold">{{ c.caseId }}</span> — {{ c.title }}
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
              <v-expansion-panel v-if="preview.updated.length" :title="`Updated (${preview.updated.length})`">
                <v-expansion-panel-text>
                  <div v-for="c in preview.updated.slice(0, 200)" :key="c.caseId" class="text-caption py-1">
                    <span class="text-mono font-weight-bold">{{ c.caseId }}</span> — {{ c.title }}
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeImport">Cancel</v-btn>
          <v-btn
            v-if="!preview" color="primary" variant="flat" :loading="busy" :disabled="!content"
            @click="runPreview">Preview changes</v-btn>
          <v-btn v-else color="primary" variant="flat" :loading="busy" @click="commit">
            Apply {{ preview.counts.added + preview.counts.updated + preview.counts.missing }} change(s)
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!--
      Case detail: what to do, what to expect, and a place to record the result
      against a run that's in progress — so a tester browsing the library never
      has to hunt for the matching row on the run screen. Recording here uses
      the same upsert the run screen does, so the two can't disagree.
    -->
    <v-dialog v-model="detailOpen" max-width="720">
      <v-card v-if="detail" rounded="lg">
        <v-card-title class="d-flex align-center flex-wrap" style="gap: 8px">
          <span class="text-mono font-weight-bold">{{ detail.caseId }}</span>
          <v-chip size="x-small" variant="tonal" :color="priorityColor(detail.priority)">{{ detail.priority }}</v-chip>
          <v-chip v-if="!detail.active" size="x-small" variant="tonal">retired</v-chip>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="detailOpen = false" />
        </v-card-title>
        <v-card-text>
          <p class="text-caption text-medium-emphasis mb-3">{{ detail.section }}</p>

          <div class="text-overline">What to do</div>
          <p class="text-body-2 mb-3">{{ detail.steps || detail.title }}</p>
          <template v-if="detail.expected">
            <div class="text-overline">What you should see</div>
            <p class="text-body-2 mb-3">{{ detail.expected }}</p>
          </template>
          <p v-if="detail.source === 'repo'" class="text-caption text-medium-emphasis mb-4">
            This case comes from <span class="text-mono">{{ detail.sourceDoc }}</span> — to reword it, edit the
            document and re-import.
            <span v-if="detail.specPath">Behavior owned by <span class="text-mono">{{ specLabel(detail.specPath) }}</span>.</span>
          </p>

          <v-divider class="mb-4" />

          <!-- Record a result -->
          <template v-if="detail.active">
            <div class="text-overline">Record a result</div>
            <template v-if="openRuns.length">
              <v-select
                v-model="recordRunId" :items="runOptions" item-title="label" item-value="id"
                label="Which test run" density="comfortable" variant="outlined" class="mb-2" hide-details />
              <v-btn-toggle v-model="recordStatus" density="comfortable" variant="outlined" class="mb-2">
                <v-btn value="pass" size="small" color="success">Pass</v-btn>
                <v-btn value="fail" size="small" color="error">Fail</v-btn>
                <v-btn value="blocked" size="small" color="warning">Blocked</v-btn>
                <v-btn value="na" size="small">N/A</v-btn>
              </v-btn-toggle>
              <v-textarea
                v-if="recordStatus === 'fail' || recordStatus === 'blocked'"
                v-model="recordNote" label="What happened?" rows="2" density="comfortable" variant="outlined"
                class="mb-2" hide-details />
              <v-btn
                color="primary" variant="flat" size="small" :disabled="!recordStatus || !recordRunId"
                :loading="recordBusy" @click="saveRecord">Save result</v-btn>
            </template>
            <p v-else class="text-body-2 text-medium-emphasis">
              No test run is in progress. Open <router-link to="/releases">Releases</router-link>, pick your
              release, and start a run — then results can be recorded here or on the run screen.
            </p>
          </template>

          <v-divider class="my-4" />

          <!-- History -->
          <div class="text-overline">History</div>
          <v-skeleton-loader v-if="historyLoading" type="list-item-two-line@2" />
          <template v-else>
            <div v-for="h in history" :key="h._id" class="d-flex align-center py-1" style="gap: 8px">
              <v-chip size="x-small" variant="tonal" :color="statusColor(h.status)">{{ h.status }}</v-chip>
              <span class="text-caption">
                {{ h.release ? `${h.release.version} (${h.release.buildNumber})` : '' }}
                <span v-if="h.run"> · {{ h.run.device || h.run.name }}</span>
              </span>
              <span v-if="h.note" class="text-caption text-medium-emphasis">— {{ h.note }}</span>
              <v-spacer />
              <span class="text-caption text-medium-emphasis"><Timestamp :date="h.at" /></span>
            </div>
            <p v-if="!history.length" class="text-body-2 text-medium-emphasis">Never run yet.</p>
          </template>
        </v-card-text>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { qaApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import { downloadCsv } from '../lib/csv';
import SnackbarHost from '../components/SnackbarHost.vue';
import Timestamp from '../components/Timestamp.vue';

const PRIORITIES = ['blocker', 'critical', 'major', 'minor'];
const ACTIVE_OPTIONS = [
  { label: 'Active', value: 'true' },
  { label: 'Retired', value: 'false' },
  { label: 'All', value: 'all' },
];
const DEFAULT_DOC = 'docs/PRE-RELEASE-TEST-PLAN.md';

const { snack, fromError, success } = useSnackbar();
const sections = ref([]);
const blockerCount = ref(0);

const list = usePagedList({
  pageSize: 50,
  filters: { q: '', section: '', priority: '', active: 'true' },
  fetch: async ({ page, pageSize, filters }) => {
    const res = await qaApi.cases({
      q: filters.q || undefined,
      section: filters.section || undefined,
      priority: filters.priority || undefined,
      active: filters.active || undefined,
      page,
      pageSize,
    });
    sections.value = res.data.sections || [];
    blockerCount.value = res.data.blockerCount || 0;
    return res;
  },
  onError: (e) => fromError(e, 'Failed to load test cases'),
});

function priorityColor(p) {
  if (p === 'blocker') return 'error';
  if (p === 'critical') return 'warning';
  if (p === 'minor') return 'default';
  return 'primary';
}

// "../specs/features/calendar.md" → "calendar.md"
const specLabel = (p) => String(p).split('/').pop();

function statusColor(s) {
  if (s === 'pass') return 'success';
  if (s === 'fail') return 'error';
  if (s === 'blocked') return 'warning';
  return 'default';
}

// --- Case detail ------------------------------------------------------------

const detailOpen = ref(false);
const detail = ref(null);
const history = ref([]);
const historyLoading = ref(false);
const openRuns = ref([]);           // in-progress runs, newest first
const releasesById = ref({});       // releaseId → { version, buildNumber }
const recordRunId = ref(null);
const recordStatus = ref(null);
const recordNote = ref('');
const recordBusy = ref(false);

const runOptions = computed(() => openRuns.value.map((r) => {
  const rel = releasesById.value[String(r.releaseId)];
  const device = r.environment?.device || r.name || 'Run';
  return { id: r._id, label: rel ? `${device} — ${rel.version} (${rel.buildNumber})` : device };
}));

async function openCase(c) {
  detail.value = c;
  detailOpen.value = true;
  recordStatus.value = null;
  recordNote.value = '';
  historyLoading.value = true;
  try {
    const [hist, runs, rels] = await Promise.all([
      qaApi.caseHistory(c._id),
      qaApi.runs(),
      qaApi.releases({ page: 1, pageSize: 25 }),
    ]);
    history.value = hist.data.results;
    releasesById.value = Object.fromEntries(rels.data.items.map((r) => [String(r._id), r]));
    openRuns.value = runs.data.items.filter((r) => r.status === 'in_progress');
    recordRunId.value = openRuns.value[0]?._id || null;
  } catch (e) {
    fromError(e, 'Failed to load the case');
  } finally {
    historyLoading.value = false;
  }
}

// Picking a run pre-fills the answer already recorded on it, so re-opening a
// case shows (and lets you correct) what you said, rather than looking blank.
watch(recordRunId, (runId) => {
  const prev = history.value.find((h) => String(h.runId) === String(runId));
  recordStatus.value = prev?.status || null;
  recordNote.value = prev?.note || '';
});

async function saveRecord() {
  recordBusy.value = true;
  try {
    await qaApi.saveResults(recordRunId.value, [{
      caseId: detail.value.caseId,
      status: recordStatus.value,
      note: recordNote.value || '',
    }]);
    success('Result saved.');
    const hist = await qaApi.caseHistory(detail.value._id);
    history.value = hist.data.results;
  } catch (e) {
    fromError(e, 'Could not save the result');
  } finally {
    recordBusy.value = false;
  }
}

// --- Import ---------------------------------------------------------------

const importOpen = ref(false);
const file = ref(null);
const fileName = ref('');
const content = ref('');
const sourceDoc = ref(DEFAULT_DOC);
const preview = ref(null);
const busy = ref(false);
const error = ref('');

function openImport() {
  file.value = null;
  fileName.value = '';
  content.value = '';
  sourceDoc.value = DEFAULT_DOC;
  preview.value = null;
  error.value = '';
  importOpen.value = true;
}

const closeImport = () => { importOpen.value = false; };

// The file is read in the BROWSER and its text is posted — no multipart upload,
// so the server needs no new dependency and the payload is just JSON.
async function onPick(picked) {
  error.value = '';
  const f = Array.isArray(picked) ? picked[0] : picked;
  if (!f) {
    content.value = '';
    fileName.value = '';
    return;
  }
  fileName.value = f.name || '';
  try {
    content.value = await f.text();
    // Name the source after the file unless it IS the standard plan document,
    // so retiring stays scoped to the document the cases came from.
    if (fileName.value && fileName.value !== 'PRE-RELEASE-TEST-PLAN.md') {
      sourceDoc.value = `docs/${fileName.value}`;
    }
  } catch {
    error.value = 'Could not read that file.';
  }
}

const formatOf = () => (/\.csv$/i.test(fileName.value) ? 'csv' : 'markdown');

async function runPreview() {
  busy.value = true;
  error.value = '';
  try {
    const res = await qaApi.importCases({
      format: formatOf(), content: content.value, sourceDoc: sourceDoc.value, dryRun: true,
    });
    preview.value = res.data;
  } catch (e) {
    error.value = e?.response?.data?.error || 'Import failed';
  } finally {
    busy.value = false;
  }
}

async function commit() {
  busy.value = true;
  error.value = '';
  try {
    const res = await qaApi.importCases({
      format: formatOf(), content: content.value, sourceDoc: sourceDoc.value, dryRun: false,
    });
    const c = res.data.counts;
    success(`Imported: ${c.added} added, ${c.updated} updated, ${c.missing} retired.`);
    importOpen.value = false;
    await list.load();
  } catch (e) {
    error.value = e?.response?.data?.error || 'Import failed';
  } finally {
    busy.value = false;
  }
}

// Exports what the current filter selects, capped like the other admin exports.
async function exportCsv() {
  try {
    const res = await qaApi.cases({ ...list.filters.value, page: 1, pageSize: 500 });
    downloadCsv('test-cases.csv', [
      { label: 'Case ID', key: 'caseId' },
      { label: 'Section', key: 'section' },
      { label: 'Priority', key: 'priority' },
      { label: 'Steps', key: 'steps' },
      { label: 'Expected', key: 'expected' },
      { label: 'Spec', key: 'specPath' },
      { label: 'Source', key: 'source' },
      { label: 'Active', value: (r) => (r.active ? 'yes' : 'retired') },
    ], res.data.items);
  } catch (e) {
    fromError(e, 'Export failed');
  }
}
</script>

<style scoped>
.tc-row { border-radius: 8px; cursor: pointer; }
.tc-row + .tc-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.tc-row:hover { background: rgba(var(--v-theme-on-surface), 0.04); }
.text-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
