<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Users</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-download" @click="exportCsv">Export CSV</v-btn>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="list.loading.value" @click="list.load">Refresh</v-btn>
    </div>

    <v-text-field
      v-model="list.filters.value.q" placeholder="Search by email or name" prepend-inner-icon="mdi-magnify"
      density="comfortable" variant="outlined" hide-details clearable class="mb-4" style="max-width: 420px"
      @update:model-value="list.onSearch" />

    <v-card rounded="lg" variant="outlined">
      <v-card-text>
        <v-skeleton-loader v-if="list.loading.value" type="table-row@8" />
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Household</th>
              <th>App version</th>
              <th style="width: 140px">Role</th>
              <th style="width: 150px" class="text-right">Admin access</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in list.items.value" :key="u._id">
              <td class="font-weight-medium">
                <router-link :to="{ path: '/billing', query: { q: u.email } }" class="cross-link" title="Open in Billing">
                  {{ u.email }}
                </router-link>
              </td>
              <td>{{ [u.firstName, u.lastName].filter(Boolean).join(' ') || '—' }}</td>
              <td>{{ u.householdName || '—' }}</td>
              <td class="text-caption">
                {{ u.clientVersion || '—' }}<span v-if="u.clientPlatform" class="text-medium-emphasis"> ({{ u.clientPlatform }})</span>
              </td>
              <td>
                <v-chip size="small" :color="u.role === 'admin' ? 'primary' : 'default'" variant="tonal">{{ u.role }}</v-chip>
              </td>
              <td class="text-right">
                <v-switch
                  :model-value="u.role === 'admin'" color="primary" density="compact" hide-details inset
                  :loading="savingId === u._id" :disabled="u._id === auth.user?._id"
                  @update:model-value="v => askRoleChange(u, v)" />
              </td>
            </tr>
            <tr v-if="!list.items.value.length">
              <td colspan="6" class="text-medium-emphasis py-4">
                No users found{{ list.filters.value.q ? ' — try clearing the search' : '' }}.
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

    <!-- Admin access is the portal's most sensitive toggle — always confirm. -->
    <ConfirmDialog
      v-model="confirm.open" :loading="savingId !== null"
      :title="confirm.grant ? 'Grant admin access?' : 'Revoke admin access?'"
      :confirm-text="confirm.grant ? 'Grant admin' : 'Revoke admin'"
      :color="confirm.grant ? 'primary' : 'error'"
      @confirm="applyRoleChange">
      <template v-if="confirm.user">
        <strong>{{ confirm.user.email }}</strong>
        {{ confirm.grant
          ? 'will get full access to this console: billing overrides, monetization config, support email, and user management.'
          : 'will immediately lose access to this console.' }}
      </template>
    </ConfirmDialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { ref } from 'vue';
import { adminApi } from '../services/api';
import { useAuthStore } from '../stores/auth';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import { downloadCsv } from '../lib/csv';
import SnackbarHost from '../components/SnackbarHost.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const auth = useAuthStore();
const { snack, success, fromError } = useSnackbar();

const list = usePagedList({
  pageSize: 50,
  filters: { q: '' },
  fetch: ({ page, pageSize, filters }) =>
    adminApi.users({ q: (filters.q || '').trim() || undefined, page, pageSize }),
  onError: (e) => fromError(e, 'Failed to load users'),
});

const savingId = ref(null);
const confirm = ref({ open: false, user: null, grant: false });

function askRoleChange(u, isAdmin) {
  confirm.value = { open: true, user: u, grant: isAdmin };
}

async function applyRoleChange() {
  const { user: u, grant } = confirm.value;
  const role = grant ? 'admin' : 'user';
  savingId.value = u._id;
  try {
    await adminApi.setRole(u._id, role);
    u.role = role;
    success(`${u.email} → ${role}`);
    confirm.value.open = false;
  } catch (e) {
    fromError(e, 'Failed to update role');
  } finally {
    savingId.value = null;
  }
}

// Export the full (filtered) list, walking the server's pagination.
async function exportCsv() {
  try {
    const q = (list.filters.value.q || '').trim() || undefined;
    const rows = [];
    for (let page = 1; page <= 10; page++) { // safety cap: 10 × 200 = 2000 rows
      const { data } = await adminApi.users({ q, page, pageSize: 200 });
      rows.push(...data.items);
      if (rows.length >= data.total) break;
    }
    downloadCsv('users.csv', [
      { label: 'Email', key: 'email' },
      { label: 'Name', value: (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') },
      { label: 'Household', key: 'householdName' },
      { label: 'Role', key: 'role' },
      { label: 'App version', key: 'clientVersion' },
      { label: 'Platform', key: 'clientPlatform' },
      { label: 'Created', key: 'createdAt' },
    ], rows);
  } catch (e) {
    fromError(e, 'Failed to export users');
  }
}
</script>

<style scoped>
.cross-link { color: inherit; text-decoration: none; }
.cross-link:hover { text-decoration: underline; }
</style>
