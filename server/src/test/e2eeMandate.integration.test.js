// Integration test for the mandatory-E2EE enforcement (the write-guard) and the
// born-encrypted activation endpoint. The policy is off under NODE_ENV=test by
// default so the other suites keep exercising the plaintext paths — this file
// flips the E2EE_ENFORCE_IN_TEST opt-in so e2eeRequired() reports true for a
// normal (non-exempt) household, exactly as it will in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, request, b64u, fakeEnc, registerUser, enrollKeys,
} = require('./harness');

// Turn the mandate on for this process before any request runs.
process.env.E2EE_ENFORCE_IN_TEST = '1';

before(startDb);
after(async () => { delete process.env.E2EE_ENFORCE_IN_TEST; await stopDb(); });

// Enroll the owner and mint HDK v1 so the session "holds a key" the way a real
// onboarded client would.
async function onboardOwner(firstName) {
  const owner = await registerUser({ firstName });
  await enrollKeys(owner.auth);
  const mint = await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(mint.status, 201);
  return owner;
}

// A fresh client-minted ObjectId (24 hex chars), as the client supplies when
// creating an encrypted record so its ciphertext AAD can bind to the _id.
const crypto = require('node:crypto');
const oid = () =>
  Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + crypto.randomBytes(8).toString('hex');

// Onboard, seal the register-seeded stragglers + settings blob, and run the
// born-encrypted activation so the household is E2EE-live (e2eeActive = true) —
// the state in which the steady-state write rule applies.
async function activateOwner(firstName) {
  const owner = await onboardOwner(firstName);
  const strag = await request().get('/api/household/e2ee/stragglers').set('Authorization', owner.auth);
  for (const group of strag.body.collections) {
    for (const row of group.records) {
      await request().post('/api/household/e2ee/seal').set('Authorization', owner.auth)
        .send({ collection: group.collection, _id: row._id, enc: fakeEnc(), keyVersion: 1 });
    }
  }
  await request().put('/api/settings').set('Authorization', owner.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  const activate = await request().post("/api/household/e2ee/activate").set("Authorization", owner.auth);
  assert.equal(activate.body.e2eeActive, true, `${firstName}'s household should be e2eeActive`);
  return owner;
}

test('write-guard: the opaque store is enc-only; the shared-trip plaintext lane is preserved', async () => {
  const owner = await onboardOwner('Ada');

  // Signal-parity C3b: the 9 content collections (contacts/events/chores/tasks/items/
  // recipes/odometer/meal-plan/categories) all write through the unified opaque
  // store, which is STRUCTURALLY enc-only — a no-enc create is rejected with the
  // mandate message; an enc-bearing one succeeds. The collection type is inside the
  // ciphertext, so there is nothing per-collection to guard here anymore.
  const plain = await request().post('/api/records').set('Authorization', owner.auth).send({});
  assert.equal(plain.status, 400, 'a no-enc content create is blocked');
  assert.match(plain.body.error, /end-to-end encrypted/i, 'it returns the mandate message');
  const sealed = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ _id: oid(), enc: fakeEnc(), keyVersion: 1 });
  assert.equal(sealed.status, 201, 'an enc-bearing content create succeeds');
  assert.ok(sealed.body.enc?.ct, 'the ciphertext is persisted');

  // Trip / TripItem stay their own (non-migrated) collections, so their
  // per-collection write-guard remains. A private trip's item needs enc…
  const privateTrip = await request().post('/api/trips').set('Authorization', owner.auth)
    .send({ name: 'Private', destination: 'Rome', _id: oid(), enc: fakeEnc(), keyVersion: 1 });
  const itemPlain = await request().post(`/api/trips/${privateTrip.body._id}/items`)
    .set('Authorization', owner.auth).send({ type: 'hotel', title: 'Hotel Roma', start: '2026-09-02' });
  assert.equal(itemPlain.status, 400, 'a private trip item without enc is blocked');
  const itemSealed = await request().post(`/api/trips/${privateTrip.body._id}/items`)
    .set('Authorization', owner.auth)
    .send({ type: 'hotel', title: 'Hotel Roma', start: '2026-09-02', _id: oid(), enc: fakeEnc(), keyVersion: 1 });
  assert.equal(itemSealed.status, 201, 'a private trip item with enc succeeds');

  // …but a SHARED trip stays plaintext-readable for outside collaborators, so a
  // plaintext item on it is allowed (and never sealed).
  const sharedTrip = await request().post('/api/trips').set('Authorization', owner.auth)
    .send({ name: 'Shared', destination: 'Algonquin', _id: oid(), enc: fakeEnc(), keyVersion: 1 });
  await request().put(`/api/trips/${sharedTrip.body._id}/share`)
    .set('Authorization', owner.auth).send({ recipients: [{ email: 'cousin@example.com' }] });
  const sharedItem = await request().post(`/api/trips/${sharedTrip.body._id}/items`)
    .set('Authorization', owner.auth).send({ type: 'activity', title: 'Canoe', start: '2026-07-20' });
  assert.equal(sharedItem.status, 201, 'a shared trip item without enc is allowed');
  assert.equal(sharedItem.body.enc, undefined, 'a shared trip item is never sealed');
});

