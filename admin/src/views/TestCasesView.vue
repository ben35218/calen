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
          <div v-for="c in list.items.value" :key="c._id" class="tc-row py-3">
            <div class="d-flex align-center flex-wrap mb-1" style="gap: 8px">
              <span class="font-weight-bold text-mono">{{ c.caseId }}</span>
              <v-chip size="x-small" variant="tonal" :color="priorityColor(c.priority)">{{ c.priority }}</v-chip>
              <v-chip v-if="!c.active" size="x-small" variant="tonal">retired</v-chip>
              <v-chip v-if="c.source === 'manual'" size="x-small" variant="tonal" color="info">portal</v-chip>
              <span class="text-caption text-medium-emphasis">{{ c.section }}</span>
              <v-spacer />
              <span v-if="c.specPath" class="text-caption text-medium-emphasis">{{ specLabel(c.specPath) }}</span>
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

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { ref } from 'vue';
import { qaApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import { downloadCsv } from '../lib/csv';
import SnackbarHost from '../components/SnackbarHost.vue';

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
.tc-row + .tc-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.text-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
