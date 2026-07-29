const test = require('node:test');
const assert = require('node:assert');
const {
  MC_PER_CREDIT, rateForModel, tokenDebitMc, callDebitMc, packForProduct, packsHint,
} = require('./credits');

const CONFIG = {
  credits: {
    margin: 2.0,
    tokenRatesPer1M: { default: 6, haiku: 3, sonnet: 10 },
    callRatePerMinute: 0.10,
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
  assert.equal(rateForModel('claude-sonnet-4-6', {}), 0); // missing config → no debit
});

test('tokenDebitMc: raw cost × margin, ceiled at the millicredit', () => {
  // 1M sonnet tokens: $10 raw × 2 margin = $20 = 2000 credits = 2,000,000 Mc.
  assert.equal(tokenDebitMc(1_000_000, 'claude-sonnet-4-6', CONFIG), 2_000_000);
  // A tiny call still debits at least 1 Mc (ceil), never 0 and never a whole credit.
  const tiny = tokenDebitMc(10, 'claude-haiku-4-5-20251001', CONFIG);
  // 10 tokens × $3/1M × 2 = $0.00006 = 0.006 credits = 6 Mc.
  assert.equal(tiny, 6);
  assert.ok(tiny >= 1 && tiny < MC_PER_CREDIT);
  // Zero / negative / missing → no debit.
  assert.equal(tokenDebitMc(0, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(tokenDebitMc(-5, 'claude-sonnet-4-6', CONFIG), 0);
  assert.equal(tokenDebitMc(undefined, 'claude-sonnet-4-6', CONFIG), 0);
});

test('callDebitMc: per-minute rate × margin, ceiled at the millicredit', () => {
  // 60s at $0.10/min × 2 margin = $0.20 = 20 credits = 20,000 Mc.
  assert.equal(callDebitMc(60, CONFIG), 20_000);
  // 90s → 30,000 Mc (linear in seconds).
  assert.equal(callDebitMc(90, CONFIG), 30_000);
  // 1s → ceil($0.10/60 × 2 × 100 × 1000) = ceil(333.33…) = 334 Mc.
  assert.equal(callDebitMc(1, CONFIG), 334);
  assert.equal(callDebitMc(0, CONFIG), 0);
  assert.equal(callDebitMc(-10, CONFIG), 0);
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
