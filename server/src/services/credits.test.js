const test = require('node:test');
const assert = require('node:assert');
const {
  MC_PER_CREDIT, rateForModel, actionDebitMc, callDebitMc, tokenCostMc, callCostMc,
  packForProduct, packsHint,
} = require('./credits');

const CONFIG = {
  credits: {
    margin: 2.0,
    tokenRatesPer1M: { default: 6, haiku: 3, sonnet: 10 },
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

test('rateForModel matches by family substring, else the default rate', () => {
  assert.equal(rateForModel('claude-sonnet-4-6', CONFIG), 10);
  assert.equal(rateForModel('claude-haiku-4-5-20251001', CONFIG), 3);
  assert.equal(rateForModel('some-future-model', CONFIG), 6);
  assert.equal(rateForModel(null, CONFIG), 6);
  assert.equal(rateForModel('claude-sonnet-4-6', {}), 0); // missing config → no cost recorded
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

test('tokenCostMc: margin-free provider-cost estimate for reconciliation', () => {
  // 1M sonnet tokens: $10 raw = 1000 credits = 1,000,000 Mc (no margin).
  assert.equal(tokenCostMc(1_000_000, 'claude-sonnet-4-6', CONFIG), 1_000_000);
  // 10 haiku tokens × $3/1M = $0.00003 = 0.003 credits = 3 Mc.
  const tiny = tokenCostMc(10, 'claude-haiku-4-5-20251001', CONFIG);
  assert.equal(tiny, 3);
  assert.ok(tiny >= 1 && tiny < MC_PER_CREDIT);
  assert.equal(tokenCostMc(0, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(tokenCostMc(undefined, 'claude-sonnet-4-6', CONFIG), 0);
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
