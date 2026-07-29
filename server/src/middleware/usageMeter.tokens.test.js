const test = require('node:test');
const assert = require('node:assert');
const {
  totalTokens, currentPeriodKey, recordCallSecondsById, adminUnlimited, creditStatus, periodUsage,
} = require('./usageMeter');

const P = currentPeriodKey();

test('totalTokens sums input + output + cache read + write', () => {
  assert.equal(totalTokens({
    input_tokens: 100, output_tokens: 50,
    cache_creation_input_tokens: 20, cache_read_input_tokens: 30,
  }), 200);
  assert.equal(totalTokens({ input_tokens: 10 }), 10); // missing fields → 0
  assert.equal(totalTokens(null), 0);
  assert.equal(totalTokens(undefined), 0);
});

test('recordCallSecondsById returns the rounded seconds (0/negative → no-op)', () => {
  // No ids → nothing to write, but the rounded seconds are reported back.
  assert.equal(recordCallSecondsById({}, 71.4), 71);
  assert.equal(recordCallSecondsById({}, 0), 0);
  assert.equal(recordCallSecondsById({}, -5), 0);
});

test('adminUnlimited: only admins, and only while the config toggle allows it', () => {
  const admin = { role: 'admin' };
  const member = { role: 'user' };
  // Default / toggle on → admins exempt, non-admins never.
  assert.equal(adminUnlimited({ admin: { unlimitedAi: true } }, admin), true);
  assert.equal(adminUnlimited({ admin: { unlimitedAi: true } }, member), false);
  // Missing section defaults to exempt (backfilled to true elsewhere).
  assert.equal(adminUnlimited({}, admin), true);
  // Toggle off → admins are metered like everyone else.
  assert.equal(adminUnlimited({ admin: { unlimitedAi: false } }, admin), false);
  // No user → never exempt.
  assert.equal(adminUnlimited({ admin: { unlimitedAi: true } }, null), false);
});

test('creditStatus: whole-credit floor, low threshold, exhaustion at <= 0', () => {
  const config = { credits: { lowBalanceThreshold: 25 }, admin: { unlimitedAi: true } };

  // Healthy balance: floors 1050.9 credits worth of Mc down to 1050.
  const healthy = creditStatus({ creditBalanceMc: 1_050_900 }, config);
  assert.deepEqual(healthy, { balanceMc: 1_050_900, balance: 1050, unlimited: false, exhausted: false, low: false });

  // At the threshold → low but not exhausted.
  const low = creditStatus({ creditBalanceMc: 25_000 }, config);
  assert.equal(low.low, true);
  assert.equal(low.exhausted, false);

  // Zero and negative (post-refund) → exhausted; balance may be negative.
  assert.equal(creditStatus({ creditBalanceMc: 0 }, config).exhausted, true);
  const negative = creditStatus({ creditBalanceMc: -3_000 }, config);
  assert.equal(negative.exhausted, true);
  assert.equal(negative.balance, -3);

  // Missing user / balance → treated as 0 (blocked until the starter grant lands).
  assert.equal(creditStatus(null, config).exhausted, true);
  assert.equal(creditStatus({}, config).exhausted, true);

  // Exempt admins are never low/exhausted regardless of balance.
  const admin = creditStatus({ role: 'admin', creditBalanceMc: -5_000 }, config);
  assert.deepEqual(
    { unlimited: admin.unlimited, exhausted: admin.exhausted, low: admin.low },
    { unlimited: true, exhausted: false, low: false }
  );
});

test('periodUsage returns the per-action counts and drops the breakdown blob', () => {
  const doc = { usage: { [P]: { chat: 5, scan: 2, breakdown: { chat: { calendar: 5 } } } } };
  assert.deepEqual(periodUsage(doc, P), { chat: 5, scan: 2 });
  assert.deepEqual(periodUsage({}, P), {});
  assert.deepEqual(periodUsage(null, P), {});
});
