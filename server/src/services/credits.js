// Prepaid AI-credit economy: debit math, pack lookup, and grant helpers.
//
// 1 credit = $0.01 of RETAIL value; balances live on User.creditBalanceMc in
// integer MILLICREDITS (1 credit = 1000 Mc) so tiny per-call debits never need
// float $inc's.
//
// Usage debits are FLAT published prices per action (config
// credits.actionCosts, whole credits; calls prorate `callPerMinute` per
// connected second) — users can predict spend and a new model id can never
// misprice a debit. The token/call rates (`tokenRatesPer1M`,
// `callRatePerMinute`) are the raw PROVIDER-COST reference: they feed the
// cost-estimate counters that margin reconciliation compares against debited
// revenue, and never drive a debit.
//
// All math helpers take the config object (usageMeter's cached
// MonetizationConfig) as an argument; this module requires only models, so
// there's no require cycle with the middleware.

const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');

const MC_PER_CREDIT = 1000;
const CREDITS_PER_DOLLAR = 100;

// Blended raw $/1M-token rate for a model id, matched by family substring
// ('haiku'/'sonnet'), else the default rate. Missing config → 0 (no cost
// recorded — fail open on cost, never on features).
function rateForModel(model, config) {
  const rates = config?.credits?.tokenRatesPer1M || {};
  const id = String(model || '').toLowerCase();
  for (const [family, rate] of Object.entries(rates)) {
    if (family !== 'default' && id.includes(family)) return Number(rate) || 0;
  }
  return Number(rates.default) || 0;
}

// Ceil that shrugs off float noise (6.000000000000001 must read as 6, not 7 —
// ceil is our rounding, so a phantom ulp would overcharge a whole millicredit).
function ceilMc(x) {
  return Math.max(0, Math.ceil(x - 1e-9));
}

// Millicredits to DEBIT for one completed action — the flat published price
// (credits.actionCosts[action] × 1000 Mc). Unknown action → 0 (fail open on
// cost, never on features).
function actionDebitMc(action, config) {
  const price = Number(config?.credits?.actionCosts?.[action]) || 0;
  return price > 0 ? Math.round(price * MC_PER_CREDIT) : 0;
}

// Millicredits to DEBIT for `seconds` of connected assistant phone-call time:
// the flat `actionCosts.callPerMinute` price prorated per second, ceiled at
// the millicredit.
function callDebitMc(seconds, config) {
  const s = Number(seconds) || 0;
  if (s <= 0) return 0;
  const perMinute = Number(config?.credits?.actionCosts?.callPerMinute) || 0;
  return ceilMc((s * perMinute * MC_PER_CREDIT) / 60);
}

// Estimated raw PROVIDER cost of an AI call's tokens, in margin-free
// millicredit units (Mc/100000 = $): tokens × ratePer1M / 10. Recorded on the
// weekly cost counters for margin reconciliation only — never debited.
function tokenCostMc(tokens, model, config) {
  const t = Number(tokens) || 0;
  if (t <= 0) return 0;
  return ceilMc((t * rateForModel(model, config)) / 10);
}

// Estimated raw provider cost of `seconds` of connected call time (Vapi
// STT + TTS + telephony), same margin-free Mc units as tokenCostMc.
function callCostMc(seconds, config) {
  const s = Number(seconds) || 0;
  if (s <= 0) return 0;
  const perMinute = Number(config?.credits?.callRatePerMinute) || 0;
  return ceilMc((s * perMinute * (CREDITS_PER_DOLLAR * MC_PER_CREDIT)) / 60);
}

// The pack a store product id sells, or null if the product isn't a pack.
function packForProduct(productId, config) {
  const pack = config?.credits?.packs?.[productId];
  return pack ? { productId, ...pack } : null;
}

// Pack catalog as an array for API payloads (display fallbacks; the store's
// localized price is authoritative on device).
function packsHint(config) {
  const packs = config?.credits?.packs || {};
  return Object.entries(packs).map(([productId, p]) => ({
    productId, label: p.label, price: p.price, credits: p.credits,
  }));
}

// Fire-and-forget usage debit against a user's materialized balance, LEDGERED
// (kind 'usage' + the action) so "where did my credits go?" has a per-row
// answer and reconciliation can sum debited revenue per action. May drive the
// balance negative on the last call. A ledger failure falls back to the bare
// $inc — the balance must never drift from what was actually spent.
function debitUsageMc(userId, mc, action = null) {
  if (!userId || !mc || mc <= 0) return;
  CreditLedger.debit({ userId, mc, action })
    .catch((err) => {
      console.error('[credits] usage debit ledger failed:', err.message);
      User.updateOne({ _id: userId }, { $inc: { creditBalanceMc: -mc } })
        .catch((e) => console.error('[credits] usage debit failed:', e.message));
    });
}

// One-time starter grant for a new user, so the AI can be tried before the
// first pack purchase. Idempotent: the ledger's unique transactionId makes a
// re-run a no-op.
async function grantStarterCredits(userId, config) {
  const credits = Number(config?.credits?.starterCredits) || 0;
  if (!userId || credits <= 0) return null;
  return CreditLedger.grant({
    userId,
    deltaMc: Math.round(credits * MC_PER_CREDIT),
    kind: 'starter',
    transactionId: `starter:${userId}`,
  });
}

module.exports = {
  MC_PER_CREDIT,
  rateForModel, actionDebitMc, callDebitMc, tokenCostMc, callCostMc,
  packForProduct, packsHint,
  debitUsageMc, grantStarterCredits,
};
