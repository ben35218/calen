// Integration-test harness: boots the REAL Express app (src/app.js) over an
// in-memory MongoDB (mongodb-memory-server), so route logic, middleware, and
// mongoose models all execute for real — no mocks. Each *.integration.test.js
// file runs in its own node:test process and owns one mongod instance.
//
// Usage in a test file:
//   const { startDb, stopDb, getApp, registerUser, enrollKeys, b64u } = require('./harness');
//   before(startDb); after(stopDb);

// Deterministic env BEFORE any app module loads. dotenv (if a .env exists) does
// not override pre-set vars, so these win regardless of local config.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = 'integration-test-secret';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-used';
process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || require('os').tmpdir() + '/hc-test-uploads';
// Pin the mongod binary cache to a cwd-independent path: when the suite runs
// through the root `npm test` fan-out, mongodb-memory-server would otherwise
// resolve node_modules/.cache from the repo root and every parallel test
// process would race-download the binary (corrupting its MD5 check). Same path
// the CI workflow caches.
process.env.MONGOMS_DOWNLOAD_DIR =
  process.env.MONGOMS_DOWNLOAD_DIR || require('path').join(require('os').homedir(), '.cache', 'mongodb-binaries');
delete process.env.E2EE_MIN_APP_VERSION; // version gate is exercised explicitly per test

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const supertest = require('supertest');

let mongod = null;

async function startDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

async function stopDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

// Lazy so env above is set before the route modules load.
let app = null;
function getApp() {
  if (!app) app = require('../app');
  return app;
}

function request() {
  return supertest(getApp());
}

// A plausible opaque base64url blob (sealed box / ciphertext stand-in). The
// server never verifies crypto — only shape — so any b64url string works.
function b64u(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// A well-formed record ciphertext blob (`enc` field) as clients dual-write it.
function fakeEnc() {
  return { alg: 'xchacha20poly1305-ietf', nonce: b64u(32), ct: b64u(96) };
}

// Register through the real API: creates the User, their solo Household,
// seeded categories, and self-Contact — exactly like production onboarding.
// Returns { token, user, auth } where auth is the Authorization header value.
let ipSeq = 0;
async function registerUser({ email, password = 'test-password-1', firstName = 'Test', lastName = 'User' } = {}) {
  // A distinct source IP per registration (the app trusts X-Forwarded-For), so
  // suites that create many accounts don't trip the per-IP register limiter.
  ipSeq += 1;
  const res = await request().post('/api/auth/register')
    .set('X-Forwarded-For', `10.0.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`)
    .send({
      email: email || `user-${b64u(8).toLowerCase()}@example.com`,
      password, firstName, lastName,
    });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const auth = `Bearer ${res.body.token}`;
  // The register response omits householdId etc. — fetch the full user record.
  const me = await request().get('/api/auth/me').set('Authorization', auth);
  return { token: res.body.token, user: { ...res.body.user, ...me.body }, auth };
}

// Enroll E2EE keys through the real API (identity public key + password factor).
async function enrollKeys(auth) {
  const res = await request().post('/api/keys/enroll').set('Authorization', auth).send({
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
  if (res.status >= 300) throw new Error(`enroll failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

// Second user joins the first user's household via the real invite → accept →
// approve flow: the approver invites the joiner's email, the joiner accepts
// (opening a JoinRequest), then the approver wraps the current HDK to them and
// approves. Returns after approval.
async function joinHousehold({ joiner, approver, keyVersion }) {
  const inviteRes = await request().post('/api/household/invitations')
    .set('Authorization', approver.auth).send({ email: joiner.user.email });
  if (inviteRes.status >= 300) throw new Error(`invite failed: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  const inbox = await request().get('/api/household/invitations/mine').set('Authorization', joiner.auth);
  const invite = inbox.body.find((i) => i.status === 'pending');
  if (!invite) throw new Error('no pending household invitation found');
  const acceptRes = await request().post(`/api/household/invitations/${invite._id}/accept`)
    .set('Authorization', joiner.auth).send({});
  if (acceptRes.status >= 300) throw new Error(`accept failed: ${acceptRes.status} ${JSON.stringify(acceptRes.body)}`);
  const pending = await request().get('/api/household/join-requests').set('Authorization', approver.auth);
  const reqRow = pending.body.find((r) => String(r.requesterUserId) === String(joiner.user._id));
  if (!reqRow) throw new Error('no pending join request found');
  const approveRes = await request().post(`/api/household/join-requests/${reqRow._id}/approve`)
    .set('Authorization', approver.auth)
    .send({ keyVersion, wrappedHDK: b64u(96) });
  if (approveRes.status >= 300) throw new Error(`approve failed: ${approveRes.status} ${JSON.stringify(approveRes.body)}`);
}

module.exports = { startDb, stopDb, getApp, request, b64u, fakeEnc, registerUser, enrollKeys, joinHousehold };
