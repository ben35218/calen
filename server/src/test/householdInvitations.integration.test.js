// Integration tests for household sharing by email invitation (replaces the join
// code). A member invites an email; the recipient accepts, which opens a
// JoinRequest an existing member approves on-device (the HDK is granted then).
// Also covers decline, revoke, and lazy-claim of an email-only invite. Real app +
// in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, request, b64u, registerUser, enrollKeys, joinHousehold,
} = require('./harness');

const User = require('../models/User');
const JoinRequest = require('../models/JoinRequest');

before(startDb);
after(stopDb);

// An owner with a minted HDK, ready to approve joiners.
async function ownerWithKey() {
  const owner = await registerUser({ firstName: 'Olive' });
  await enrollKeys(owner.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  return owner;
}

test('invite → accept → approve grants membership (harness end-to-end)', async () => {
  const owner = await ownerWithKey();
  const member = await registerUser({ firstName: 'Milo' });
  await enrollKeys(member.auth);

  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  const hh = await request().get('/api/household').set('Authorization', member.auth);
  const owned = await request().get('/api/household').set('Authorization', owner.auth);
  assert.equal(String(hh.body._id), String(owned.body._id), 'member now in the owner household');
  assert.equal(owned.body.members.length, 2);
});

test('accepting opens a join request but does not itself grant membership', async () => {
  const owner = await ownerWithKey();
  const joiner = await registerUser({ firstName: 'Jo' });
  await enrollKeys(joiner.auth);

  await request().post('/api/household/invitations')
    .set('Authorization', owner.auth).send({ email: joiner.user.email });
  const inbox = await request().get('/api/household/invitations/mine').set('Authorization', joiner.auth);
  const invite = inbox.body.find((i) => i.status === 'pending');
  assert.ok(invite);

  const accept = await request().post(`/api/household/invitations/${invite._id}/accept`)
    .set('Authorization', joiner.auth).send({});
  assert.equal(accept.status, 201);
  assert.equal(accept.body.status, 'pending');

  // Still in their own solo household until a member approves the request.
  const before = await User.findById(joiner.user._id).lean();
  assert.equal(String(before.householdId), String(joiner.user.householdId));
  const pending = await request().get('/api/household/join-requests').set('Authorization', owner.auth);
  assert.equal(pending.body.length, 1);
});

test('cannot invite someone already in the household', async () => {
  const owner = await ownerWithKey();
  const member = await registerUser({ firstName: 'Mae' });
  await enrollKeys(member.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  const res = await request().post('/api/household/invitations')
    .set('Authorization', owner.auth).send({ email: member.user.email });
  assert.equal(res.status, 400);
});

test('declining withdraws the pending join request', async () => {
  const owner = await ownerWithKey();
  const joiner = await registerUser({ firstName: 'Dana' });
  await enrollKeys(joiner.auth);

  await request().post('/api/household/invitations')
    .set('Authorization', owner.auth).send({ email: joiner.user.email });
  const inbox = await request().get('/api/household/invitations/mine').set('Authorization', joiner.auth);
  const invite = inbox.body[0];
  await request().post(`/api/household/invitations/${invite._id}/accept`)
    .set('Authorization', joiner.auth).send({});
  await request().post(`/api/household/invitations/${invite._id}/decline`)
    .set('Authorization', joiner.auth).send({});

  const open = await JoinRequest.countDocuments({ requesterUserId: joiner.user._id, status: 'pending' });
  assert.equal(open, 0);
});

test('revoking a sent invitation removes it from the recipient inbox', async () => {
  const owner = await ownerWithKey();
  const joiner = await registerUser({ firstName: 'Remy' });
  await enrollKeys(joiner.auth);

  const sent = await request().post('/api/household/invitations')
    .set('Authorization', owner.auth).send({ email: joiner.user.email });
  await request().delete(`/api/household/invitations/${sent.body.invitation._id}`)
    .set('Authorization', owner.auth);

  const inbox = await request().get('/api/household/invitations/mine').set('Authorization', joiner.auth);
  assert.equal(inbox.body.length, 0);
});

test('an email-only invite is claimed when the recipient registers later', async () => {
  const owner = await ownerWithKey();
  const email = `late-${b64u(6).toLowerCase()}@example.com`;
  await request().post('/api/household/invitations')
    .set('Authorization', owner.auth).send({ email });

  const late = await registerUser({ email });
  const inbox = await request().get('/api/household/invitations/mine').set('Authorization', late.auth);
  assert.equal(inbox.body.length, 1);
  // The first fetch claims it (toUserId written); a second fetch reflects that.
  const again = await request().get('/api/household/invitations/mine').set('Authorization', late.auth);
  assert.equal(String(again.body[0].toUserId), String(late.user._id));
});

test('removing a member files a dismissible notice in their inbox', async () => {
  const owner = await ownerWithKey();
  const member = await registerUser({ firstName: 'Nora' });
  await enrollKeys(member.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  // No 'removed' notice before removal (joining did file an 'approved' one).
  const before = await request().get('/api/household/notices').set('Authorization', member.auth);
  assert.equal(before.body.filter((n) => n.kind === 'removed').length, 0);

  const removed = await request().post(`/api/household/members/${member.user._id}/remove`)
    .set('Authorization', owner.auth);
  assert.equal(removed.status, 200);

  // The removed member now sees a 'removed' notice naming the remover (never the
  // sealed household name), and it's undismissed → belongs in the "New" tab.
  const notices = await request().get('/api/household/notices').set('Authorization', member.auth);
  const notice = notices.body.find((n) => n.kind === 'removed');
  assert.ok(notice, 'removed notice exists');
  assert.equal(notice.actorName, 'Olive');
  assert.ok(!notice.acknowledgedAt);

  // Dismissing stamps acknowledgedAt so the client can move it to history.
  const ack = await request().post(`/api/household/notices/${notice._id}/ack`)
    .set('Authorization', member.auth);
  assert.equal(ack.status, 200);
  assert.ok(ack.body.notice.acknowledgedAt);
});

test('leaving a household files no removal notice (self-initiated)', async () => {
  const owner = await ownerWithKey();
  const member = await registerUser({ firstName: 'Wes' });
  await enrollKeys(member.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });

  await request().post('/api/household/leave').set('Authorization', member.auth);

  // Leaving files no 'removed' notice (only being removed by an owner does). The
  // joiner does carry an 'approved' notice from when they joined — leave adds
  // nothing.
  const notices = await request().get('/api/household/notices').set('Authorization', member.auth);
  assert.equal(notices.body.filter((n) => n.kind === 'removed').length, 0);
});

test('rejecting a join request retires (revokes) the sent invitation', async () => {
  const owner = await ownerWithKey();
  const joiner = await registerUser({ firstName: 'Rex' });
  await enrollKeys(joiner.auth);

  const sent = await request().post('/api/household/invitations')
    .set('Authorization', owner.auth).send({ email: joiner.user.email });
  const inviteId = sent.body.invitation._id;

  // Joiner accepts → invitation flips to 'accepted', a pending request opens.
  const inbox = await request().get('/api/household/invitations/mine').set('Authorization', joiner.auth);
  const invite = inbox.body.find((i) => i.status === 'pending');
  await request().post(`/api/household/invitations/${invite._id}/accept`)
    .set('Authorization', joiner.auth).send({});

  const pending = await request().get('/api/household/join-requests').set('Authorization', owner.auth);
  assert.equal(pending.body.length, 1);

  // Owner rejects the request.
  const rejected = await request().post(`/api/household/join-requests/${pending.body[0]._id}/reject`)
    .set('Authorization', owner.auth);
  assert.equal(rejected.status, 200);

  // The request is rejected and the invitation is retired to 'declined', so the
  // member's card (which hides declined invites) no longer shows it.
  assert.equal((await JoinRequest.findById(pending.body[0]._id).lean()).status, 'rejected');
  const ownerSent = await request().get('/api/household/invitations').set('Authorization', owner.auth);
  const row = ownerSent.body.find((i) => String(i._id) === String(inviteId));
  assert.equal(row.status, 'declined');
});

test('approving a request files an "approved" notice in the joiner’s inbox', async () => {
  const owner = await ownerWithKey();
  const joiner = await registerUser({ firstName: 'Ada' });
  await enrollKeys(joiner.auth);

  // No membership notice before approval.
  const before = await request().get('/api/household/notices').set('Authorization', joiner.auth);
  assert.equal(before.body.length, 0);

  await joinHousehold({ joiner, approver: owner, keyVersion: 1 });

  // The joiner now sees an undismissed 'approved' notice naming the approver.
  const notices = await request().get('/api/household/notices').set('Authorization', joiner.auth);
  const approved = notices.body.find((n) => n.kind === 'approved');
  assert.ok(approved, 'approved notice exists');
  assert.equal(approved.actorName, 'Olive');
  assert.ok(!approved.acknowledgedAt);
});
