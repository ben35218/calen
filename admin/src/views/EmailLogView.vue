<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Email log</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-email-sync-outline" :loading="reconciling" @click="reconcileNow">Reconcile now</v-btn>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="refresh">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Every email sent from no-reply@householdcalendar.com — invites, password resets, welcome and
      account notices. Bodies aren't stored. "dry" means SMTP wasn't configured; "queued" is a
      provider-blocked send waiting in the outbox for an automatic retry.
    </p>

    <div class="d-flex mb-4 flex-wrap" style="gap: 8px">
      <v-chip label color="info" variant="tonal" prepend-icon="mdi-tray-full">Queued {{ stats.queued }}</v-chip>
      <v-chip label color="error" variant="tonal" prepend-icon="mdi-alert-circle-outline">Failed {{ stats.failed }}</v-chip>
      <v-chip label color="warning" variant="tonal" prepend-icon="mdi-email-off-outline">Suppressed {{ stats.suppressed }}</v-chip>
    </div>

    <div class="d-flex mb-4 flex-wrap" style="gap: 12px">
      <v-text-field
        v-model="list.filters.value.q" label="Recipient or subject" density="comfortable" variant="outlined"
        hide-details clearable style="max-width: 320px" prepend-inner-icon="mdi-magnify"
        @update:model-value="list.onSearch" />
      <v-select
        v-model="list.filters.value.status" :items="STATUS_OPTIONS" label="Status" density="comfortable"
        variant="outlined" hide-details clearable style="max-width: 180px" @update:model-value="list.reload" />
      <v-select
        v-model="list.filters.value.kind" :items="KIND_OPTIONS" label="Type" density="comfortable"
        variant="outlined" hide-details clearable style="max-width: 240px" @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="table-row@8" />
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th style="width: 140px">When</th>
              <th>To</th>
              <th>Subject</th>
              <th style="width: 170px">Type</th>
              <th style="width: 150px">Status</th>
              <th style="width: 56px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in list.items.value" :key="e._id">
              <td class="text-caption"><Timestamp :date="e.at" /></td>
              <td class="text-caption">{{ e.to }}</td>
              <td>
                {{ e.subject }}
                <div v-if="e.lastError || e.error" class="text-caption text-error">{{ e.lastError || e.error }}</div>
              </td>
              <td><v-chip size="small" variant="tonal">{{ e.kind }}</v-chip></td>
              <td>
                <v-chip size="small" :color="statusColor(e.status)" variant="tonal">{{ e.status }}</v-chip>
                <div v-if="e.status === 'queued' && e.nextAttemptAt" class="text-caption text-medium-emphasis mt-1">
                  try {{ e.attempts }} · next <Timestamp :date="e.nextAttemptAt" />
                </div>
              </td>
              <td>
                <v-menu v-if="rowActions(e).length" location="bottom end">
                  <template #activator="{ props }">
                    <v-btn icon="mdi-dots-vertical" size="small" variant="text" v-bind="props" :loading="busyId === e._id" />
                  </template>
                  <v-list density="compact">
                    <v-list-item v-for="a in rowActions(e)" :key="a.key" :prepend-icon="a.icon" :title="a.label" @click="a.run(e)" />
                  </v-list>
                </v-menu>
              </td>
            </tr>
            <tr v-if="!list.items.value.length">
              <td colspan="6" class="text-medium-emphasis py-4">
                No emails logged{{ hasFilter ? ' — try clearing the filters' : ' yet' }}.
              </td>
            </tr>
          </tbody>
        </v-table>

        <div class="d-flex align-center mt-3" v-if="list.total.value">
          <span class="text-caption text-medium-emphasis">{{ list.rangeLabel.value }}</span>
          <v-spacer />
          <v-pagination v-model="list.page.value" :length="list.pageCount.value" :total-visible="5" density="comfortable" />
        </div>
      </v-card-text>
    </v-card>

    <ConfirmDialog
      v-model="confirm.open" :title="confirm.title" :message="confirm.message"
      :confirm-text="confirm.confirmText" :color="confirm.color" :loading="!!busyId"
      @confirm="confirm.onConfirm" />
    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { emailApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import SnackbarHost from '../components/SnackbarHost.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Timestamp from '../components/Timestamp.vue';

const STATUS_OPTIONS = ['sent', 'queued', 'failed', 'suppressed', 'canceled', 'dry'];
// Keep in step with the server catalog (services/emailCatalog.js). `other`
// covers retired kinds still present in historical logs — the ongoing-access
// invites (household/calendar/trip) are device-composed now, no longer server-sent.
const KIND_OPTIONS = [
  'welcome', 'password_reset', 'security_alert', 'event_invitation',
  'recipe_share', 'ecard', 'account_deleted', 'other',
];

const { snack, success, fromError } = useSnackbar();
const busyId = ref(null);
const stats = ref({ queued: 0, failed: 0, suppressed: 0 });
const reconciling = ref(false);

const confirm = ref({ open: false, title: '', message: '', confirmText: 'Confirm', color: 'primary', onConfirm: () => {} });

const list = usePagedList({
  pageSize: 50,
  filters: { q: '', status: null, kind: null },
  fetch: ({ page, pageSize, filters }) => emailApi.log({
    q: filters.q || undefined,
    status: filters.status || undefined,
    kind: filters.kind || undefined,
    page, pageSize,
  }),
  onError: (e) => fromError(e, 'Failed to load email log'),
});

const hasFilter = computed(() =>
  !!(list.filters.value.q || list.filters.value.status || list.filters.value.kind));

function statusColor(status) {
  if (status === 'sent') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'queued') return 'info';
  if (status === 'suppressed') return 'warning';
  return 'default'; // dry, canceled
}

