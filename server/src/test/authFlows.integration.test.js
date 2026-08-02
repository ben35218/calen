// Integration tests for the auth hardening pass (routes/auth.js +
// routes/authPasskey.js + middleware/auth.js): the forgot-password code flow
// (anti-enumeration, expiry, attempt lockout, E2EE flag), sliding session
// refresh via X-Refreshed-Token, the passkey sign-in ceremony endpoints, and
// per-IP rate limiting on login. Real app + in-memory MongoDB.
//
// NOTE on ordering: the rate limiters are per-IP and in-process, and every
// supertest request shares one IP — the login-rate-limit test exhausts the
// login budget, so it runs LAST.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { startDb, stopDb, request, registerUser, enrollKeys } = require('./harness');

const User = require('../models/User');

before(startDb);
after(stopDb);

// ── Registration monetization side-effects ────────────────────────────────────

test('registration exposes appUnlocked=false and grants starter credits once', async () => {
  const CreditLedger = require('../models/CreditLedger');
  const res = await request().post('/api/auth/register').send({
    email: 'starter@example.com', password: 'a-password-1', firstName: 'Star', passwordless: false,
  });
  assert.equal(res.status, 201);
  // The hard paywall keys off this flag in every auth payload.
  assert.equal(res.body.user.appUnlocked, false);

  const user = await User.findOne({ email: 'starter@example.com' }).lean();
  assert.equal(user.appUnlocked, false);
  // Starter credits landed (default config grants > 0) with exactly one
  // idempotency-keyed ledger row.
  assert.ok(user.creditBalanceMc > 0);
  const rows = await CreditLedger.find({ userId: user._id, kind: 'starter' }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transactionId, `starter:${user._id}`);
});

// ── Forgot password ───────────────────────────────────────────────────────────

