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
  // `tokenRatesPer1M` are RAW $ per 1M tokens PER TOKEN TYPE — Anthropic bills
  // input, output, cache reads (~0.1× input), and cache writes (1.25× input) at
  // very different rates, and chat turns are cache-read heavy, so a blended
  // rate wildly overprices them. Families are matched by substring on the model
  // id ('haiku'/'sonnet'), else `default`. A legacy stored NUMBER (the old
  // blended rate) is still honored by credits.tokenCostMc (applied to every
  // type) until getSingleton migrates it to the per-type shape.
  credits: {
    margin: 2.0,
    // Chat is TOKEN-PRICED (not flat): each turn debits whole credits sized to
    // cover its token provider-cost AFTER Apple's storefront cut, plus a slight
    // margin, ceiled (credits.chatCreditsForTokens). `appleFeePct` is Apple's
    // commission (0.15 = App Store Small Business Program); `chatMargin` is the
    // target markup on the after-Apple cost, clamped [1.0, 1.5] — 1.0 leans on
    // the ceil for the margin. These tune the band; the token rates below still
    // supply the raw cost.
    appleFeePct: 0.15,
    chatMargin: 1.0,
    tokenRatesPer1M: {
      default: { input: 6, output: 30, cacheRead: 0.6,  cacheWrite: 7.5  },
      haiku:   { input: 1, output: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
      sonnet:  { input: 3, output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
    },
    // Raw Vapi cost per connected minute (STT + TTS + telephony; measured ~$0.082).
    callRatePerMinute: 0.10,
    // Raw Anthropic web-search fee per executed search ($10 / 1,000 searches).
    // The extra result tokens a search injects are already captured by the
    // token counters — this covers only the per-search API fee.
    webSearchRatePerSearch: 0.01,
    // FLAT published credit prices per completed action — what usage actually
    // debits (whole credits; `callPerMinute` is prorated per connected second).
    // Set from metered token averages with `margin` built in; the token/call
    // rates above are the raw PROVIDER-COST reference used only to estimate
    // spend for margin reconciliation, never to debit. Flat prices mean users
    // can predict spend and a new model id can never misprice a debit.
    actionCosts: {
      // chat is TOKEN-PRICED (credits.chatCreditsForTokens) — this value is NOT
      // debited; it survives only as a nominal anchor for the rate card's sort
      // and legacy readers. The card labels chat "Varies with length".
      chat: 5,
      scan: 3,
      generation: 3,
      // Manual parsing runs on Sonnet over long documents (~$0.18/parse with
      // headroom) — priced rare-but-heavy, ~2× retail.
      manualParse: 40,
      aiHelper: 1,
      callPerMinute: 20,
      // Web search is NOT a separate debit: it runs inside a chat turn, so its
      // result tokens are already billed by the token-priced chat debit. See
      // usageMeter.recordWebSearches (count/cost recorded, never charged).
    },
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
  // The optional monthly "Calen AI" plan (auto-renewable subscription, RC
  // entitlement `calen_ai`): each paid period grants `monthlyCredits` at a
  // better per-credit rate than any pack (600 vs the $4.99 pack's 500). Packs
  // remain the top-up and the non-subscriber path — the plan is never
  // required. `price` is a USD display fallback.
  aiPlan: { productId: 'calen_ai_monthly_499', price: 4.99, monthlyCredits: 600, entitlement: 'calen_ai' },
  // $ per call — reference numbers for the admin page; not used for billing.
  costs: {
    sonnetChat:  0.03,
    haikuChat:   0.01,
    scan:        0.015,
    generation:  0.012,
    // Sonnet over a long manual (~16k in + ~4k out) with upgrade headroom.
    manualParse: 0.18,
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
      birthdays:   { label: 'Occasions',   price: 0,    description: 'Birthdays, anniversaries, and other dates from your contacts — on the calendar every year, with e-cards' },
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
    aiPlan:   { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS.aiPlan },
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
  } else if (!doc.credits.actionCosts) {
    // Backfill the flat per-action prices for docs predating them (the raw
    // token-pass-through debit era).
    doc.credits.actionCosts = { ...DEFAULTS.credits.actionCosts };
    doc.markModified('credits');
    dirty = true;
  } else if (doc.credits.actionCosts.webSearch != null) {
    // Web search is no longer a separate debit (folded into token-priced chat);
    // strip any stored per-search price so the rate card / admin editor drop it.
    delete doc.credits.actionCosts.webSearch;
    doc.markModified('credits');
    dirty = true;
  }
  if (doc.credits && doc.credits.webSearchRatePerSearch == null) {
    doc.credits.webSearchRatePerSearch = DEFAULTS.credits.webSearchRatePerSearch;
    doc.markModified('credits');
    dirty = true;
  }
  // Backfill the chat token-pricing knobs for docs predating token-priced chat.
  if (doc.credits && doc.credits.appleFeePct == null) {
    doc.credits.appleFeePct = DEFAULTS.credits.appleFeePct;
    doc.markModified('credits');
    dirty = true;
  }
  if (doc.credits && doc.credits.chatMargin == null) {
    doc.credits.chatMargin = DEFAULTS.credits.chatMargin;
    doc.markModified('credits');
    dirty = true;
  }
  // Migrate legacy BLENDED token rates (a bare number per family) to the
  // per-type shape. Known families take the current default per-type prices;
  // an admin-customized family we don't know keeps its number applied to every
  // type, so no tuning is silently discarded.
  if (doc.credits && doc.credits.tokenRatesPer1M) {
    for (const [fam, rate] of Object.entries(doc.credits.tokenRatesPer1M)) {
      if (typeof rate !== 'number') continue;
      doc.credits.tokenRatesPer1M[fam] = DEFAULTS.credits.tokenRatesPer1M[fam]
        ? { ...DEFAULTS.credits.tokenRatesPer1M[fam] }
        : { input: rate, output: rate, cacheRead: rate, cacheWrite: rate };
      doc.markModified('credits');
      dirty = true;
    }
  }
  if (!doc.unlock) {
    doc.unlock = { ...DEFAULTS.unlock };
    doc.markModified('unlock');
    dirty = true;
  }
  if (!doc.aiPlan) {
    doc.aiPlan = { ...DEFAULTS.aiPlan };
    doc.markModified('aiPlan');
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
