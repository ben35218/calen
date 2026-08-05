// RevenueCat webhook (/api/billing/webhook): shared-secret auth + event →
// per-user unlock/credit mapping and household add-on grants, including the
// events that must be acked without effect (legacy subscription-era tier
// events, unknown users, lifecycle noise).

process.env.REVENUECAT_WEBHOOK_SECRET = 'test-rc-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startDb, stopDb, request, registerUser } = require('./harness');
const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');
const { grantStarterCredits } = require('../services/credits');

before(startDb);
after(stopDb);

function post(event, secret = 'test-rc-secret') {
  return request()
    .post('/api/billing/webhook')
    .set('Authorization', `Bearer ${secret}`)
    .send({ api_version: '1.0', event });
}

async function userDoc(id) {
  return User.findById(id).lean();
}

// Whole credits from the stored Mc balance (may be negative after a refund).
async function balanceOf(userId) {
  const u = await userDoc(userId);
  return Math.floor((u.creditBalanceMc || 0) / 1000);
}

test('rejects a bad secret', async () => {
  const res = await post({ type: 'INITIAL_PURCHASE' }, 'wrong');
  assert.equal(res.status, 401);
});

test('registration grants starter credits once (ledger-keyed idempotency)', async () => {
  const { user } = await registerUser();
  const starter = await balanceOf(user._id);
  assert.ok(starter > 0, 'starter grant landed at registration');
  const rows = await CreditLedger.find({ userId: user._id, kind: 'starter' }).lean();
  assert.equal(rows.length, 1);

  // Re-running the grant (retry, double-fire) is a no-op.
  const again = await grantStarterCredits(user._id, { credits: { starterCredits: 100 } });
  assert.equal(again.duplicate, true);
  assert.equal(await balanceOf(user._id), starter);
});

test('unlock purchase grants the user; a refund revokes', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);

  const buy = await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: uid,
    entitlement_ids: ['app_unlock'], product_id: 'app_unlock_499',
  });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.unlocked, true);
  let doc = await userDoc(user._id);
  assert.equal(doc.appUnlocked, true);
  assert.equal(doc.unlockProductId, 'app_unlock_499');
  assert.equal(doc.revenueCatId, uid);

  const refund = await post({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: uid,
    entitlement_ids: ['app_unlock'], product_id: 'app_unlock_499',
  });
  assert.equal(refund.status, 200);
  doc = await userDoc(user._id);
  assert.equal(doc.appUnlocked, false);
});

test('credit pack purchase credits once per transaction id (RC retries dedupe)', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);
  const before = await balanceOf(user._id);

  const buy = await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: uid,
    product_id: 'credits_999', transaction_id: 'txn_dupe',
  });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.credited, 1050);
  assert.equal(await balanceOf(user._id), before + 1050);

  // Same event delivered again — the ledger's unique key blocks a double credit.
  const dupe = await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: uid,
    product_id: 'credits_999', transaction_id: 'txn_dupe',
  });
  assert.equal(dupe.status, 200);
  assert.equal(dupe.body.duplicate, true);
  assert.equal(await balanceOf(user._id), before + 1050);

  // Ledger rows: the starter grant + exactly one purchase.
  const rows = await CreditLedger.find({ userId: user._id }).lean();
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['purchase', 'starter']);
});

test('a pack refund debits and may drive the balance negative', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);
  const before = await balanceOf(user._id); // starter credits only

  const refund = await post({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: uid,
    product_id: 'credits_999', transaction_id: 'txn_refund_1',
  });
  assert.equal(refund.status, 200);
  assert.equal(await balanceOf(user._id), before - 1050); // negative allowed — no clamp

  // The refund's ':refund' key dedupes independently of the purchase key.
  const dupe = await post({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: uid,
    product_id: 'credits_999', transaction_id: 'txn_refund_1',
  });
  assert.equal(dupe.body.duplicate, true);
  assert.equal(await balanceOf(user._id), before - 1050);
});

