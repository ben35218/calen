const test = require('node:test');
const assert = require('node:assert');
const {
  rateForModel, usageBreakdown, actionDebitMc, callDebitMc, tokenCostMc, callCostMc,
  chatCreditsForTokens, chatDebitMc,
  packForProduct, packsHint,
} = require('./credits');

const CONFIG = {
  credits: {
    margin: 2.0,
    appleFeePct: 0.15,
    chatMargin: 1.0,
    // Real Anthropic per-type $/1M rates — cache reads are ~0.1× input.
    tokenRatesPer1M: {
      default: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 },
      haiku:   { input: 1, output: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
      sonnet:  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    callRatePerMinute: 0.10,
    actionCosts: {
      chat: 5, scan: 3, generation: 3, manualParse: 40, aiHelper: 1,
      callPerMinute: 20,
    },
    packs: {
      credits_499: { label: 'Starter', price: 4.99, credits: 500 },
      credits_999: { label: 'Plus', price: 9.99, credits: 1050 },
    },
  },
};

// The retired blended shape (one number per family) — still honored so a
// stale cached config mid-deploy can never crash or misprice billing.
const LEGACY_CONFIG = {
  credits: {
    appleFeePct: 0.15,
    chatMargin: 1.0,
    tokenRatesPer1M: { default: 6, haiku: 3, sonnet: 10 },
  },
};

test('rateForModel matches by family substring, else the default entry', () => {
  assert.deepEqual(rateForModel('claude-sonnet-4-6', CONFIG), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.deepEqual(rateForModel('claude-haiku-4-5-20251001', CONFIG), { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  assert.deepEqual(rateForModel('some-future-model', CONFIG), { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 });
  assert.deepEqual(rateForModel(null, CONFIG), { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 });
  // Legacy blended numbers pass through untouched.
  assert.equal(rateForModel('claude-sonnet-4-6', LEGACY_CONFIG), 10);
  assert.equal(rateForModel('claude-sonnet-4-6', {}), 0); // missing config → no cost recorded
});

test('usageBreakdown maps an Anthropic usage object to per-type counts', () => {
  assert.deepEqual(usageBreakdown({
    input_tokens: 100, output_tokens: 50,
    cache_creation_input_tokens: 20, cache_read_input_tokens: 30,
  }), { input: 100, output: 50, cacheRead: 30, cacheWrite: 20 });
  assert.deepEqual(usageBreakdown({ input_tokens: 10 }), { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(usageBreakdown(null), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('actionDebitMc: the flat published price for one completed action', () => {
  assert.equal(actionDebitMc('chat', CONFIG), 5_000);
  assert.equal(actionDebitMc('scan', CONFIG), 3_000);
  assert.equal(actionDebitMc('manualParse', CONFIG), 40_000);
  // Unknown action / missing config → 0: fail open on cost, never on features.
  assert.equal(actionDebitMc('someFutureAction', CONFIG), 0);
  assert.equal(actionDebitMc('chat', {}), 0);
});

test('callDebitMc: flat per-minute price prorated per second, ceiled at the millicredit', () => {
  // 60s at the flat 20 credits/min = 20,000 Mc.
  assert.equal(callDebitMc(60, CONFIG), 20_000);
  // 90s → 30,000 Mc (linear in seconds).
  assert.equal(callDebitMc(90, CONFIG), 30_000);
  // 1s → ceil(20,000/60) = 334 Mc.
  assert.equal(callDebitMc(1, CONFIG), 334);
  assert.equal(callDebitMc(0, CONFIG), 0);
  assert.equal(callDebitMc(-10, CONFIG), 0);
  assert.equal(callDebitMc(60, {}), 0);
});

test('tokenCostMc: per-type provider cost — cache reads price ~0.1× input, not blended', () => {
  // 1M sonnet INPUT tokens: $3 raw = 300 credits = 300,000 Mc.
  assert.equal(tokenCostMc({ input: 1_000_000 }, 'claude-sonnet-4-6', CONFIG), 300_000);
  // 1M sonnet CACHE-READ tokens: $0.30 raw = 30,000 Mc — 10× cheaper than input.
  assert.equal(tokenCostMc({ cacheRead: 1_000_000 }, 'claude-sonnet-4-6', CONFIG), 30_000);
  // Mixed sonnet breakdown, each type at its own rate:
  //   input 10k×3/10=3,000 + output 2k×15/10=3,000 + cacheRead 40k×0.3/10=1,200
  //   + cacheWrite 8k×3.75/10=3,000 → 10,200 Mc.
  assert.equal(
    tokenCostMc({ input: 10_000, output: 2_000, cacheRead: 40_000, cacheWrite: 8_000 }, 'claude-sonnet-4-6', CONFIG),
    10_200
  );
  // Tiny counts still ceil to a whole Mc: 10 haiku input × $1/1M → 1 Mc.
  assert.equal(tokenCostMc({ input: 10 }, 'claude-haiku-4-5-20251001', CONFIG), 1);
  // A legacy blended NUMBER rate applies to every type — old math exactly:
  // 200 total tokens × $10/1M = 200 Mc.
  assert.equal(
    tokenCostMc({ input: 100, output: 50, cacheRead: 30, cacheWrite: 20 }, 'claude-sonnet-4-6', LEGACY_CONFIG),
    200
  );
  // Legacy bare-number tokens price at the input rate (legacy callers only).
  assert.equal(tokenCostMc(1_000_000, 'claude-sonnet-4-6', CONFIG), 300_000);
  assert.equal(tokenCostMc(1_000_000, 'claude-sonnet-4-6', LEGACY_CONFIG), 1_000_000);
  // Zero / empty → 0 (fail open on cost).
  assert.equal(tokenCostMc({}, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(tokenCostMc(0, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(tokenCostMc(undefined, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(tokenCostMc({ input: 1_000_000 }, 'claude-sonnet-4-6', {}), 0);
});

test('chatCreditsForTokens: whole-credit chat price from the per-type cost, after Apple + margin', () => {
  // The mixed breakdown above costs 10,200 Mc → ceil(10,200 / 850) = 12 credits.
  const mixed = { input: 10_000, output: 2_000, cacheRead: 40_000, cacheWrite: 8_000 };
  assert.equal(chatCreditsForTokens(mixed, 'claude-sonnet-4-6', CONFIG), 12);
  // A cache-read-heavy turn is CHEAP: 100k sonnet cache reads = 3,000 Mc →
  // ceil(3,000/850) = 4 credits (the old blended rate billed this at 118).
  assert.equal(chatCreditsForTokens({ cacheRead: 100_000 }, 'claude-sonnet-4-6', CONFIG), 4);
  // Any turn that spent tokens costs at least 1 whole credit.
  assert.equal(chatCreditsForTokens({ input: 100 }, 'claude-sonnet-4-6', CONFIG), 1);
  // Zero-token turn debits nothing (fail open on cost).
  assert.equal(chatCreditsForTokens({}, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(chatCreditsForTokens(undefined, 'claude-sonnet-4-6', CONFIG), 0);
  // Legacy blended config still prices the old way: 10k tokens ≡ 10,000 Mc →
  // ceil(10,000/850) = 12.
  assert.equal(chatCreditsForTokens(10_000, 'claude-sonnet-4-6', LEGACY_CONFIG), 12);
});

test('chatCreditsForTokens: fee/margin knobs move the price, clamped to the band', () => {
  const mixed = { input: 10_000, output: 2_000, cacheRead: 40_000, cacheWrite: 8_000 }; // 10,200 Mc
  const highFee = { credits: { ...CONFIG.credits, appleFeePct: 0.30 } };
  // 30% cut: ceil(10,200 / (1000 × 0.70)) = ceil(14.57) = 15.
  assert.equal(chatCreditsForTokens(mixed, 'claude-sonnet-4-6', highFee), 15);
  const maxMargin = { credits: { ...CONFIG.credits, chatMargin: 1.5 } };
  // 1.5× markup: ceil(10,200 × 1.5 / 850) = 18.
  assert.equal(chatCreditsForTokens(mixed, 'claude-sonnet-4-6', maxMargin), 18);
  // Out-of-band / missing knobs fall back to the defaults (0.15 fee, 1.0 margin).
  const bad = { credits: { ...CONFIG.credits, appleFeePct: 2, chatMargin: 9 } };
  assert.equal(chatCreditsForTokens(mixed, 'claude-sonnet-4-6', bad), 12);
  // No rate configured → no cost → no debit.
  assert.equal(chatCreditsForTokens(mixed, 'claude-sonnet-4-6', {}), 0);
});

test('chatDebitMc: chat credits expressed in millicredits', () => {
  const mixed = { input: 10_000, output: 2_000, cacheRead: 40_000, cacheWrite: 8_000 };
  assert.equal(chatDebitMc(mixed, 'claude-sonnet-4-6', CONFIG), 12_000);
  assert.equal(chatDebitMc({}, 'claude-sonnet-4-6', CONFIG), 0);
});

test('callCostMc: margin-free raw Vapi cost estimate', () => {
  // 60s at $0.10/min raw = $0.10 = 10 credits = 10,000 Mc.
  assert.equal(callCostMc(60, CONFIG), 10_000);
  // 1s → ceil(10,000/60) = 167 Mc.
  assert.equal(callCostMc(1, CONFIG), 167);
  assert.equal(callCostMc(0, CONFIG), 0);
});

test('packForProduct maps catalog products and rejects everything else', () => {
  assert.deepEqual(packForProduct('credits_999', CONFIG), {
    productId: 'credits_999', label: 'Plus', price: 9.99, credits: 1050,
  });
  assert.equal(packForProduct('app_unlock_499', CONFIG), null);
  assert.equal(packForProduct('addon_meals', CONFIG), null);
  assert.equal(packForProduct(undefined, CONFIG), null);
});

test('packsHint flattens the catalog for API payloads in catalog order', () => {
  assert.deepEqual(packsHint(CONFIG), [
    { productId: 'credits_499', label: 'Starter', price: 4.99, credits: 500 },
    { productId: 'credits_999', label: 'Plus', price: 9.99, credits: 1050 },
  ]);
  assert.deepEqual(packsHint({}), []);
});
