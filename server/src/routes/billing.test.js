const test = require('node:test');
const assert = require('node:assert');
const { unlockUpdateForEvent, creditUpdateForEvent, addonUpdateForEvent } = require('./billing');

// Minimal config for the pure helpers (matches MonetizationConfig DEFAULTS shape).
const CONFIG = {
  unlock: { price: 4.99, productId: 'app_unlock_499' },
  credits: {
    packs: {
      credits_499: { label: 'Starter', price: 4.99, credits: 500 },
      credits_999: { label: 'Plus', price: 9.99, credits: 1050 },
    },
  },
};

// --- App unlock (unlockUpdateForEvent) ---

test('an unlock purchase grants via the entitlement', () => {
  for (const type of ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'UNCANCELLATION']) {
    const { unlocked } = unlockUpdateForEvent(
      { type, entitlement_ids: ['app_unlock'], product_id: 'app_unlock_499' },
      CONFIG
    );
    assert.equal(unlocked, true, type);
  }
});

test('the unlock is matched by product id even without the entitlement', () => {
  const { unlocked } = unlockUpdateForEvent(
    { type: 'NON_RENEWING_PURCHASE', entitlement_ids: [], product_id: 'app_unlock_499' },
    CONFIG
  );
  assert.equal(unlocked, true);
});

test('an unlock refund (CUSTOMER_SUPPORT cancellation) revokes; EXPIRATION defensively', () => {
  for (const event of [
    { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', entitlement_ids: ['app_unlock'] },
    { type: 'EXPIRATION', entitlement_ids: ['app_unlock'] },
  ]) {
    const { unlocked } = unlockUpdateForEvent(event, CONFIG);
    assert.equal(unlocked, false, event.type);
  }
});

test('unlock lifecycle noise and unrelated events change nothing', () => {
  for (const event of [
    { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', entitlement_ids: ['app_unlock'] },
    { type: 'BILLING_ISSUE', entitlement_ids: ['app_unlock'] },
    { type: 'INITIAL_PURCHASE', entitlement_ids: ['premium'], product_id: 'premium_monthly' },
    { type: 'NON_RENEWING_PURCHASE', entitlement_ids: ['addon_meals'], product_id: 'addon_meals' },
  ]) {
    const { unlocked } = unlockUpdateForEvent(event, CONFIG);
    assert.equal(unlocked, null, `${event.type} ${event.product_id}`);
  }
});

// --- Credit packs (creditUpdateForEvent) ---

test('a pack purchase credits the pack amount, keyed by transaction id', () => {
  const out = creditUpdateForEvent(
    { type: 'NON_RENEWING_PURCHASE', product_id: 'credits_999', transaction_id: 'txn_1', id: 'evt_1' },
    CONFIG
  );
  assert.deepEqual(out, {
    deltaMc: 1050 * 1000,
    kind: 'purchase',
    productId: 'credits_999',
    transactionId: 'txn_1',
  });
});

test('a pack event without a store transaction id falls back to the RC event id', () => {
  const out = creditUpdateForEvent(
    { type: 'INITIAL_PURCHASE', product_id: 'credits_499', id: 'evt_2' },
    CONFIG
  );
  assert.equal(out.transactionId, 'evt_2');
  assert.equal(out.deltaMc, 500 * 1000);
});

test('a pack refund debits the same amount under a distinct idempotency key', () => {
  const out = creditUpdateForEvent(
    {
      type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT',
      product_id: 'credits_499', transaction_id: 'txn_9',
    },
    CONFIG
  );
  assert.deepEqual(out, {
    deltaMc: -(500 * 1000),
    kind: 'refund',
    productId: 'credits_499',
    transactionId: 'txn_9:refund',
  });
});

test('non-pack products and lifecycle noise produce no credit change', () => {
  for (const event of [
    { type: 'NON_RENEWING_PURCHASE', product_id: 'app_unlock_499' },
    { type: 'NON_RENEWING_PURCHASE', product_id: 'addon_meals' },
    { type: 'BILLING_ISSUE', product_id: 'credits_499' },
    { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', product_id: 'credits_499' },
    { type: 'NON_RENEWING_PURCHASE' },
  ]) {
    assert.equal(creditUpdateForEvent(event, CONFIG), null, `${event.type} ${event.product_id}`);
  }
});

// --- Feature-calendar add-ons (addonUpdateForEvent) ---

test('a one-time add-on purchase grants its calendar key', () => {
  const { add, remove } = addonUpdateForEvent({
    type: 'NON_RENEWING_PURCHASE',
    entitlement_ids: ['addon_meals'],
  });
  assert.deepEqual(add, ['recipes']);
  assert.deepEqual(remove, []);
});

test('a bundle purchase (all three entitlements) grants all three keys', () => {
  const { add, remove } = addonUpdateForEvent({
    type: 'INITIAL_PURCHASE',
    entitlement_ids: ['addon_meals', 'addon_maintenance', 'addon_trips'],
  });
  assert.deepEqual(add.sort(), ['maintenance', 'recipes', 'trips']);
  assert.deepEqual(remove, []);
});

test('addon_birthdays (retired pre-release — Birthdays is free) is ignored', () => {
  const { add, remove } = addonUpdateForEvent({
    type: 'NON_RENEWING_PURCHASE',
    entitlement_ids: ['addon_birthdays'],
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test('an add-on refund revokes exactly the refunded keys', () => {
  const { add, remove } = addonUpdateForEvent({
    type: 'CANCELLATION',
    cancel_reason: 'CUSTOMER_SUPPORT',
    entitlement_ids: ['addon_trips'],
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, ['trips']);
});

test('EXPIRATION on an add-on entitlement revokes defensively', () => {
  const { add, remove } = addonUpdateForEvent({
    type: 'EXPIRATION',
    entitlement_ids: ['addon_maintenance'],
  });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, ['maintenance']);
});

test('subscription lifecycle noise never touches add-ons', () => {
  for (const event of [
    { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', entitlement_ids: ['addon_meals'] },
    { type: 'BILLING_ISSUE', entitlement_ids: ['addon_meals'] },
    { type: 'SUBSCRIPTION_PAUSED', entitlement_ids: ['addon_meals'] },
  ]) {
    const { add, remove } = addonUpdateForEvent(event);
    assert.deepEqual(add, [], event.type);
    assert.deepEqual(remove, [], event.type);
  }
});

test('legacy tier and unknown entitlements produce no add-on change', () => {
  for (const ids of [['premium'], ['unlimited'], ['mystery_addon'], [], undefined]) {
    const { add, remove } = addonUpdateForEvent({ type: 'INITIAL_PURCHASE', entitlement_ids: ids });
    assert.deepEqual(add, []);
    assert.deepEqual(remove, []);
  }
});
