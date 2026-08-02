// Integration test for Signal-parity C3 — opaque record envelopes / unified store.
// The server stores every content record in ONE collection with NO plaintext type,
// and serves them via a single householdId + updatedAt sync cursor. Pins:
//   (1) an opaque write stores only routing + ciphertext — no plaintext collection
//       or content anywhere on the row;
//   (2) householdId is stamped authoritatively (a client can't spoof it);
//   (3) the sync cursor returns only records newer than `since`, tombstones incl.;
//   (4) reads accept the pre-C3 (v1) envelope alg too (dual-accept);
//   (5) resource-scoped (D1/D2) records survive the bump — scope + ks are stored
//       and a collaborator holding the resource key reads them via the shared lane;
//   (6) cross-household isolation holds.
// Mirrors the authorHiding / calendarKeys / tripKeys / invitations suites.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, request, b64u, fakeEnc, registerUser, enrollKeys, joinHousehold,
} = require('./harness');

const Household = require('../models/Household');
const Record = require('../models/Record');
const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');

before(startDb);
after(stopDb);

async function activate(householdId) {
  await Household.updateOne({ _id: householdId }, { $set: { e2eeActive: true } });
}

// A v2 (opaque) record ciphertext blob — the C3 default. The server never reads
// it; the collection type is (in real crypto) inside the ciphertext.
function opaqueEnc() {
  return { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(120) };
}

async function setupActiveHousehold(firstName) {
  const owner = await registerUser({ firstName });
  await enrollKeys(owner.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  await activate(hh.body._id);
  return { owner, householdId: hh.body._id };
}

test('C3: an opaque record write stores only routing + ciphertext — no plaintext type', async () => {
  const { owner, householdId } = await setupActiveHousehold('Ada');
  const created = await request().post('/api/records')
    .set('Authorization', owner.auth)
    .send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.equal(created.status, 201);

  const row = await Record.findById(created.body._id).lean();
  assert.ok(row.enc?.ct, 'the ciphertext is stored');
  assert.equal(row.enc.alg, 'xchacha20poly1305-ietf-v2');
  assert.equal(String(row.householdId), String(householdId), 'attributed to the household');
  // There is no plaintext collection/type/content field on the unified row at all.
  const keys = Object.keys(row).sort();
  assert.deepEqual(
    keys.filter((k) => !['_id', 'householdId', 'userId', 'keyVersion', 'enc', 'scope', 'deleted', 'createdAt', 'updatedAt', '__v'].includes(k)),
    [],
    'no field beyond opaque routing metadata',
  );
});

test('C3: householdId is stamped authoritatively — a client cannot spoof it', async () => {
  const { owner, householdId } = await setupActiveHousehold('Ben');
  const bogus = '66aabbccddeeff0011223344';
  const created = await request().post('/api/records')
    .set('Authorization', owner.auth)
    .send({ enc: opaqueEnc(), keyVersion: 1, householdId: bogus });
  assert.equal(created.status, 201);
  const row = await Record.findById(created.body._id).lean();
  assert.equal(String(row.householdId), String(householdId));
  assert.notEqual(String(row.householdId), bogus);
});

test('C3: an opaque create requires ciphertext (opaque-only store)', async () => {
  const { owner } = await setupActiveHousehold('Cara');
  const res = await request().post('/api/records')
    .set('Authorization', owner.auth).send({ keyVersion: 1 });
  assert.equal(res.status, 400, 'a record with no enc is rejected');
});

test('C3: the sync cursor returns records newer than `since`, and delete tombstones propagate', async () => {
  const { owner } = await setupActiveHousehold('Dan');
  const a = await request().post('/api/records').set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  // Full pull sees the record.
  const full = await request().get('/api/records/sync').set('Authorization', owner.auth);
  assert.equal(full.status, 200);
  assert.ok(full.body.records.find((r) => String(r._id) === String(a.body._id)));
  const cursor = full.body.serverTime;

  // Nothing new since the cursor.
  await new Promise((r) => setTimeout(r, 5));
  const empty = await request().get('/api/records/sync').query({ since: cursor }).set('Authorization', owner.auth);
  assert.equal(empty.body.records.find((r) => String(r._id) === String(a.body._id)), undefined, 'no records after the cursor');

  // A delete tombstones the row and surfaces on the next incremental pull.
  const del = await request().delete(`/api/records/${a.body._id}`).set('Authorization', owner.auth);
  assert.equal(del.status, 200);
  const afterDelete = await request().get('/api/records/sync').query({ since: cursor }).set('Authorization', owner.auth);
  const tomb = afterDelete.body.records.find((r) => String(r._id) === String(a.body._id));
  assert.ok(tomb, 'the tombstone appears in the incremental pull');
  assert.equal(tomb.deleted, true);
});

test('C3b: deleting a record reaps its orphaned EventAttachments (rows + files)', async () => {
  const EventAttachment = require('../models/EventAttachment');
  const { owner } = await setupActiveHousehold('Della');
  // An "event" record in the opaque store…
  const ev = await request().post('/api/records').set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.equal(ev.status, 201);
  // …with two file attachments referencing it (created directly; the upload route
  // gates on the record's existence, which the reaper test doesn't need to cover).
  await EventAttachment.create({ userId: owner.user._id, eventId: ev.body._id, title: 'a', storageKey: 'nope-a.bin' });
  await EventAttachment.create({ userId: owner.user._id, eventId: ev.body._id, title: 'b', storageKey: 'nope-b.bin' });
  assert.equal(await EventAttachment.countDocuments({ eventId: ev.body._id }), 2);

  // The /records tombstone replaces the retired per-event delete cascade.
  const del = await request().delete(`/api/records/${ev.body._id}`).set('Authorization', owner.auth);
  assert.equal(del.status, 200);
  assert.equal(await EventAttachment.countDocuments({ eventId: ev.body._id }), 0, 'attachments reaped on delete');

  // A non-event record with no attachments deletes cleanly (the reap is a no-op).
  const other = await request().post('/api/records').set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  const delOther = await request().delete(`/api/records/${other.body._id}`).set('Authorization', owner.auth);
  assert.equal(delOther.status, 200);
});

test('C3: reads accept the pre-bump (v1) envelope alg too (dual-accept)', async () => {
  const { owner } = await setupActiveHousehold('Eve');
  // A record written in the old format (v1 alg) — e.g. a straggler not yet re-sealed.
  const v1 = await request().post('/api/records')
    .set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 }); // fakeEnc() = v1 alg
  assert.equal(v1.status, 201, 'the server stores a v1-alg record');
  const sync = await request().get('/api/records/sync').set('Authorization', owner.auth);
  const row = sync.body.records.find((r) => String(r._id) === String(v1.body._id));
  assert.ok(row, 'a v1 record is served by the unified sync');
  assert.equal(row.enc.alg, 'xchacha20poly1305-ietf');
});