test('TRANSFER moves the unlock between users (restore under a new account)', async () => {
  const { user: alice } = await registerUser();
  const { user: bob } = await registerUser();
  await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: String(alice._id),
    entitlement_ids: ['app_unlock'], product_id: 'app_unlock_499',
  });

  const res = await post({
    type: 'TRANSFER',
    transferred_from: [String(alice._id)],
    transferred_to: [String(bob._id)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.transferred, true);
  assert.equal((await userDoc(bob._id)).appUnlocked, true);
  assert.equal((await userDoc(alice._id)).appUnlocked, false);

  // A transfer between unknown ids is acked, never 400'd into RC's retry loop.
  const unknown = await post({ type: 'TRANSFER', transferred_from: ['x'], transferred_to: ['y'] });
  assert.equal(unknown.status, 200);
});

test('TRANSFER whose losing id no longer resolves still grants the unlock (account deleted before Restore)', async () => {
  // The deleted-account restore path: RC fires TRANSFER only when real store
  // transactions moved, and the hard paywall means any Calen receipt contains
  // the unlock — a returning customer must not be stranded behind the paywall
  // just because their old user doc is gone.
  const { user: dana } = await registerUser();
  const ghost = '0123456789abcdef01234567'; // valid-shaped id, matches no user

  const res = await post({
    type: 'TRANSFER',
    transferred_from: [ghost],
    transferred_to: [String(dana._id)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.transferred, true);
  assert.equal(res.body.fromDeleted, true);
  assert.equal((await userDoc(dana._id)).appUnlocked, true);

  // A known losing user WITHOUT the unlock still transfers nothing.
  const { user: erin } = await registerUser();
  const { user: fred } = await registerUser();
  const none = await post({
    type: 'TRANSFER',
    transferred_from: [String(erin._id)],
    transferred_to: [String(fred._id)],
  });
  assert.equal(none.body.transferred, false);
  assert.equal((await userDoc(fred._id)).appUnlocked, false);
});

test('legacy subscription-era tier events are acked without effect', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);
  const before = await balanceOf(user._id);

  // Entitlements that no longer map to anything → ignored, regardless of type.
  for (const event of [
    { type: 'INITIAL_PURCHASE', app_user_id: uid, entitlement_ids: ['premium'], product_id: 'premium_monthly' },
    { type: 'RENEWAL', app_user_id: uid, entitlement_ids: ['unlimited'] },
    { type: 'CANCELLATION', app_user_id: uid, cancel_reason: 'UNSUBSCRIBE', entitlement_ids: ['premium'] },
    { type: 'EXPIRATION', app_user_id: uid, entitlement_ids: ['premium'] },
    { type: 'BILLING_ISSUE', app_user_id: uid },
  ]) {
    const res = await post(event);
    assert.equal(res.status, 200, event.type);
    assert.equal(res.body.ignored, event.type);
  }
  const doc = await userDoc(user._id);
  assert.equal(doc.appUnlocked, false);
  assert.equal(await balanceOf(user._id), before);
});

test('unknown app_user_id is acknowledged so RC stops retrying', async () => {
  const res = await post({
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: '000000000000000000000000',
    product_id: 'credits_499',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, matched: false });
});

