// Integration test for the §9 plaintext drop, updated for the Signal-parity C3b
// unified store. The drop still nulls the plaintext content columns on any record
// that carries ciphertext (for the non-migrated Trip/TripItem + the household
// blob, and for legacy per-collection rows created before the C3b migration),
// nulls the C4 author (`userId`) on author-hidden collections, and keeps the
// shared-trip plaintext lane. The 9 migrated collections are opaque in the Record
// store, so a fresh household has NO content stragglers — only the household name
// blob gates the drop. Post-drop, content creates go through the opaque /records.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, request, b64u, fakeEnc, registerUser, enrollKeys, joinHousehold,
} = require('./harness');

const Household = require('../models/Household');
const Contact = require('../models/Contact');
const CalendarEvent = require('../models/CalendarEvent');
const Trip = require('../models/Trip');
const TripItem = require('../models/TripItem');
const Record = require('../models/Record');
const Category = require('../models/Category');
const AuditLog = require('../models/AuditLog');
const { dropPlaintext } = require('../scripts/dropPlaintext');

before(startDb);
after(stopDb);

// Regression: a household must activate when its Record store is fully sealed,
// EVEN IF a legacy per-collection table still holds an orphaned plaintext
// author-hidden row (a pre-C3b seeded Category with no Record twin, no
// householdId). The sealer (/e2ee/seal) writes ciphertext to Record, so such a
// row can never be sealed in place — counting it as a straggler used to deadlock
// activation permanently ("ready, not live"). The gate now reads Record.
test('an orphaned legacy plaintext author-hidden row does not block activation', async () => {
  const owner = await registerUser({ firstName: 'Cara' });
  await enrollKeys(owner.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  const householdId = hh.body._id;

  // Seal the household name/location blob so it isn't the straggler under test.
  await request().put('/api/settings').set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });

  // Real content, sealed, in the unified store — written pre-activation, so it
  // still carries the plaintext author `userId` (as a not-yet-active household's
  // records legitimately do).
  const rec = await Record.create({ userId: owner.user._id, householdId, enc: fakeEnc(), keyVersion: 1 });

  // The orphan: legacy plaintext, no Record twin, no householdId → unsealable.
  await Category.create({ userId: owner.user._id, name: 'Vehicles', keyVersion: 1 });

  // Gate reads Record (all sealed) → no stragglers → dry-run, not a deadlock.
  let result = await dropPlaintext(householdId);
  assert.equal(result.status, 'dry-run', 'the orphaned legacy plaintext row must not block the drop');

  result = await dropPlaintext(householdId, { commit: true });
  assert.equal(result.status, 'committed');
  assert.equal((await Household.findById(householdId)).e2eeActive, true);
  // C4 author-hiding reaches the Record store: the pre-activation record's
  // plaintext author is nulled at the drop, so the server can't attribute it.
  const after = await Record.findById(rec._id).lean();
  assert.equal(after.userId, undefined, 'the Record author userId must be nulled at activation');
});

