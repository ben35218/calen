// Integration tests for guardian recovery's server surface (features/
// guardian-recovery.md): the blind envelope store (PUT/GET/DELETE
// /keys/guardian) and the request → approve → poll relay. The server never
// touches crypto here — stand-in b64 blobs throughout — so what's under test is
// the lifecycle: membership checks, the audit trail (guardian_armed /
// guardian_disarmed / guardian_approved — arming once 500'd because these were
// missing from AUDIT_EVENTS), and burn-on-delivery.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u } = require('./harness');
const AuditLog = require('../models/AuditLog');
const GuardianRecoveryRequest = require('../models/GuardianRecoveryRequest');
const User = require('../models/User');

before(startDb);
after(stopDb);

// An enrolled owner with a minted household key, plus an enrolled member who
// joined it — the only kind of user who can be named guardian.
async function householdPair() {
  const owner = await registerUser({ firstName: 'Uma' });
  await enrollKeys(owner.auth);
  const mint = await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(mint.status, 201);
  const guardian = await registerUser({ firstName: 'Gray' });
  await enrollKeys(guardian.auth);
  await joinHousehold({ joiner: guardian, approver: owner, keyVersion: 1 });
  return { owner, guardian };
}

const armPayload = (guardian) => ({
  guardianUserId: guardian.user._id,
  guardianFingerprint: 'AB12 CD34',
  outer: b64u(256),
});

test('arm → request → approve → poll: the full relay, audited at each human step', async () => {
  const { owner, guardian } = await householdPair();

  // Arm — this is the call that used to 500 on AuditLog enum validation.
  const arm = await request().put('/api/keys/guardian')
    .set('Authorization', owner.auth).send(armPayload(guardian));
  assert.equal(arm.status, 200);
  assert.equal(arm.body.armed, true);
  assert.equal(await AuditLog.countDocuments({ userId: owner.user._id, event: 'guardian_armed' }), 1);

  const status = await request().get('/api/keys/guardian').set('Authorization', owner.auth);
  assert.equal(status.body.armed, true);
  assert.equal(String(status.body.guardianUserId), String(guardian.user._id));

  // Recovering device opens a request; the guardian sees it with the outer blob.
  const open = await request().post('/api/keys/guardian/request')
    .set('Authorization', owner.auth)
    .send({ ephemeralPublicKey: b64u(43), fingerprint: 'AB12 CD34' });
  assert.equal(open.status, 201);
  const { requestId } = open.body;

  const inbox = await request().get('/api/keys/guardian/requests').set('Authorization', guardian.auth);
  const pending = inbox.body.requests.find((r) => r.requestId === requestId);
  assert.ok(pending, 'guardian should see the pending request');
  assert.ok(pending.outer, 'the outer blob rides along for local unsealing');

  const approve = await request().post('/api/keys/guardian/approve')
    .set('Authorization', guardian.auth)
    .send({ requestId, sealedPayload: b64u(256) });
  assert.equal(approve.status, 200);
  assert.equal(await AuditLog.countDocuments({ userId: owner.user._id, event: 'guardian_approved' }), 1);

  // Poll delivers the sealed payload exactly once — burned on delivery.
  const poll = await request().get(`/api/keys/guardian/request/${requestId}`).set('Authorization', owner.auth);
  assert.equal(poll.body.status, 'sealed');
  assert.ok(poll.body.sealedPayload);
  const again = await request().get(`/api/keys/guardian/request/${requestId}`).set('Authorization', owner.auth);
  assert.equal(again.status, 404);
});

test('arming rejects self, non-members, and unenrolled guardians', async () => {
  const { owner, guardian } = await householdPair();

  const self = await request().put('/api/keys/guardian')
    .set('Authorization', owner.auth).send(armPayload(owner));
  assert.equal(self.status, 400);

  const outsider = await registerUser({ firstName: 'Out' });
  await enrollKeys(outsider.auth);
  const notMember = await request().put('/api/keys/guardian')
    .set('Authorization', owner.auth).send(armPayload(outsider));
  assert.equal(notMember.status, 404);

  // The e2ee mandate means a member without keys can't exist via the join flow;
  // strip the guardian's key directly to hit the defence-in-depth 409.
  await User.updateOne({ _id: guardian.user._id }, { $unset: { identityPublicKey: 1 } });
  const noKey = await request().put('/api/keys/guardian')
    .set('Authorization', owner.auth).send(armPayload(guardian));
  assert.equal(noKey.status, 409);

  // None of the refusals wrote an audit row.
  assert.equal(await AuditLog.countDocuments({ userId: owner.user._id, event: 'guardian_armed' }), 0);
});

test('disarm clears the envelope, cancels in-flight requests, and is audited', async () => {
  const { owner, guardian } = await householdPair();
  assert.equal(
    (await request().put('/api/keys/guardian').set('Authorization', owner.auth).send(armPayload(guardian))).status,
    200,
  );
  const open = await request().post('/api/keys/guardian/request')
    .set('Authorization', owner.auth)
    .send({ ephemeralPublicKey: b64u(43), fingerprint: 'AB12 CD34' });
  assert.equal(open.status, 201);

  const disarm = await request().delete('/api/keys/guardian').set('Authorization', owner.auth);
  assert.equal(disarm.status, 200);
  assert.equal(disarm.body.armed, false);
  assert.equal(await AuditLog.countDocuments({ userId: owner.user._id, event: 'guardian_disarmed' }), 1);
  assert.equal(await GuardianRecoveryRequest.countDocuments({ userId: owner.user._id }), 0);

  const status = await request().get('/api/keys/guardian').set('Authorization', owner.auth);
  assert.equal(status.body.armed, false);
});