test('forgot: unknown email still answers ok (no account enumeration)', async () => {
  const res = await request().post('/api/auth/forgot').send({ email: 'nobody@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('forgot: known email stores a hashed short-lived code', async () => {
  const { user } = await registerUser({ email: 'forgetful@example.com' });
  const res = await request().post('/api/auth/forgot').send({ email: 'Forgetful@Example.com' });
  assert.equal(res.status, 200);

  const doc = await User.findById(user._id);
  assert.ok(doc.resetCodeHash, 'code hash stored');
  assert.ok(doc.resetCodeExpiresAt > new Date(), 'expiry in the future');
  assert.equal(doc.resetCodeAttempts, 0);
  assert.ok(!doc.resetCodeHash.includes('resetCodeHash'), 'hash, not plaintext');
});

test('reset: correct code sets the new password and signs the user in', async () => {
  const { user, auth } = await registerUser({ email: 'resetter@example.com', password: 'old-password-1' });
  await enrollKeys(auth); // so the response's e2eeEnrolled flag is exercised

  // Plant a known code (the emailed one is random and the mailer is dry-run).
  await User.updateOne({ _id: user._id }, {
    resetCodeHash: await bcrypt.hash('123456', 12),
    resetCodeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    resetCodeAttempts: 0,
  });

  const res = await request().post('/api/auth/reset')
    .send({ email: 'resetter@example.com', code: '123456', newPassword: 'new-password-9' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'signed in after reset');
  assert.equal(res.body.e2eeEnrolled, true, 'client is told to expect a locked E2EE state');

  // The token works, the new password works, the old one doesn't.
  const me = await request().get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(me.status, 200);
  const good = await request().post('/api/auth/login').send({ email: 'resetter@example.com', password: 'new-password-9' });
  assert.equal(good.status, 200);
  const bad = await request().post('/api/auth/login').send({ email: 'resetter@example.com', password: 'old-password-1' });
  assert.equal(bad.status, 401);

  // Code is single-use.
  const reuse = await request().post('/api/auth/reset')
    .send({ email: 'resetter@example.com', code: '123456', newPassword: 'another-pass-1' });
  assert.equal(reuse.status, 400);
});

test('reset: five wrong guesses burn the code even if the sixth is right', async () => {
  const { user } = await registerUser({ email: 'bruteforced@example.com' });
  await User.updateOne({ _id: user._id }, {
    resetCodeHash: await bcrypt.hash('654321', 12),
    resetCodeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    resetCodeAttempts: 0,
  });

  for (let i = 0; i < 5; i++) {
    const res = await request().post('/api/auth/reset')
      .send({ email: 'bruteforced@example.com', code: '000000', newPassword: 'whatever-123' });
    assert.equal(res.status, 400);
  }
  const res = await request().post('/api/auth/reset')
    .send({ email: 'bruteforced@example.com', code: '654321', newPassword: 'whatever-123' });
  assert.equal(res.status, 400, 'locked out after 5 attempts');
});

test('reset: expired code is rejected', async () => {
  const { user } = await registerUser({ email: 'slowpoke@example.com' });
  await User.updateOne({ _id: user._id }, {
    resetCodeHash: await bcrypt.hash('111222', 12),
    resetCodeExpiresAt: new Date(Date.now() - 1000),
    resetCodeAttempts: 0,
  });
  const res = await request().post('/api/auth/reset')
    .send({ email: 'slowpoke@example.com', code: '111222', newPassword: 'whatever-123' });
  assert.equal(res.status, 400);
});

// ── Account deletion (Apple 5.1.1(v)) ─────────────────────────────────────────

test('delete account: password account must confirm its password', async () => {
  const { user, auth } = await registerUser({ email: 'deleteme@example.com', password: 'right-password-1' });

  const missing = await request().delete('/api/auth/account').set('Authorization', auth).send({});
  assert.equal(missing.status, 400, 'no password → 400');

  const wrong = await request().delete('/api/auth/account').set('Authorization', auth).send({ password: 'nope-1234' });
  assert.equal(wrong.status, 401, 'wrong password → 401');
  assert.ok(await User.findById(user._id), 'still exists after failed attempts');

  const ok = await request().delete('/api/auth/account').set('Authorization', auth).send({ password: 'right-password-1' });
  assert.equal(ok.status, 200);
  assert.equal(await User.findById(user._id), null, 'user is gone');
});

test('delete account: passwordless account deletes on session token alone', async () => {
  // A passkey/OAuth account: `hasPassword` false, `passwordHash` a secret the
  // user never knows. It must still be able to delete itself (no password).
  const { user, auth } = await registerUser({ email: 'nopass@example.com' });
  await User.updateOne({ _id: user._id }, { hasPassword: false });

  const res = await request().delete('/api/auth/account').set('Authorization', auth).send({});
  assert.equal(res.status, 200, 'no password required');
  assert.equal(await User.findById(user._id), null, 'user is gone');
});

test('delete account: purges the RevenueCat subscriber for the user id and its alias', async () => {
  // billing-plans.md "Account deletion × billing": with a secret key set,
  // deletion issues DELETE /v1/subscribers/{id} for both RC identities —
  // best-effort data minimization (it can't cancel the store subscription).
  const { user, auth } = await registerUser({ email: 'rcpurge@example.com', password: 'right-password-1' });
  await User.updateOne({ _id: user._id }, { $set: { revenueCatId: 'rc-alias-1', aiPlanActive: true } });

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, auth: opts?.headers?.Authorization });
    return { ok: true };
  };
  process.env.REVENUECAT_SECRET_API_KEY = 'sk_test_123';
  try {
    const res = await request().delete('/api/auth/account').set('Authorization', auth).send({ password: 'right-password-1' });
    assert.equal(res.status, 200);
    assert.equal(await User.findById(user._id), null, 'user is gone');
  } finally {
    global.fetch = realFetch;
    delete process.env.REVENUECAT_SECRET_API_KEY;
  }
  const rc = calls.filter((c) => c.url.includes('api.revenuecat.com'));
  assert.equal(rc.length, 2, 'one DELETE per RC identity');
  assert.ok(rc.some((c) => c.url.endsWith(`/v1/subscribers/${user._id}`)), 'user id purged');
  assert.ok(rc.some((c) => c.url.endsWith('/v1/subscribers/rc-alias-1')), 'alias purged');
  for (const c of rc) {
    assert.equal(c.method, 'DELETE');
    assert.equal(c.auth, 'Bearer sk_test_123');
  }
});

