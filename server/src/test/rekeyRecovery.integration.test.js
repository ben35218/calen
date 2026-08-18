// Integration tests for lost-every-factor recovery: POST /keys/rekey plus the
// calendar access request → approve pair it feeds.
//
// The scenario is a free viewer (billing-plans.md "Free viewer mode") whose
// shared calendar is sealed under a CalendarKey wrapped to an identity key they
// can no longer open — a forgotten-password reset changes only the login
// password. Re-keying mints a NEW identity so the calendar's owner can re-wrap
// to it, and the interesting property under test is what re-keying does NOT do:
// grant anything by itself. Real app + Mongo, stand-in ciphertext throughout
// (the server verifies shape, never crypto).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u } = require('./harness');
const CustomCalendar = require('../models/CustomCalendar');
const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const Record = require('../models/Record');

before(startDb);
after(stopDb);

let seq = 0;
const mintCalKey = () => `custom-rk${Date.now().toString(36)}${(seq++).toString(36)}`;

// The enrollment payload shape /keys/rekey shares with /keys/enroll.
const keyMaterial = () => ({
  identityPublicKey: b64u(43),
  factors: [{
    factor: 'password',
    nonce: b64u(32),
    ct: b64u(96),
    kdf: 'argon2id',
    salt: b64u(22),
    opslimit: 2,
    memlimit: 67108864,
  }],
});

// An owner with an outside-shared calendar at CalendarKey v1, and a
// cross-household collaborator who has accepted and been wrapped to.
async function sharedCalendarSetup() {
  const owner = await registerUser({ firstName: 'Odette' });
  await enrollKeys(owner.auth);
  const mint = await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(mint.status, 201);

  const viewer = await registerUser({ firstName: 'Vera' });
  await enrollKeys(viewer.auth);

  const calendarKey = mintCalKey();
  const create = await request().post('/api/calendars').set('Authorization', owner.auth).send({
    key: calendarKey, name: 'Soccer Schedule', color: '#1976D2',
    sharedWithOutside: [{ email: viewer.user.email, access: 'view' }],
  });
  assert.equal(create.status, 201);

  const inbox = await request().get('/api/calendars/invitations').set('Authorization', viewer.auth);
  const inv = inbox.body.find((i) => i.calendarKey === calendarKey);
  assert.ok(inv, 'expected a calendar invitation');
  assert.equal(
    (await request().post(`/api/calendars/invitations/${inv._id}/accept`).set('Authorization', viewer.auth)).status,
    200,
  );

  // The owner mints the CalendarKey and wraps it to the collaborator.
  const minted = await request().post(`/api/calendars/${calendarKey}/keys`)
    .set('Authorization', owner.auth)
    .send({
      keyVersion: 1,
      household: { hdkVersion: 1, wrappedKey: b64u(96) },
      members: [{ userId: viewer.user._id, wrappedKey: b64u(96) }],
    });
  assert.equal(minted.status, 201);
  return { owner, viewer, calendarKey };
}

const pendingFor = async (auth) =>
  (await request().get('/api/calendars/keys/pending').set('Authorization', auth)).body;

test('re-key replaces the identity key and clears every envelope sealed to the old one', async () => {
  const { viewer, calendarKey } = await sharedCalendarSetup();
  const before = await request().get('/api/keys/me').set('Authorization', viewer.auth);
  assert.ok(before.body.identityPublicKey);
  assert.equal(
    await ResourceKeyEnvelope.countDocuments({ recipient: 'member', userId: viewer.user._id }), 1,
  );

  const material = keyMaterial();
  const res = await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(material);
  assert.equal(res.status, 201);

  const after = await request().get('/api/keys/me').set('Authorization', viewer.auth);
  assert.equal(after.body.identityPublicKey, material.identityPublicKey);
  assert.notEqual(after.body.identityPublicKey, before.body.identityPublicKey);
  // The dead envelopes are gone — nothing can open them, so keeping them would
  // only make the collaborator look wrapped when they aren't.
  assert.equal(
    await ResourceKeyEnvelope.countDocuments({ recipient: 'member', userId: viewer.user._id }), 0,
  );
  assert.equal(await HouseholdKeyEnvelope.countDocuments({ userId: viewer.user._id }), 0);
  // Recovery is unconfirmed again: the fresh one-time code hasn't been saved.
  assert.equal(after.body.recoverySetupAt, null);
  // And the collaboration is flagged, which is what suppresses the auto-wrap.
  const cal = await CustomCalendar.findOne({ key: calendarKey }).lean();
  const seat = cal.collaborators.find((c) => String(c.userId) === String(viewer.user._id));
  assert.ok(seat.keyChangedAt, 'the seat records that their key changed');
});