async function loadStats() {
  try { stats.value = (await emailApi.logStats()).data; } catch { /* best-effort header */ }
}

function refresh() {
  list.load();
  loadStats();
}

async function reconcileNow() {
  reconciling.value = true;
  try {
    const { data } = await emailApi.reconcile();
    success(`Reconciled — ${data.sent} sent, ${data.requeued} requeued, ${data.failed} failed`);
    refresh();
  } catch (e) { fromError(e, 'Reconcile failed'); } finally { reconciling.value = false; }
}

async function doRetry(e) {
  busyId.value = e._id;
  try {
    const { data } = await emailApi.retry(e._id);
    Object.assign(e, data.email);
    success(data.email.status === 'sent' ? 'Sent' : `Still ${data.email.status}`);
    loadStats();
  } catch (err) { fromError(err, 'Retry failed'); } finally { busyId.value = null; }
}

function askCancel(e) {
  confirm.value = {
    open: true, title: 'Cancel queued email?', color: 'warning', confirmText: 'Cancel send',
    message: `Drop the queued email to ${e.to} from the outbox without sending it?`,
    onConfirm: async () => {
      busyId.value = e._id;
      try { Object.assign(e, (await emailApi.cancel(e._id)).data.email); success('Canceled'); loadStats(); }
      catch (err) { fromError(err, 'Cancel failed'); }
      finally { busyId.value = null; confirm.value.open = false; }
    },
  };
}

function askSuppress(e) {
  confirm.value = {
    open: true, title: 'Suppress recipient?', color: 'error', confirmText: 'Suppress',
    message: `Stop sending non-essential email to ${e.to}? Security mail (password resets, sign-in alerts) still goes through. You can release this from the Email lifecycle page.`,
    onConfirm: async () => {
      busyId.value = e._id;
      try { await emailApi.addSuppression(e.to); success(`Suppressed ${e.to}`); loadStats(); }
      catch (err) { fromError(err, 'Suppress failed'); }
      finally { busyId.value = null; confirm.value.open = false; }
    },
  };
}

// Actions available per row, by status.
function rowActions(e) {
  const out = [];
  if (e.status === 'queued') {
    out.push({ key: 'retry', icon: 'mdi-send-clock-outline', label: 'Retry now', run: doRetry });
    out.push({ key: 'cancel', icon: 'mdi-close-circle-outline', label: 'Cancel retry', run: askCancel });
  }
  if (e.status === 'failed' || e.status === 'queued') {
    out.push({ key: 'suppress', icon: 'mdi-email-off-outline', label: 'Suppress recipient', run: askSuppress });
  }
  return out;
}

onMounted(loadStats);
</script>
