// Integration tests for cross-household event invitations (routes/invitations.js):
// invite by email (registered vs. unknown address), the recipient's New/Replied
// lifecycle (accept copies the event onto their calendar; decline doesn't), the
// late-registration claim of email-only invites, the .ics download, and the
// guard rails (self, same household, out-of-scope event, bad email).
// Real app + in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, b64u, fakeEnc } = require('./harness');
const mongoose = require('mongoose');

// Signal-parity C3b: events live in the unified opaque `Record` store.
const Record = require('../models/Record');
const EventInvitation = require('../models/EventInvitation');

before(startDb);
after(stopDb);

// A sender with one event in the opaque store (stand-in ciphertext); returns the
// invite payload the mobile client posts (its decrypted plaintext snapshot
// alongside the eventId — the server can't read the sealed source).
async function setupSenderWithEvent() {
  const sender = await registerUser({ firstName: 'Ada', lastName: 'Sender' });
  const res = await request().post('/api/records')
    .set('Authorization', sender.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(res.status, 201);
  const snapshot = {
    title: 'Lake day', location: 'Sandbanks', description: 'Bring sunscreen',
    startDate: '2026-08-15T12:00:00.000Z', allDay: true, calendarType: 'activities',
  };
  return { sender, eventId: res.body._id, snapshot };
}

// C3b: the recipient seals its OWN independent copy of the event (invitationId
// folded inside the ciphertext) and accept stores it as an opaque Record. Send a
// client-minted _id + stand-in ciphertext.
function acceptSealed(invId, auth, body = {}) {
  return request().post(`/api/invitations/${invId}/accept`)
    .set('Authorization', auth)
    .send({ _id: new mongoose.Types.ObjectId().toString(), enc: fakeEnc(), keyVersion: 1, ...body });
}

test('invite a registered user → pending invitation, resolved recipient, no duplicates on resend', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser({ firstName: 'Ben', lastName: 'Recipient' });

  const res = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email.toUpperCase(), event: snapshot });
  assert.equal(res.status, 201);
  assert.equal(res.body.userExists, true);
  assert.equal(res.body.invitation.status, 'pending');
  assert.equal(res.body.invitation.toEmail, recipient.user.email);
  assert.equal(String(res.body.invitation.toUserId), String(recipient.user._id));
  assert.equal(res.body.invitation.event.title, 'Lake day');

  // Resending to the same address refreshes the pending invite, not a new row.
  const again = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot });
  assert.equal(again.status, 201);
  const list = await request().get('/api/invitations').set('Authorization', recipient.auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});

test('accept copies the event onto the recipient calendar and moves the invite to Replied', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  const sent = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot });
  const invId = sent.body.invitation._id;

  const res = await acceptSealed(invId, recipient.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.invitation.status, 'accepted');

  // The copy is an opaque Record the recipient owns (content sealed inside enc).
  const copy = await Record.findById(res.body.event._id).lean();
  assert.equal(String(copy.userId), String(recipient.user._id));
  assert.ok(copy.enc?.ct);

  // The copy is independent — the sender's original is untouched.
  const original = await Record.findById(eventId).lean();
  assert.equal(String(original.userId), String(sender.user._id));
  assert.notEqual(String(original._id), String(res.body.event._id));

  // Replying twice is rejected, and the invite now lives in Replied.
  const twice = await request().post(`/api/invitations/${invId}/decline`).set('Authorization', recipient.auth);
  assert.equal(twice.status, 400);
  const list = await request().get('/api/invitations').set('Authorization', recipient.auth);
  assert.equal(list.body[0].status, 'accepted');
});

test('decline records the reply without creating an event', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  const sent = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot });

  const res = await request().post(`/api/invitations/${sent.body.invitation._id}/decline`)
    .set('Authorization', recipient.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.invitation.status, 'declined');
  // Decline creates no copy — the recipient owns no Record.
  const copies = await Record.find({ userId: recipient.user._id }).lean();
  assert.equal(copies.length, 0);
});

test('email-only invite (no account) is claimed when that user registers later', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const email = 'future-user@example.com';

  const sent = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email, event: snapshot });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.userExists, false);
  assert.equal(sent.body.invitation.toUserId ?? null, null);

  const lateUser = await registerUser({ email });
  const list = await request().get('/api/invitations').set('Authorization', lateUser.auth);
  assert.equal(list.body.length, 1);
  assert.equal(String(list.body[0].toUserId), String(lateUser.user._id));
  assert.equal(list.body[0].status, 'pending');
});

