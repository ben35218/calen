<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Do-not-call list</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="list.load">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Numbers suppressed from outbound Calen calls. A number lands here when the person asks not to be
      called again on a call, or when added below for a support request. Suppression is platform-wide
      (it blocks every household). Numbers are stored hashed — only the last four digits are shown.
    </p>

    <v-card rounded="lg" variant="outlined" class="mb-4">
      <v-card-text>
        <div class="d-flex flex-wrap align-center" style="gap: 12px">
          <v-text-field
            v-model="newPhone" label="Phone number" placeholder="+1 555 123 4567" density="comfortable"
            variant="outlined" hide-details style="max-width: 240px" @keyup.enter="add" />
          <v-text-field
            v-model="newNote" label="Note (optional)" density="comfortable" variant="outlined"
            hide-details style="max-width: 320px" @keyup.enter="add" />
          <v-btn color="primary" :loading="adding" :disabled="!newPhone.trim()" @click="add">Add</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <div class="d-flex mb-4" style="gap: 12px; max-width: 260px">
      <v-select
        v-model="list.filters.value.active" :items="SCOPE_OPTIONS" item-title="label" item-value="value"
        label="Show" density="comfortable" variant="outlined" hide-details @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="list-item-two-line@4" />
        <template v-else>
          <div v-for="e in list.items.value" :key="e._id" class="dnc-row py-3 d-flex align-center" style="gap: 10px">
            <v-icon :icon="e.active ? 'mdi-phone-off' : 'mdi-phone-check'" :color="e.active ? 'error' : 'success'" />
            <span class="font-weight-medium">•••&nbsp;{{ e.last4 || '????' }}</span>
            <v-chip size="x-small" variant="tonal" :color="sourceColor(e.source)">{{ sourceLabel(e.source) }}</v-chip>
            <span v-if="e.note" class="text-caption text-medium-emphasis">{{ e.note }}</span>
            <span class="text-caption text-medium-emphasis">· <Timestamp :date="e.updatedAt" /></span>
            <v-spacer />
            <v-btn v-if="e.active" size="small" variant="text" :loading="busyId === e._id" @click="release(e)">
              Release
            </v-btn>
            <v-chip v-else size="x-small" variant="tonal">released</v-chip>
          </div>
          <p v-if="!list.items.value.length" class="text-medium-emphasis py-4">
            No suppressed numbers.
          </p>
        </template>

        <div class="d-flex align-center mt-3" v-if="list.total.value">
          <span class="text-caption text-medium-emphasis">{{ list.rangeLabel.value }}</span>
          <v-spacer />
          <v-pagination v-model="list.page.value" :length="list.pageCount.value" :total-visible="5" density="comfortable" />
        </div>
      </v-card-text>
    </v-card>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { ref } from 'vue';
import { adminApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import SnackbarHost from '../components/SnackbarHost.vue';
import Timestamp from '../components/Timestamp.vue';

const SCOPE_OPTIONS = [
  { label: 'Active only', value: 'active' },
  { label: 'All (incl. released)', value: 'all' },
];
const SOURCE_LABELS = {
  'callee-request': 'asked on call',
  'inbound-sms': 'texted STOP',
  support: 'support',
  user: 'user',
};

const { snack, fromError, success } = useSnackbar();
const busyId = ref(null);
const adding = ref(false);
const newPhone = ref('');
const newNote = ref('');

const list = usePagedList({
  pageSize: 50,
  filters: { active: 'active' },
  fetch: ({ page, pageSize, filters }) =>
    adminApi.dnc({ active: filters.active, page, pageSize }),
  onError: (e) => fromError(e, 'Failed to load the do-not-call list'),
});

function sourceLabel(s) { return SOURCE_LABELS[s] || s; }
function sourceColor(s) { return s === 'callee-request' ? 'error' : s === 'inbound-sms' ? 'warning' : 'primary'; }

async function add() {
  const phone = newPhone.value.trim();
  if (!phone) return;
  adding.value = true;
  try {
    await adminApi.addDnc(phone, newNote.value.trim() || undefined);
    success('Number added to the do-not-call list.');
    newPhone.value = '';
    newNote.value = '';
    await list.load();
  } catch (e) {
    fromError(e, 'Could not add the number');
  } finally {
    adding.value = false;
  }
}

async function release(entry) {
  busyId.value = entry._id;
  try {
    await adminApi.releaseDnc(entry._id);
    success('Number released — it can be called again.');
    await list.load();
  } catch (e) {
    fromError(e, 'Could not release the number');
  } finally {
    busyId.value = null;
  }
}
</script>

<style scoped>
.dnc-row + .dnc-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
</style>
