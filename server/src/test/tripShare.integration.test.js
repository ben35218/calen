// Integration tests for trip sharing under Signal-parity D2 (per-resource
// TripKeys replace the §9.3 decrypt-on-share plaintext lane). Sharing a sealed
// trip is now allowed with NO `409 decrypt_required` — the trip stays sealed and
// migrates onto a TripKey on the owner's next unlock; the client passes a
// plaintext { tripName } snapshot only for the invitation display row. A shared
// trip's records seal under the TripKey (enc.ks === 'trip'), which strips the
// plaintext content columns unconditionally. Accepting the invitation makes the
// recipient a collaborator. Real app + in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, request, b64u, fakeEnc, registerUser, enrollKeys,
} = require('./harness');

const Household = require('../models/Household');
const Trip = require('../models/Trip');
const TripItem = require('../models/TripItem');

before(startDb);
after(stopDb);

// An owner whose household is post-drop (e2eeActive), holding one sealed trip
// with one sealed booking — plaintext content nulled, exactly as the drop leaves
// them (updateOne bypasses required-field validation, like updateMany at the drop).
async function setupSealedTrip() {
  const owner = await registerUser({ firstName: 'Vera' });
  await enrollKeys(owner.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  await Household.updateOne({ ownerId: owner.user._id }, { $set: { e2eeActive: true } });

  const trip = await Trip.create({
    userId: owner.user._id, name: 'tmp', destination: 'tmp', notes: 'tmp',
    start: new Date('2026-08-01'), end: new Date('2026-08-08'),
    enc: fakeEnc(), keyVersion: 1,
  });
  await Trip.updateOne({ _id: trip._id }, { $unset: { name: '', destination: '', notes: '' } });

  const item = await TripItem.create({
    userId: owner.user._id, householdId: owner.user.householdId, tripId: trip._id,
    type: 'hotel', title: 'tmp', start: new Date('2026-08-01'),
    enc: fakeEnc(), keyVersion: 1,
  });
  await TripItem.updateOne({ _id: item._id }, { $unset: { title: '', notes: '', location: '' } });

  return { owner, tripId: trip._id, itemId: item._id };
}

test('sharing a sealed trip is allowed with NO 409 — the trip stays sealed (D2)', async () => {
  const { owner, tripId } = await setupSealedTrip();
  const res = await request().put(`/api/trips/${tripId}/share`)
    .set('Authorization', owner.auth)
    .send({ recipients: [{ email: 'gil@example.com' }], tripName: 'Ski Week', destination: 'Whistler' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sharedWithOutside.map((e) => e.email), ['gil@example.com']);

  // The trip is NOT flipped to plaintext — its content stays sealed (enc intact,
  // name still nulled), to be re-sealed under a TripKey by the owner's reconcile.
  const trip = await Trip.findById(tripId).lean();
  assert.equal(trip.name, undefined, 'trip name is not reintroduced as plaintext');
  assert.ok(trip.enc && trip.enc.ct, 'trip keeps its ciphertext');
});

test('the invitation display row uses the client-passed tripName snapshot (sealed name)', async () => {
  const { owner, tripId } = await setupSealedTrip();
  const guest = await registerUser({ firstName: 'Gil' });
  const share = await request().put(`/api/trips/${tripId}/share`)
    .set('Authorization', owner.auth)
    .send({ recipients: [{ email: guest.user.email }], tripName: 'Ski Week', destination: 'Whistler' });
  assert.equal(share.status, 200);

  const inbox = await request().get('/api/trips/invitations').set('Authorization', guest.auth);
  const invite = inbox.body.find((i) => i.status === 'pending');
  assert.ok(invite, 'guest sees a pending invitation');
  assert.equal(invite.tripName, 'Ski Week', 'snapshot name (not the sealed Trip.name) is shown');
  assert.equal(invite.destination, 'Whistler');
});

test('TripKey-sealed records strip plaintext unconditionally (enc.ks === trip)', async () => {
  // A NON-e2eeActive owner: a trip-scoped seal must still strip the plaintext
  // content columns (the whole point of D2 — no plaintext feed for collaborators),
  // exactly like D1's cal-scoped events.
  const owner = await registerUser({ firstName: 'Wes' });
  const trip = await Trip.create({
    userId: owner.user._id, name: 'placeholder', destination: 'placeholder',
    sharedWithOutside: [{ email: 'pat@example.com' }], tripKeyVersion: 1,
  });

  // Create a booking sealed under the TripKey — title/location/notes are stripped
  // even though the household is not e2eeActive.
  const created = await request().post(`/api/trips/${trip._id}/items`)
    .set('Authorization', owner.auth)
    .send({ type: 'hotel', title: 'Hotel Alpina', location: 'Village', notes: 'late checkout', start: '2026-08-01', keyVersion: 1, enc: { ...fakeEnc(), ks: 'trip' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, undefined, 'title stripped');
  assert.equal(created.body.location, undefined, 'location stripped');
  assert.equal(created.body.enc.ks, 'trip');
  assert.equal(created.body.keyVersion, 1);

  // Editing the Trip itself under the TripKey never PERSISTS the incoming
  // plaintext name/destination — the write rule strips them from the update, so
  // the client-sent plaintext never lands (any lingering value is the drop's job
  // to null, not this write's).
  const put = await request().put(`/api/trips/${trip._id}`)
    .set('Authorization', owner.auth)
    .send({ name: 'Ski Week 2026', destination: 'Whistler', keyVersion: 1, enc: { ...fakeEnc(), ks: 'trip' } });
  assert.equal(put.status, 200);
  assert.notEqual(put.body.name, 'Ski Week 2026', 'the incoming plaintext name is not persisted');
  assert.notEqual(put.body.destination, 'Whistler', 'the incoming plaintext destination is not persisted');
  assert.equal(put.body.enc.ks, 'trip');
});

test('a private trip in a non-E2EE household shares directly (no decrypt step)', async () => {
  const owner = await registerUser({ firstName: 'Paulo' });
  const trip = await Trip.create({
    userId: owner.user._id, name: 'Lake weekend', destination: 'Muskoka',
    start: new Date('2026-09-01'), end: new Date('2026-09-03'),
  });
  const res = await request().put(`/api/trips/${trip._id}/share`)
    .set('Authorization', owner.auth).send({ emails: ['friend@example.com'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sharedWithOutside.map((e) => e.email), ['friend@example.com']);
});

test('invite → accept makes a collaborator; the shared trip shows in their trip list', async () => {
  const owner = await registerUser({ firstName: 'Hana' });
  const guest = await registerUser({ firstName: 'Gil' });
  const trip = await Trip.create({
    userId: owner.user._id, name: 'Japan', destination: 'Tokyo',
    startDate: new Date('2027-01-31'), endDate: new Date('2027-02-25'),
  });

  // Owner shares to the guest's email → a pending invitation lands in the guest's inbox.
  const share = await request().put(`/api/trips/${trip._id}/share`)
    .set('Authorization', owner.auth).send({ emails: [guest.user.email] });
  assert.equal(share.status, 200);

  const inbox = await request().get('/api/trips/invitations').set('Authorization', guest.auth);
  const invite = inbox.body.find((i) => i.status === 'pending');
  assert.ok(invite, 'guest sees a pending trip invitation');

  const accept = await request().post(`/api/trips/invitations/${invite._id}/accept`)
    .set('Authorization', guest.auth).send({});
  assert.equal(accept.status, 200);
  assert.equal(String(accept.body.tripId), String(trip._id));

  // The calendar aggregate is assembled client-side now (C3b); a collaborator's
  // access to the shared trip is served by the trip list (the client overlays it
  // on the calendar via lib/calendarData.loadTrips).
  const list = await request().get('/api/trips').set('Authorization', guest.auth);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map(t => t.name), ['Japan']);

  // A stranger sees no shared trips.
  const other = await registerUser({ firstName: 'Uma' });
  const none = await request().get('/api/trips').set('Authorization', other.auth);
  assert.deepEqual(none.body, []);
});

test('share by phone resolves to the account with that number; they can accept', async () => {
  const owner = await registerUser({ firstName: 'Nadia' });
  const guest = await registerUser({ firstName: 'Omar' });
  // The guest saves a phone number on their account (loosely normalized server-side).
  const save = await request().put('/api/settings')
    .set('Authorization', guest.auth).send({ phone: '(416) 555-0199' });
  assert.equal(save.status, 200);

  const trip = await Trip.create({
    userId: owner.user._id, name: 'Road trip', destination: 'PEI',
    startDate: new Date('2027-05-01'), endDate: new Date('2027-05-05'),
  });

  // Owner shares by the guest's phone — a slightly different format resolves to
  // the same normalized number and to the guest's account.
  const share = await request().put(`/api/trips/${trip._id}/share`)
    .set('Authorization', owner.auth).send({ recipients: [{ phone: '416-555-0199' }] });
  assert.equal(share.status, 200);
  assert.deepEqual(share.body.sharedWithOutside.map((e) => e.phone), ['4165550199']);

  const inbox = await request().get('/api/trips/invitations').set('Authorization', guest.auth);
  const invite = inbox.body.find((i) => i.status === 'pending');
  assert.ok(invite, 'guest sees the phone-addressed invitation resolved to their account');

  const accept = await request().post(`/api/trips/invitations/${invite._id}/accept`)
    .set('Authorization', guest.auth).send({});
  assert.equal(accept.status, 200);
  assert.equal(String(accept.body.tripId), String(trip._id));
});