test('billing status reports unlock, balance, low/out state and the pack catalog', async () => {
  const { user, auth } = await registerUser();
  const uid = String(user._id);

  let res = await request().get('/api/billing/status').set('Authorization', auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.unlocked, false);
  assert.equal(typeof res.body.unlockPrice, 'number');
  assert.equal(res.body.usageScope, 'user');
  assert.equal(res.body.unlimited, false);
  // Fresh account holds the starter grant: positive, not low, not negative.
  assert.ok(res.body.creditBalance > 0);
  assert.equal(res.body.lowBalance, false);
  // Pack catalog for the store display.
  assert.ok(Array.isArray(res.body.packs) && res.body.packs.length >= 1);
  for (const p of res.body.packs) {
    assert.equal(typeof p.productId, 'string');
    assert.equal(typeof p.price, 'number');
    assert.equal(typeof p.credits, 'number');
  }

  // Unlock lands in the payload after the webhook grant.
  await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: uid,
    entitlement_ids: ['app_unlock'], product_id: 'app_unlock_499',
  });
  res = await request().get('/api/billing/status').set('Authorization', auth);
  assert.equal(res.body.unlocked, true);

  // Drain the balance below zero via a refund → lowBalance flips on and the
  // whole-credit balance goes negative (display floors client-side).
  await post({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: uid,
    product_id: 'credits_1999', transaction_id: 'txn_status_refund',
  });
  res = await request().get('/api/billing/status').set('Authorization', auth);
  assert.ok(res.body.creditBalance < 0);
  assert.equal(res.body.lowBalance, true);
});

test('the credit ledger endpoint lists the caller’s grants newest-first', async () => {
  const { user, auth } = await registerUser();
  await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: String(user._id),
    product_id: 'credits_499', transaction_id: 'txn_ledger_1',
  });

  const res = await request().get('/api/billing/credits/ledger').set('Authorization', auth);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries.map((e) => e.kind), ['purchase', 'starter']);
  assert.equal(res.body.entries[0].credits, 500);
  assert.equal(res.body.entries[0].productId, 'credits_499');
});

test('the ledger endpoint with ?grants=1 excludes usage debits (the History surfaces)', async () => {
  const { user, auth } = await registerUser();
  const CreditLedgerModel = require('../models/CreditLedger');
  await CreditLedgerModel.debit({ userId: user._id, mc: 2000, action: 'chat' });

  const full = await request().get('/api/billing/credits/ledger').set('Authorization', auth);
  assert.ok(full.body.entries.some((e) => e.kind === 'usage'), 'default includes usage rows');

  const grants = await request().get('/api/billing/credits/ledger?grants=1').set('Authorization', auth);
  assert.equal(grants.status, 200);
  assert.ok(grants.body.entries.length > 0, 'the starter grant survives the filter');
  assert.ok(!grants.body.entries.some((e) => e.kind === 'usage'), 'usage debits are filtered out');
});

// --- Feature-calendar add-ons ---
// The webhook's app_user_id is the USER id (the mobile app logs the RC SDK in
// as the signed-in user), and add-ons now land on that USER: ownership belongs to
// whoever paid, not to a household they could later leave. The household-wide
// EFFECT is derived as the union across members at read time — so these tests
// assert ownership via `addonsOf(userId)` and effect via GET /billing/status.

async function addonsOf(userId) {
  const u = await User.findById(userId).lean();
  return (u.addons || []).sort();
}

test('add-on purchase grants the household key; repeat delivery is idempotent', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);

  const buy = await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: uid, entitlement_ids: ['addon_meals'] });
  assert.equal(buy.status, 200);
  assert.deepEqual(await addonsOf(user._id), ['recipes']);

  // Duplicate delivery (RC retries) must not duplicate the key.
  await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: uid, entitlement_ids: ['addon_meals'] });
  assert.deepEqual(await addonsOf(user._id), ['recipes']);
});

test('bundle purchase grants all three add-ons in one event', async () => {
  const { user } = await registerUser();
  await post({
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: String(user._id),
    entitlement_ids: ['addon_meals', 'addon_maintenance', 'addon_trips'],
  });
  assert.deepEqual(await addonsOf(user._id), ['maintenance', 'recipes', 'trips']);
});

test('an add-on refund revokes exactly that add-on', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);
  await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: uid, entitlement_ids: ['addon_trips'] });
  await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: uid, entitlement_ids: ['addon_meals'] });
  assert.deepEqual(await addonsOf(user._id), ['recipes', 'trips']);

  const refund = await post({
    type: 'CANCELLATION',
    app_user_id: uid,
    cancel_reason: 'CUSTOMER_SUPPORT',
    entitlement_ids: ['addon_trips'],
  });
  assert.equal(refund.status, 200);
  assert.deepEqual(await addonsOf(user._id), ['recipes']);
});

