<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Support inbox</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="reload">Refresh</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      support@householdcalendar.com, live from the mailbox — read, reply (sent as Support), and
      archive. Replies are filed to Sent, so webmail stays in sync.
    </p>

    <v-alert v-if="notConfigured" type="info" variant="tonal" class="mb-4">
      The support mailbox isn't configured on the server. Set
      <code>SUPPORT_EMAIL_USER</code> / <code>SUPPORT_EMAIL_PASS</code> (the support@ mailbox's own
      Migadu credentials) and restart the API.
    </v-alert>

    <template v-else>
      <v-tabs v-model="mailbox" density="comfortable" class="mb-4" @update:model-value="reload">
        <v-tab v-for="b in boxes" :key="b.path" :value="b.path">
          {{ label(b.path) }}
          <v-badge v-if="b.path === 'INBOX' && b.unseen" :content="b.unseen" color="error" inline class="ml-1" />
        </v-tab>
      </v-tabs>

      <v-card rounded="lg" variant="outlined">
        <v-card-text>
          <div v-if="loading" class="text-center py-8"><v-progress-circular indeterminate color="primary" /></div>
          <v-table v-else density="comfortable" hover>
            <thead>
              <tr>
                <th style="width: 170px">Date</th>
                <th style="width: 260px">{{ mailbox === 'Sent' ? 'To' : 'From' }}</th>
                <th>Subject</th>
                <th style="width: 90px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in items" :key="m.uid" style="cursor: pointer" @click="open(m)">
                <td class="text-caption" :class="rowClass(m)"><Timestamp :date="m.date" /></td>
                <td class="text-caption text-truncate" :class="rowClass(m)" style="max-width: 260px">
                  {{ mailbox === 'Sent' ? m.to : m.from }}
                </td>
                <td :class="rowClass(m)">
                  {{ m.subject }}
                  <v-icon v-if="m.hasAttachments" icon="mdi-paperclip" size="x-small" class="ml-1" />
                  <v-icon v-if="m.answered" icon="mdi-reply" size="x-small" class="ml-1 text-medium-emphasis" />
                </td>
                <td @click.stop>
                  <v-btn
                    v-if="mailbox !== 'Sent'" size="small" variant="text"
                    :icon="mailbox === 'INBOX' ? 'mdi-archive-arrow-down-outline' : 'mdi-inbox-arrow-up-outline'"
                    :title="mailbox === 'INBOX' ? 'Archive' : 'Move to inbox'"
                    @click="move(m, mailbox === 'INBOX' ? 'Archive' : 'INBOX')" />
                </td>
              </tr>
              <tr v-if="!items.length">
                <td colspan="4" class="text-medium-emphasis py-4">No messages.</td>
              </tr>
            </tbody>
          </v-table>

          <div class="d-flex align-center mt-3" v-if="total">
            <span class="text-caption text-medium-emphasis">{{ rangeLabel }}</span>
            <v-spacer />
            <v-pagination v-model="page" :length="pageCount" :total-visible="5" density="comfortable"
              @update:model-value="load" />
          </div>
        </v-card-text>
      </v-card>
    </template>

    <!-- Message detail + reply -->
    <v-dialog v-model="dialog" max-width="860">
      <v-card v-if="detail" rounded="lg">
        <v-card-title class="d-flex align-center" style="gap: 8px">
          <span class="text-subtitle-1 font-weight-bold flex-grow-1 text-truncate">{{ detail.subject }}</span>
          <v-btn
            v-if="mailbox !== 'Sent'" size="small" variant="text"
            :prepend-icon="mailbox === 'INBOX' ? 'mdi-archive-arrow-down-outline' : 'mdi-inbox-arrow-up-outline'"
            @click="moveOpen(mailbox === 'INBOX' ? 'Archive' : 'INBOX')">
            {{ mailbox === 'INBOX' ? 'Archive' : 'To inbox' }}
          </v-btn>
          <v-btn icon="mdi-close" variant="text" size="small" @click="dialog = false" />
        </v-card-title>
        <v-card-subtitle class="pb-2">
          <div>From: {{ detail.from }}</div>
          <div>To: {{ detail.to }}<template v-if="detail.cc"> · Cc: {{ detail.cc }}</template></div>
          <div>{{ fmt(detail.date) }}</div>
          <div v-if="detail.attachments.length" class="mt-1">
            <v-chip v-for="a in detail.attachments" :key="a.filename" size="x-small" class="mr-1"
              prepend-icon="mdi-paperclip">
              {{ a.filename }}
            </v-chip>
            <span class="text-caption text-medium-emphasis">(download attachments via webmail)</span>
          </div>
        </v-card-subtitle>
        <v-divider />
        <v-card-text style="max-height: 45vh; overflow-y: auto">
          <div v-if="detailLoading" class="text-center py-8"><v-progress-circular indeterminate color="primary" /></div>
          <!-- Untrusted email HTML only ever renders inside a sandboxed iframe
               (no scripts, no same-origin), never in the admin app's DOM. -->
          <iframe
            v-else-if="detail.html" :srcdoc="detail.html" sandbox=""
            style="width: 100%; height: 40vh; border: 0; background: #fff" title="Email body" />
          <pre v-else class="text-body-2" style="white-space: pre-wrap; font-family: inherit">{{ detail.text }}</pre>
        </v-card-text>
        <template v-if="mailbox !== 'Sent'">
          <v-divider />
          <v-card-text>
            <v-textarea
              v-model="replyText" label="Reply as Calen Support" rows="4" auto-grow
              variant="outlined" hide-details density="comfortable" />
            <div class="d-flex mt-2">
              <v-spacer />
              <v-btn color="primary" prepend-icon="mdi-send" :loading="sending"
                :disabled="!replyText.trim()" @click="sendReply">
                Send reply
              </v-btn>
            </div>
          </v-card-text>
        </template>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { emailApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { fmtDateTime as fmt } from '../lib/format';
import SnackbarHost from '../components/SnackbarHost.vue';
import Timestamp from '../components/Timestamp.vue';

const PAGE_SIZE = 25;
const KNOWN_BOXES = ['INBOX', 'Archive', 'Sent'];

const route = useRoute();
const router = useRouter();
const { snack, success, fromError } = useSnackbar();
const loading = ref(true);
const notConfigured = ref(false);
const boxes = ref([{ path: 'INBOX', unseen: 0 }, { path: 'Archive' }, { path: 'Sent' }]);
const mailbox = ref(KNOWN_BOXES.includes(route.query.mailbox) ? route.query.mailbox : 'INBOX');
const items = ref([]);
const page = ref(1);
const total = ref(0);

const dialog = ref(false);
const detail = ref(null);
const detailLoading = ref(false);
const replyText = ref('');
const sending = ref(false);

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const rangeLabel = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE + 1;
  const end = Math.min(page.value * PAGE_SIZE, total.value);
  return `${start}–${end} of ${total.value}`;
});