test('C3: a resource-scoped (D1/D2) record survives the bump — scope + ks stored, shared lane reads it', async () => {
  const { owner } = await setupActiveHousehold('Fay');
  const resource = 'custom-carpool';
  // An event sealed under a CalendarKey: carries ks + a plaintext scope.
  const created = await request().post('/api/records')
    .set('Authorization', owner.auth)
    .send({
      enc: { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(120), ks: 'cal' },
      keyVersion: 3,
      scope: { kind: 'calendar', resource, version: 3 },
    });
  assert.equal(created.status, 201);
  const row = await Record.findById(created.body._id).lean();
  assert.equal(row.enc.ks, 'cal', 'the key-scope discriminator is preserved');
  assert.deepEqual({ kind: row.scope.kind, resource: row.scope.resource, version: row.scope.version }, { kind: 'calendar', resource, version: 3 });

  // A cross-household collaborator who holds a member key envelope for that
  // resource reads the record via the shared lane, even though it's not their
  // household.
  const collaborator = await registerUser({ firstName: 'Gil' });
  await enrollKeys(collaborator.auth);
  const before = await request().get('/api/records/sync').set('Authorization', collaborator.auth);
  assert.equal(before.body.records.find((r) => String(r._id) === String(row._id)), undefined, 'no access without the resource key');

  await ResourceKeyEnvelope.create({
    resourceType: 'calendar', resourceKey: resource, keyVersion: 3,
    recipient: 'member', userId: collaborator.user._id,
    wrappedKey: b64u(96), wrappedByUserId: owner.user._id,
  });
  const afterGrant = await request().get('/api/records/sync').set('Authorization', collaborator.auth);
  assert.ok(afterGrant.body.records.find((r) => String(r._id) === String(row._id)), 'the resource key grants shared-lane read access');
});

test('C3: cross-household isolation — the unified sync never leaks another household', async () => {
  const { owner } = await setupActiveHousehold('Hana');
  const secret = await request().post('/api/records')
    .set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });

  const outsider = await registerUser({ firstName: 'Ivy' });
  await enrollKeys(outsider.auth);
  const sync = await request().get('/api/records/sync').set('Authorization', outsider.auth);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.records.find((r) => String(r._id) === String(secret.body._id)), undefined, 'no cross-household read');

  // And a direct update attempt is scoped out (404).
  const put = await request().put(`/api/records/${secret.body._id}`)
    .set('Authorization', outsider.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.equal(put.status, 404);
});

// ── Calendar-lane write authorization (free viewer mode hardening) ──────────
// A 'view' collaborator holds a member key envelope (they need it to READ the
// shared calendar), but the calendar lane rejects their writes: POST/PUT/DELETE
// of a record whose `scope` names the calendar require 'full' effective access.
// Also closes the foreign-scope hole: no one can POST records claiming a
// calendar they have no access to.

