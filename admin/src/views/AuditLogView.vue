<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Audit log</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-download" @click="exportCsv">Export CSV</v-btn>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="list.load">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      E2EE key &amp; membership lifecycle plus sensitive admin actions (roles, billing overrides,
      config edits, support-mail access). Content is never logged — only who did what, and when.
    </p>

    <div class="d-flex mb-4" style="gap: 12px; max-width: 420px">
      <v-select
        v-model="list.filters.value.event" :items="EVENT_OPTIONS" label="Event type" density="comfortable"
        variant="outlined" hide-details clearable @update:model-value="list.reload" />
    </div>

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="table-row@8" />
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th style="width: 140px">When</th>
              <th>Event</th>
              <th>Household</th>
              <th>Actor</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in list.items.value" :key="l._id">
              <td class="text-caption"><Timestamp :date="l.at" /></td>
              <td><v-chip size="small" :color="color(l.event)" variant="tonal">{{ l.event }}</v-chip></td>
              <td>{{ l.householdName || '—' }}</td>
              <td class="text-caption">{{ l.userEmail || '—' }}</td>
              <td class="text-caption text-medium-emphasis">{{ metaStr(l.meta) }}</td>
            </tr>
            <tr v-if="!list.items.value.length">
              <td colspan="5" class="text-medium-emphasis py-4">
                No audit events{{ list.filters.value.event ? ' of this type' : '' }}.
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

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { adminApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import { downloadCsv } from '../lib/csv';
import SnackbarHost from '../components/SnackbarHost.vue';
import Timestamp from '../components/Timestamp.vue';

// Mirrors AuditLog.EVENTS on the server (minus purely-historical ones would
// still appear in unfiltered results).
const EVENT_OPTIONS = [
  'hdk_minted', 'member_approved', 'hdk_rotated', 'key_enrolled',
  'deletion_scheduled', 'deletion_canceled', 'deletion_purged', 'plaintext_dropped',
  'admin_role_changed', 'unlock_changed', 'credits_adjusted', 'config_changed',
  'moderation_status_changed', 'support_message_read', 'support_reply_sent', 'support_message_moved',
  'plan_changed', // legacy (subscription era)
];

const { snack, fromError } = useSnackbar();

const list = usePagedList({
  pageSize: 50,
  filters: { event: null },
  fetch: ({ page, pageSize, filters }) =>
    adminApi.audit({ event: filters.event || undefined, page, pageSize }),
  onError: (e) => fromError(e, 'Failed to load audit log'),
});

function metaStr(meta) {
  if (!meta || !Object.keys(meta).length) return '';
  return Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join(', ');
}

function color(event) {
  if (event === 'plaintext_dropped') return 'success';
  if (['plan_changed', 'admin_role_changed', 'unlock_changed', 'credits_adjusted', 'config_changed'].includes(event)) return 'orange';
  if (event.startsWith('deletion')) return 'error';
  if (event.startsWith('support_') || event === 'moderation_status_changed') return 'teal';
  if (event.startsWith('hdk') || event === 'key_enrolled') return 'primary';
  return 'default';
}

async function exportCsv() {
  try {
    const event = list.filters.value.event || undefined;
    const rows = [];
    for (let page = 1; page <= 10; page++) { // safety cap: 10 × 200 = 2000 rows
      const { data } = await adminApi.audit({ event, page, pageSize: 200 });
      rows.push(...data.items);
      if (rows.length >= data.total) break;
    }
    downloadCsv('audit-log.csv', [
      { label: 'When', key: 'at' },
      { label: 'Event', key: 'event' },
      { label: 'Household', key: 'householdName' },
      { label: 'Actor', key: 'userEmail' },
      { label: 'Details', value: (l) => metaStr(l.meta) },
    ], rows);
  } catch (e) {
    fromError(e, 'Failed to export audit log');
  }
}
</script>