test('task completion is content-blind: the ledger records facts + the re-sealed task enc is applied', async () => {
  const owner = await onboardOwner('Kim');
  const Record = require('../models/Record');

  // C3b: the task lives in the opaque store; its content (title/nextDueDate/km)
  // is inside enc. Create it there.
  const tId = oid();
  const create = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ _id: tId, enc: fakeEnc(), keyVersion: 1 });
  assert.equal(create.status, 201);

  // The client computed the rollover (shared engine) and re-sealed the task; the
  // completion route records the FACTS (a TaskCompletion ledger row) and applies
  // the new ciphertext to the task's Record — it never reads/writes content.
  const done = await request().post(`/api/tasks/${tId}/complete`)
    .set('Authorization', owner.auth)
    .send({
      completedDate: '2026-07-17', odometerReading: 50000,
      nextDueDate: '2027-01-17', nextDueKm: 58000, lastServiceKm: 50000,
      enc: fakeEnc(), keyVersion: 1,
    });
  assert.equal(done.status, 200);
  assert.equal(done.body.completion.nextDueDateAfter.slice(0, 10), '2027-01-17', 'the ledger records the client-computed date');
  const after = await Record.findById(tId).lean();
  assert.ok(after.enc?.ct, 'the re-sealed task ciphertext is applied to the record');

  // A one-time completion sends no nextDueDate → the ledger records null.
  const oneTime = oid();
  await request().post('/api/records').set('Authorization', owner.auth)
    .send({ _id: oneTime, enc: fakeEnc(), keyVersion: 1 });
  const doneOnce = await request().post(`/api/tasks/${oneTime}/complete`)
    .set('Authorization', owner.auth).send({ completedDate: '2026-07-17', enc: fakeEnc(), keyVersion: 1 });
  assert.equal(doneOnce.status, 200);
  assert.equal(doneOnce.body.completion.nextDueDateAfter ?? null, null, 'no client date → the ledger records null');
});

test('born-encrypted activation flips e2eeActive and stays enforced afterward', async () => {
  const owner = await onboardOwner('Ivy');
  const Record = require('../models/Record');

  // Signal-parity C3b: the server seeds no plaintext content on register, so a
  // fresh mandated household has NO content stragglers — only the household
  // settings blob (name, C2) needs sealing before the drop.
  const strag = await request().get('/api/household/e2ee/stragglers').set('Authorization', owner.auth);
  assert.equal(strag.body.total, 0, "a born-encrypted household has no content stragglers");

  const blob = await request().put('/api/settings').set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(blob.status, 200);

  // Activate → the household drops (empty) plaintext and goes E2EE-live.
  const activate = await request().post("/api/household/e2ee/activate").set("Authorization", owner.auth);
  assert.equal(activate.status, 200);
  assert.equal(activate.body.status, "committed");
  assert.equal(activate.body.e2eeActive, true);

  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  assert.equal(hh.body.e2eeActive, true);

  // Idempotent — a second activation is a no-op success.
  const again = await request().post('/api/household/e2ee/activate').set('Authorization', owner.auth);
  assert.equal(again.body.status, 'already-active');
  assert.equal(again.body.e2eeActive, true);

  // The write-guard still holds post-activation: the opaque store is enc-only, an
  // enc-bearing create persists NO plaintext (structural), and it hides the author.
  const plain = await request().post('/api/records').set('Authorization', owner.auth).send({});
  assert.equal(plain.status, 400);
  const pid = oid();
  const sealed = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ _id: pid, enc: fakeEnc(), keyVersion: 1 });
  assert.equal(sealed.status, 201);
  const stored = await Record.findById(pid).lean();
  assert.equal(stored.userId, undefined, 'a post-activation HDK create hides the author');
  assert.ok(stored.enc?.ct, 'only the ciphertext is stored');
});