test('.ics download renders the snapshot as an all-day VEVENT', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  const sent = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot });

  const res = await request().get(`/api/invitations/${sent.body.invitation._id}/ics`)
    .set('Authorization', recipient.auth);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/calendar/);
  assert.match(res.text, /SUMMARY:Lake day/);
  assert.match(res.text, /DTSTART;VALUE=DATE:20260815/);
  assert.match(res.text, /LOCATION:Sandbanks/);
});

test('organizer invitee list: visible in event scope only, tracks the accept linkage', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot });
  await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: 'other@example.com', event: snapshot });

  // The organizer sees every invitee for the event…
  let sent = await request().get('/api/invitations/sent').query({ eventId }).set('Authorization', sender.auth);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.length, 2);

  // …the recipient does not (the source event isn't in their scope), and their
  // accepted copy has a different id that maps to no invitations.
  const denied = await request().get('/api/invitations/sent').query({ eventId }).set('Authorization', recipient.auth);
  assert.equal(denied.status, 404);

  const inv = sent.body.find((i) => i.toEmail === recipient.user.email);
  const accepted = await acceptSealed(inv._id, recipient.auth);
  // The invitationId now rides INSIDE the sealed copy; the linkage is tracked on
  // the invitation's acceptedEventId (asserted below), not on the opaque row.
  const viaCopy = await request().get('/api/invitations/sent')
    .query({ eventId: accepted.body.event._id }).set('Authorization', recipient.auth);
  assert.equal(viaCopy.status, 200);
  assert.equal(viaCopy.body.length, 0);

  sent = await request().get('/api/invitations/sent').query({ eventId }).set('Authorization', sender.auth);
  const row = sent.body.find((i) => i.toEmail === recipient.user.email);
  assert.equal(row.status, 'accepted');
  assert.equal(String(row.acceptedEventId), String(accepted.body.event._id));
});

test('leave deletes the recipient copy and retires the invitation to left', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  const inv = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot })).body.invitation;

  // Leaving before accepting is rejected.
  const early = await request().post(`/api/invitations/${inv._id}/leave`).set('Authorization', recipient.auth);
  assert.equal(early.status, 400);

  const accepted = await acceptSealed(inv._id, recipient.auth);
  const copyId = accepted.body.event._id;

  const left = await request().post(`/api/invitations/${inv._id}/leave`).set('Authorization', recipient.auth);
  assert.equal(left.status, 200);
  assert.equal(left.body.invitation.status, 'left');
  // C3b: the copy is tombstoned (deleted flag) so the delete propagates via sync.
  assert.equal((await Record.findById(copyId).lean()).deleted, true);

  // The organizer's list still records the invitee (as left); the original stays.
  const sent = await request().get('/api/invitations/sent').query({ eventId }).set('Authorization', sender.auth);
  assert.equal(sent.body[0].status, 'left');
  assert.notEqual((await Record.findById(eventId).lean()).deleted, true);
});

test('organizer revoke removes the invitation — and the copy if it was accepted', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();

  // Pending revoke: the invite vanishes from the recipient's inbox.
  const pending = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot })).body.invitation;

  // Only the organizer side can revoke.
  const notYours = await request().delete(`/api/invitations/${pending._id}`).set('Authorization', recipient.auth);
  assert.equal(notYours.status, 404);

  const revoked = await request().delete(`/api/invitations/${pending._id}`).set('Authorization', sender.auth);
  assert.equal(revoked.status, 200);
  const inbox = await request().get('/api/invitations').set('Authorization', recipient.auth);
  assert.equal(inbox.body.length, 0);

  // Accepted revoke: the recipient's copy goes too.
  const again = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot })).body.invitation;
  const accepted = await acceptSealed(again._id, recipient.auth);
  await request().delete(`/api/invitations/${again._id}`).set('Authorization', sender.auth);
  // C3b: the recipient's copy is tombstoned by the organizer's revoke.
  assert.equal((await Record.findById(accepted.body.event._id).lean()).deleted, true);
});

