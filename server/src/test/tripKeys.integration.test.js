// Integration tests for per-resource TripKeys (Signal-parity D2): the mechanism
// that replaces the §9.3 shared-trip decrypt-on-share plaintext lane. A shared
// trip's Trip + TripItems (+ shared_shared attachments) seal under a TripKey
// (envelope carries enc.ks === 'trip'), wrapped to the owning household (via its
// HDK) and to each accepted collaborator (via their identity key) as opaque
// ResourceKeyEnvelope rows (resourceType 'trip', resourceKey = the Trip _id). The
// server is content-blind — these tests drive the envelope lifecycle with stand-in
// blobs, exactly like the HDK-envelope + calendarKeys suites. Real app + Mongo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, b64u } = require('./harness');

before(startDb);
after(stopDb);

// An owner (enrolled + HDK minted) plus an enrolled outsider in a different
// household — the D2 cross-household case.
async function setup() {
  const owner = await registerUser({ firstName: 'Tara' });
  await enrollKeys(owner.auth);
  const mint = await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(mint.status, 201);
  const outsider = await registerUser({ firstName: 'Yves' });
  await enrollKeys(outsider.auth);
  return { owner, outsider };
}

// Create a trip and share it with an outside email (seats a pending invitation).
async function createShared(auth, outsiderEmail) {
  const trip = await request().post('/api/trips').set('Authorization', auth)
    .send({ name: 'Alps', destination: 'Chamonix' });
  assert.equal(trip.status, 201);
  const share = await request().put(`/api/trips/${trip.body._id}/share`).set('Authorization', auth)
    .send({ recipients: [{ email: outsiderEmail }], tripName: 'Alps', destination: 'Chamonix' });
  assert.equal(share.status, 200);
  return trip.body._id;
}

// Accept the trip invitation as the outsider (seats them as a collaborator).
async function acceptInvite(outsider, tripId) {
  const inbox = await request().get('/api/trips/invitations').set('Authorization', outsider.auth);
  const inv = inbox.body.find((i) => String(i.tripId) === String(tripId));
  assert.ok(inv, 'expected a trip invitation');
  const accept = await request().post(`/api/trips/invitations/${inv._id}/accept`).set('Authorization', outsider.auth);
  assert.equal(accept.status, 200);
}

test('mint: owner provisions a TripKey v1 (household wrap); versioning is compare-and-set', async () => {
  const { owner, outsider } = await setup();
  const tripId = await createShared(owner.auth, outsider.user.email);

  // A version that isn't current+1 is refused.
  const wrong = await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 2, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  assert.equal(wrong.status, 409);

  // A household wrap is required.
  const noWrap = await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: {} });
  assert.equal(noWrap.status, 400);

  const mint = await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  assert.equal(mint.status, 201);

  // A second mint from v0 now loses the compare-and-set (already at v1).
  const dup = await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  assert.equal(dup.status, 409);

  const keys = await request().get(`/api/trips/${tripId}/keys`).set('Authorization', owner.auth);
  assert.equal(keys.body.currentKeyVersion, 1);
  assert.equal(keys.body.household.length, 1);
  assert.equal(keys.body.household[0].hdkVersion, 1);
});

test('only the owning household manages the TripKey', async () => {
  const { owner, outsider } = await setup();
  const tripId = await createShared(owner.auth, outsider.user.email);
  const notOwner = await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', outsider.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  assert.equal(notOwner.status, 404); // outsider isn't in the owning household (not yet even a collaborator)
});