// The pass-2 steady-state write rule: once a household is e2eeActive, no
// create/update may re-persist the plaintext content columns the drop nulled.
// Without it the dual-write clients keep sending plaintext and every route
// stores it, silently re-granting the server readable content.
test('steady-state write rule: the opaque store persists ciphertext + routing only', async () => {
  const owner = await activateOwner('Zoe');
  const Record = require('../models/Record');
  const Household = require('../models/Household');

  // C3b: the write rule is now STRUCTURAL — the unified store has no content
  // column at all, so a create keeps ONLY the opaque routing keys + enc, whatever
  // the client sends. (The type + every content/routing field rides in enc.)
  const id = oid();
  const create = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ _id: id, enc: fakeEnc(), keyVersion: 1, title: 'Dentist', calendarType: 'appointments' });
  assert.equal(create.status, 201);
  assert.equal(create.body.title, undefined, 'the response carries no plaintext content');
  const row = await Record.findById(id).lean();
  const extra = Object.keys(row).filter((k) =>
    !['_id', 'householdId', 'userId', 'keyVersion', 'enc', 'scope', 'deleted', 'createdAt', 'updatedAt', '__v'].includes(k));
  assert.deepEqual(extra, [], 'no content/routing column is stored beyond the opaque store keys');
  assert.equal(row.userId, undefined, 'the author is hidden on an e2eeActive HDK record');
  assert.ok(row.enc?.ct, 'the ciphertext is stored');

  // An update re-seals; still ciphertext-only.
  const upd = await request().put(`/api/records/${id}`).set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1, title: 'Dentist v2' });
  assert.equal(upd.status, 200);
  const row2 = await Record.findById(id).lean();
  assert.equal(row2.title, undefined, 'an edit does not re-introduce plaintext content');
  assert.ok(row2.enc?.ct);

  // Household rename (C2): only the re-sealed blob, never the plaintext name.
  // (Household is NOT migrated — it stays its own settings doc.)
  const rename = await request().put('/api/household').set('Authorization', owner.auth)
    .send({ name: 'The Riveras', enc: fakeEnc(), keyVersion: 1 });
  assert.equal(rename.status, 200);
  const hh = await Household.findById(owner.user.householdId).lean();
  assert.equal(hh.name, undefined, 'the household name is not re-stored plaintext');
  assert.ok(hh.enc?.ct, 'the sealed household blob is updated');
});

// The exempt plaintext lanes (§9.3 shared trips, §9.5 outside-shared calendars)
// must keep storing plaintext even for an e2eeActive household — collaborators
// hold no HDK. They write WITHOUT enc, so the write rule is a no-op for them.
test('steady-state write rule: the shared-trip plaintext lane is untouched on an e2eeActive household', async () => {
  const owner = await activateOwner('Max');
  const TripItem = require('../models/TripItem');

  const trip = await request().post('/api/trips').set('Authorization', owner.auth)
    .send({ name: 'Cousins camping', destination: 'Algonquin', _id: oid(), enc: fakeEnc(), keyVersion: 1 });
  // Sharing a sealed trip on an e2eeActive household is the §9.3 decrypt-on-share
  // flow: the owner's device posts the decrypted content, which becomes the
  // collaborator-readable plaintext (enc cleared).
  const shared = await request().put(`/api/trips/${trip.body._id}/share`).set('Authorization', owner.auth)
    .send({
      recipients: [{ email: 'cousin@example.com' }],
      decrypted: { trip: { name: 'Cousins camping', destination: 'Algonquin' }, items: [] },
    });
  assert.equal(shared.status, 200);

  // A plaintext (enc-less) booking on the shared trip is allowed AND keeps its
  // plaintext so the outside collaborator can read it.
  const item = await request().post(`/api/trips/${trip.body._id}/items`).set('Authorization', owner.auth)
    .send({ type: 'activity', title: 'Canoe rental', location: 'Dock 3', start: '2026-07-20' });
  assert.equal(item.status, 201);
  assert.equal(item.body.enc, undefined, 'a shared booking is never sealed');
  const stored = await TripItem.findById(item.body._id).lean();
  assert.equal(stored.title, 'Canoe rental', 'the shared booking keeps its plaintext title');
  assert.equal(stored.location, 'Dock 3', 'and its plaintext location');
});
