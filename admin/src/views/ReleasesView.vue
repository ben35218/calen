<template>
  <v-container class="py-6" style="max-width: 1200px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Releases</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="list.load">Refresh</v-btn>
      <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="openNew">New release</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      One record per public build. Each carries its test runs and the sign-off, which is refused while a
      blocker case is unexecuted or failing.
    </p>

    <div class="d-flex flex-wrap mb-4" style="gap: 12px">
      <v-select
        v-model="list.filters.value.status" :items="STATUSES" label="Status" density="comfortable"
        variant="outlined" hide-details clearable style="max-width: 220px" @update:model-value="list.reload" />
      <v-select
        v-model="list.filters.value.channel" :items="CHANNELS" label="Channel" density="comfortable"
        variant="outlined" hide-details clearable style="max-width: 220px" @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="table-row@4" />
        <template v-else>
          <div
            v-for="r in list.items.value" :key="r._id" class="rel-row py-3 px-1"
            role="button" tabindex="0" @click="open(r)" @keyup.enter="open(r)">
            <div class="d-flex align-center flex-wrap mb-1" style="gap: 8px">
              <span class="font-weight-bold">{{ r.version }} ({{ r.buildNumber }})</span>
              <v-chip size="x-small" variant="tonal">{{ r.channel }}</v-chip>
              <v-chip size="x-small" variant="tonal" :color="statusColor(r.status)">{{ r.status }}</v-chip>
              <v-chip v-if="r.signOff?.at" size="x-small" variant="tonal" color="success"
                prepend-icon="mdi-check-decagram">signed off</v-chip>
              <v-chip v-else-if="r.summary.outstandingBlockers" size="x-small" variant="tonal" color="error">
                {{ r.summary.outstandingBlockers }} blocker(s) outstanding
              </v-chip>
              <v-spacer />
              <span class="text-caption text-medium-emphasis"><Timestamp :date="r.createdAt" /></span>
            </div>

            <div class="d-flex align-center" style="gap: 12px">
              <v-progress-linear
                :model-value="coverage(r)" :color="r.summary.failed ? 'warning' : 'success'"
                height="6" rounded style="max-width: 260px" />
              <span class="text-caption text-medium-emphasis">
                {{ r.summary.executed }}/{{ r.summary.totalCases }} executed ·
                {{ r.summary.passRate }}% pass ·
                {{ r.runCount }} run(s)
              </span>
            </div>
          </div>
          <p v-if="!list.items.value.length" class="text-medium-emphasis py-4">
            No releases yet. Create one for the build you're about to test.
          </p>
        </template>

        <div v-if="list.total.value" class="d-flex align-center mt-3">
          <span class="text-caption text-medium-emphasis">{{ list.rangeLabel.value }}</span>
          <v-spacer />
          <v-pagination v-model="list.page.value" :length="list.pageCount.value" :total-visible="5" density="comfortable" />
        </div>
      </v-card-text>
    </v-card>

    <v-dialog v-model="newOpen" max-width="520">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1 font-weight-bold">New release</v-card-title>
        <v-card-text>
          <div class="d-flex" style="gap: 12px">
            <v-text-field v-model="form.version" label="Version" placeholder="1.0.0" density="comfortable" variant="outlined" />
            <v-text-field v-model="form.buildNumber" label="Build" placeholder="42" density="comfortable" variant="outlined" />
          </div>
          <v-select v-model="form.channel" :items="CHANNELS" label="Channel" density="comfortable" variant="outlined" />
          <v-text-field
            v-model="form.tag" label="Git tag" density="comfortable" variant="outlined"
            :placeholder="suggestedTag" persistent-placeholder
            hint="The anchor npm run release:notes creates for this build." persistent-hint />
          <v-alert v-if="error" type="error" variant="tonal" density="comfortable" class="mt-3">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="newOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="busy" @click="create">Create</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { qaApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import SnackbarHost from '../components/SnackbarHost.vue';
import Timestamp from '../components/Timestamp.vue';

const STATUSES = ['planning', 'testing', 'submitted', 'released', 'rolled-back'];
const CHANNELS = ['testflight', 'app-store', 'play'];

const router = useRouter();
const { snack, fromError, success } = useSnackbar();

const list = usePagedList({
  pageSize: 25,
  filters: { status: '', channel: '' },
  fetch: ({ page, pageSize, filters }) => qaApi.releases({
    status: filters.status || undefined,
    channel: filters.channel || undefined,
    page,
    pageSize,
  }),
  onError: (e) => fromError(e, 'Failed to load releases'),
});

function statusColor(s) {
  if (s === 'released') return 'success';
  if (s === 'rolled-back') return 'error';
  if (s === 'testing') return 'info';
  return 'default';
}

const coverage = (r) => (r.summary.totalCases ? (r.summary.executed / r.summary.totalCases) * 100 : 0);
const open = (r) => router.push({ name: 'Release', params: { id: r._id } });

const newOpen = ref(false);
const busy = ref(false);
const error = ref('');
const form = ref({ version: '', buildNumber: '', channel: 'testflight', tag: '' });

const suggestedTag = computed(() => (form.value.version && form.value.buildNumber
  ? `testflight/${form.value.version}-${form.value.buildNumber}`
  : 'testflight/1.0.0-42'));

function openNew() {
  form.value = { version: '', buildNumber: '', channel: 'testflight', tag: '' };
  error.value = '';
  newOpen.value = true;
}

async function create() {
  busy.value = true;
  error.value = '';
  try {
    const res = await qaApi.createRelease({
      ...form.value,
      tag: form.value.tag || suggestedTag.value,
    });
    success('Release created.');
    newOpen.value = false;
    router.push({ name: 'Release', params: { id: res.data._id } });
  } catch (e) {
    error.value = e?.response?.data?.error || 'Could not create the release';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.rel-row { border-radius: 8px; cursor: pointer; }
.rel-row + .rel-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.rel-row:hover { background: rgba(var(--v-theme-on-surface), 0.04); }
</style>
