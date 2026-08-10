<template>
  <v-container class="py-6" style="max-width: 1200px">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" :to="{ name: 'Releases' }" class="mb-2">Releases</v-btn>

    <v-skeleton-loader v-if="loading" type="article, table-row@3" />
    <template v-else-if="data">
      <div class="d-flex align-center flex-wrap mb-1" style="gap: 12px">
        <h1 class="text-h5 font-weight-bold">{{ data.release.version }} ({{ data.release.buildNumber }})</h1>
        <v-chip size="small" variant="tonal">{{ data.release.channel }}</v-chip>
        <v-select
          :model-value="data.release.status" :items="STATUSES" density="compact" variant="outlined"
          hide-details style="max-width: 180px" @update:model-value="setStatus" />
        <v-spacer />
        <v-btn variant="text" prepend-icon="mdi-refresh" @click="load">Refresh</v-btn>
      </div>
      <p v-if="data.release.tag" class="text-caption text-medium-emphasis mb-4 text-mono">{{ data.release.tag }}</p>

      <!-- Coverage. The same rollup the sign-off gate reads, so the numbers here
           can never disagree with the reason it refuses. -->
      <v-row class="mb-2" dense>
        <v-col v-for="t in tiles" :key="t.label" cols="6" sm="4" md="2">
          <v-card rounded="lg" variant="outlined">
            <v-card-text class="py-3">
              <div class="text-caption text-medium-emphasis">{{ t.label }}</div>
              <div class="text-h6 font-weight-bold" :class="t.class">{{ t.value }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-alert
        v-if="data.outstandingBlockers.length" type="error" variant="tonal" density="comfortable" class="mb-4">
        <div class="font-weight-bold mb-1">
          {{ data.outstandingBlockers.length }} blocker case(s) are unexecuted or failing
        </div>
        <div class="text-caption text-mono">{{ data.outstandingBlockers.join(', ') }}</div>
        <div class="text-caption mt-1">Sign-off is refused until each one passes on at least one run.</div>
      </v-alert>

      <v-alert
        v-else-if="data.release.signOff?.at" type="success" variant="tonal" density="comfortable" class="mb-4">
        Signed off <Timestamp :date="data.release.signOff.at" />
        <span v-if="data.release.signOff.note"> — “{{ data.release.signOff.note }}”</span>
      </v-alert>

      <!-- Runs -->
      <div class="d-flex align-center mb-2" style="gap: 12px">
        <h2 class="text-subtitle-1 font-weight-bold">Test runs</h2>
        <v-spacer />
        <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-play" @click="openRun">Start a run</v-btn>
      </div>
      <v-card rounded="lg" variant="outlined" class="mb-6">
        <v-card-text>
          <div
            v-for="r in data.perRun" :key="r._id" class="run-row py-3 px-1"
            role="button" tabindex="0" @click="openRunDetail(r)" @keyup.enter="openRunDetail(r)">
            <div class="d-flex align-center flex-wrap" style="gap: 8px">
              <span class="font-weight-medium">{{ r.name || r.environment?.device || 'Run' }}</span>
              <span class="text-caption text-medium-emphasis">
                {{ [r.environment?.osVersion, r.environment?.build, r.environment?.tester].filter(Boolean).join(' · ') }}
              </span>
              <v-chip size="x-small" variant="tonal" :color="r.status === 'complete' ? 'success' : 'info'">
                {{ r.status.replace('_', ' ') }}
              </v-chip>
              <v-spacer />
              <span class="text-caption text-medium-emphasis">
                {{ r.executed }} executed ·
                <span class="text-success">{{ r.counts.pass }}P</span>
                <span v-if="r.counts.fail" class="text-error"> · {{ r.counts.fail }}F</span>
                <span v-if="r.counts.blocked" class="text-warning"> · {{ r.counts.blocked }}B</span>
              </span>
              <v-icon icon="mdi-chevron-right" size="18" />
            </div>
          </div>
          <p v-if="!data.perRun.length" class="text-medium-emphasis py-4">
            No runs yet. Start one per device you're testing on.
          </p>
        </v-card-text>
      </v-card>

      <!-- Sign-off -->
      <h2 class="text-subtitle-1 font-weight-bold mb-2">Sign-off</h2>
      <v-card rounded="lg" variant="outlined">
        <v-card-text>
          <v-textarea
            v-model="signNote" label="Note (optional)" rows="2" density="comfortable" variant="outlined"
            hide-details class="mb-3" />
          <div class="d-flex align-center" style="gap: 12px">
            <v-btn
              color="success" variant="flat" :loading="signing" :disabled="!data.canSignOff"
              prepend-icon="mdi-check-decagram" @click="confirmOpen = true">
              {{ data.release.signOff?.at ? 'Re-sign' : 'Sign off' }}
            </v-btn>
            <span v-if="!data.canSignOff" class="text-caption text-medium-emphasis">
              Blocked by {{ data.outstandingBlockers.length }} outstanding blocker case(s).
            </span>
          </div>
        </v-card-text>
      </v-card>
    </template>

    <ConfirmDialog
      v-model="confirmOpen" title="Sign off this release?" confirm-text="Sign off" color="success"
      :loading="signing"
      :message="`${data?.executed || 0} of ${data?.totalCases || 0} cases executed, ${data?.passRate || 0}% pass rate. This is recorded against your account and audited.`"
      @confirm="signOff" />

    <v-dialog v-model="runOpen" max-width="520">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1 font-weight-bold">Start a test run</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">
            One run per device, so a case's result on the iPhone SE stays distinguishable from the same case on an iPad.
          </p>
          <v-text-field v-model="runForm.device" label="Device" placeholder="iPhone SE (3rd gen)" density="comfortable" variant="outlined" />
          <v-text-field v-model="runForm.osVersion" label="OS version" placeholder="iOS 18.1" density="comfortable" variant="outlined" />
          <v-text-field v-model="runForm.build" label="Build" :placeholder="data?.release?.buildNumber" density="comfortable" variant="outlined" />
          <v-text-field v-model="runForm.tester" label="Tester" density="comfortable" variant="outlined" />
          <v-alert v-if="runError" type="error" variant="tonal" density="comfortable">{{ runError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="runOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="runBusy" @click="startRun">Start</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { qaApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import SnackbarHost from '../components/SnackbarHost.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Timestamp from '../components/Timestamp.vue';

const STATUSES = ['planning', 'testing', 'submitted', 'released', 'rolled-back'];

const route = useRoute();
const router = useRouter();
const { snack, fromError, success } = useSnackbar();

const loading = ref(true);
const data = ref(null);
const signNote = ref('');
const signing = ref(false);
const confirmOpen = ref(false);

const tiles = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    { label: 'Cases', value: d.totalCases },
    { label: 'Executed', value: d.executed },
    { label: 'Passed', value: d.passed, class: 'text-success' },
    { label: 'Failing', value: d.failed, class: d.failed ? 'text-error' : '' },
    { label: 'Pass rate', value: `${d.passRate}%` },
    {
      label: 'Blockers out',
      value: d.outstandingBlockers.length,
      class: d.outstandingBlockers.length ? 'text-error' : 'text-success',
    },
  ];
});