test('an invited copy is the recipient-owned opaque record; leave is the sanctioned exit; the original is untouched', async () => {
  // C3b: event content is sealed, so the "invited copies are read-only" rule is
  // now enforced CLIENT-side (the form flips Delete→Leave on the `invitationId`
  // sealed inside the copy) — the server no longer gates edits on a plaintext
  // event. What the server still guarantees: the copy belongs to the recipient,
  // leave tombstones it, and the organizer's original is independent.
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  const inv = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot })).body.invitation;
  const accepted = await acceptSealed(inv._id, recipient.auth);
  const copyId = accepted.body.event._id;

  const copy = await Record.findById(copyId).lean();
  assert.equal(String(copy.userId), String(recipient.user._id));

  // Leave tombstones the copy; the sender's original record is unaffected.
  const left = await request().post(`/api/invitations/${inv._id}/leave`).set('Authorization', recipient.auth);
  assert.equal(left.status, 200);
  assert.equal((await Record.findById(copyId).lean()).deleted, true);
  assert.notEqual((await Record.findById(eventId).lean()).deleted, true);
});

test('phone invite: normalized number, no account resolution, no duplicates on resend', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();

  const res = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, phone: '+1 (415) 555-0134', event: snapshot });
  assert.equal(res.status, 201);
  assert.equal(res.body.userExists, false);
  assert.equal(res.body.invitation.toPhone, '+14155550134');
  assert.equal(res.body.invitation.toEmail ?? null, null);
  assert.equal(res.body.invitation.toUserId ?? null, null);
  assert.equal(res.body.invitation.status, 'pending');
  assert.ok(res.body.invitation.shareToken);

  // Re-inviting the same number (formatted differently) refreshes in place.
  const again = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, phone: '+1 415.555.0134', event: snapshot });
  assert.equal(again.status, 201);
  assert.equal(String(again.body.invitation._id), String(res.body.invitation._id));

  const sent = await request().get('/api/invitations/sent').query({ eventId }).set('Authorization', sender.auth);
  assert.equal(sent.body.length, 1);

  // Too short / empty numbers are rejected.
  const bad = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, phone: '12345', event: snapshot });
  assert.equal(bad.status, 400);
});

test('public .ics link: shareToken grants unauthenticated download, wrong token does not', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const inv = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, phone: '+14155550134', event: snapshot })).body.invitation;

  const res = await request().get(`/api/invitations/public/${inv._id}/ics`).query({ k: inv.shareToken });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/calendar/);
  assert.match(res.text, /SUMMARY:Lake day/);

  const wrong = await request().get(`/api/invitations/public/${inv._id}/ics`)
    .query({ k: 'f'.repeat(inv.shareToken.length) });
  assert.equal(wrong.status, 404);
  const missing = await request().get(`/api/invitations/public/${inv._id}/ics`);
  assert.equal(missing.status, 404);
});

test('guard rails: self-invite, same-household recipient, bad email, out-of-scope event', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();

  const self = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: sender.user.email, event: snapshot });
  assert.equal(self.status, 400);

  const bad = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: 'not-an-email', event: snapshot });
  assert.equal(bad.status, 400);

  // A stranger can't invite off someone else's event (not in their scope).
  const stranger = await registerUser();
  const outOfScope = await request().post('/api/invitations')
    .set('Authorization', stranger.auth)
    .send({ eventId, email: 'anyone@example.com', event: snapshot });
  assert.equal(outOfScope.status, 404);

  // A recipient inside the sender's own household already sees the event.
  const housemate = await registerUser();
  const User = require('../models/User');
  await User.updateOne({ _id: housemate.user._id }, { $set: { householdId: sender.user.householdId } });
  const sameHouse = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: housemate.user.email, event: snapshot });
  assert.equal(sameHouse.status, 400);
  assert.match(sameHouse.body.error, /household/);
});

// ── D3: encrypted snapshot when the recipient is a known account ──────────────

