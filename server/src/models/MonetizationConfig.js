const mongoose = require('mongoose');

// Single source of truth for monetization: the app-unlock product, the prepaid
// AI-credit economy (rates/margin/packs/starter grant), per-call API cost
// references, model choices, the add-on catalog, and abuse guards.
//
// There is exactly ONE document (singleton). The admin /monetization-config
// page reads and writes it; the usageMeter middleware and billing routes read
// it. Counters listed in `METERED_ACTIONS` are always tracked (incremented)
// for analytics even though enforcement is the prepaid credit balance.

// Action keys we COUNT for analytics (feature-mix / adoption). Not caps —
// enforcement is the per-user credit balance.
const METERED_ACTIONS = ['chat', 'scan', 'generation', 'manualParse', 'aiHelper'];

// Feature-calendar add-on keys (calendar ids). Order = display order: the paid
// store products first, then the free opt-in calendars (price 0 in the catalog).
const ADDON_KEYS = ['recipes', 'maintenance', 'trips', 'birthdays', 'chores'];

// Add-on labels that were renamed after some config docs were already saved.
// A stored doc still holding a retired label is upgraded to the current default
// on load. Scoped to the exact old string, so an admin-customized label (which
// wouldn't match) is left untouched. `birthdays` shipped as "Birthdays" before
// the calendar was broadened and renamed "Occasions".
const RETIRED_ADDON_LABELS = { birthdays: ['Birthdays'] };

// Normalize a stored `addons.items` map against DEFAULTS, in place: backfill
// catalog items added after the doc was created, force-sync a now-free add-on's
// price (a stale paid price would block /billing/addons/claim, which validates
// price === 0), and upgrade a retired label to its current name. Returns true if
// anything changed. Pure over a plain object (no mongoose) so it's unit-testable.
function normalizeAddonItems(items) {
  let changed = false;
  for (const key of ADDON_KEYS) {
    const def = DEFAULTS.addons.items[key];
    const cur = items[key];
    if (!cur || (def.price === 0 && cur.price !== 0)) {
      items[key] = { ...def };
      changed = true;
      continue;
    }
    // Upgrade a stored label that still holds a since-renamed default (e.g.
    // "Birthdays" → "Occasions"); an admin-customized label won't match the
    // retired string, so it's preserved.
    if ((RETIRED_ADDON_LABELS[key] || []).includes(cur.label) && cur.label !== def.label) {
      cur.label = def.label;
      changed = true;
    }
  }
  return changed;
}

const DEFAULTS = {
  // Prepaid AI-credit economy. 1 credit = $0.01 of RETAIL value; balances are
  // stored in integer millicredits (1 credit = 1000 Mc). Usage debits at
  // raw cost × `margin` (2.0 = 100% margin):
  //   tokens: ceil(tokens × ratePer1M/1e6 × margin × 100 × 1000) Mc
  //   calls:  ceil(seconds × callRatePerMinute/60 × margin × 100 × 1000) Mc
  // `tokenRatesPer1M` are blended RAW $ per 1M tokens (input+output+cache),
  // matched by substring on the model id ('haiku'/'sonnet'), else `default`.
  // Deliberately rough — tune the rates against real spend, not the formula.
  credits: {
    margin: 2.0,
    tokenRatesPer1M: { default: 6, haiku: 3, sonnet: 10 },
    // Raw Vapi cost per connected minute (STT + TTS + telephony; measured ~$0.082).
    callRatePerMinute: 0.10,
    // One-time grant per new user (in credits), so the AI can be tried before
    // the first pack purchase. Idempotent via the CreditLedger.
    starterCredits: 100,
    // Balance (in credits) at/below which clients show the low-balance state.
    lowBalanceThreshold: 25,
    // Consumable credit packs. Keys are the store product ids; `price` is a USD
    // display FALLBACK (the store's localized price is authoritative);
    // `credits` is what the webhook grants. Bigger packs carry a volume bonus.
    packs: {
      credits_499:  { label: 'Starter',    price: 4.99,  credits: 500 },
      credits_999:  { label: 'Plus',       price: 9.99,  credits: 1050 },
      credits_1999: { label: 'Best value', price: 19.99, credits: 2200 },
    },
  },
  // The $4.99 one-time PER-USER app unlock (non-consumable IAP, RevenueCat
  // entitlement `app_unlock`). `price` is a USD display fallback.
  unlock: { price: 4.99, productId: 'app_unlock_499' },
  // $ per call — reference numbers for the admin page; not used for billing.
  costs: {
    sonnetChat:  0.03,
    haikuChat:   0.01,
    scan:        0.015,
    generation:  0.012,
    manualParse: 0.15,
    mapsMonthly: 0.10,
  },
  models: {
    freeChat: 'claude-haiku-4-5-20251001',
    paidChat: 'claude-sonnet-4-6',
  },
  // Feature-calendar add-ons acquired on the mobile "Add-ons" screen, keyed by
  // calendar ids (they match Household.addons and the mobile CALENDARS
  // registry). Price > 0 = one-time store purchase (paid prices are USD display
  // FALLBACKS only — the store's localized price is authoritative, same
  // doctrine as the packs). Price 0 = included free but OPT-IN: never sold
  // through the store; a member claims it via POST /billing/addons/claim.
  addons: {
    items: {
      recipes:     { label: 'Meals',       price: 2.99, description: 'Meal planner, recipes and the grocery schedule on your calendar' },
      maintenance: { label: 'Maintenance', price: 2.99, description: 'Home and vehicle maintenance tasks on your calendar' },
      trips:       { label: 'Trips',       price: 2.99, description: 'Trip planning with legs, expenses and calendar overlays' },
      birthdays:   { label: 'Occasions',   price: 0,    description: 'Birthdays, anniversaries, and other dates from your people — on the calendar every year, with e-cards' },
      chores:      { label: 'Chores',      price: 0,    description: 'Recurring household chores the family shares' },
    },
    bundle: { label: 'All add-ons', price: 7.99, description: 'Every paid feature calendar in one purchase' },
  },
  guards: { mapsPerDay: 500 },
  // Admin-account policy. `unlimitedAi: true` exempts users with role 'admin'
  // from the credit-balance pre-checks (internal team + testing); usage is
  // still tracked and debited either way. Flip to false in the admin app to
  // meter admins exactly like everyone else. Read by the usageMeter middleware
  // and the billing-status payload.
  admin: { unlimitedAi: true },
};