async function load() {
  loading.value = true;
  try {
    const res = await qaApi.summary(route.params.id);
    data.value = res.data;
    signNote.value = res.data.release.signOff?.note || '';
  } catch (e) {
    fromError(e, 'Failed to load the release');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function setStatus(status) {
  try {
    await qaApi.updateRelease(route.params.id, { status });
    success(`Marked ${status}.`);
    await load();
  } catch (e) {
    fromError(e, 'Could not update the release');
  }
}

async function signOff() {
  signing.value = true;
  try {
    await qaApi.signOff(route.params.id, signNote.value);
    success('Release signed off.');
    confirmOpen.value = false;
    await load();
  } catch (e) {
    // The gate answers 409 with the offending case ids — surface them rather
    // than a bare refusal the admin can't act on.
    const blockers = e?.response?.data?.blockers;
    if (blockers?.length) fromError(e, `Blocked by: ${blockers.join(', ')}`);
    else fromError(e, 'Could not sign off');
    confirmOpen.value = false;
    await load();
  } finally {
    signing.value = false;
  }
}

const runOpen = ref(false);
const runBusy = ref(false);
const runError = ref('');
const runForm = ref({ device: '', osVersion: '', build: '', tester: '' });

function openRun() {
  runForm.value = { device: '', osVersion: '', build: data.value?.release?.buildNumber || '', tester: '' };
  runError.value = '';
  runOpen.value = true;
}

async function startRun() {
  runBusy.value = true;
  runError.value = '';
  try {
    const res = await qaApi.createRun({
      releaseId: route.params.id,
      name: runForm.value.device,
      environment: runForm.value,
    });
    runOpen.value = false;
    router.push({ name: 'TestRun', params: { id: res.data._id } });
  } catch (e) {
    runError.value = e?.response?.data?.error || 'Could not start the run';
  } finally {
    runBusy.value = false;
  }
}

const openRunDetail = (r) => router.push({ name: 'TestRun', params: { id: r._id } });
</script>

<style scoped>
.run-row { border-radius: 8px; cursor: pointer; }
.run-row + .run-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.run-row:hover { background: rgba(var(--v-theme-on-surface), 0.04); }
.text-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