test('D3 lookup: resolves an invited email → keys for an enrolled account, withheld for a housemate, none for a stranger', async () => {
  const sender = await registerUser({ firstName: 'Ada' });
  const recipient = await registerUser({ firstName: 'Ben' });
  await enrollKeys(recipient.auth);

  // A cross-household account with enrolled keys hands back the public key.
  const hit = await request().get('/api/invitations/lookup')
    .query({ email: recipient.user.email.toUpperCase() }).set('Authorization', sender.auth);
  assert.equal(hit.status, 200);
  assert.equal(hit.body.userExists, true);
  assert.ok(hit.body.identityPublicKey);

  // An account with no enrolled keys → exists but nothing to seal to.
  const noKeys = await registerUser();
  const cold = await request().get('/api/invitations/lookup')
    .query({ email: noKeys.user.email }).set('Authorization', sender.auth);
  assert.equal(cold.body.userExists, true);
  assert.equal(cold.body.identityPublicKey, null);

  // A stranger email → no account.
  const miss = await request().get('/api/invitations/lookup')
    .query({ email: 'nobody@example.com' }).set('Authorization', sender.auth);
  assert.deepEqual(miss.body, { userExists: false, identityPublicKey: null });

  // Bad email → 400.
  const bad = await request().get('/api/invitations/lookup')
    .query({ email: 'not-an-email' }).set('Authorization', sender.auth);
  assert.equal(bad.status, 400);

  // A member of the caller's own household never leaks keys through this surface.
  const housemate = await registerUser();
  await enrollKeys(housemate.auth);
  const User = require('../models/User');
  await User.updateOne({ _id: housemate.user._id }, { $set: { householdId: sender.user.householdId } });
  const same = await request().get('/api/invitations/lookup')
    .query({ email: housemate.user.email }).set('Authorization', sender.auth);
  assert.equal(same.body.userExists, true);
  assert.equal(same.body.identityPublicKey, null);
});

test('device-composed outreach: an invite sends NO email (account holders get push + inbox), and lookup resolves a phone (existence only)', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser({ firstName: 'Cam' });

  const res = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot });
  assert.equal(res.status, 201);
  assert.equal(res.body.userExists, true);

  // The server records the invitation but sends no invite email — outreach is
  // device-composed like the other sharing flows (the `event_invitation` mail
  // was retired 2026-07-29; households-sharing.md). Nothing in this whole
  // suite should have enqueued one.
  const EmailLog = require('../models/EmailLog');
  assert.equal(await EmailLog.countDocuments({ kind: 'event_invitation' }), 0);

  // Phone lookup (the trip/calendar flows' pre-outreach check): existence
  // only, never a key — sealed invites are email-to-account.
  const User = require('../models/User');
  await User.updateOne({ _id: recipient.user._id }, { $set: { phone: '+16045550000' } });
  const hit = await request().get('/api/invitations/lookup')
    .query({ phone: '+1 (604) 555-0000' }).set('Authorization', sender.auth);
  assert.equal(hit.status, 200);
  assert.equal(hit.body.userExists, true);
  assert.equal(hit.body.identityPublicKey, null);

  const miss = await request().get('/api/invitations/lookup')
    .query({ phone: '+19998887777' }).set('Authorization', sender.auth);
  assert.equal(miss.body.userExists, false);

  // Neither email nor phone → 400.
  const bad = await request().get('/api/invitations/lookup')
    .query({}).set('Authorization', sender.auth);
  assert.equal(bad.status, 400);
});

test('D3 sealed invite: a known account stores the sealed blob and NO plaintext; the .ics degrades to 404', async () => {
  const { sender, eventId } = await setupSenderWithEvent();
  const recipient = await registerUser();
  await enrollKeys(recipient.auth);
  const sealedEvent = b64u(120); // opaque to the server — the client's sealed box

  const res = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, sealedEvent });
  assert.equal(res.status, 201);
  assert.equal(res.body.userExists, true);
  assert.equal(res.body.invitation.sealedEvent, sealedEvent);
  // No plaintext snapshot reaches the store.
  const row = await EventInvitation.findById(res.body.invitation._id).lean();
  assert.equal(row.sealedEvent, sealedEvent);
  assert.ok(!row.event || !row.event.title);

  // The recipient sees it in their inbox (they decrypt on-device).
  const inbox = await request().get('/api/invitations').set('Authorization', recipient.auth);
  assert.equal(inbox.body.find((i) => String(i._id) === String(row._id)).sealedEvent, sealedEvent);

  // No server-rendered .ics for a sealed invite.
  const ics = await request().get(`/api/invitations/${row._id}/ics`).set('Authorization', recipient.auth);
  assert.equal(ics.status, 404);
});

test('D3 sealed invite: rejected when the address has no keys to seal to', async () => {
  const { sender, eventId } = await setupSenderWithEvent();
  const bad = await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: 'keyless@example.com', sealedEvent: b64u(120) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /keys/);
});