test('re-keying an account that holds its own records needs an explicit confirmation', async () => {
  const user = await registerUser({ firstName: 'Rhoda' });
  await enrollKeys(user.auth);
  const created = await request().post('/api/records').set('Authorization', user.auth)
    .send({ enc: { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(96) }, keyVersion: 1 });
  assert.equal(created.status, 201);

  const blocked = await request().post('/api/keys/rekey').set('Authorization', user.auth).send(keyMaterial());
  assert.equal(blocked.status, 409, 'refuses to silently abandon the account’s own data');
  assert.equal(blocked.body.code, 'confirm_data_loss');
  assert.equal(blocked.body.recordCount, 1);
  assert.equal(blocked.body.recoverableByHousehold, false, 'solo household — nobody can re-seal');

  const material = keyMaterial();
  const allowed = await request().post('/api/keys/rekey').set('Authorization', user.auth)
    .send({ ...material, confirmDataLoss: true });
  assert.equal(allowed.status, 201);
  const me = await request().get('/api/keys/me').set('Authorization', user.auth);
  assert.equal(me.body.identityPublicKey, material.identityPublicKey);
});

test('re-key suppresses the owner’s automatic re-wrap until they approve', async () => {
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();
  assert.equal(
    await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(keyMaterial()).then((r) => r.status),
    201,
  );

  // The envelope is gone, so without the suppression the collaborator would
  // reappear as a missing member and the owner's background pass would re-wrap
  // on its next run — a silent re-grant to a key nobody vouched for.
  // A re-key with no request yet leaves the owner nothing to do: the calendar
  // drops off the work list entirely rather than appearing as a member to wrap.
  const entry = (await pendingFor(owner.auth)).find((p) => p.calendarKey === calendarKey);
  if (entry) {
    assert.equal(entry.missingMembers.length, 0, 'not offered for automatic wrapping');
    assert.equal(
      entry.collaborators.filter((c) => String(c.userId) === String(viewer.user._id)).length, 0,
      'nor via the mint/rotate collaborator list',
    );
  }

  // Belt and braces: a client that ignores all that and posts the wrap anyway
  // must still be refused, or the gate is only advisory.
  const sneaky = await request().post(`/api/calendars/${calendarKey}/keys/members`)
    .set('Authorization', owner.auth)
    .send({ keyVersion: 1, members: [{ userId: viewer.user._id, wrappedKey: b64u(96) }] });
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.body.wrapped, 0, 'the server refuses the suppressed wrap');
  assert.equal(
    await ResourceKeyEnvelope.countDocuments({ recipient: 'member', userId: viewer.user._id }), 0,
  );
});

test('request → approve restores access, and only then', async () => {
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();
  await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(keyMaterial());

  // Before the request the owner has nothing to act on.
  const quiet = (await pendingFor(owner.auth)).find((p) => p.calendarKey === calendarKey);
  assert.equal((quiet?.reapprovals || []).length, 0);

  const asked = await request().post(`/api/calendars/${calendarKey}/access-request`)
    .set('Authorization', viewer.auth);
  assert.equal(asked.status, 200);
  assert.equal(asked.body.calendarName, 'Soccer Schedule', 'the viewer is told which calendar');

  const queued = (await pendingFor(owner.auth)).find((p) => p.calendarKey === calendarKey);
  assert.equal(queued.reapprovals.length, 1);
  const req = queued.reapprovals[0];
  assert.equal(String(req.userId), String(viewer.user._id));
  assert.equal(req.name, 'Vera User');
  // The NEW key: its safety number is what the owner compares before approving.
  const me = await request().get('/api/keys/me').set('Authorization', viewer.auth);
  assert.equal(req.identityPublicKey, me.body.identityPublicKey);

  const approved = await request().post(`/api/calendars/${calendarKey}/keys/approve`)
    .set('Authorization', owner.auth)
    .send({ userId: viewer.user._id, keyVersion: 1, wrappedKey: b64u(96) });
  assert.equal(approved.status, 200);

  // Wrapped, and the seat is back to ordinary — no lingering suppression.
  assert.equal(
    await ResourceKeyEnvelope.countDocuments({ recipient: 'member', userId: viewer.user._id }), 1,
  );
  const cal = await CustomCalendar.findOne({ key: calendarKey }).lean();
  const seat = cal.collaborators.find((c) => String(c.userId) === String(viewer.user._id));
  assert.ok(!seat.keyChangedAt && !seat.reapprovalRequestedAt);
  // Nothing left pending for this calendar.
  const done = (await pendingFor(owner.auth)).find((p) => p.calendarKey === calendarKey);
  assert.ok(!done || (done.reapprovals || []).length === 0);
});

