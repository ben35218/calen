<template>
  <v-container class="py-6" style="max-width: 1100px">
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <h1 class="text-h5 font-weight-bold">Email lifecycle</h1>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Reload</v-btn>
      <v-btn color="primary" prepend-icon="mdi-content-save" :disabled="!changes.length" :loading="saving" @click="reviewOpen = true">
        Save{{ changes.length ? ` (${changes.length})` : '' }}
      </v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">
      Every email Calen sends across a user's life with the app — from signup to deletion. Bodies are
      code-owned (tested, injection-safe); here you control which optional emails send, override
      subject lines, and set how blocked sends retry. Security mail is always on.
    </p>

    <v-skeleton-loader v-if="loading" type="article, article" />

    <template v-else-if="form">
      <!-- Lifecycle stages -->
      <div v-for="stage in stages" :key="stage.key" class="mb-6">
        <div class="d-flex align-center mb-1" style="gap: 8px">
          <h2 class="text-subtitle-1 font-weight-bold">{{ stage.label }}</h2>
          <span class="text-caption text-medium-emphasis">{{ stage.blurb }}</span>
        </div>
        <v-card rounded="lg" variant="outlined">
          <v-list>
            <template v-for="(t, i) in templatesInStage(stage.key)" :key="t.key">
              <v-divider v-if="i" />
              <v-list-item class="py-3">
                <template #prepend>
                  <v-switch
                    :model-value="t.required ? true : form.templates[t.key].enabled"
                    :disabled="t.required || !t.implemented" color="primary" hide-details density="compact"
                    class="mr-2" @update:model-value="(v) => (form.templates[t.key].enabled = v)" />
                </template>
                <v-list-item-title class="font-weight-medium">
                  {{ t.title }}
                  <v-chip v-if="t.required" size="x-small" color="primary" variant="tonal" class="ml-1">Required</v-chip>
                  <v-chip v-if="!t.implemented" size="x-small" color="default" variant="tonal" class="ml-1">Planned</v-chip>
                </v-list-item-title>
                <v-list-item-subtitle class="text-caption">
                  {{ t.description }}<br>
                  <span class="text-medium-emphasis">Trigger: {{ t.trigger }} · To: {{ t.audience }}</span>
                </v-list-item-subtitle>

                <div v-if="t.implemented" class="d-flex flex-wrap align-center mt-2" style="gap: 12px">
                  <v-text-field
                    v-model="form.templates[t.key].subjectOverride" label="Subject override (optional)"
                    density="compact" variant="outlined" hide-details clearable style="min-width: 320px; flex: 1"
                    placeholder="Leave blank to use the built-in subject" />
                  <v-text-field
                    v-model="form.templates[t.key].note" label="Note (internal)"
                    density="compact" variant="outlined" hide-details clearable style="min-width: 220px" />
                  <v-btn size="small" variant="tonal" prepend-icon="mdi-eye-outline" @click="openPreview(t)">Preview</v-btn>
                </div>
              </v-list-item>
            </template>
          </v-list>
        </v-card>
      </div>

      <!-- Delivery / retry policy -->
      <div class="mb-6">
        <h2 class="text-subtitle-1 font-weight-bold mb-1">Delivery &amp; reconciliation</h2>
        <span class="text-caption text-medium-emphasis">How blocked or transiently-failed sends are retried (the outbox).</span>
        <v-card rounded="lg" variant="outlined" class="mt-1">
          <v-card-text>
            <div class="d-flex flex-wrap" style="gap: 16px">
              <v-text-field v-model.number="form.retry.maxAttempts" type="number" label="Max attempts" density="comfortable" variant="outlined" hide-details style="max-width: 160px" />
              <v-text-field v-model.number="form.retry.baseMinutes" type="number" label="Base backoff (min)" density="comfortable" variant="outlined" hide-details style="max-width: 190px" />
              <v-text-field v-model.number="form.retry.capMinutes" type="number" label="Backoff cap (min)" density="comfortable" variant="outlined" hide-details style="max-width: 190px" />
              <v-switch v-model="form.suppressionEnabled" label="Honor suppression list" color="primary" hide-details inset class="ml-2" />
            </div>
            <p class="text-caption text-medium-emphasis mt-2 mb-0">
              Backoff = base × 2^(attempt−1), capped. Transient/provider-blocked sends retry automatically
              every 10 min; permanent failures (hard bounces) stop and suppress the address.
            </p>
          </v-card-text>
        </v-card>
      </div>

      <!-- Suppression list -->
      <div class="mb-6">
        <h2 class="text-subtitle-1 font-weight-bold mb-1">Suppressed recipients</h2>
        <span class="text-caption text-medium-emphasis">Addresses we stop mailing (hard bounces + manual adds). Security mail still sends.</span>
        <v-card rounded="lg" variant="outlined" class="mt-1">
          <v-card-text>
            <div class="d-flex mb-3 flex-wrap align-center" style="gap: 12px">
              <v-text-field v-model="newSuppress" label="Add an email to suppress" density="compact" variant="outlined" hide-details style="max-width: 320px" @keyup.enter="addSuppress" />
              <v-btn :disabled="!newSuppress" :loading="suppressBusy" prepend-icon="mdi-email-off-outline" @click="addSuppress">Suppress</v-btn>
            </div>
            <v-skeleton-loader v-if="supp.loading.value" type="table-row@3" />
            <v-table v-else density="comfortable">
              <thead>
                <tr><th>Email</th><th style="width: 130px">Reason</th><th style="width: 120px">Source</th><th style="width: 150px">Updated</th><th style="width: 110px">Status</th><th style="width: 90px"></th></tr>
              </thead>
              <tbody>
                <tr v-for="s in supp.items.value" :key="s._id">
                  <td class="text-caption">{{ s.email }}</td>
                  <td><v-chip size="x-small" variant="tonal">{{ s.reason }}</v-chip></td>
                  <td class="text-caption">{{ s.source }}</td>
                  <td class="text-caption"><Timestamp :date="s.updatedAt" /></td>
                  <td><v-chip size="x-small" :color="s.active ? 'warning' : 'default'" variant="tonal">{{ s.active ? 'active' : 'released' }}</v-chip></td>
                  <td>
                    <v-btn v-if="s.active" size="x-small" variant="text" :loading="suppBusyId === s._id" @click="release(s)">Release</v-btn>
                  </td>
                </tr>
                <tr v-if="!supp.items.value.length"><td colspan="6" class="text-medium-emphasis py-4">No suppressed recipients.</td></tr>
              </tbody>
            </v-table>
            <div class="d-flex align-center mt-3" v-if="supp.total.value">
              <span class="text-caption text-medium-emphasis">{{ supp.rangeLabel.value }}</span>
              <v-spacer />
              <v-pagination v-model="supp.page.value" :length="supp.pageCount.value" :total-visible="5" density="comfortable" />
            </div>
          </v-card-text>
        </v-card>
      </div>
    </template>

    <!-- Review-before-save diff -->
    <ConfirmDialog
      v-model="reviewOpen" title="Save email lifecycle changes?" confirm-text="Save" color="primary" :loading="saving"
      :message="`${changes.length} change${changes.length === 1 ? '' : 's'}:\n\n${changes.join('\n')}`"
      @confirm="save" />

    <!-- Template preview -->
    <v-dialog v-model="preview.open" max-width="640">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ preview.title }} — preview</v-card-title>
        <v-card-subtitle>Subject: {{ preview.subject }}</v-card-subtitle>
        <v-card-text>
          <v-progress-linear v-if="preview.loading" indeterminate />
          <iframe v-else :srcdoc="preview.html" sandbox="" style="width:100%;height:60vh;border:1px solid #e5e7eb;border-radius:8px;background:#fff" />
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="preview.open = false">Close</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <SnackbarHost :snack="snack" />
  </v-container>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { emailApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import { usePagedList } from '../composables/usePagedList';
import SnackbarHost from '../components/SnackbarHost.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Timestamp from '../components/Timestamp.vue';

const { snack, success, fromError } = useSnackbar();

const loading = ref(true);
const saving = ref(false);
const reviewOpen = ref(false);
const stages = ref([]);
const catalog = ref([]);       // full template metadata from the server
const form = ref(null);        // editable overlay { templates, retry, suppressionEnabled }
let baseline = '{}';

function templatesInStage(stageKey) {
  return catalog.value.filter((t) => t.stage === stageKey);
}

async function load() {
  loading.value = true;
  try {
    const { data } = await emailApi.catalog();
    stages.value = data.stages;
    catalog.value = data.templates;
    const templates = {};
    for (const t of data.templates) {
      templates[t.key] = {
        enabled: t.config?.enabled !== false,
        subjectOverride: t.config?.subjectOverride || '',
        note: t.config?.note || '',
      };
    }
    form.value = {
      templates,
      retry: { maxAttempts: data.retry?.maxAttempts ?? 5, baseMinutes: data.retry?.baseMinutes ?? 5, capMinutes: data.retry?.capMinutes ?? 240 },
      suppressionEnabled: data.suppressionEnabled !== false,
    };
    baseline = JSON.stringify(form.value);
  } catch (e) { fromError(e, 'Failed to load email lifecycle'); } finally { loading.value = false; }
}

// Leaf diff baseline → current, as readable "path: from → to" lines.
function diffLeaves(before, after, prefix, out) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const a = before?.[k];
    const b = after?.[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') diffLeaves(a, b, path, out);
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return out;
}
const changes = computed(() => {
  if (!form.value) return [];
  return diffLeaves(JSON.parse(baseline), form.value, '', []);
});

async function save() {
  saving.value = true;
  try {
    await emailApi.saveCatalog(form.value);
    baseline = JSON.stringify(form.value);
    reviewOpen.value = false;
    success('Email lifecycle saved');
  } catch (e) { fromError(e, 'Save failed'); } finally { saving.value = false; }
}

// --- Preview ---
const preview = ref({ open: false, loading: false, title: '', subject: '', html: '' });
async function openPreview(t) {
  preview.value = { open: true, loading: true, title: t.title, subject: '', html: '' };
  try {
    const { data } = await emailApi.preview(t.key);
    preview.value.subject = form.value.templates[t.key].subjectOverride || data.subject;
    preview.value.html = data.html || `<pre>${data.text || ''}</pre>`;
  } catch (e) { fromError(e, 'Preview failed'); preview.value.open = false; } finally { preview.value.loading = false; }
}

// --- Suppression list ---
const newSuppress = ref('');
const suppressBusy = ref(false);
const suppBusyId = ref(null);
const supp = usePagedList({
  pageSize: 25,
  filters: {},
  fetch: ({ page, pageSize }) => emailApi.suppressions({ page, pageSize }),
  onError: (e) => fromError(e, 'Failed to load suppressions'),
});
async function addSuppress() {
  if (!newSuppress.value) return;
  suppressBusy.value = true;
  try { await emailApi.addSuppression(newSuppress.value.trim()); newSuppress.value = ''; supp.reload(); success('Suppressed'); }
  catch (e) { fromError(e, 'Suppress failed'); } finally { suppressBusy.value = false; }
}
async function release(s) {
  suppBusyId.value = s._id;
  try { await emailApi.releaseSuppression(s._id); supp.reload(); success('Released'); }
  catch (e) { fromError(e, 'Release failed'); } finally { suppBusyId.value = null; }
}

// Unsaved-changes guards.
function beforeUnload(e) { if (changes.value.length) { e.preventDefault(); e.returnValue = ''; } }
onBeforeRouteLeave(() => {
  if (changes.value.length && !window.confirm('Discard unsaved email lifecycle changes?')) return false;
  return true;
});

onMounted(() => { load(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>