test('wrap-on-approve: an accepted collaborator appears in keys/pending, then gets a member wrap', async () => {
  const { owner, outsider } = await setup();
  const tripId = await createShared(owner.auth, outsider.user.email);
  await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });

  // Before accepting, the trip is shared (needs a key) but no collaborator is
  // missing a wrap yet — so it's not on the pending list.
  let pending = await request().get('/api/trips/keys/pending').set('Authorization', owner.auth);
  assert.ok(!pending.body.some((p) => String(p.tripId) === String(tripId)));

  await acceptInvite(outsider, tripId);

  pending = await request().get('/api/trips/keys/pending').set('Authorization', owner.auth);
  const entry = pending.body.find((p) => String(p.tripId) === String(tripId));
  assert.ok(entry);
  assert.equal(entry.currentKeyVersion, 1);
  assert.equal(entry.needsMint, false);
  const missing = entry.missingMembers.find((m) => String(m.userId) === String(outsider.user._id));
  assert.ok(missing);
  assert.ok(missing.identityPublicKey);

  const wrap = await request().post(`/api/trips/${tripId}/keys/members`)
    .set('Authorization', owner.auth)
    .send({ keyVersion: 1, members: [{ userId: outsider.user._id, wrappedKey: b64u(120) }] });
  assert.equal(wrap.status, 200);
  assert.equal(wrap.body.wrapped, 1);

  // The collaborator can now fetch their own member envelope.
  const keys = await request().get(`/api/trips/${tripId}/keys`).set('Authorization', outsider.auth);
  assert.equal(keys.status, 200);
  assert.equal(keys.body.member.length, 1);
  assert.equal(keys.body.member[0].keyVersion, 1);
  assert.equal(keys.body.household.length, 0); // not in the owning household

  // Once wrapped, the collaborator drops off the pending list.
  const after = await request().get('/api/trips/keys/pending').set('Authorization', owner.auth);
  assert.ok(!after.body.some((p) => String(p.tripId) === String(tripId)));
});

test('an owner cannot hand the key to a non-collaborator (member wrap is seated only for collaborators)', async () => {
  const { owner, outsider } = await setup();
  const stranger = await registerUser({ firstName: 'Stranger' });
  await enrollKeys(stranger.auth);
  const tripId = await createShared(owner.auth, outsider.user.email);
  await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });

  const wrap = await request().post(`/api/trips/${tripId}/keys/members`)
    .set('Authorization', owner.auth)
    .send({ keyVersion: 1, members: [{ userId: stranger.user._id, wrappedKey: b64u(120) }] });
  assert.equal(wrap.status, 200);
  assert.equal(wrap.body.wrapped, 0); // not a collaborator → not seated

  const keys = await request().get(`/api/trips/${tripId}/keys`).set('Authorization', stranger.auth);
  assert.equal(keys.status, 404); // stranger has no access to the trip at all
});

test('revoke: removing the outsider flags a rotation; the owner rotates to a new TripKey version', async () => {
  const { owner, outsider } = await setup();
  const tripId = await createShared(owner.auth, outsider.user.email);
  await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  await acceptInvite(outsider, tripId);
  await request().post(`/api/trips/${tripId}/keys/members`)
    .set('Authorization', owner.auth)
    .send({ keyVersion: 1, members: [{ userId: outsider.user._id, wrappedKey: b64u(120) }] });

  // Owner un-shares → the trip is flagged for a TripKey rotation.
  const unshare = await request().delete(`/api/trips/${tripId}/share`).set('Authorization', owner.auth);
  assert.equal(unshare.status, 200);

  const pending = await request().get('/api/trips/keys/pending').set('Authorization', owner.auth);
  const entry = pending.body.find((p) => String(p.tripId) === String(tripId));
  assert.ok(entry, 'un-shared trip should surface for rotation');
  assert.equal(entry.rotationPending, true);

  const rotate = await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 2, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  assert.equal(rotate.status, 201);

  const keys = await request().get(`/api/trips/${tripId}/keys`).set('Authorization', owner.auth);
  assert.equal(keys.body.currentKeyVersion, 2);

  // The removed outsider lost trip access entirely (revoked collaborator).
  const outKeys = await request().get(`/api/trips/${tripId}/keys`).set('Authorization', outsider.auth);
  assert.equal(outKeys.status, 404);

  // Rotation flag cleared.
  const after = await request().get('/api/trips/keys/pending').set('Authorization', owner.auth);
  assert.ok(!after.body.some((p) => String(p.tripId) === String(tripId)));
});

test('deleting the trip removes its TripKey envelopes', async () => {
  const { owner, outsider } = await setup();
  const tripId = await createShared(owner.auth, outsider.user.email);
  await request().post(`/api/trips/${tripId}/keys`)
    .set('Authorization', owner.auth).send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });

  const del = await request().delete(`/api/trips/${tripId}`).set('Authorization', owner.auth);
  assert.equal(del.status, 200);

  const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');
  const remaining = await ResourceKeyEnvelope.countDocuments({ resourceType: 'trip', resourceKey: String(tripId) });
  assert.equal(remaining, 0);
});
