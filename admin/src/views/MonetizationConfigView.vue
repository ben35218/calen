<template>
  <v-container class="py-6" style="max-width: 1100px">
    <h1 class="text-h5 font-weight-bold mb-1">Monetization config</h1>
    <p class="text-body-2 text-medium-emphasis mb-6">
      Single source of truth for the app unlock, the prepaid credit economy, per-call costs,
      models and guards. Edits take effect on the server within ~30s of saving.
    </p>

    <div v-if="loading" class="text-center py-12"><v-progress-circular indeterminate color="primary" /></div>

    <v-alert v-else-if="!config" type="error" variant="tonal" rounded="lg">
      Couldn't load the monetization config.
      <template #append><v-btn variant="text" @click="load">Retry</v-btn></template>
    </v-alert>

    <template v-else>
      <!-- ===================== CREDITS ===================== -->
      <v-card class="mb-5" rounded="lg" variant="outlined">
        <v-card-title class="text-subtitle-1 font-weight-bold">AI credits</v-card-title>
        <v-card-text>
          <div class="d-flex flex-wrap mb-4" style="gap: 12px">
            <v-text-field v-model.number="config.credits.margin" label="Margin multiplier" type="number" step="0.1" density="compact" variant="outlined" style="max-width: 170px" hide-details />
            <v-text-field v-model.number="config.credits.callRatePerMinute" label="Call raw cost ($/min)" type="number" step="0.01" density="compact" variant="outlined" style="max-width: 190px" hide-details />
            <v-text-field v-model.number="config.credits.starterCredits" label="Starter credits (new user)" type="number" density="compact" variant="outlined" style="max-width: 210px" hide-details />
            <v-text-field v-model.number="config.credits.lowBalanceThreshold" label="Low-balance threshold" type="number" density="compact" variant="outlined" style="max-width: 190px" hide-details />
          </div>

          <div class="text-subtitle-2 mb-2">Action prices (credits per action — what usage debits)</div>
          <div class="d-flex flex-wrap mb-2" style="gap: 12px">
            <v-text-field
              v-for="(_, action) in config.credits.actionCosts" :key="action"
              v-model.number="config.credits.actionCosts[action]"
              :label="action" type="number" density="compact" variant="outlined"
              style="max-width: 150px" hide-details />
          </div>
          <p class="text-caption text-medium-emphasis mb-4">
            Flat published prices, one debit per completed action (<code>callPerMinute</code> is
            prorated per connected second). Set them so price ≈ raw cost × the target margin;
            check the fit on the reconciliation numbers below once real usage exists.
          </p>

          <div class="text-subtitle-2 mb-2">Raw provider cost reference (reconciliation only — never debited)</div>
          <div class="d-flex flex-wrap mb-4" style="gap: 12px">
            <v-text-field
              v-for="(_, fam) in config.credits.tokenRatesPer1M" :key="fam"
              v-model.number="config.credits.tokenRatesPer1M[fam]"
              :label="`${fam} ($/1M tokens)`" type="number" step="0.5" density="compact" variant="outlined"
              style="max-width: 190px" hide-details />
          </div>

          <div class="text-subtitle-2 mb-2">Credit packs (consumable IAPs)</div>
          <div class="pack-grid">
            <div class="th">Product id</div><div class="th">Label</div><div class="th">Price ($)</div><div class="th">Credits</div>
            <template v-for="(pack, pid) in config.credits.packs" :key="pid">
              <div class="rl">{{ pid }}</div>
              <v-text-field v-model="pack.label" density="compact" variant="outlined" hide-details />
              <v-text-field v-model.number="pack.price" type="number" step="0.01" density="compact" variant="outlined" hide-details />
              <v-text-field v-model.number="pack.credits" type="number" density="compact" variant="outlined" hide-details />
            </template>
          </div>
          <p class="text-caption text-medium-emphasis mt-2">
            1 credit = $0.01 retail. Usage debits the flat action prices above (margin is the
            TARGET they're set to hold, not a live multiplier). Pack prices here are display
            fallbacks — the store's localized price is authoritative; the credited amount is what
            the webhook grants. Product ids must match App Store Connect.
          </p>
        </v-card-text>
      </v-card>

      <!-- ===================== UNLOCK / COSTS / MODELS / ADMIN ===================== -->
      <div class="d-flex flex-wrap" style="gap: 16px">
        <v-card class="flex-1-1" rounded="lg" variant="outlined" style="min-width: 320px">
          <v-card-title class="text-subtitle-1 font-weight-bold">App unlock</v-card-title>
          <v-card-text>
            <v-text-field v-model="config.unlock.productId" label="Store product id" density="compact" variant="outlined" class="mb-1" hide-details />
            <v-text-field v-model.number="config.unlock.price" label="Price ($, display fallback)" type="number" step="0.01" density="compact" variant="outlined" hide-details />
            <p class="text-caption text-medium-emphasis mt-1">
              The one-time per-user purchase that opens the app (non-consumable, RevenueCat
              entitlement <code>app_unlock</code>).
            </p>
          </v-card-text>
        </v-card>

        <v-card class="flex-1-1" rounded="lg" variant="outlined" style="min-width: 320px">
          <v-card-title class="text-subtitle-1 font-weight-bold">Calen AI plan (monthly)</v-card-title>
          <v-card-text>
            <v-text-field v-model="config.aiPlan.productId" label="Store product id" density="compact" variant="outlined" class="mb-1" hide-details />
            <v-text-field v-model.number="config.aiPlan.price" label="Price ($/month, display fallback)" type="number" step="0.01" density="compact" variant="outlined" class="mb-1" hide-details />
            <v-text-field v-model.number="config.aiPlan.monthlyCredits" label="Credits granted per period" type="number" density="compact" variant="outlined" hide-details />
            <p class="text-caption text-medium-emphasis mt-1">
              Optional auto-renewable subscription (RevenueCat entitlement <code>calen_ai</code>).
              Each paid period grants the credits; keep it the best per-credit rate or the plan
              has no reason to exist. Granted credits are ordinary balance and never expire.
            </p>
          </v-card-text>
        </v-card>

        <v-card class="flex-1-1" rounded="lg" variant="outlined" style="min-width: 320px">
          <v-card-title class="text-subtitle-1 font-weight-bold">Per-call cost to us ($)</v-card-title>
          <v-card-text>
            <v-text-field v-for="(_, k) in config.costs" :key="k" v-model.number="config.costs[k]" :label="k" type="number" step="0.001" density="compact" variant="outlined" class="mb-1" hide-details />
            <p class="text-caption text-medium-emphasis mt-1">Reference numbers only — billing uses the credit rates above.</p>
          </v-card-text>
        </v-card>

        <v-card class="flex-1-1" rounded="lg" variant="outlined" style="min-width: 320px">
          <v-card-title class="text-subtitle-1 font-weight-bold">Models, guards &amp; admin</v-card-title>
          <v-card-text>
            <v-text-field v-model="config.models.paidChat" label="Chat model" density="compact" variant="outlined" class="mb-3" hide-details />
            <v-text-field v-model.number="config.guards.mapsPerDay" label="Maps calls / household / day" type="number" density="compact" variant="outlined" class="mb-3" hide-details />
            <v-switch
              v-model="config.admin.unlimitedAi"
              color="primary"
              density="compact"
              hide-details
              label="Admins get unlimited AI" />
            <p class="text-caption text-medium-emphasis mt-1">
              When on, users with the <strong>admin</strong> role skip the credit-balance checks
              (for internal team use and testing). Usage is tracked and debited either way.
            </p>
          </v-card-text>
        </v-card>
      </div>

      <!-- ===================== ADD-ONS ===================== -->
      <v-card class="my-5" rounded="lg" variant="outlined">
        <v-card-title class="text-subtitle-1 font-weight-bold">Feature-calendar add-ons</v-card-title>
        <v-card-text>
          <div class="pack-grid">
            <div class="th">Key</div><div class="th">Label</div><div class="th">Price ($)</div><div class="th">Description</div>
            <template v-for="(item, key) in config.addons.items" :key="key">
              <div class="rl">{{ key }}</div>
              <v-text-field v-model="item.label" density="compact" variant="outlined" hide-details />
              <v-text-field v-model.number="item.price" type="number" step="0.01" density="compact" variant="outlined" hide-details />
              <v-text-field v-model="item.description" density="compact" variant="outlined" hide-details />
            </template>
            <div class="rl">bundle</div>
            <v-text-field v-model="config.addons.bundle.label" density="compact" variant="outlined" hide-details />
            <v-text-field v-model.number="config.addons.bundle.price" type="number" step="0.01" density="compact" variant="outlined" hide-details />
            <v-text-field v-model="config.addons.bundle.description" density="compact" variant="outlined" hide-details />
          </div>
          <p class="text-caption text-medium-emphasis mt-2">
            One-time household-wide purchases. Prices are display fallbacks — the store's localized
            price is authoritative.
          </p>
        </v-card-text>
      </v-card>

      <div class="d-flex align-center mb-8" style="gap: 12px">
        <v-btn color="primary" :disabled="!changes.length" @click="openReview">
          Review &amp; save<template v-if="changes.length"> ({{ changes.length }})</template>
        </v-btn>
        <span v-if="!changes.length && savedAt" class="text-caption text-success">Saved {{ savedAt }}</span>
        <span v-else-if="changes.length" class="text-caption text-warning">Unsaved changes</span>
      </div>
    </template>

    <!-- Review the exact diff before it hits the live economy. -->
    <ConfirmDialog
      v-model="reviewOpen" title="Save monetization config?" confirm-text="Save config"
      :loading="saving" @confirm="save">
      <p class="text-body-2 mb-3">These values change billing for every user within ~30 seconds:</p>
      <ul class="text-body-2 pl-4">
        <li v-for="c in changes" :key="c.path">
          <code>{{ c.path }}</code>: {{ c.from }} → <strong>{{ c.to }}</strong>
        </li>
      </ul>
    </ConfirmDialog>

    <SnackbarHost :snack="snack" :timeout="4000" />
  </v-container>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { monetizationApi } from '../services/api';
import { useSnackbar } from '../composables/useSnackbar';
import SnackbarHost from '../components/SnackbarHost.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const { snack, success, error, fromError } = useSnackbar();

const loading = ref(true);
const saving = ref(false);
const savedAt = ref('');
const config = ref(null);
const reviewOpen = ref(false);
let baseline = null; // deep snapshot of the last loaded/saved state

async function load() {
  loading.value = true;
  try {
    const { data } = await monetizationApi.get();
    if (!data.admin) data.admin = { unlimitedAi: true }; // predates the admin-policy section
    // Predates the flat-price / AI-plan restructure (the server backfills on
    // its next singleton load; render sensible defaults meanwhile).
    if (!data.credits.actionCosts) {
      data.credits.actionCosts = { chat: 2, scan: 3, generation: 3, manualParse: 1, aiHelper: 1, callPerMinute: 20 };
    }
    if (!data.aiPlan) data.aiPlan = { productId: 'calen_ai_monthly_499', price: 4.99, monthlyCredits: 600, entitlement: 'calen_ai' };
    config.value = data;
    baseline = JSON.parse(JSON.stringify(editable(data)));
  } catch (e) {
    config.value = null;
    fromError(e, 'Failed to load monetization config');
  } finally {
    loading.value = false;
  }
}

function editable(c) {
  const { credits, unlock, aiPlan, costs, models, guards, admin, addons } = c;
  return { credits, unlock, aiPlan, costs, models, guards, admin, addons };
}

// Leaf-level diff against the baseline, shown in the review dialog and used
// for dirty-state tracking.
function diffLeaves(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const av = a?.[k];
    const bv = b?.[k];
    if (av && bv && typeof av === 'object' && typeof bv === 'object') {
      diffLeaves(av, bv, path, out);
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ path, from: String(av ?? '—'), to: String(bv ?? '—') });
    }
  }
  return out;
}