test('retired addon_birthdays entitlement is ignored (Birthdays ships free)', async () => {
  const { user } = await registerUser();
  const res = await post({
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: String(user._id),
    entitlement_ids: ['addon_birthdays'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, 'NON_RENEWING_PURCHASE');
  assert.deepEqual(await addonsOf(user._id), []);
});

test('billing status reports owned add-ons and the catalog (3 paid + 2 free)', async () => {
  const { user, auth } = await registerUser();

  let res = await request().get('/api/billing/status').set('Authorization', auth);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.addons, []);
  assert.deepEqual(res.body.addonCatalog.items.map((i) => i.key),
    ['recipes', 'maintenance', 'trips', 'birthdays', 'chores']);
  // Paid items carry a price; free ones (opt-in, claimed not bought) are 0.
  const priceOf = (key) => res.body.addonCatalog.items.find((i) => i.key === key).price;
  for (const key of ['recipes', 'maintenance', 'trips']) assert.ok(priceOf(key) > 0, key);
  for (const key of ['birthdays', 'chores']) assert.equal(priceOf(key), 0, key);
  assert.equal(typeof res.body.addonCatalog.bundle.price, 'number');

  await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: String(user._id), entitlement_ids: ['addon_maintenance'] });
  res = await request().get('/api/billing/status').set('Authorization', auth);
  assert.deepEqual(res.body.addons, ['maintenance']);
});

test('any member can claim a FREE add-on; paid keys are rejected', async () => {
  const { user, auth } = await registerUser();

  // Free add-ons are opt-in: nothing granted by default.
  assert.deepEqual(await addonsOf(user._id), []);

  const claim = await request().post('/api/billing/addons/claim')
    .set('Authorization', auth).send({ addon: 'birthdays' });
  assert.equal(claim.status, 200);
  assert.deepEqual(await addonsOf(user._id), ['birthdays']);

  // Claiming again is idempotent.
  await request().post('/api/billing/addons/claim')
    .set('Authorization', auth).send({ addon: 'birthdays' });
  assert.deepEqual(await addonsOf(user._id), ['birthdays']);

  // A paid key can never be claimed for free; garbage keys likewise.
  for (const addon of ['recipes', 'maintenance', 'trips', 'not-a-key', undefined]) {
    const res = await request().post('/api/billing/addons/claim')
      .set('Authorization', auth).send({ addon });
    assert.equal(res.status, 400, String(addon));
  }
  assert.deepEqual(await addonsOf(user._id), ['birthdays']);
});

// The purchase lands on the user with no household lookup, so a buy made before
// joining one no longer has to be deferred until the buyer taps Restore (the old
// path acked with `addons: false` and waited, because there was nowhere to grant).
test('an add-on bought with no household still lands on the buyer', async () => {
  const { user, auth } = await registerUser();
  await User.updateOne({ _id: user._id }, { $unset: { householdId: 1 } });

  const buy = await post({
    type: 'NON_RENEWING_PURCHASE', app_user_id: String(user._id), entitlement_ids: ['addon_meals'],
  });
  assert.equal(buy.status, 200);
  assert.deepEqual(await addonsOf(user._id), ['recipes']);

  // And a householdless user reads back their own set, not an empty one.
  const status = await request().get('/api/billing/status').set('Authorization', auth);
  assert.deepEqual(status.body.addons, ['recipes']);
});

// Household-wide EFFECT from per-user ownership: status returns the union across
// members, which is what lets one purchase serve a whole family.
test('billing status unions add-ons across household members', async () => {
  const a = await registerUser();
  const b = await registerUser();
  // Put both in one household without going through the full join/approve dance.
  await User.updateOne({ _id: b.user._id }, { $set: { householdId: a.user.householdId } });

  await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: String(a.user._id), entitlement_ids: ['addon_meals'] });
  await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: String(b.user._id), entitlement_ids: ['addon_trips'] });

  for (const who of [a, b]) {
    const res = await request().get('/api/billing/status').set('Authorization', who.auth);
    assert.deepEqual(res.body.addons.sort(), ['recipes', 'trips'], 'both members see both add-ons');
  }
  // Ownership stayed split — only the effect is shared.
  assert.deepEqual(await addonsOf(a.user._id), ['recipes']);
  assert.deepEqual(await addonsOf(b.user._id), ['trips']);
});

