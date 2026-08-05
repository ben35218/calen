// Integration tests for event (calendar) attachments — the sibling of the trip
// attachments suite, covering the upload → list → download → delete round-trip
// on an opaque event Record. Both lanes: plaintext and the E2EE ciphertext path
// (opaque bytes + a wrapped per-file key + a client-minted _id). The server is
// blind to which key wrapped Kf; it stores only the opaque wrappedFileKey and
// serves the ciphertext back as an octet-stream. Also pins the scope gate: you
// can only attach to an event that exists in your own household scope.
//
// Routes live at /api/calendar (see app.js): events/:id/attachments[/upload],
// attachments/:id/download, attachments/:id (DELETE).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, request, b64u, registerUser, enrollKeys,
} = require('./harness');

const Household = require('../models/Household');

before(startDb);
after(stopDb);

async function activate(householdId) {
  await Household.updateOne({ _id: householdId }, { $set: { e2eeActive: true } });
}

// A v2 (opaque) record ciphertext blob — the C3 default for an event Record.
function opaqueEnc() {
  return { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(120) };
}

// An owner in an e2ee-active household + one event Record to hang files on.
async function setupEvent(firstName = 'Test') {
  const owner = await registerUser({ firstName });
  await enrollKeys(owner.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  await activate(hh.body._id);
  const ev = await request().post('/api/records')
    .set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.equal(ev.status, 201);
  return { owner, eventId: ev.body._id };
}

const CIPHERTEXT = Buffer.from('opaque-encrypted-event-bytes-here');
const PLAINTEXT = Buffer.from('%PDF-1.4 fake pdf bytes');

test('E2EE upload stores the crypto metadata and download serves opaque ciphertext', async () => {
  const { owner, eventId } = await setupEvent('Ada');
  const attId = '66aabbccddeeff0011223361';
  const res = await request()
    .post(`/api/calendar/events/${eventId}/attachments/upload`)
    .set('Authorization', owner.auth)
    .field('encrypted', 'true')
    .field('_id', attId)
    .field('wrappedFileKey', JSON.stringify({ alg: 'xchacha20poly1305-ietf', nonce: b64u(32), ct: b64u(80) }))
    .field('keyVersion', '1')
    .field('fileType', 'application/pdf')
    .field('title', 'confirmation.pdf')
    .attach('file', CIPHERTEXT, { filename: `${attId}.bin`, contentType: 'application/octet-stream' });
  assert.equal(res.status, 201);
  assert.equal(res.body._id, attId, 'honours the client-minted _id');
  assert.equal(res.body.eventId, String(eventId));
  assert.equal(res.body.encrypted, true);
  assert.ok(res.body.wrappedFileKey);
  assert.equal(res.body.keyVersion, 1);
  assert.equal(res.body.fileType, 'application/pdf', 'plaintext mimetype preserved for post-decrypt');
  assert.equal(res.body.title, 'confirmation.pdf');

  // It shows up in the event's attachment list.
  const list = await request()
    .get(`/api/calendar/events/${eventId}/attachments`)
    .set('Authorization', owner.auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0]._id, attId);

  // Download serves the ciphertext as an opaque stream, not the plaintext type.
  const dl = await request()
    .get(`/api/calendar/attachments/${attId}/download`)
    .set('Authorization', owner.auth);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /application\/octet-stream/);
});

