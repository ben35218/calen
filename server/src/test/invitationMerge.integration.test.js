// Integration tests for invitation merge (routes/invitations.js) — reconciling a
// cross-household event invitation once the two parties join ONE household.
//
// Guards the "we shared an event, then moved in together, and now the calendar
// shows it twice" defect. An EventInvitation encodes a contract between two
// households (organizer keeps the event, recipient owns an independent copy);
// joining dissolves that premise, and nothing used to notice — carry-over hauls
// the recipient's copy into the shared household beside the original, the
// recipient appears on no invitee list, and "leave"/"uninvite" start operating on
// a record the household jointly owns.
//
// Pinned here: the work list is recipient-scoped and only lists invitations whose
// organizer is now a housemate; merging tombstones the duplicate copy and retires
// the row to the terminal `merged` status; merging is idempotent; a merged row
// disappears from both inboxes; an orphaned copy (organizer deleted their event)
// is KEPT rather than tombstoned; and the destructive lanes (accept / leave /
// revoke) refuse for the window before the pass runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u, fakeEnc } = require('./harness');
const mongoose = require('mongoose');

const Record = require('../models/Record');
const EventInvitation = require('../models/EventInvitation');

before(startDb);
after(stopDb);

const SNAPSHOT = {
  title: 'Lake day', location: 'Sandbanks',
  startDate: '2026-08-15T12:00:00.000Z', allDay: true, calendarType: 'activities',
};

async function mintKey(auth) {
  const res = await request().post('/api/household/key').set('Authorization', auth)
    .send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(res.status, 201, `mint failed: ${JSON.stringify(res.body)}`);
}

// An organizer in one household who invited a recipient in another, plus the
// recipient's accepted copy. Households are still separate at this point.
async function setupCrossHouseholdInvite({ accept = true } = {}) {
  const organizer = await registerUser({ firstName: 'Ada', lastName: 'Organizer' });
  const recipient = await registerUser({ firstName: 'Ben', lastName: 'Recipient' });
  await enrollKeys(organizer.auth);
  await enrollKeys(recipient.auth);
  await mintKey(organizer.auth);
  await mintKey(recipient.auth);

  const ev = await request().post('/api/records').set('Authorization', organizer.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(ev.status, 201);
  const eventId = ev.body._id;

  const sent = await request().post('/api/invitations').set('Authorization', organizer.auth)
    .send({ eventId, email: recipient.user.email, event: SNAPSHOT });
  assert.equal(sent.status, 201);
  const invitationId = sent.body.invitation._id;

  let copyId = null;
  if (accept) {
    copyId = new mongoose.Types.ObjectId().toString();
    const res = await request().post(`/api/invitations/${invitationId}/accept`)
      .set('Authorization', recipient.auth)
      .send({ _id: copyId, enc: fakeEnc(), keyVersion: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  return { organizer, recipient, eventId, invitationId, copyId };
}

// ...and then they move in together: the recipient joins the organizer's household.
async function moveInTogether(ctx) {
  await joinHousehold({ joiner: ctx.recipient, approver: ctx.organizer, keyVersion: 1 });
  return ctx;
}

test('reconcile lists only invitations whose organizer is now a housemate', async () => {
  const ctx = await setupCrossHouseholdInvite();

  // Before the join there is nothing to merge — the contract still holds.
  const before = await request().get('/api/invitations/reconcile').set('Authorization', ctx.recipient.auth);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.invitations, []);

  await moveInTogether(ctx);

  const res = await request().get('/api/invitations/reconcile').set('Authorization', ctx.recipient.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.invitations.length, 1);
  const row = res.body.invitations[0];
  assert.equal(row._id, String(ctx.invitationId));
  assert.equal(row.status, 'accepted');
  assert.equal(row.eventId, String(ctx.eventId));
  assert.equal(row.acceptedEventId, String(ctx.copyId));
  assert.equal(row.organizerUserId, String(ctx.organizer.user._id));
  // The organizer's original is alive, so this copy is a genuine duplicate.
  assert.equal(row.sourceExists, true);

  // Recipient-driven: the organizer is handed none of this work.
  const theirs = await request().get('/api/invitations/reconcile').set('Authorization', ctx.organizer.auth);
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.body.invitations, []);
});

test('merging tombstones the duplicate copy, retires the row, and is idempotent', async () => {
  const ctx = await moveInTogether(await setupCrossHouseholdInvite());

  const res = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.recipient.auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.merged, true);
  assert.equal(res.body.tombstoned, true);

  // The duplicate is tombstoned (not hard-deleted) so the delete propagates to
  // the recipient's other devices through the /records sync cursor.
  const copy = await Record.findById(ctx.copyId).lean();
  assert.equal(copy.deleted, true);
  // The organizer's original is untouched — it is the survivor.
  const source = await Record.findById(ctx.eventId).lean();
  assert.notEqual(source.deleted, true);

  const inv = await EventInvitation.findById(ctx.invitationId).lean();
  assert.equal(inv.status, 'merged');
  assert.ok(inv.mergedAt);

  // A retried pass finds it already done and succeeds without acting again.
  const again = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.recipient.auth);
  assert.equal(again.status, 200);
  assert.equal(again.body.merged, false);
  assert.equal(again.body.tombstoned, false);

  // And it drops out of the work list.
  const list = await request().get('/api/invitations/reconcile').set('Authorization', ctx.recipient.auth);
  assert.deepEqual(list.body.invitations, []);
});

