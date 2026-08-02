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
// The ONE exception is `chat` (see TOKEN_PRICED_ACTIONS): a chat turn's cost
// grows with the conversation length, so a flat price is unfair on short chats
// and underwater on long ones. Chat instead debits TOKEN-BASED whole credits
// via chatCreditsForTokens — the turn's token provider-cost, marked up to cover
// Apple's cut plus a slight margin, ceiled to a whole credit. meter() skips its
// flat debit for these actions; chatStream debits per completed turn.
//
// All math helpers take the config object (usageMeter's cached
// MonetizationConfig) as an argument; this module requires only models, so
// there's no require cycle with the middleware.

const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');

const MC_PER_CREDIT = 1000;
const CREDITS_PER_DOLLAR = 100;

// Actions whose per-use debit is TOKEN-BASED (chatCreditsForTokens) rather than
// the flat `actionCosts` price. meter() must NOT flat-debit these — the owning
// stream/handler debits the token-based amount once the token total is known.
const TOKEN_PRICED_ACTIONS = new Set(['chat']);

// Defaults for the chat token-pricing knobs when config omits them.
const DEFAULT_APPLE_FEE_PCT = 0.15; // App Store Small Business Program (<$1M/yr)
const DEFAULT_CHAT_MARGIN = 1.0;    // cover 100% of after-Apple cost; the ceil is the margin

// Apple's storefront commission as a fraction in [0, 1); anything out of range
// (or missing) falls back to the Small Business rate.
function appleFeePct(config) {
  const n = Number(config?.credits?.appleFeePct);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : DEFAULT_APPLE_FEE_PCT;
}

// Target markup on the after-Apple token cost, clamped to [1.0, 1.5] — the
// band that keeps chat a slight-but-honest profit. Out of range / missing → 1.0.
function chatMargin(config) {
  const n = Number(config?.credits?.chatMargin);
  return Number.isFinite(n) && n >= 1 && n <= 1.5 ? n : DEFAULT_CHAT_MARGIN;
}

// Raw $/1M-token rates for a model id, matched by family substring
// ('haiku'/'sonnet'), else the default entry. The entry is normally a per-type
// object { input, output, cacheRead, cacheWrite }, but a legacy stored NUMBER
// (the old blended rate) passes through as-is — tokenCostMc applies it to
// every token type, reproducing the old math exactly. Missing config → 0 (no
// cost recorded — fail open on cost, never on features).
function rateForModel(model, config) {
  const rates = config?.credits?.tokenRatesPer1M || {};
  const id = String(model || '').toLowerCase();
  for (const [family, rate] of Object.entries(rates)) {
    if (family !== 'default' && id.includes(family)) return rate ?? 0;
  }
  return rates.default ?? 0;
}