test('plaintext upload round-trips with its real content-type and filename', async () => {
  const { owner, eventId } = await setupEvent('Ben');
  const res = await request()
    .post(`/api/calendar/events/${eventId}/attachments/upload`)
    .set('Authorization', owner.auth)
    .field('title', 'menu.pdf')
    .attach('file', PLAINTEXT, { filename: 'menu.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 201);
  assert.equal(res.body.encrypted, false);
  assert.equal(res.body.wrappedFileKey, undefined);
  assert.equal(res.body.fileType, 'application/pdf');
  assert.ok(res.body.fileSizeBytes > 0);

  const dl = await request()
    .get(`/api/calendar/attachments/${res.body._id}/download`)
    .set('Authorization', owner.auth);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /application\/pdf/);
  assert.match(dl.headers['content-disposition'], /menu\.pdf/);
});

test('deleting an attachment removes the row and its file (download then 404s)', async () => {
  const { owner, eventId } = await setupEvent('Cass');
  const up = await request()
    .post(`/api/calendar/events/${eventId}/attachments/upload`)
    .set('Authorization', owner.auth)
    .attach('file', PLAINTEXT, { filename: 'receipt.pdf', contentType: 'application/pdf' });
  assert.equal(up.status, 201);

  const del = await request()
    .delete(`/api/calendar/attachments/${up.body._id}`)
    .set('Authorization', owner.auth);
  assert.equal(del.status, 200);

  const dl = await request()
    .get(`/api/calendar/attachments/${up.body._id}/download`)
    .set('Authorization', owner.auth);
  assert.equal(dl.status, 404, 'row is gone after delete');
});

test('scope gate: cannot attach to an event outside your household', async () => {
  const { eventId } = await setupEvent('Della');
  // A stranger in a different household holds no scope over Della's event.
  const stranger = await registerUser({ firstName: 'Eve' });
  const res = await request()
    .post(`/api/calendar/events/${eventId}/attachments/upload`)
    .set('Authorization', stranger.auth)
    .attach('file', PLAINTEXT, { filename: 'sneaky.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 404, 'the event is invisible to the stranger, so upload 404s');

  // A wholly unknown event id 404s the same way.
  const ghost = await request()
    .post('/api/calendar/events/66aabbccddeeff0011223399/attachments/upload')
    .set('Authorization', stranger.auth)
    .attach('file', PLAINTEXT, { filename: 'ghost.pdf', contentType: 'application/pdf' });
  assert.equal(ghost.status, 404);
});

// An occurrence override or a series fork writes a NEW event record, and
// attachments hang off the event id — so without a copy the fork (which BECOMES
// the ongoing series) silently loses every file. The per-file key is wrapped to
// the household, not the event, so nothing is re-encrypted; only the row and the
// file on disk are duplicated.
test('copy-from duplicates an event\'s attachments onto another event', async () => {
  const { owner, eventId } = await setupEvent('Fern');
  const up = await request()
    .post(`/api/calendar/events/${eventId}/attachments/upload`)
    .set('Authorization', owner.auth)
    .field('encrypted', 'true')
    .field('fileType', 'application/pdf')
    .field('wrappedFileKey', 'wrapped-key-abc')
    .field('keyVersion', '1')
    .attach('file', CIPHERTEXT, { filename: 'blob.bin', contentType: 'application/octet-stream' });
  assert.equal(up.status, 201);

  // The fork: a second event record in the same household.
  const fork = await request().post('/api/records')
    .set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.equal(fork.status, 201);

  const copy = await request()
    .post(`/api/calendar/events/${fork.body._id}/attachments/copy-from/${eventId}`)
    .set('Authorization', owner.auth);
  assert.equal(copy.status, 201);
  assert.equal(copy.body.length, 1);

  const [copied] = copy.body;
  assert.equal(copied.eventId, fork.body._id, 'the copy belongs to the new event');
  assert.notEqual(copied._id, up.body._id, 'it is its own row');
  assert.equal(copied.wrappedFileKey, 'wrapped-key-abc', 'the household-wrapped key carries over unchanged');
  assert.equal(copied.encrypted, true);
  assert.notEqual(copied.storageKey, up.body.storageKey, 'the file is duplicated, not shared');

  // Both are independently downloadable...
  for (const id of [up.body._id, copied._id]) {
    const dl = await request().get(`/api/calendar/attachments/${id}/download`).set('Authorization', owner.auth);
    assert.equal(dl.status, 200);
  }
  // ...and deleting one must not take the other's file with it, which is exactly
  // what sharing a storageKey would have caused.
  const del = await request().delete(`/api/calendar/attachments/${up.body._id}`).set('Authorization', owner.auth);
  assert.equal(del.status, 200);
  const survivor = await request()
    .get(`/api/calendar/attachments/${copied._id}/download`)
    .set('Authorization', owner.auth);
  assert.equal(survivor.status, 200, 'the copy survives the original being deleted');
});

test('copy-from is scope-gated on both events', async () => {
  const { owner, eventId } = await setupEvent('Gus');
  const stranger = await registerUser({ firstName: 'Hal' });

  const target = await request().post('/api/records')
    .set('Authorization', owner.auth).send({ enc: opaqueEnc(), keyVersion: 1 });

  // A stranger can see neither event.
  const outsider = await request()
    .post(`/api/calendar/events/${target.body._id}/attachments/copy-from/${eventId}`)
    .set('Authorization', stranger.auth);
  assert.equal(outsider.status, 404);

  // An unknown SOURCE 404s even when the target is the caller's own.
  const ghost = await request()
    .post(`/api/calendar/events/${target.body._id}/attachments/copy-from/66aabbccddeeff0011223399`)
    .set('Authorization', owner.auth);
  assert.equal(ghost.status, 404);
});