test('delete account: RevenueCat purge is skipped without a key and never blocks deletion', async () => {
  const { user, auth } = await registerUser({ email: 'rcnokey@example.com', password: 'right-password-1' });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true }; };
  try {
    const res = await request().delete('/api/auth/account').set('Authorization', auth).send({ password: 'right-password-1' });
    assert.equal(res.status, 200);
    assert.equal(await User.findById(user._id), null, 'user is gone');
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls.filter((u) => u.includes('revenuecat')).length, 0, 'no RC call without a key');

  // And a purge that throws must not fail the deletion (best-effort doctrine).
  const { user: u2, auth: auth2 } = await registerUser({ email: 'rcboom@example.com', password: 'right-password-1' });
  global.fetch = async () => { throw new Error('network down'); };
  process.env.REVENUECAT_SECRET_API_KEY = 'sk_test_123';
  try {
    const res = await request().delete('/api/auth/account').set('Authorization', auth2).send({ password: 'right-password-1' });
    assert.equal(res.status, 200, 'deletion survives a failing purge');
    assert.equal(await User.findById(u2._id), null, 'user is gone');
  } finally {
    global.fetch = realFetch;
    delete process.env.REVENUECAT_SECRET_API_KEY;
  }
});

// ── Change password (biometric-first, current-password fallback) ──────────────

test('change password: biometric path omits currentPassword and changes the hash on the session alone', async () => {
  const { user, auth } = await registerUser({ email: 'pwbio@example.com', password: 'old-password-1' });
  const before = (await User.findById(user._id).lean()).passwordHash;

  // Biometric re-auth is enforced client-side, so the request carries no
  // currentPassword — a valid session is enough.
  const res = await request().put('/api/auth/password').set('Authorization', auth)
    .send({ newPassword: 'brand-new-9' });
  assert.equal(res.status, 200);

  const after = (await User.findById(user._id).lean()).passwordHash;
  assert.notEqual(after, before, 'hash was rotated');
  const good = await request().post('/api/auth/login').send({ email: 'pwbio@example.com', password: 'brand-new-9' });
  assert.equal(good.status, 200, 'new password signs in');
});

test('change password: fallback path verifies currentPassword when supplied', async () => {
  const { user, auth } = await registerUser({ email: 'pwfallback@example.com', password: 'old-password-1' });
  const before = (await User.findById(user._id).lean()).passwordHash;

  const wrong = await request().put('/api/auth/password').set('Authorization', auth)
    .send({ currentPassword: 'not-it-1', newPassword: 'brand-new-9' });
  assert.equal(wrong.status, 401, 'wrong current password → 401');
  assert.equal((await User.findById(user._id).lean()).passwordHash, before, 'hash unchanged after 401');

  const short = await request().put('/api/auth/password').set('Authorization', auth)
    .send({ newPassword: 'short' });
  assert.equal(short.status, 400, 'sub-8-char new password → 400');

  const ok = await request().put('/api/auth/password').set('Authorization', auth)
    .send({ currentPassword: 'old-password-1', newPassword: 'brand-new-9' });
  assert.equal(ok.status, 200, 'correct current password → 200');
});

// ── Change email (biometric-first, current-password fallback) ─────────────────

