<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Feedback</h1>
      <v-chip v-if="newCount" size="small" color="error" variant="tonal">{{ newCount }} new</v-chip>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="list.load">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Questions, bug reports, and ideas users submitted from the app (Profile → Help &amp; feedback).
      Each carries the message plus captured device diagnostics; triage each one when handled.
    </p>

    <div class="d-flex mb-4" style="gap: 12px; max-width: 420px">
      <v-select
        v-model="list.filters.value.status" :items="STATUS_OPTIONS" label="Status" density="comfortable"
        variant="outlined" hide-details clearable @update:model-value="list.reload" />
      <v-select
        v-model="list.filters.value.type" :items="TYPE_OPTIONS" label="Type" density="comfortable"
        variant="outlined" hide-details clearable @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="list-item-three-line@4" />
        <template v-else>
          <div v-for="r in list.items.value" :key="r._id" class="fb-row py-3">
            <div class="d-flex align-center mb-1" style="gap: 8px">
              <v-chip size="x-small" variant="tonal" :color="typeColor(r.type)">{{ r.type }}</v-chip>
              <v-chip size="x-small" variant="tonal" :color="statusColor(r.status)">{{ r.status }}</v-chip>
              <span class="text-caption text-medium-emphasis"><Timestamp :date="r.createdAt" /></span>
              <span class="text-caption text-medium-emphasis">· {{ r.contactEmail || r.reporterEmail || 'unknown' }}</span>
              <v-spacer />
              <template v-if="r.status !== 'triaged'">
                <v-btn size="small" variant="text" :loading="busyId === r._id"
                  @click="setStatus(r, 'triaged')">Mark triaged</v-btn>
              </template>
              <template v-if="r.status !== 'resolved'">
                <v-btn size="small" variant="text" color="success" :loading="busyId === r._id"
                  @click="setStatus(r, 'resolved')">Resolve</v-btn>
              </template>
              <template v-if="r.status !== 'new'">
                <v-btn size="small" variant="text" :loading="busyId === r._id"
                  @click="setStatus(r, 'new')">Reopen</v-btn>
              </template>
            </div>
            <div class="fb-message text-body-2">{{ r.message || '(no message)' }}</div>
            <p v-if="diagLine(r.diagnostics)" class="text-caption text-medium-emphasis mt-1 mb-0">
              {{ diagLine(r.diagnostics) }}
            </p>
          </div>
          <p v-if="!list.items.value.length" class="text-medium-emphasis py-4">
            No {{ list.filters.value.status || '' }} feedback — all caught up.
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

const STATUS_OPTIONS = ['new', 'triaged', 'resolved'];
const TYPE_OPTIONS = ['question', 'bug', 'idea'];

const { snack, fromError, success } = useSnackbar();
const newCount = ref(0);
const busyId = ref(null);

const list = usePagedList({
  pageSize: 50,
  filters: { status: 'new', type: '' },
  fetch: async ({ page, pageSize, filters }) => {
    const res = await adminApi.feedback({
      status: filters.status || undefined,
      type: filters.type || undefined,
      page,
      pageSize,
    });
    newCount.value = res.data.newCount;
    return res;
  },
  onError: (e) => fromError(e, 'Failed to load feedback'),
});

function statusColor(status) {
  if (status === 'new') return 'error';
  if (status === 'resolved') return 'success';
  return 'default';
}

function typeColor(type) {
  if (type === 'bug') return 'error';
  if (type === 'idea') return 'primary';
  return 'info';
}

// Compact one-line summary of the captured device/app context.
function diagLine(d) {
  if (!d) return '';
  const parts = [];
  if (d.appVersion) parts.push(`v${d.appVersion}${d.buildNumber ? ` (${d.buildNumber})` : ''}`);
  if (d.platform || d.osVersion) parts.push([d.platform, d.osVersion].filter(Boolean).join(' '));
  if (d.deviceModel) parts.push(d.deviceModel);
  if (d.route) parts.push(`on ${d.route}`);
  if (d.locale) parts.push(d.locale);
  return parts.join(' · ');
}

async function setStatus(row, status) {
  busyId.value = row._id;
  try {
    await adminApi.setFeedbackStatus(row._id, status);
    success(`Marked ${status}.`);
    await list.load();
  } catch (e) {
    fromError(e, 'Could not update the feedback');
  } finally {
    busyId.value = null;
  }
}
</script>

<style scoped>
.fb-row + .fb-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.fb-message {
  white-space: pre-wrap;
  background: rgba(var(--v-theme-on-surface), 0.05);
  border-radius: 8px;
  padding: 10px 12px;
}
</style>