// Owner + an outside collaborator seated on an owner calendar at `access`,
// holding a member key envelope (as the real accept + owner-wrap flow leaves them).
async function setupSharedCalendar(access) {
  const { owner } = await setupActiveHousehold(`Own${access}`);
  const outsider = await registerUser({ firstName: `Col${access}` });
  await enrollKeys(outsider.auth);

  const key = `custom-lane${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const cal = await request().post('/api/calendars')
    .set('Authorization', owner.auth)
    .send({ key, name: 'Lane', color: '#1976D2', sharedWithOutside: [{ email: outsider.user.email, access }] });
  assert.equal(cal.status, 201);
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', outsider.auth);
  const inv = inbox.body.find((i) => i.calendarKey === key);
  const accept = await request().post(`/api/calendars/invitations/${inv._id}/accept`)
    .set('Authorization', outsider.auth);
  assert.equal(accept.status, 200);
  await ResourceKeyEnvelope.create({
    resourceType: 'calendar', resourceKey: key, keyVersion: 1,
    recipient: 'member', userId: outsider.user._id,
    wrappedKey: b64u(96), wrappedByUserId: owner.user._id,
  });
  return { owner, outsider, key };
}

const calScoped = (resource) => ({
  enc: { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(120), ks: 'cal' },
  keyVersion: 1,
  scope: { kind: 'calendar', resource, version: 1 },
});

test('calendar lane: a view collaborator reads but cannot POST/PUT/DELETE', async () => {
  const { owner, outsider, key } = await setupSharedCalendar('view');

  // The owner's event on the shared calendar…
  const ev = await request().post('/api/records')
    .set('Authorization', owner.auth).send(calScoped(key));
  assert.equal(ev.status, 201);

  // …is readable through the collaborator's resource lane…
  const sync = await request().get('/api/records/sync').set('Authorization', outsider.auth);
  assert.ok(sync.body.records.find((r) => String(r._id) === String(ev.body._id)), 'view collaborator reads the lane');

  // …but every write is rejected (they hold the envelope; access is view).
  const post = await request().post('/api/records')
    .set('Authorization', outsider.auth).send(calScoped(key));
  assert.equal(post.status, 403, 'view collaborator cannot create');

  const put = await request().put(`/api/records/${ev.body._id}`)
    .set('Authorization', outsider.auth).send(calScoped(key));
  assert.equal(put.status, 403, 'view collaborator cannot replace');

  // Dropping the scope from the body must not shed the calendar lane — the
  // STORED scope still gates the write.
  const putNoScope = await request().put(`/api/records/${ev.body._id}`)
    .set('Authorization', outsider.auth)
    .send({ enc: { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(120), ks: 'cal' }, keyVersion: 1 });
  assert.equal(putNoScope.status, 403, 'stored scope still gates a scope-less body');

  const del = await request().delete(`/api/records/${ev.body._id}`).set('Authorization', outsider.auth);
  assert.equal(del.status, 403, 'view collaborator cannot tombstone');

  // The owner is unaffected (e.g. the re-seal pass).
  const ownerPut = await request().put(`/api/records/${ev.body._id}`)
    .set('Authorization', owner.auth).send(calScoped(key));
  assert.equal(ownerPut.status, 200);
});

test('calendar lane: a full-access collaborator writes; view→full upgrades take effect', async () => {
  const { outsider, key } = await setupSharedCalendar('full');

  const post = await request().post('/api/records')
    .set('Authorization', outsider.auth).send(calScoped(key));
  assert.equal(post.status, 201, 'full collaborator creates');

  const put = await request().put(`/api/records/${post.body._id}`)
    .set('Authorization', outsider.auth).send(calScoped(key));
  assert.equal(put.status, 200, 'full collaborator replaces');

  const del = await request().delete(`/api/records/${post.body._id}`).set('Authorization', outsider.auth);
  assert.equal(del.status, 200, 'full collaborator tombstones');
});

test('calendar lane: a non-collaborator cannot POST records claiming a foreign calendar scope', async () => {
  const { key } = await setupSharedCalendar('view');
  const rando = await registerUser({ firstName: 'Rand' });
  await enrollKeys(rando.auth);

  const post = await request().post('/api/records')
    .set('Authorization', rando.auth).send(calScoped(key));
  assert.equal(post.status, 403, 'no seat on the calendar → no writes into its lane');
});

// A household member (joined via the real flow) reads a co-member's opaque record
// through the household lane, though it carries no plaintext author.
test('C3: a household co-member reads an opaque record via the household lane', async () => {
  const { owner, householdId } = await setupActiveHousehold('Jo');
  const member = await registerUser({ firstName: 'Kim' });
  await enrollKeys(member.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  const rec = await request().post('/api/records')
    .set('Authorization', member.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  const row = await Record.findById(rec.body._id).lean();
  assert.equal(String(row.householdId), String(householdId));

  for (const who of [owner, member]) {
    const sync = await request().get('/api/records/sync').set('Authorization', who.auth);
    assert.ok(sync.body.records.find((r) => String(r._id) === String(row._id)), 'both members see it');
  }
});
