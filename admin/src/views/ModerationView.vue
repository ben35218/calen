<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Content reports</h1>
      <v-chip v-if="openCount" size="small" color="error" variant="tonal">{{ openCount }} open</v-chip>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="list.load">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      AI-generated messages users flagged as objectionable (Apple Guideline 1.2). The reported message
      is shown so it can be reviewed and acted on; triage each one when handled.
    </p>

    <div class="d-flex mb-4" style="gap: 12px; max-width: 420px">
      <v-select
        v-model="list.filters.value.status" :items="STATUS_OPTIONS" label="Status" density="comfortable"
        variant="outlined" hide-details clearable @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="list-item-three-line@4" />
        <template v-else>
          <div v-for="r in list.items.value" :key="r._id" class="report-row py-3">
            <div class="d-flex align-center mb-1" style="gap: 8px">
              <v-chip size="x-small" variant="tonal" color="primary">{{ r.surface }}</v-chip>
              <v-chip size="x-small" variant="tonal" :color="statusColor(r.status)">{{ r.status }}</v-chip>
              <span class="text-caption text-medium-emphasis"><Timestamp :date="r.createdAt" /></span>
              <span class="text-caption text-medium-emphasis">· {{ r.reporterEmail || 'unknown' }}</span>
              <v-spacer />
              <template v-if="r.status !== 'reviewed'">
                <v-btn size="small" variant="text" color="success" :loading="busyId === r._id"
                  @click="setStatus(r, 'reviewed')">Mark reviewed</v-btn>
              </template>
              <template v-if="r.status !== 'dismissed'">
                <v-btn size="small" variant="text" :loading="busyId === r._id"
                  @click="setStatus(r, 'dismissed')">Dismiss</v-btn>
              </template>
              <template v-if="r.status !== 'open'">
                <v-btn size="small" variant="text" :loading="busyId === r._id"
                  @click="setStatus(r, 'open')">Reopen</v-btn>
              </template>
            </div>
            <p v-if="r.reason" class="text-caption text-medium-emphasis mb-1">Reason: {{ r.reason }}</p>
            <div class="report-content text-body-2">{{ r.content || '(no content captured)' }}</div>
          </div>
          <p v-if="!list.items.value.length" class="text-medium-emphasis py-4">
            No {{ list.filters.value.status || '' }} reports — all caught up.
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

const STATUS_OPTIONS = ['open', 'reviewed', 'dismissed'];

const { snack, fromError, success } = useSnackbar();
const openCount = ref(0);
const busyId = ref(null);

const list = usePagedList({
  pageSize: 50,
  filters: { status: 'open' },
  fetch: async ({ page, pageSize, filters }) => {
    const res = await adminApi.moderation({ status: filters.status || undefined, page, pageSize });
    openCount.value = res.data.openCount;
    return res;
  },
  onError: (e) => fromError(e, 'Failed to load content reports'),
});

function statusColor(status) {
  if (status === 'open') return 'error';
  if (status === 'reviewed') return 'success';
  return 'default';
}

async function setStatus(report, status) {
  busyId.value = report._id;
  try {
    await adminApi.setReportStatus(report._id, status);
    success(`Marked ${status}.`);
    await list.load();
  } catch (e) {
    fromError(e, 'Could not update the report');
  } finally {
    busyId.value = null;
  }
}
</script>

<style scoped>
.report-row + .report-row { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.report-content {
  white-space: pre-wrap;
  background: rgba(var(--v-theme-on-surface), 0.05);
  border-radius: 8px;
  padding: 10px 12px;
}
</style>