const changes = computed(() => {
  if (!config.value || !baseline) return [];
  return diffLeaves(baseline, editable(config.value));
});

// The config is the live economy — refuse to save obviously broken numbers.
function validate(c) {
  const errors = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!num(c.credits.margin) || c.credits.margin <= 0) errors.push('Margin multiplier must be > 0');
  if (!num(c.credits.callRatePerMinute) || c.credits.callRatePerMinute < 0) errors.push('Call rate must be ≥ 0');
  if (!Number.isInteger(c.credits.starterCredits) || c.credits.starterCredits < 0) errors.push('Starter credits must be a whole number ≥ 0');
  if (!num(c.credits.lowBalanceThreshold) || c.credits.lowBalanceThreshold < 0) errors.push('Low-balance threshold must be ≥ 0');
  for (const [fam, rate] of Object.entries(c.credits.tokenRatesPer1M || {})) {
    if (!num(rate) || rate < 0) errors.push(`Token rate "${fam}" must be ≥ 0`);
  }
  for (const [pid, pack] of Object.entries(c.credits.packs || {})) {
    if (!pack.label?.trim()) errors.push(`Pack "${pid}" needs a label`);
    if (!num(pack.price) || pack.price < 0) errors.push(`Pack "${pid}" price must be ≥ 0`);
    if (!Number.isInteger(pack.credits) || pack.credits <= 0) errors.push(`Pack "${pid}" credits must be a whole number > 0`);
  }
  for (const [action, price] of Object.entries(c.credits.actionCosts || {})) {
    if (!Number.isInteger(price) || price < 0) errors.push(`Action price "${action}" must be a whole number of credits ≥ 0`);
  }
  if (!num(c.unlock.price) || c.unlock.price < 0) errors.push('Unlock price must be ≥ 0');
  if (!num(c.aiPlan.price) || c.aiPlan.price < 0) errors.push('AI plan price must be ≥ 0');
  if (!Number.isInteger(c.aiPlan.monthlyCredits) || c.aiPlan.monthlyCredits < 0) errors.push('AI plan monthly credits must be a whole number ≥ 0');
  for (const [k, v] of Object.entries(c.costs || {})) {
    if (!num(v) || v < 0) errors.push(`Cost "${k}" must be ≥ 0`);
  }
  if (!Number.isInteger(c.guards.mapsPerDay) || c.guards.mapsPerDay < 0) errors.push('Maps/day guard must be a whole number ≥ 0');
  const addonRows = { ...(c.addons?.items || {}), bundle: c.addons?.bundle };
  for (const [key, item] of Object.entries(addonRows)) {
    if (!item) continue;
    if (!item.label?.trim()) errors.push(`Add-on "${key}" needs a label`);
    if (!num(item.price) || item.price < 0) errors.push(`Add-on "${key}" price must be ≥ 0`);
  }
  return errors;
}