test('change email: biometric path omits currentPassword and updates on the session alone', async () => {
  const { user, auth } = await registerUser({ email: 'emailbio@example.com', password: 'old-password-1' });

  const res = await request().put('/api/auth/email').set('Authorization', auth)
    .send({ email: 'emailbio-new@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'emailbio-new@example.com');
  assert.equal((await User.findById(user._id).lean()).email, 'emailbio-new@example.com');
});

test('change email: fallback verifies currentPassword; rejects invalid + taken', async () => {
  const { user, auth } = await registerUser({ email: 'emailfb@example.com', password: 'old-password-1' });
  await registerUser({ email: 'occupied@example.com', password: 'whatever-1' });

  const wrong = await request().put('/api/auth/email').set('Authorization', auth)
    .send({ email: 'emailfb-new@example.com', currentPassword: 'not-it-1' });
  assert.equal(wrong.status, 401, 'wrong current password → 401');
  assert.equal((await User.findById(user._id).lean()).email, 'emailfb@example.com', 'unchanged');

  const bad = await request().put('/api/auth/email').set('Authorization', auth)
    .send({ email: 'not-an-email' });
  assert.equal(bad.status, 400, 'malformed email → 400');

  const taken = await request().put('/api/auth/email').set('Authorization', auth)
    .send({ email: 'occupied@example.com' });
  assert.equal(taken.status, 409, 'already-in-use email → 409');

  const ok = await request().put('/api/auth/email').set('Authorization', auth)
    .send({ email: 'emailfb-new@example.com', currentPassword: 'old-password-1' });
  assert.equal(ok.status, 200, 'correct current password → 200');
});

// ── Sliding session refresh ───────────────────────────────────────────────────

test('requireAuth: token past half-life gets X-Refreshed-Token; fresh token does not', async () => {
  const { user, token } = await registerUser();

  const fresh = await request().get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers['x-refreshed-token'], undefined, 'fresh token not refreshed');

  // 4 days into a 7-day token → past half-life.
  const nowSec = Math.floor(Date.now() / 1000);
  const old = jwt.sign({ userId: user._id, iat: nowSec - 4 * 86400 }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const res = await request().get('/api/auth/me').set('Authorization', `Bearer ${old}`);
  assert.equal(res.status, 200);
  const refreshed = res.headers['x-refreshed-token'];
  assert.ok(refreshed, 'refreshed token issued');

  const again = await request().get('/api/auth/me').set('Authorization', `Bearer ${refreshed}`);
  assert.equal(again.status, 200, 'refreshed token is valid');
  assert.equal(again.headers['x-refreshed-token'], undefined, 'and is itself fresh');
});

// ── Passkey sign-in ceremonies ───────────────────────────────────────────────

test('passkey challenge: username-first with no account or no passkeys → 404', async () => {
  const unknown = await request().post('/api/auth/passkey/challenge').send({ email: 'ghost@example.com' });
  assert.equal(unknown.status, 404);

  await registerUser({ email: 'nopasskey@example.com' });
  const bare = await request().post('/api/auth/passkey/challenge').send({ email: 'nopasskey@example.com' });
  assert.equal(bare.status, 404);
});

test('passkey challenge: no email → usernameless discoverable challenge (empty allowCredentials)', async () => {
  // No email supplied: the platform's account picker chooses among the device's
  // discoverable passkeys, so the server issues a challenge with no allowlist
  // and no user bound to it (resolved from the assertion at /login). It never
  // 404s, so it can't be used to probe which emails have passkeys.
  const res = await request().post('/api/auth/passkey/challenge').send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.challengeId);
  assert.ok(res.body.challenge);
  assert.deepEqual(res.body.allowCredentials, []);
});

test('passkey challenge: returns credentials with their E2EE PRF salts', async () => {
  const { user, auth } = await registerUser({ email: 'haspasskey@example.com' });
  await enrollKeys(auth);
  // Plant a registered credential + a matching passkey unlock factor directly —
  // a real WebAuthn attestation needs a platform authenticator.
  const credentialId = 'test-credential-b64url';
  await User.updateOne({ _id: user._id }, {
    $push: {
      passkeyCredentials: { credentialId, publicKey: 'dGVzdC1jb3NlLWtleQ', counter: 0 },
      wrappedPrivateKey: {
        factor: 'passkey', nonce: 'bm9uY2U', ct: 'Y3Q', credentialId, prfSalt: 'cHJmLXNhbHQ',
      },
    },
  });

  const res = await request().post('/api/auth/passkey/challenge').send({ email: 'haspasskey@example.com' });
  assert.equal(res.status, 200);
  assert.ok(res.body.challengeId);
  assert.ok(res.body.challenge);
  assert.deepEqual(res.body.allowCredentials, [{ id: credentialId, prfSalt: 'cHJmLXNhbHQ' }]);
});

test('passkey login: unknown challengeId and forged assertions are rejected', async () => {
  const missing = await request().post('/api/auth/passkey/login').send({});
  assert.equal(missing.status, 400);

  const bogus = await request().post('/api/auth/passkey/login')
    .send({ challengeId: 'nope', response: { id: 'test-credential-b64url' } });
  assert.equal(bogus.status, 400, 'unknown/expired challenge');

  // A real challenge with a forged assertion fails signature verification, and
  // the challenge is consumed (single-use) so a retry can't probe it again.
  const ch = await request().post('/api/auth/passkey/challenge').send({ email: 'haspasskey@example.com' });
  assert.equal(ch.status, 200);
  const forged = await request().post('/api/auth/passkey/login').send({
    challengeId: ch.body.challengeId,
    response: {
      id: 'test-credential-b64url', rawId: 'test-credential-b64url', type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    },
  });
  assert.ok([400, 401].includes(forged.status), `forged assertion rejected (got ${forged.status})`);
  const replay = await request().post('/api/auth/passkey/login')
    .send({ challengeId: ch.body.challengeId, response: { id: 'test-credential-b64url' } });
  assert.equal(replay.status, 400, 'challenge is single-use');
});

test('passkey login: usernameless challenge resolves the user by credential id', async () => {
  // A usernameless challenge binds no user; /login must resolve the account from
  // the asserted credential id. An unknown credential → 401 "Unknown passkey"
  // (no user matched); a known one gets past resolution to signature
  // verification, which a forged assertion still fails.
  const unknown = await request().post('/api/auth/passkey/challenge').send({});
  assert.equal(unknown.status, 200);
  const noMatch = await request().post('/api/auth/passkey/login')
    .send({ challengeId: unknown.body.challengeId, response: { id: 'no-such-credential' } });
  assert.equal(noMatch.status, 401, 'unresolvable credential → 401');

  // 'test-credential-b64url' was planted on haspasskey@example.com earlier, so a
  // usernameless assertion for it resolves that account (then fails on the
  // forged signature, not on user resolution).
  const known = await request().post('/api/auth/passkey/challenge').send({});
  const forged = await request().post('/api/auth/passkey/login').send({
    challengeId: known.body.challengeId,
    response: {
      id: 'test-credential-b64url', rawId: 'test-credential-b64url', type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    },
  });
  assert.ok([400, 401].includes(forged.status), `forged assertion rejected (got ${forged.status})`);
  assert.notEqual(forged.body.error, 'Unknown passkey', 'user was resolved before verification');
});

test('passkey register-options: requires auth, then issues a challenge for this RP', async () => {
  const anon = await request().post('/api/auth/passkey/register-options').send();
  assert.equal(anon.status, 401);

  const { auth } = await registerUser();
  const res = await request().post('/api/auth/passkey/register-options').set('Authorization', auth).send();
  assert.equal(res.status, 200);
  assert.ok(res.body.challenge);
  assert.equal(res.body.rp.id, 'localhost'); // PASSKEY_RP_ID default
  assert.equal(res.body.authenticatorSelection.userVerification, 'required');
});

// ── Login rate limiting (LAST — exhausts the shared per-IP budget) ────────────

test('login: per-IP limiter answers 429 after repeated failures', async () => {
  await registerUser({ email: 'target@example.com', password: 'correct-horse-1' });
  let limited = null;
  for (let i = 0; i < 11; i++) {
    const res = await request().post('/api/auth/login')
      .send({ email: 'target@example.com', password: 'wrong-guess' });
    if (res.status === 429) { limited = res; break; }
    assert.equal(res.status, 401);
  }
  assert.ok(limited, 'limiter kicked in');
  assert.ok(limited.headers['retry-after'], 'Retry-After header set');

  // Even the CORRECT password is throttled now — the window must expire first.
  const res = await request().post('/api/auth/login')
    .send({ email: 'target@example.com', password: 'correct-horse-1' });
  assert.equal(res.status, 429);
});
