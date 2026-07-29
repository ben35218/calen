// Prepaid AI-credit economy: debit math, pack lookup, and grant helpers.
//
// 1 credit = $0.01 of RETAIL value; balances live on User.creditBalanceMc in
// integer MILLICREDITS (1 credit = 1000 Mc) so tiny per-call debits never need
// float $inc's. Usage debits charge raw cost × config.credits.margin (2.0 =
// 100% margin), always rounded UP at the millicredit — worst-case overcharge
// is 0.001 credit per call.
//
// All math helpers take the config object (usageMeter's cached
// MonetizationConfig) as an argument; this module requires only models, so
// there's no require cycle with the middleware.

const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');

const MC_PER_CREDIT = 1000;
const CREDITS_PER_DOLLAR = 100;

// Blended raw $/1M-token rate for a model id, matched by family substring
// ('haiku'/'sonnet'), else the default rate. Missing config → 0 (no debit —
// fail open on cost, never on features).
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

// Millicredits to debit for an AI call's token usage. The $→credits→Mc chain
// reduces to Mc = tokens × ratePer1M × margin / 10, which stays exact for the
// integer-ish configs we actually use.
function tokenDebitMc(tokens, model, config) {
  const t = Number(tokens) || 0;
  if (t <= 0) return 0;
  const margin = Number(config?.credits?.margin) || 2.0;
  return ceilMc((t * rateForModel(model, config) * margin) / 10);
}

// Millicredits to debit for `seconds` of connected assistant phone-call time.
// Reduced the same way: Mc = seconds × $/min × margin × 100000 / 60.
function callDebitMc(seconds, config) {
  const s = Number(seconds) || 0;
  if (s <= 0) return 0;
  const margin = Number(config?.credits?.margin) || 2.0;
  const perMinute = Number(config?.credits?.callRatePerMinute) || 0;
  return ceilMc((s * perMinute * margin * (CREDITS_PER_DOLLAR * MC_PER_CREDIT)) / 60);
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

// Fire-and-forget usage debit against a user's materialized balance. Never
// ledgered (high volume); may drive the balance negative on the last call.
function debitUsageMc(userId, mc) {
  if (!userId || !mc || mc <= 0) return;
  User.updateOne({ _id: userId }, { $inc: { creditBalanceMc: -mc } })
    .catch((err) => console.error('[credits] usage debit failed:', err.message));
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
  rateForModel, tokenDebitMc, callDebitMc,
  packForProduct, packsHint,
  debitUsageMc, grantStarterCredits,
};