test('the whole drop journey: seal → readiness → dry run → commit → post-drop API', async (t) => {
  // ── Setup: a household of two with real onboarding ─────────────────────────
  const owner = await registerUser({ firstName: 'Ada' });
  const member = await registerUser({ firstName: 'Ben' });
  await enrollKeys(owner.auth);
  await enrollKeys(member.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  const householdId = hh.body._id;
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  // Legacy per-collection dual-write rows (enc + plaintext) the drop must null:
  // an author-hidden event + contact, a private trip, and a SHARED trip + booking
  // that must STAY plaintext for outside collaborators.
  const event = await CalendarEvent.create({
    userId: owner.user._id, householdId, calendarType: 'appointments', title: 'Dentist',
    startDate: new Date('2026-08-10'), enc: fakeEnc(), keyVersion: 1,
  });
  const contact = await Contact.create({
    userId: owner.user._id, householdId, type: 'friend', name: 'Neighbor', enc: fakeEnc(), keyVersion: 1,
  });
  const privateTrip = await Trip.create({
    userId: owner.user._id, name: 'Anniversary', destination: 'Quebec City',
    start: new Date('2026-10-01'), end: new Date('2026-10-04'), enc: fakeEnc(), keyVersion: 1,
  });
  const sharedTrip = await Trip.create({
    userId: owner.user._id, name: 'Cousins camping', destination: 'Algonquin',
    start: new Date('2026-07-20'), end: new Date('2026-07-22'),
    sharedWithOutside: [{ email: 'cousin@example.com' }],
  });
  const sharedItem = await TripItem.create({
    userId: owner.user._id, householdId: owner.user.householdId, tripId: sharedTrip._id,
    type: 'activity', title: 'Canoe rental', start: new Date('2026-07-20'),
  });

  // ── 1) The only straggler is the household name blob (C3b: no server-seeded
  //       content, and every created record already carries enc) ──────────────
  let result = await dropPlaintext(householdId);
  assert.equal(result.status, 'stragglers', 'the unsealed household name blocks the drop');

  const stragglers = await request().get('/api/household/e2ee/stragglers').set('Authorization', owner.auth);
  assert.equal(stragglers.status, 200);
  assert.equal(stragglers.body.total, 0, 'no CONTENT stragglers — all records are already sealed');
  // The shared trip is legitimately plaintext — it must NOT be offered for sealing.
  assert.equal(stragglers.body.collections.find((c) => c.collection === 'Trip'), undefined);

  // Seal the household settings blob (name + homeAddress — C2) via PUT /settings.
  const blob = await request().put('/api/settings').set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(blob.status, 200);

  // ── 2) Min-app-version gate ────────────────────────────────────────────────
  process.env.E2EE_MIN_APP_VERSION = '1.2.0';
  t.after(() => { delete process.env.E2EE_MIN_APP_VERSION; });
  let readiness = await request().get('/api/household/e2ee/readiness').set('Authorization', owner.auth);
  assert.equal(readiness.body.ready, false, 'unreported client versions must fail the gate');

  for (const u of [owner, member]) {
    const rep = await request().post('/api/household/e2ee/client-version')
      .set('Authorization', u.auth).send({ version: '1.2.3', platform: 'ios' });
    assert.equal(rep.status, 200);
  }
  readiness = await request().get('/api/household/e2ee/readiness').set('Authorization', owner.auth);
  assert.equal(readiness.body.ready, true);
  assert.equal(readiness.body.e2eeActive, false);

  // ── 3) Dry run changes nothing ─────────────────────────────────────────────
  result = await dropPlaintext(householdId);
  assert.equal(result.status, 'dry-run');
  assert.equal((await Household.findById(householdId)).e2eeActive, false);
  assert.equal((await CalendarEvent.findById(event._id)).title, 'Dentist');

  // ── 4) COMMIT ──────────────────────────────────────────────────────────────
  result = await dropPlaintext(householdId, { commit: true });
  assert.equal(result.status, 'committed');

  const hhAfter = await Household.findById(householdId);
  assert.equal(hhAfter.e2eeActive, true);
  // C2: the household name is content — nulled at the drop, blob intact.
  assert.equal(hhAfter.name, undefined);
  assert.ok(hhAfter.enc?.ct);

  // Sealed records: plaintext content nulled, ciphertext intact, and the C4 author
  // (plaintext userId) nulled on the author-hidden collections.
  const eventAfter = await CalendarEvent.findById(event._id).lean();
  assert.equal(eventAfter.title, undefined);
  assert.equal(eventAfter.userId, undefined, 'author (plaintext userId) is nulled at the drop');
  assert.ok(eventAfter.enc?.ct);
  const contactAfter = await Contact.findById(contact._id).lean();
  assert.equal(contactAfter.name, undefined);
  assert.equal(contactAfter.userId, undefined, 'author sealed inside enc, plaintext nulled');
  assert.equal(String(contactAfter.householdId), String(householdId), 'attributed to the household');
  assert.ok(contactAfter.enc?.ct);
  const privAfter = await Trip.findById(privateTrip._id).lean();
  assert.equal(privAfter.name, undefined);
  assert.ok(privAfter.enc?.ct);

  // The shared trip and its booking keep their plaintext (no enc → collaborator-readable).
  const sharedAfter = await Trip.findById(sharedTrip._id).lean();
  assert.equal(sharedAfter.name, 'Cousins camping');
  const sharedItemAfter = await TripItem.findById(sharedItem._id).lean();
  assert.equal(sharedItemAfter.title, 'Canoe rental');

  // Audit trail + idempotence.
  assert.ok(await AuditLog.findOne({ householdId, event: 'plaintext_dropped' }));
  assert.equal((await dropPlaintext(householdId, { commit: true })).status, 'already-active');

  // ── 5) The API, live with e2eeActive = true ────────────────────────────────
  const hhLive = await request().get('/api/household').set('Authorization', member.auth);
  assert.equal(hhLive.status, 200);
  assert.equal(hhLive.body.e2eeActive, true);

  // Post-drop content creates go through the opaque store: ciphertext only, and the
  // HDK record's author is hidden (attributed to the household).
  const create = await request().post('/api/records')
    .set('Authorization', member.auth)
    .send({ _id: '66aabbccddeeff0011223344', enc: fakeEnc(), keyVersion: 1 });
  assert.equal(create.status, 201);
  const createdRow = await Record.findById('66aabbccddeeff0011223344').lean();
  assert.equal(createdRow.title, undefined, 'the opaque store persists no plaintext content');
  assert.equal(createdRow.userId, undefined, 'a post-drop HDK create hides the author');
  assert.equal(String(createdRow.householdId), String(householdId));
  assert.ok(createdRow.enc?.ct);

  // Readiness endpoint reports the live state; no new stragglers.
  const readyAfter = await request().get('/api/household/e2ee/readiness').set('Authorization', owner.auth);
  assert.equal(readyAfter.body.e2eeActive, true);
  const strag = await request().get('/api/household/e2ee/stragglers').set('Authorization', owner.auth);
  assert.equal(strag.body.total, 0);
});