const monetizationConfigSchema = new mongoose.Schema(
  {
    // Marker so we can upsert the one-and-only document.
    singleton: { type: String, default: 'config', unique: true, index: true },
    credits:  { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.credits },
    unlock:   { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.unlock },
    costs:    { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.costs },
    models:   { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.models },
    addons:   { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.addons },
    guards:   { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.guards },
    admin:    { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.admin },
  },
  { timestamps: true, minimize: false }
);

// Fetch the singleton, creating it from defaults on first access. Backfills
// sections added after a doc was created and strips retired ones (the
// subscription-era `tiers`/`activity`/`fees`).
monetizationConfigSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ singleton: 'config' });
  if (!doc) doc = await this.create({ singleton: 'config' });

  let dirty = false;
  // Backfill the credit economy + unlock product for docs predating prepaid
  // credits (the subscription era).
  if (!doc.credits) {
    doc.credits = JSON.parse(JSON.stringify(DEFAULTS.credits));
    doc.markModified('credits');
    dirty = true;
  }
  if (!doc.unlock) {
    doc.unlock = { ...DEFAULTS.unlock };
    doc.markModified('unlock');
    dirty = true;
  }
  if (!doc.admin) {
    doc.admin = { ...DEFAULTS.admin };
    doc.markModified('admin');
    dirty = true;
  }
  if (!doc.addons) {
    doc.addons = JSON.parse(JSON.stringify(DEFAULTS.addons));
    doc.markModified('addons');
    dirty = true;
  } else {
    if (!doc.addons.items) doc.addons.items = {};
    if (normalizeAddonItems(doc.addons.items)) {
      doc.markModified('addons');
      dirty = true;
    }
  }
  // Strip retired subscription-era sections so the doc matches the schema the
  // admin app round-trips.
  for (const legacy of ['tiers', 'activity', 'fees', 'stripe']) {
    if (doc.get(legacy) !== undefined) {
      doc.set(legacy, undefined, { strict: false });
      dirty = true;
    }
  }
  if (dirty) await doc.save();

  return doc;
};

const MonetizationConfig = mongoose.model('MonetizationConfig', monetizationConfigSchema);
MonetizationConfig.DEFAULTS = DEFAULTS;
MonetizationConfig.METERED_ACTIONS = METERED_ACTIONS;
MonetizationConfig.ADDON_KEYS = ADDON_KEYS;
MonetizationConfig.RETIRED_ADDON_LABELS = RETIRED_ADDON_LABELS;
MonetizationConfig.normalizeAddonItems = normalizeAddonItems;

module.exports = MonetizationConfig;