// A refund revokes only the refunding user's ownership; a co-member who bought
// the same add-on independently keeps the lane lit for the household.
test('a refund by one member does not revoke another member\'s purchase', async () => {
  const a = await registerUser();
  const b = await registerUser();
  await User.updateOne({ _id: b.user._id }, { $set: { householdId: a.user.householdId } });
  for (const who of [a, b]) {
    await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: String(who.user._id), entitlement_ids: ['addon_meals'] });
  }

  await post({
    type: 'CANCELLATION', app_user_id: String(a.user._id),
    cancel_reason: 'CUSTOMER_SUPPORT', entitlement_ids: ['addon_meals'],
  });

  assert.deepEqual(await addonsOf(a.user._id), [], 'the refunder loses theirs');
  assert.deepEqual(await addonsOf(b.user._id), ['recipes'], 'the co-member keeps theirs');
  const res = await request().get('/api/billing/status').set('Authorization', a.auth);
  assert.deepEqual(res.body.addons, ['recipes'], 'the household lane stays lit');
});

// Claims land on the claimer, so they no longer require a household — a solo user
// is as entitled to a free add-on as a member of a shared one.
test('a free add-on can be claimed with no household', async () => {
  const { user, auth } = await registerUser();
  await User.updateOne({ _id: user._id }, { $unset: { householdId: 1 } });

  const claim = await request().post('/api/billing/addons/claim')
    .set('Authorization', auth).send({ addon: 'chores' });
  assert.equal(claim.status, 200);
  assert.deepEqual(claim.body.addons, ['chores']);
  assert.deepEqual(await addonsOf(user._id), ['chores']);
});

test('admin add-on override validates keys and requires admin', async () => {
  const { user, auth } = await registerUser();

  // Non-admin is rejected.
  const forbidden = await request().post('/api/billing/addons')
    .set('Authorization', auth).send({ addons: ['recipes'] });
  assert.equal(forbidden.status, 403);

  const User = require('../models/User');
  await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });

  const bad = await request().post('/api/billing/addons')
    .set('Authorization', auth).send({ addons: ['recipes', 'not-a-key'] });
  assert.equal(bad.status, 400);

  const ok = await request().post('/api/billing/addons')
    .set('Authorization', auth).send({ addons: ['recipes', 'trips'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await addonsOf(user._id), ['recipes', 'trips']);
});

// --- Calen AI plan (monthly subscription → per-period credit grants) ---

test('plan purchase activates and grants the monthly credits; renewals grant again', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);
  const before = await balanceOf(user._id);

  const buy = await post({
    type: 'INITIAL_PURCHASE', app_user_id: uid,
    entitlement_ids: ['calen_ai'], product_id: 'calen_ai_monthly_499',
    transaction_id: 'plan_txn_1', expiration_at_ms: Date.now() + 30 * 24 * 3600 * 1000,
  });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.plan, true);
  assert.equal(buy.body.credited, 600);
  let doc = await userDoc(user._id);
  assert.equal(doc.aiPlanActive, true);
  assert.ok(doc.aiPlanExpiresAt);
  assert.equal(await balanceOf(user._id), before + 600);

  // A re-delivered event dedupes on the transaction id.
  const dupe = await post({
    type: 'INITIAL_PURCHASE', app_user_id: uid,
    entitlement_ids: ['calen_ai'], product_id: 'calen_ai_monthly_499',
    transaction_id: 'plan_txn_1',
  });
  assert.equal(dupe.body.duplicate, true);
  assert.equal(await balanceOf(user._id), before + 600);

  // Next month's RENEWAL (fresh transaction id) grants another period.
  const renew = await post({
    type: 'RENEWAL', app_user_id: uid,
    entitlement_ids: ['calen_ai'], product_id: 'calen_ai_monthly_499',
    transaction_id: 'plan_txn_2',
  });
  assert.equal(renew.body.credited, 600);
  assert.equal(await balanceOf(user._id), before + 1200);

  // Ledger rows carry kind 'plan'.
  const rows = await CreditLedger.find({ userId: user._id, kind: 'plan' }).lean();
  assert.equal(rows.length, 2);
});