function openReview() {
  const errors = validate(editable(config.value));
  if (errors.length) {
    error(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''));
    return;
  }
  reviewOpen.value = true;
}

async function save() {
  saving.value = true;
  try {
    await monetizationApi.update(editable(config.value));
    baseline = JSON.parse(JSON.stringify(editable(config.value)));
    savedAt.value = new Date().toLocaleTimeString();
    reviewOpen.value = false;
    success('Config saved');
  } catch (e) {
    fromError(e, 'Failed to save config');
  } finally {
    saving.value = false;
  }
}

// Unsaved-changes guards: in-app navigation and tab close.
onBeforeRouteLeave(() => {
  if (!changes.value.length) return true;
  return window.confirm('You have unsaved monetization changes. Leave without saving?');
});
function beforeUnload(e) {
  if (changes.value.length) e.preventDefault();
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload);
  load();
});
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
</script>

<style scoped>
.pack-grid {
  display: grid;
  grid-template-columns: 140px 1fr 120px 1fr;
  gap: 8px 12px;
  align-items: center;
}
.pack-grid .th { font-weight: 600; font-size: 0.85rem; }
.pack-grid .rl { font-size: 0.85rem; color: rgba(var(--v-theme-on-surface), 0.6); }
.flex-1-1 { flex: 1 1 0; }
</style>
