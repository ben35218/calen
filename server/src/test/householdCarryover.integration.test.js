// Integration tests for the join carry-over (routes/household.js) — the server
// half of merging a joiner's data into the household they joined.
//
// Guards the "we joined households but our calendars never merged" defect.
// Approving a join only flips `User.householdId`; under Signal-parity C4 the
// joiner's records stay stamped with the household they left and sealed under its
// HDK, so they're readable by nobody in the destination. The server can't re-seal
// (it holds no key), so it exposes the ciphertext to the one party that still
// holds the old envelope, accepts the re-sealed blob back, and re-stamps the row.
//
// Pinned here: the listing is scoped by envelope-holding (never by who asks), a
// move is idempotent and preserves `_id`, a caller without the envelope is
// refused, resource-scoped rows are left in their own lane, and the drained
// household is reaped along with its key material.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u, fakeEnc } = require('./harness');
const Household = require('../models/Household');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const Record = require('../models/Record');
const User = require('../models/User');

before(startDb);
after(stopDb);

async function mintKey(auth) {
  const res = await request().post('/api/household/key').set('Authorization', auth)
    .send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(res.status, 201, `mint failed: ${JSON.stringify(res.body)}`);
}

// A joiner who owned a household with records in it, then joined the owner's.
async function setupStrandedJoin() {
  const owner = await registerUser({ firstName: 'Owner' });
  const joiner = await registerUser({ firstName: 'Joiner' });
  await enrollKeys(owner.auth);
  await enrollKeys(joiner.auth);
  await mintKey(owner.auth);
  await mintKey(joiner.auth);

  const oldHouseholdId = joiner.user.householdId;
  const rec = await request().post('/api/records').set('Authorization', joiner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(rec.status, 201);

  await joinHousehold({ joiner, approver: owner, keyVersion: 1 });
  return { owner, joiner, oldHouseholdId, recordId: rec.body._id };
}

test('a joiner\'s records are stranded by the move and listed for carry-over', async () => {
  const { joiner, oldHouseholdId, recordId } = await setupStrandedJoin();

  // The record did NOT travel with the membership flip — this is the defect.
  const stranded = await Record.findById(recordId).lean();
  assert.equal(String(stranded.householdId), String(oldHouseholdId));

  const res = await request().get('/api/household/carryover').set('Authorization', joiner.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.households.length, 1);
  const group = res.body.households[0];
  assert.equal(String(group.householdId), String(oldHouseholdId));
  assert.equal(String(group.records[0]._id), String(recordId));
  // The envelopes ride along so the device can unwrap the key that opens them.
  assert.ok(group.envelopes.length >= 1, 'old household envelopes served');
  assert.ok(group.envelopes[0].wrappedHDK);
});

test('carrying over re-stamps the record in place and reaps the drained household', async () => {
  const { owner, joiner, oldHouseholdId, recordId } = await setupStrandedJoin();
  const newHouseholdId = owner.user.householdId;

  const move = await request().put(`/api/household/carryover/${recordId}`)
    .set('Authorization', joiner.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(move.status, 200);
  assert.equal(move.body.moved, true);

  // Moved, not copied: same _id, now in the destination household.
  const moved = await Record.findById(recordId).lean();
  assert.equal(String(moved.householdId), String(newHouseholdId));
  assert.equal(await Record.countDocuments({ _id: recordId }), 1, 'no duplicate row');

  // Now visible to the OTHER member — the whole point of the merge.
  const sync = await request().get('/api/records/sync').set('Authorization', owner.auth);
  assert.equal(sync.status, 200);
  assert.ok(sync.body.records.some((r) => String(r._id) === String(recordId)), 'owner sees the carried-over record');

  const done = await request().post('/api/household/carryover/complete').set('Authorization', joiner.auth).send({});
  assert.equal(done.status, 200);
  assert.equal(done.body.reaped, 1);
  assert.equal(await Household.countDocuments({ _id: oldHouseholdId }), 0, 'emptied household reaped');
  assert.equal(await HouseholdKeyEnvelope.countDocuments({ householdId: oldHouseholdId }), 0, 'its key material retired');
});

test('a second carry-over of the same record is a no-op, not an error', async () => {
  const { joiner, recordId } = await setupStrandedJoin();
  const first = await request().put(`/api/household/carryover/${recordId}`)
    .set('Authorization', joiner.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(first.body.moved, true);

  // Idempotent: the pass runs on every unlock and must tolerate a retry.
  const second = await request().put(`/api/household/carryover/${recordId}`)
    .set('Authorization', joiner.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(second.status, 200);
  assert.equal(second.body.moved, false);
});

// Authorization is envelope-holding, not membership: a stranger who never had the
// old household's key must not be able to pull its ciphertext into their own.
test('a user without the old household\'s envelope cannot carry its records over', async () => {
  const { recordId, oldHouseholdId } = await setupStrandedJoin();
  const stranger = await registerUser({ firstName: 'Stranger' });
  await enrollKeys(stranger.auth);
  await mintKey(stranger.auth);

  const res = await request().put(`/api/household/carryover/${recordId}`)
    .set('Authorization', stranger.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(res.status, 403);
  const untouched = await Record.findById(recordId).lean();
  assert.equal(String(untouched.householdId), String(oldHouseholdId), 'record left where it was');

  // And their own listing sees nothing — they hold no foreign envelopes.
  const list = await request().get('/api/household/carryover').set('Authorization', stranger.auth);
  assert.equal(list.body.total, 0);
});

test('the listing never includes the caller\'s CURRENT household', async () => {
  const owner = await registerUser({ firstName: 'Settled' });
  await enrollKeys(owner.auth);
  await mintKey(owner.auth);
  const rec = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(rec.status, 201);

  const res = await request().get('/api/household/carryover').set('Authorization', owner.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0, 'nothing stranded — these records are already home');
});

// D1/D2 shared-lane rows route by `scope.resource` to collaborators in ANY
// household, so they're already reachable after the move. Re-stamping one would
// break the owner-side rotation accounting — they must be left alone, and they
// keep their household (and its key) alive.
test('resource-scoped records are excluded from carry-over and block the reap', async () => {
  const owner = await registerUser({ firstName: 'CalOwner' });
  const joiner = await registerUser({ firstName: 'CalJoiner' });
  await enrollKeys(owner.auth);
  await enrollKeys(joiner.auth);
  await mintKey(owner.auth);
  await mintKey(joiner.auth);
  const oldHouseholdId = joiner.user.householdId;

  const shared = await request().post('/api/records').set('Authorization', joiner.auth).send({
    enc: { ...fakeEnc(), ks: 'cal' },
    keyVersion: 1,
    scope: { kind: 'calendar', resource: 'custom-book-club', version: 1 },
  });
  assert.equal(shared.status, 201);

  await joinHousehold({ joiner, approver: owner, keyVersion: 1 });

  const res = await request().get('/api/household/carryover').set('Authorization', joiner.auth);
  assert.equal(res.body.total, 0, 'shared-lane row is not stranded');

  const done = await request().post('/api/household/carryover/complete').set('Authorization', joiner.auth).send({});
  assert.equal(done.body.reaped, 0);
  assert.ok(await Household.findById(oldHouseholdId), 'household kept — its resource-lane ciphertext still lives there');
});

// Add-on ownership is per USER (User.addons) and takes effect as the union across
// household members. That split is what makes a purchase survive every membership
// change — the failure it replaces was storing the entitlement on a household the
// buyer could walk out of, which silently revoked what they'd paid for.
test('a purchased add-on survives joining a household, and unlocks it for everyone', async () => {
  const owner = await registerUser({ firstName: 'Owner' });
  const joiner = await registerUser({ firstName: 'Buyer' });
  await enrollKeys(owner.auth);
  await enrollKeys(joiner.auth);
  await mintKey(owner.auth);
  await mintKey(joiner.auth);

  // The joiner bought Meals before joining; the owner bought nothing.
  await User.updateOne({ _id: joiner.user._id }, { $set: { addons: ['recipes'] } });

  await joinHousehold({ joiner, approver: owner, keyVersion: 1 });

  const status = await request().get('/api/billing/status').set('Authorization', joiner.auth);
  assert.equal(status.status, 200);
  assert.ok(status.body.addons.includes('recipes'), 'the purchase survived the join');

  // Household-wide EFFECT: the owner, who bought nothing, gets the lane too.
  const ownerStatus = await request().get('/api/billing/status').set('Authorization', owner.auth);
  assert.ok(ownerStatus.body.addons.includes('recipes'), 'one member\'s purchase unlocks the household');
  // …but ownership itself did not spread — only the buyer holds it.
  const ownerDoc = await User.findById(owner.user._id, 'addons').lean();
  assert.deepEqual(ownerDoc.addons, [], 'the non-buyer owns nothing');
});

// The regression this whole change exists for: under household-stored ownership,
// leaving minted a fresh household with an empty add-on set, so the member who
// PAID lost their own purchase with no indication it had happened.
test('a buyer keeps their add-on after leaving the household they joined', async () => {
  const owner = await registerUser({ firstName: 'Owner' });
  const joiner = await registerUser({ firstName: 'Buyer' });
  await enrollKeys(owner.auth);
  await enrollKeys(joiner.auth);
  await mintKey(owner.auth);
  await mintKey(joiner.auth);
  await User.updateOne({ _id: joiner.user._id }, { $set: { addons: ['recipes'] } });
  await joinHousehold({ joiner, approver: owner, keyVersion: 1 });

  const left = await request().post('/api/household/leave').set('Authorization', joiner.auth).send({});
  assert.equal(left.status, 200);

  const status = await request().get('/api/billing/status').set('Authorization', joiner.auth);
  assert.ok(status.body.addons.includes('recipes'), 'the buyer still owns what they paid for');

  // And the household they left keeps only what its own members own — the lane
  // goes dark for the owner, who never bought it.
  const ownerStatus = await request().get('/api/billing/status').set('Authorization', owner.auth);
  assert.ok(!ownerStatus.body.addons.includes('recipes'), 'the borrowed add-on left with its buyer');
});

// Mirror case: removal must not confiscate the removed member's own purchase.
test('a removed member keeps their own add-on', async () => {
  const owner = await registerUser({ firstName: 'Owner' });
  const member = await registerUser({ firstName: 'Buyer' });
  await enrollKeys(owner.auth);
  await enrollKeys(member.auth);
  await mintKey(owner.auth);
  await mintKey(member.auth);
  await User.updateOne({ _id: member.user._id }, { $set: { addons: ['trips'] } });
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  const removed = await request().post(`/api/household/members/${member.user._id}/remove`)
    .set('Authorization', owner.auth).send({});
  assert.equal(removed.status, 200);

  const status = await request().get('/api/billing/status').set('Authorization', member.auth);
  assert.ok(status.body.addons.includes('trips'), 'removal did not confiscate the purchase');
});