test('only the calendar’s owner can approve, and only for a real request', async () => {
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();
  await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(keyMaterial());
  await request().post(`/api/calendars/${calendarKey}/access-request`).set('Authorization', viewer.auth);

  // The requester can't approve themselves back in.
  const self = await request().post(`/api/calendars/${calendarKey}/keys/approve`)
    .set('Authorization', viewer.auth)
    .send({ userId: viewer.user._id, keyVersion: 1, wrappedKey: b64u(96) });
  assert.equal(self.status, 403);

  // An owner approving someone with no pending request is a no-op, not a wrap.
  const stranger = await registerUser({ firstName: 'Sam' });
  await enrollKeys(stranger.auth);
  const bogus = await request().post(`/api/calendars/${calendarKey}/keys/approve`)
    .set('Authorization', owner.auth)
    .send({ userId: stranger.user._id, keyVersion: 1, wrappedKey: b64u(96) });
  assert.equal(bogus.status, 409);
});

test('re-accepting the invitation does not clear the suppression', async () => {
  // The viewer shell auto-accepts pending shares on every focus, so if accept
  // reset the flags a re-keyed viewer would silently re-grant themselves.
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();
  await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(keyMaterial());

  // Re-invite (owner re-adds the same address) and accept again.
  const reInvite = await request().put(`/api/calendars/${calendarKey}`)
    .set('Authorization', owner.auth)
    .send({ sharedWithOutside: [{ email: viewer.user.email, access: 'view' }] });
  assert.equal(reInvite.status, 200);
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', viewer.auth);
  const inv = inbox.body.find((i) => i.calendarKey === calendarKey);
  if (inv && inv.status === 'pending') {
    assert.equal(
      (await request().post(`/api/calendars/invitations/${inv._id}/accept`).set('Authorization', viewer.auth)).status,
      200,
    );
  }

  const cal = await CustomCalendar.findOne({ key: calendarKey }).lean();
  const seat = cal.collaborators.find((c) => String(c.userId) === String(viewer.user._id));
  assert.ok(seat.keyChangedAt, 'accepting again leaves the key change flagged');
  const entry = (await pendingFor(owner.auth)).find((p) => p.calendarKey === calendarKey);
  assert.equal((entry?.missingMembers || []).length, 0, 'still not automatically wrappable');
});

// The wait has to survive a sign-out. "Request sent" is component state in the
// viewer shell, so without a server-side record of the pending request the user
// signed back in and landed on a blank calendar whose ordinary sync note gave
// no sign their request existed. GET /api/calendars therefore reports the
// REQUESTER'S OWN seat stamps — and nobody else's, since the collaborator list
// itself is never serialized to clients.
test('the calendar list reports the requester’s own pending access request', async () => {
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();

  const before = (await request().get('/api/calendars').set('Authorization', viewer.auth))
    .body.find((c) => c.key === calendarKey);
  assert.ok(before, 'the viewer sees the shared calendar');
  assert.ok(!before.keyChangedAt && !before.accessRequestedAt, 'nothing pending yet');

  assert.equal(
    (await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(keyMaterial())).status,
    201,
  );
  // Re-keyed but not yet asked: the suppression is visible, the request isn't.
  const rekeyed = (await request().get('/api/calendars').set('Authorization', viewer.auth))
    .body.find((c) => c.key === calendarKey);
  assert.ok(rekeyed.keyChangedAt, 'the viewer can see their own key changed');
  assert.ok(!rekeyed.accessRequestedAt);

  assert.equal(
    (await request().post(`/api/calendars/${calendarKey}/access-request`).set('Authorization', viewer.auth)).status,
    200,
  );
  const asked = (await request().get('/api/calendars').set('Authorization', viewer.auth))
    .body.find((c) => c.key === calendarKey);
  assert.ok(asked.accessRequestedAt, 'the pending request is durable, not client state');

  // The OWNER's view of their own calendar carries no seat stamps — these are
  // the requester's own state, and the collaborator list stays private.
  const ownerView = (await request().get('/api/calendars').set('Authorization', owner.auth))
    .body.find((c) => c.key === calendarKey);
  assert.ok(!ownerView.accessRequestedAt && !ownerView.keyChangedAt);
  assert.equal(ownerView.collaborators, undefined);
});