// The token types Anthropic prices separately, keyed the way `usageBreakdown`
// and `tokenRatesPer1M` spell them.
const TOKEN_TYPES = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Per-type token counts from an Anthropic API `usage` object (null-safe →
// zeros). Cache reads cost ~0.1× input and writes 1.25× — pricing them at
// their own rates instead of a blended one is what keeps chat debits honest.
function usageBreakdown(usage) {
  return {
    input: Number(usage?.input_tokens) || 0,
    output: Number(usage?.output_tokens) || 0,
    cacheRead: Number(usage?.cache_read_input_tokens) || 0,
    cacheWrite: Number(usage?.cache_creation_input_tokens) || 0,
  };
}

// The $/1M rate for one token type from a rates entry that may be per-type
// (object) or legacy blended (number applies to every type).
function rateForType(rate, type) {
  if (rate && typeof rate === 'object') return Number(rate[type]) || 0;
  return Number(rate) || 0;
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

// Raw PROVIDER cost of an AI call's tokens, in margin-free millicredit units
// (Mc/100000 = $): Σ per type, count × ratePer1M / 10. `tokens` is normally a
// per-type breakdown ({ input, output, cacheRead, cacheWrite } — see
// usageBreakdown); a legacy bare NUMBER is priced at the input rate (legacy
// path — all live callers pass breakdowns). Feeds both the reconciliation
// cost counters and the token-priced chat debit.
function tokenCostMc(tokens, model, config) {
  const rate = rateForModel(model, config);
  if (tokens && typeof tokens === 'object') {
    let cost = 0;
    for (const type of TOKEN_TYPES) {
      const count = Number(tokens[type]) || 0;
      if (count > 0) cost += (count * rateForType(rate, type)) / 10;
    }
    return cost > 0 ? ceilMc(cost) : 0;
  }
  const t = Number(tokens) || 0;
  if (t <= 0) return 0;
  return ceilMc((t * rateForType(rate, 'input')) / 10);
}

// Whole CREDITS to debit for one chat turn that consumed `tokens` on `model`
// (`tokens` is the turn's summed per-type breakdown; a legacy number is priced
// at the input rate — see tokenCostMc).
// The turn's raw provider cost (tokenCostMc — margin-free Mc, where
// 1000 Mc = 1 credit = $0.01) is what the tokens actually cost us. We must
// still net that back AFTER Apple takes its cut of the credit sale, plus a
// slight margin, so:
//
//   creditsToCharge × (1 − appleFee) × 1000 Mc  ≥  margin × costMc
//   creditsToCharge                              ≥  margin × costMc / (1000 × (1 − appleFee))
//
// ceiled to the next whole credit (the rounding IS the low end of the margin
// band), min 1 credit for any turn that spent tokens. Returns 0 for a
// zero-token turn (fail open — never block on a cost bug). Prices are a knob:
// `appleFeePct`/`chatMargin` tune the band without touching the formula.
function chatCreditsForTokens(tokens, model, config) {
  const costMc = tokenCostMc(tokens, model, config);
  if (costMc <= 0) return 0;
  const netPerCreditMc = MC_PER_CREDIT * (1 - appleFeePct(config));
  if (netPerCreditMc <= 0) return 0; // pathological fee ≥ 100% — never debit
  const credits = Math.ceil((costMc * chatMargin(config)) / netPerCreditMc - 1e-9);
  return Math.max(1, credits);
}

// Millicredits to DEBIT for a token-priced chat turn: chatCreditsForTokens in
// whole credits × MC_PER_CREDIT (debits land in Mc like every other debit).
function chatDebitMc(tokens, model, config) {
  return chatCreditsForTokens(tokens, model, config) * MC_PER_CREDIT;
}

// Estimated raw provider cost of `seconds` of connected call time (Vapi
// STT + TTS + telephony), same margin-free Mc units as tokenCostMc.
function callCostMc(seconds, config) {
  const s = Number(seconds) || 0;
  if (s <= 0) return 0;
  const perMinute = Number(config?.credits?.callRatePerMinute) || 0;
  return ceilMc((s * perMinute * (CREDITS_PER_DOLLAR * MC_PER_CREDIT)) / 60);
}

// Estimated raw provider cost of `count` web searches (the per-search API fee;
// the extra result tokens are already in the token counters), same margin-free
// Mc units as tokenCostMc.
function webSearchCostMc(count, config) {
  const n = Number(count) || 0;
  if (n <= 0) return 0;
  const perSearch = Number(config?.credits?.webSearchRatePerSearch) || 0;
  return ceilMc(n * perSearch * (CREDITS_PER_DOLLAR * MC_PER_CREDIT));
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
  TOKEN_PRICED_ACTIONS,
  rateForModel, usageBreakdown, actionDebitMc, callDebitMc, tokenCostMc, callCostMc, webSearchCostMc,
  chatCreditsForTokens, chatDebitMc, appleFeePct, chatMargin,
  packForProduct, packsHint,
  debitUsageMc, grantStarterCredits,
};
