// Integration tests for POST /household/leave (routes/household.js) — the
// departure path. Guards the data-loss fix: a SOLE member has nothing to leave,
// so leaving must NOT tear down their household (which would delete its only key
// envelope via handleDeparture's empty-household branch and orphan every
// encrypted record with no key left to open it). Leaving a SHARED household still
// moves the leaver into a fresh solo one and preserves the household for the rest.
// Real app + in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u, fakeEnc } = require('./harness');
const Household = require('../models/Household');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const Record = require('../models/Record');

before(startDb);
after(stopDb);

// Mint the household's HDK v1 (self-wrapped envelope) the real way.
async function mintKey(auth) {
  const res = await request().post('/api/household/key').set('Authorization', auth)
    .send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(res.status, 201, `mint failed: ${JSON.stringify(res.body)}`);
}

test('sole-member leave is a no-op: household, key envelope, and records all survive', async () => {
  const owner = await registerUser({ firstName: 'Solo' });
  const householdId = owner.user.householdId;
  assert.ok(householdId);
  await enrollKeys(owner.auth);
  await mintKey(owner.auth);

  // A record that only this household's key can decrypt.
  const rec = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(rec.status, 201);

  assert.equal(await HouseholdKeyEnvelope.countDocuments({ householdId }), 1);
  assert.equal(await Record.countDocuments({ householdId }), 1);

  const res = await request().post('/api/household/leave').set('Authorization', owner.auth).send({});
  assert.equal(res.status, 200);
  // Kept in the SAME household — nothing torn down, nothing recreated.
  assert.equal(String(res.body.householdId), String(householdId));

  const me = await request().get('/api/auth/me').set('Authorization', owner.auth);
  assert.equal(String(me.body.householdId), String(householdId));

  assert.ok(await Household.findById(householdId), 'household preserved');
  assert.equal(await HouseholdKeyEnvelope.countDocuments({ householdId }), 1, 'key envelope preserved');
  assert.equal(await Record.countDocuments({ householdId }), 1, 'records preserved');
  // No orphaned empty household was minted for this owner.
  assert.equal(await Household.countDocuments({ ownerId: owner.user._id }), 1, 'no duplicate household');
});

test('leaving a SHARED household moves the leaver out and preserves it for the rest', async () => {
  const owner = await registerUser({ firstName: 'Owner' });
  const member = await registerUser({ firstName: 'Member' });
  await enrollKeys(owner.auth);
  await enrollKeys(member.auth);
  await mintKey(owner.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  const sharedId = owner.user.householdId;

  const res = await request().post('/api/household/leave').set('Authorization', member.auth).send({});
  assert.equal(res.status, 200);
  // The leaver lands in a brand-new solo household…
  assert.notEqual(String(res.body.householdId), String(sharedId));
  const memberNow = await request().get('/api/auth/me').set('Authorization', member.auth);
  assert.equal(String(memberNow.body.householdId), String(res.body.householdId));
  // …and the shared household survives for the owner who stayed.
  assert.ok(await Household.findById(sharedId), 'shared household preserved for remaining members');
  const ownerNow = await request().get('/api/auth/me').set('Authorization', owner.auth);
  assert.equal(String(ownerNow.body.householdId), String(sharedId));
  // The departed member's envelope for the shared household is dropped.
  assert.equal(
    await HouseholdKeyEnvelope.countDocuments({ householdId: sharedId, userId: member.user._id }), 0,
    "departed member's envelope removed",
  );
});