// ── Start fresh: what a re-key does to the caller's HOUSEHOLD ────────────────
//
// A record's shape as clients seal it (v2 envelope).
const sealedRecord = () => ({
  enc: { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(96) },
  keyVersion: 1,
});

test('solo re-key starts the household fresh: dead ciphertext purged, key version reset, saving works again', async () => {
  const user = await registerUser({ firstName: 'Solly' });
  await enrollKeys(user.auth);
  const mint = await request().post('/api/household/key').set('Authorization', user.auth)
    .send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(mint.status, 201);
  assert.equal(
    (await request().post('/api/records').set('Authorization', user.auth).send(sealedRecord())).status,
    201,
  );

  const res = await request().post('/api/keys/rekey').set('Authorization', user.auth)
    .send({ ...keyMaterial(), confirmDataLoss: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.householdReset, true, 'the household was reset for a fresh start');

  // The records were sealed under a key nobody holds anymore — dead ciphertext,
  // gone rather than kept as an unreadable monument.
  const householdId = user.user.householdId;
  assert.equal(await Record.countDocuments({ householdId }), 0);
  assert.equal(await HouseholdKeyEnvelope.countDocuments({ householdId }), 0);

  // The key slot is open again: without the version reset the account unlocked
  // but could never save (v1 mint guarded to version 0 → permanent `pending`).
  const key = await request().get('/api/household/key').set('Authorization', user.auth);
  assert.equal(key.body.currentKeyVersion, 0);
  assert.equal(
    (await request().post('/api/household/key').set('Authorization', user.auth)
      .send({ keyVersion: 1, wrappedHDK: b64u(96) })).status,
    201,
    'the ordinary owner mint issues a fresh HDK',
  );
  assert.equal(
    (await request().post('/api/records').set('Authorization', user.auth).send(sealedRecord())).status,
    201,
    'and the account can save data again',
  );
});

// The solo purge must be as narrow as the comment claims: only HDK-sealed rows
// are dead ciphertext. A record sealed under a RESOURCE key (`enc.ks` 'cal')
// is readable by every outside collaborator holding a member envelope for that
// calendar — deleting it would destroy data OTHER people can still open.
test('solo re-key purge spares resource-sealed records and the collaborators who read them', async () => {
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();
  const householdId = owner.user.householdId;

  // One plain HDK-sealed record (dies with the HDK) …
  const plain = await request().post('/api/records').set('Authorization', owner.auth).send(sealedRecord());
  assert.equal(plain.status, 201);
  // … and one record sealed under the shared CalendarKey (must survive).
  const calSealed = await request().post('/api/records').set('Authorization', owner.auth).send({
    enc: { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(96), ks: 'cal' },
    keyVersion: 1,
    scope: { kind: 'calendar', resource: calendarKey, version: 1 },
  });
  assert.equal(calSealed.status, 201);

  // The OWNER re-keys. Solo household (the collaborator holds a resource
  // envelope, not an HDK envelope, so peerEnvelopes === 0) → the purge runs.
  const res = await request().post('/api/keys/rekey').set('Authorization', owner.auth)
    .send({ ...keyMaterial(), confirmDataLoss: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.householdReset, true);

  // The HDK-sealed row is gone; the CalendarKey-sealed row survives.
  assert.equal(await Record.countDocuments({ _id: plain.body._id }), 0, 'dead HDK ciphertext purged');
  assert.equal(await Record.countDocuments({ _id: calSealed.body._id }), 1, 'resource-sealed row spared');

  // The collaborator's member envelope survives (only the household-wrapped
  // copy — sealed under the dead HDK — dies with the reset).
  assert.equal(
    await ResourceKeyEnvelope.countDocuments({ recipient: 'member', userId: viewer.user._id, resourceKey: calendarKey }), 1,
  );
  assert.equal(
    await ResourceKeyEnvelope.countDocuments({ recipient: 'household', householdId }), 0,
  );

  // And the collaborator can still pull the record over the ordinary sync lane.
  const sync = await request().get('/api/records/sync').set('Authorization', viewer.auth);
  assert.equal(sync.status, 200);
  const ids = sync.body.records.map((r) => String(r._id));
  assert.ok(ids.includes(String(calSealed.body._id)), 'the shared record still syncs to the collaborator');
});

test('re-key in a shared household keeps the data and flags the rotation that re-admits the new key', async () => {
  const owner = await registerUser({ firstName: 'Olive' });
  await enrollKeys(owner.auth);
  assert.equal(
    (await request().post('/api/household/key').set('Authorization', owner.auth)
      .send({ keyVersion: 1, wrappedHDK: b64u(96) })).status,
    201,
  );
  const member = await registerUser({ firstName: 'Mira' });
  await enrollKeys(member.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });
  assert.equal(
    (await request().post('/api/records').set('Authorization', owner.auth).send(sealedRecord())).status,
    201,
  );

  // The guard names the household as the way back: a peer HOLDS an envelope.
  const blocked = await request().post('/api/keys/rekey').set('Authorization', member.auth).send(keyMaterial());
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.recoverableByHousehold, true);

  const res = await request().post('/api/keys/rekey').set('Authorization', member.auth)
    .send({ ...keyMaterial(), confirmDataLoss: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.householdReset, false, 'a shared household is never purged');

  // Nothing destroyed — the owner still holds the HDK — and the rotation is
  // flagged, which is what gets the re-keyed member back in: nothing else
  // re-wraps to an EXISTING member.
  const householdId = owner.user.householdId;
  assert.equal(await Record.countDocuments({ householdId, deleted: false }), 1);
  const key = await request().get('/api/household/key').set('Authorization', owner.auth);
  assert.equal(key.body.currentKeyVersion, 1);
  assert.equal(key.body.keyRotationPending, true);

  // The owner's lazy-rotation pass wraps v2 to every enrolled member — the
  // re-keyed member's NEW key included — and the member is readable again.
  const rotate = await request().post('/api/household/key/rotate').set('Authorization', owner.auth)
    .send({
      keyVersion: 2,
      envelopes: [
        { userId: owner.user._id, wrappedHDK: b64u(96) },
        { userId: member.user._id, wrappedHDK: b64u(96) },
      ],
    });
  assert.equal(rotate.status, 200);
  const memberKey = await request().get('/api/household/key').set('Authorization', member.auth);
  assert.equal(memberKey.body.keyRotationPending, false);
  assert.deepEqual(memberKey.body.envelopes.map((e) => e.keyVersion), [2],
    'only the fresh version — the old envelopes died with the old identity');
});

// Approval is what ends the wait: it clears both stamps, so the client's poll
// sees the request resolve and sends the user back to the calendar.
test('approving the request clears the stamps the viewer was waiting on', async () => {
  const { owner, viewer, calendarKey } = await sharedCalendarSetup();
  assert.equal(
    (await request().post('/api/keys/rekey').set('Authorization', viewer.auth).send(keyMaterial())).status,
    201,
  );
  assert.equal(
    (await request().post(`/api/calendars/${calendarKey}/access-request`).set('Authorization', viewer.auth)).status,
    200,
  );

  const approve = await request().post(`/api/calendars/${calendarKey}/keys/approve`)
    .set('Authorization', owner.auth)
    .send({ userId: viewer.user._id, keyVersion: 1, wrappedKey: b64u(96) });
  assert.equal(approve.status, 200);

  const after = (await request().get('/api/calendars').set('Authorization', viewer.auth))
    .body.find((c) => c.key === calendarKey);
  assert.ok(!after.accessRequestedAt && !after.keyChangedAt, 'the wait is over');
});