test('plan EXPIRATION deactivates but granted credits survive', async () => {
  const { user } = await registerUser();
  const uid = String(user._id);
  await post({
    type: 'INITIAL_PURCHASE', app_user_id: uid,
    entitlement_ids: ['calen_ai'], product_id: 'calen_ai_monthly_499',
    transaction_id: `plan_${uid}`,
  });
  const funded = await balanceOf(user._id);

  const expire = await post({ type: 'EXPIRATION', app_user_id: uid, entitlement_ids: ['calen_ai'] });
  assert.equal(expire.status, 200);
  const doc = await userDoc(user._id);
  assert.equal(doc.aiPlanActive, false);
  assert.equal(await balanceOf(user._id), funded);
});

test('billing status reports the plan state and the flat action prices', async () => {
  const { user, token } = await registerUser();
  const uid = String(user._id);

  let res = await request().get('/api/billing/status').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.aiPlan.active, false);
  assert.equal(res.body.aiPlan.productId, 'calen_ai_monthly_499');
  assert.equal(res.body.aiPlan.monthlyCredits, 600);
  assert.equal(res.body.actionCosts.chat, 5);
  assert.equal(res.body.actionCosts.callPerMinute, 20);

  await post({
    type: 'INITIAL_PURCHASE', app_user_id: uid,
    entitlement_ids: ['calen_ai'], product_id: 'calen_ai_monthly_499',
    transaction_id: `plan_status_${uid}`,
  });
  res = await request().get('/api/billing/status').set('Authorization', `Bearer ${token}`);
  assert.equal(res.body.aiPlan.active, true);
});

// --- Usage debits are ledgered (flat per-action prices) ---

test('a usage debit writes a ledger row and the ledger endpoint surfaces it', async () => {
  const { user, token } = await registerUser();
  const before = await balanceOf(user._id);

  const CreditLedgerModel = require('../models/CreditLedger');
  await CreditLedgerModel.debit({ userId: user._id, mc: 2000, action: 'chat' });
  assert.equal(await balanceOf(user._id), before - 2);

  const rows = await CreditLedgerModel.find({ userId: user._id, kind: 'usage' }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deltaMc, -2000);
  assert.equal(rows[0].action, 'chat');

  const res = await request().get('/api/billing/credits/ledger').set('Authorization', `Bearer ${token}`);
  const usageRow = res.body.entries.find((e) => e.kind === 'usage');
  assert.ok(usageRow, 'usage debit visible in history');
  assert.equal(usageRow.credits, -2);
  assert.equal(usageRow.action, 'chat');
});

test('billing status summarizes credits spent per feature this week', async () => {
  const { user, token } = await registerUser();
  const CreditLedgerModel = require('../models/CreditLedger');
  // Two chat turns + one prorated call debit this period.
  await CreditLedgerModel.debit({ userId: user._id, mc: 5000, action: 'chat' });
  await CreditLedgerModel.debit({ userId: user._id, mc: 2000, action: 'chat' });
  await CreditLedgerModel.debit({ userId: user._id, mc: 6700, action: 'call' });

  const res = await request().get('/api/billing/status').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  // Spend is keyed by action, summed to credits — chat folds the two turns.
  assert.equal(res.body.spend.chat, 7);
  assert.equal(res.body.spend.call, 6.7);
});