test('D3 accept: a sealed invite takes the recipient-supplied snapshot to build the copy', async () => {
  const { sender, eventId } = await setupSenderWithEvent();
  const recipient = await registerUser();
  await enrollKeys(recipient.auth);
  const inv = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, sealedEvent: b64u(120) })).body.invitation;

  // Accepting without the client-sealed copy (_id + enc) has nothing to store.
  const empty = await request().post(`/api/invitations/${inv._id}/accept`).set('Authorization', recipient.auth);
  assert.equal(empty.status, 400);

  // With the on-device sealed copy, the recipient's opaque Record is created.
  const accepted = await acceptSealed(inv._id, recipient.auth);
  assert.equal(accepted.status, 200);
  const copy = await Record.findById(accepted.body.event._id).lean();
  assert.equal(String(copy.userId), String(recipient.user._id));
  assert.ok(copy.enc?.ct);
});

test('D3 lazily-claimed upgrade: the recipient re-seals a plaintext invite to itself, dropping the plaintext', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const email = 'late-sealer@example.com';
  // Sent before the recipient had an account → stored plaintext (unavoidable).
  const inv = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email, event: snapshot })).body.invitation;
  assert.equal(inv.event.title, 'Lake day');

  const recipient = await registerUser({ email });
  await enrollKeys(recipient.auth);
  // Claim the invite (sets toUserId), then upgrade it to a sealed blob.
  await request().get('/api/invitations').set('Authorization', recipient.auth);
  const sealedEvent = b64u(120);
  const up = await request().post(`/api/invitations/${inv._id}/seal`)
    .set('Authorization', recipient.auth).send({ sealedEvent });
  assert.equal(up.status, 200);

  const row = await EventInvitation.findById(inv._id).lean();
  assert.equal(row.sealedEvent, sealedEvent);
  assert.ok(!row.event || !row.event.title); // plaintext hard-dropped
  // A stranger can't seal someone else's invitation.
  const stranger = await registerUser();
  const denied = await request().post(`/api/invitations/${inv._id}/seal`)
    .set('Authorization', stranger.auth).send({ sealedEvent: b64u(120) });
  assert.equal(denied.status, 404);
});

test('guest list: invitees see who else is invited unless the organizer turns it off', async () => {
  const { sender, eventId, snapshot } = await setupSenderWithEvent();
  const recipient = await registerUser();
  const inv = (await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot })).body.invitation;
  await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: 'other@example.com', event: snapshot });
  await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, phone: '+14155550134', event: snapshot });

  // Default: visible — the recipient sees every sibling invite (email and
  // phone), the organizer's identity, and no capability secrets.
  const res = await request().get(`/api/invitations/${inv._id}/guests`).set('Authorization', recipient.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.visible, true);
  assert.equal(res.body.organizer.email, sender.user.email);
  assert.equal(res.body.guests.length, 3);
  const addresses = res.body.guests.map((g) => g.toEmail ?? g.toPhone).sort();
  assert.deepEqual(addresses, ['+14155550134', 'other@example.com', recipient.user.email].sort());
  assert.ok(res.body.guests.every((g) => g.shareToken === undefined));

  // Only someone the invitation is addressed to can ask.
  const stranger = await registerUser();
  const denied = await request().get(`/api/invitations/${inv._id}/guests`).set('Authorization', stranger.auth);
  assert.equal(denied.status, 404);

  // An invitation predating the flag (field absent) reads as visible.
  await EventInvitation.updateOne({ _id: inv._id }, { $unset: { guestListVisible: '' } });
  const legacy = await request().get(`/api/invitations/${inv._id}/guests`).set('Authorization', recipient.auth);
  assert.equal(legacy.body.visible, true);

  // C3b: guestListVisible is a SEALED event field, so the organizer's device
  // stamps it onto each invitation (here via a resend, which refreshes in place).
  // Off → the list goes dark.
  await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot, guestListVisible: false });
  const hidden = await request().get(`/api/invitations/${inv._id}/guests`).set('Authorization', recipient.auth);
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.body, { visible: false, guests: [] });

  // Back on — and RSVP statuses ride along once the recipient accepts.
  await request().post('/api/invitations')
    .set('Authorization', sender.auth)
    .send({ eventId, email: recipient.user.email, event: snapshot, guestListVisible: true });
  await acceptSealed(inv._id, recipient.auth);
  const after = await request().get(`/api/invitations/${inv._id}/guests`).set('Authorization', recipient.auth);
  assert.equal(after.body.visible, true);
  assert.equal(after.body.guests.find((g) => g.toEmail === recipient.user.email).status, 'accepted');
});