test('a merged invitation disappears from the recipient inbox and the organizer guest list', async () => {
  const ctx = await moveInTogether(await setupCrossHouseholdInvite());
  await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.recipient.auth).expect(200);

  // The event is shared by sync now and the answer lives on an EventRsvp, so the
  // invitation must not still offer itself as an invitation.
  const inbox = await request().get('/api/invitations').set('Authorization', ctx.recipient.auth);
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body, []);

  // The organizer's invitee list shows them as a household invitee chip instead.
  const sent = await request().get('/api/invitations/sent')
    .set('Authorization', ctx.organizer.auth).query({ eventId: ctx.eventId });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, []);
});

test('an orphaned copy is kept, not tombstoned, when the organizer deleted their event', async () => {
  const ctx = await moveInTogether(await setupCrossHouseholdInvite());
  // The organizer deletes the original — the recipient's copy is now the only
  // surviving record of the event, so there is no duplicate to resolve.
  await Record.updateOne({ _id: ctx.eventId }, { deleted: true });

  const list = await request().get('/api/invitations/reconcile').set('Authorization', ctx.recipient.auth);
  assert.equal(list.body.invitations[0].sourceExists, false);

  const res = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.recipient.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.merged, true);
  assert.equal(res.body.tombstoned, false);

  const copy = await Record.findById(ctx.copyId).lean();
  assert.notEqual(copy.deleted, true, 'the only surviving copy must not be deleted');
});

test('a pending invitation between new housemates merges without minting a copy', async () => {
  const ctx = await moveInTogether(await setupCrossHouseholdInvite({ accept: false }));

  const list = await request().get('/api/invitations/reconcile').set('Authorization', ctx.recipient.auth);
  assert.equal(list.body.invitations.length, 1);
  assert.equal(list.body.invitations[0].status, 'pending');
  assert.equal(list.body.invitations[0].acceptedEventId, null);

  // Accepting would create a SECOND copy of an event they already sync — refused.
  const accepted = await request().post(`/api/invitations/${ctx.invitationId}/accept`)
    .set('Authorization', ctx.recipient.auth)
    .send({ _id: new mongoose.Types.ObjectId().toString(), enc: fakeEnc(), keyVersion: 1 });
  assert.equal(accepted.status, 409);

  const res = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.recipient.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.tombstoned, false);
  assert.equal((await EventInvitation.findById(ctx.invitationId).lean()).status, 'merged');
});

test('leave and revoke refuse once the parties share a household', async () => {
  const ctx = await moveInTogether(await setupCrossHouseholdInvite());

  // "Leave event" would tombstone a record the whole household now shares.
  const left = await request().post(`/api/invitations/${ctx.invitationId}/leave`)
    .set('Authorization', ctx.recipient.auth);
  assert.equal(left.status, 409);

  // Same for the organizer uninviting a person who is now a housemate.
  const revoked = await request().delete(`/api/invitations/${ctx.invitationId}`)
    .set('Authorization', ctx.organizer.auth);
  assert.equal(revoked.status, 409);

  // Neither touched the records.
  assert.notEqual((await Record.findById(ctx.copyId).lean()).deleted, true);
  assert.notEqual((await Record.findById(ctx.eventId).lean()).deleted, true);
  assert.ok(await EventInvitation.findById(ctx.invitationId).lean());
});

test('merging is refused for a caller who is not the recipient, or who shares no household', async () => {
  const ctx = await setupCrossHouseholdInvite();

  // Still separate households — nothing to merge.
  const early = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.recipient.auth);
  assert.equal(early.status, 409);

  await moveInTogether(ctx);

  // The organizer is not the `toUserId`, so the row isn't theirs to retire.
  const wrongParty = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', ctx.organizer.auth);
  assert.equal(wrongParty.status, 404);

  // And an unrelated account can't reach it at all.
  const stranger = await registerUser({ firstName: 'Cal', lastName: 'Stranger' });
  const outsider = await request().post(`/api/invitations/${ctx.invitationId}/merge`)
    .set('Authorization', stranger.auth);
  assert.equal(outsider.status, 404);
});