function label(path) { return path === 'INBOX' ? 'Inbox' : path; }
function rowClass(m) { return !m.seen && mailbox.value !== 'Sent' ? 'font-weight-bold' : ''; }

function reload() {
  page.value = 1;
  router.replace({
    query: { ...route.query, ...(mailbox.value === 'INBOX' ? { mailbox: undefined } : { mailbox: mailbox.value }) },
  });
  load();
}

async function load() {
  loading.value = true;
  try {
    const [statusRes, listRes] = await Promise.all([
      emailApi.supportStatus(),
      emailApi.supportMessages({ mailbox: mailbox.value, page: page.value, pageSize: PAGE_SIZE }),
    ]);
    if (statusRes.data.configured === false) {
      notConfigured.value = true;
      return;
    }
    notConfigured.value = false;
    boxes.value = statusRes.data.boxes.filter((b) => !b.missing);
    items.value = listRes.data.items;
    total.value = listRes.data.total;
  } catch (e) {
    if (e?.response?.status === 503) notConfigured.value = true;
    else fromError(e, 'Failed to load support mailbox');
  } finally {
    loading.value = false;
  }
}

async function open(m) {
  dialog.value = true;
  detailLoading.value = true;
  detail.value = { ...m, attachments: [] };
  replyText.value = '';
  try {
    const { data } = await emailApi.supportMessage(m.uid, mailbox.value);
    detail.value = data;
    m.seen = true; // server marked it \Seen on fetch
    const inbox = boxes.value.find((b) => b.path === mailbox.value);
    if (inbox && inbox.unseen) inbox.unseen -= 1;
  } catch (e) {
    fromError(e, 'Failed to load message');
    dialog.value = false;
  } finally {
    detailLoading.value = false;
  }
}

async function sendReply() {
  sending.value = true;
  try {
    await emailApi.supportReply(detail.value.uid, { mailbox: mailbox.value, text: replyText.value });
    success('Reply sent');
    replyText.value = '';
    dialog.value = false;
    load();
  } catch (e) {
    fromError(e, 'Failed to send reply');
  } finally {
    sending.value = false;
  }
}

async function move(m, destination) {
  try {
    await emailApi.supportMove(m.uid, { mailbox: mailbox.value, destination });
    success(destination === 'Archive' ? 'Archived' : 'Moved to inbox');
    load();
  } catch (e) {
    fromError(e, 'Failed to move message');
  }
}

async function moveOpen(destination) {
  await move(detail.value, destination);
  dialog.value = false;
}

onMounted(load);
</script>
