// Signal-parity F1/F2 — device sessions + the reset hold (registration-lock
// analog). Real app + in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys } = require('./harness');

before(startDb);
after(stopDb);

test('sign-ins create sessions; revoking one kills its token', async () => {
  const u = await registerUser({ firstName: 'Dee', password: 'test-password-1' });

  // A second sign-in from a named device.
  const login = await request().post('/api/auth/login')
    .set('X-Device-Name', 'Test iPhone').set('X-Device-Platform', 'ios')
    .send({ email: u.user.email, password: 'test-password-1' });
  assert.equal(login.status, 200);
  const phoneAuth = `Bearer ${login.body.token}`;

  // Both sessions are listed; the phone token sees itself as current.
  const list = await request().get('/api/auth/sessions').set('Authorization', phoneAuth);
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  const current = list.body.sessions.find((s) => s.current);
  assert.equal(current.deviceName, 'Test iPhone');

  // Revoke the phone session from the original device → the phone token 401s.
  const revoke = await request().delete(`/api/auth/sessions/${current._id}`).set('Authorization', u.auth);
  assert.equal(revoke.status, 200);
  const dead = await request().get('/api/auth/sessions').set('Authorization', phoneAuth);
  assert.equal(dead.status, 401);

  // The original registration token still works.
  const alive = await request().get('/api/auth/sessions').set('Authorization', u.auth);
  assert.equal(alive.status, 200);
  assert.equal(alive.body.sessions.length, 1);
});

test('X-Device-Id sign-ins coalesce to one session row per install', async () => {
  const u = await registerUser({ firstName: 'Hal', password: 'test-password-1' });
  const login = (deviceId) => request().post('/api/auth/login')
    .set('X-Device-Name', 'iPhone').set('X-Device-Platform', 'ios').set('X-Device-Id', deviceId)
    .send({ email: u.user.email, password: 'test-password-1' });

  // First sign-in from the install: appends a row alongside the registration one.
  const first = await login('install-aaaa');
  assert.equal(first.status, 200);
  const list1 = await request().get('/api/auth/sessions')
    .set('Authorization', `Bearer ${first.body.token}`);
  assert.equal(list1.body.sessions.length, 2);
  const row1 = list1.body.sessions.find((s) => s.current);

  // Re-login from the SAME install: the row is replaced, not appended — same
  // createdAt, fresh sid — and the install's previous token is revoked.
  const second = await login('install-aaaa');
  const list2 = await request().get('/api/auth/sessions')
    .set('Authorization', `Bearer ${second.body.token}`);
  assert.equal(list2.body.sessions.length, 2, 'same install must not add a row');
  const row2 = list2.body.sessions.find((s) => s.current);
  assert.notEqual(row2._id, row1._id, 're-login mints a fresh sid');
  assert.equal(row2.createdAt, row1.createdAt, 'the install keeps its first-seen date');
  const dead = await request().get('/api/auth/sessions')
    .set('Authorization', `Bearer ${first.body.token}`);
  assert.equal(dead.status, 401, 're-login revokes the install\'s previous token');

  // A DIFFERENT install id — even with the identical name+platform — appends
  // its own row (names are non-unique; only the id may coalesce).
  const other = await login('install-bbbb');
  const list3 = await request().get('/api/auth/sessions')
    .set('Authorization', `Bearer ${other.body.token}`);
  assert.equal(list3.body.sessions.length, 3, 'a new install must get its own row');
});

async function requestResetCode(email) {
  const User = require('../models/User');
  const bcrypt = require('bcryptjs');
  // Mint the code directly (mailer is a no-op in tests, so we can't read email).
  const code = '123456';
  await User.updateOne({ email }, {
    $set: {
      resetCodeHash: await bcrypt.hash(code, 4),
      resetCodeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      resetCodeAttempts: 0,
    },
  });
  return code;
}

test('unprotected account: reset applies immediately', async () => {
  const u = await registerUser({ firstName: 'Eve', password: 'test-password-1' });
  const code = await requestResetCode(u.user.email);
  const res = await request().post('/api/auth/reset')
    .send({ email: u.user.email, code, newPassword: 'brand-new-pass-9' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('protected account: unknown-device reset is held; known device is immediate; cancel works', async () => {
  const u = await registerUser({ firstName: 'Fay', password: 'test-password-1' });
  await enrollKeys(u.auth);
  await request().post('/api/keys/recovery-complete').set('Authorization', u.auth);

  // Unknown device (no Authorization): 202 hold, password unchanged.
  let code = await requestResetCode(u.user.email);
  const held = await request().post('/api/auth/reset')
    .set('X-Device-Name', 'Attacker Phone')
    .send({ email: u.user.email, code, newPassword: 'attacker-pass-99' });
  assert.equal(held.status, 202);
  assert.ok(held.body.holdUntil);
  const oldLogin = await request().post('/api/auth/login')
    .send({ email: u.user.email, password: 'test-password-1' });
  assert.equal(oldLogin.status, 200, 'old password must still work during the hold');

  // Any signed-in device cancels the hold.
  const cancel = await request().post('/api/auth/reset/cancel').set('Authorization', u.auth);
  assert.equal(cancel.status, 200);
  const state = await request().get('/api/auth/sessions').set('Authorization', u.auth);
  assert.equal(state.body.pendingResetHoldUntil, null);

  // Known device (valid session token attached): reset applies immediately.
  code = await requestResetCode(u.user.email);
  const known = await request().post('/api/auth/reset')
    .set('Authorization', u.auth)
    .send({ email: u.user.email, code, newPassword: 'my-new-pass-77' });
  assert.equal(known.status, 200);
  const newLogin = await request().post('/api/auth/login')
    .send({ email: u.user.email, password: 'my-new-pass-77' });
  assert.equal(newLogin.status, 200);
});

test('held reset completes after the window elapses', async () => {
  const u = await registerUser({ firstName: 'Gil', password: 'test-password-1' });
  await enrollKeys(u.auth);
  await request().post('/api/keys/recovery-complete').set('Authorization', u.auth);

  let code = await requestResetCode(u.user.email);
  const held = await request().post('/api/auth/reset')
    .send({ email: u.user.email, code, newPassword: 'later-pass-11' });
  assert.equal(held.status, 202);

  // Force the hold into the past (we can't wait 24h in a test).
  const User = require('../models/User');
  await User.updateOne({ email: u.user.email }, { $set: { resetHoldUntil: new Date(Date.now() - 1000) } });

  code = await requestResetCode(u.user.email);
  const done = await request().post('/api/auth/reset')
    .send({ email: u.user.email, code, newPassword: 'later-pass-11' });
  assert.equal(done.status, 200);
  const login = await request().post('/api/auth/login')
    .send({ email: u.user.email, password: 'later-pass-11' });
  assert.equal(login.status, 200);
});
