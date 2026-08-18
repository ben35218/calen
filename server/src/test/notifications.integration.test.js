// Integration tests for the notifications server surface (spec:
// features/notifications.md): push-device registration (web + native), the
// replace-on-re-register semantics, and the local-reminders flag the daily
// reminder cron honors. Reminder *scheduling* logic (9am-per-timezone fan-out,
// audience resolution, the E2EE-household skip) is unit-tested in
// server/src/jobs/scheduler.test.js; delivery is on-device.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u, fakeEnc } = require('./harness');

// Deterministic "web push not configured" regardless of the local .env —
// services/push.js reads these at module load (on first request). Empty
// strings (not delete): dotenv only fills vars that are absent.
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const User = require('../models/User');

before(startDb);
after(stopDb);

const subs = async (u) => (await User.findById(u.user._id).lean()).pushSubscriptions || [];

test('push key endpoint: always configured (native needs no keys), web key absent without VAPID', async () => {
  const u = await registerUser({ firstName: 'Keys' });
  const res = await request().get('/api/notifications/push/key').set('Authorization', u.auth);
  assert.equal(res.status, 200);
  // Native (Expo) push works without any server config, so `configured` is
  // unconditionally true; the web public key is null when VAPID isn't set.
  assert.equal(res.body.configured, true);
  assert.equal(res.body.publicKey, null);
});

test('web subscribe validates, replaces per endpoint, and unsubscribes', async () => {
  const u = await registerUser({ firstName: 'Web' });

  const bad = await request().post('/api/notifications/push/subscribe')
    .set('Authorization', u.auth).send({ subscription: {} });
  assert.equal(bad.status, 400);

  const endpoint = 'https://push.example/ep-1';
  const first = await request().post('/api/notifications/push/subscribe')
    .set('Authorization', u.auth)
    .send({ subscription: { endpoint, keys: { p256dh: 'k1', auth: 'a1' } }, label: 'Laptop' });
  assert.equal(first.status, 200);

  // Re-subscribing the same endpoint replaces the entry (fresh keys, no duplicate).
  const again = await request().post('/api/notifications/push/subscribe')
    .set('Authorization', u.auth)
    .send({ subscription: { endpoint, keys: { p256dh: 'k2', auth: 'a2' } }, label: 'Laptop' });
  assert.equal(again.status, 200);

  let rows = await subs(u);
  assert.equal(rows.length, 1, 'one row per endpoint');
  assert.equal(rows[0].keys.p256dh, 'k2', 'the fresh keys replaced the stale ones');

  const off = await request().post('/api/notifications/push/unsubscribe')
    .set('Authorization', u.auth).send({ endpoint });
  assert.equal(off.status, 200);
  rows = await subs(u);
  assert.equal(rows.length, 0);
});

test('native register validates, coerces platform, replaces per token, and unregisters', async () => {
  const u = await registerUser({ firstName: 'Native' });

  const bad = await request().post('/api/notifications/push/register-native')
    .set('Authorization', u.auth).send({});
  assert.equal(bad.status, 400);

  const expoToken = 'ExponentPushToken[abc123]';
  const reg = await request().post('/api/notifications/push/register-native')
    .set('Authorization', u.auth).send({ expoToken, platform: 'watchOS', label: 'Phone' });
  assert.equal(reg.status, 200);

  let rows = await subs(u);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'ios', 'an unknown platform coerces to ios');
  assert.equal(rows[0].expoToken, expoToken);

  const rereg = await request().post('/api/notifications/push/register-native')
    .set('Authorization', u.auth).send({ expoToken, platform: 'android', label: 'Phone (new)' });
  assert.equal(rereg.status, 200);
  rows = await subs(u);
  assert.equal(rows.length, 1, 'one row per expo token');
  assert.equal(rows[0].platform, 'android');
  assert.equal(rows[0].label, 'Phone (new)');

  const unreg = await request().post('/api/notifications/push/unregister-native')
    .set('Authorization', u.auth).send({ expoToken });
  assert.equal(unreg.status, 200);
  assert.equal((await subs(u)).length, 0);
});

// Single-ownership (fixed 2026-08-13): an Expo token names a DEVICE, and stays
// APNs/FCM-deliverable across account switches — DeviceNotRegistered pruning
// never fires for it. Registration must therefore strip the token from every
// OTHER account, or a device whose best-effort sign-out unregister failed and
// then signed into another account receives BOTH accounts' pushes (a
// cross-household content leak).
test('registering a token under a new account strips it from the previous account', async () => {
  const a = await registerUser({ firstName: 'FirstOwner' });
  const b = await registerUser({ firstName: 'SecondOwner' });
  const expoToken = 'ExponentPushToken[shared-device-1]';

  const regA = await request().post('/api/notifications/push/register-native')
    .set('Authorization', a.auth).set('X-Device-Id', 'install-shared')
    .send({ expoToken, platform: 'ios', label: 'Phone' });
  assert.equal(regA.status, 200);
  assert.equal((await subs(a)).length, 1);

  // The device signs out of A (unregister silently fails) and into B.
  const regB = await request().post('/api/notifications/push/register-native')
    .set('Authorization', b.auth).set('X-Device-Id', 'install-shared')
    .send({ expoToken, platform: 'ios', label: 'Phone' });
  assert.equal(regB.status, 200);

  assert.equal((await subs(a)).length, 0, 'the previous account no longer holds the token');
  const rowsB = await subs(b);
  assert.equal(rowsB.length, 1, 'the token now belongs to the new account alone');
  assert.equal(rowsB[0].expoToken, expoToken);
  assert.equal(rowsB[0].deviceId, 'install-shared', 'the install id is stamped for revocation pruning');
});

// Same single-ownership rule on the legacy web-push lane (endpoint = the
// browser install's identity).
test('subscribing a web endpoint under a new account strips it from the previous account', async () => {
  const a = await registerUser({ firstName: 'WebFirst' });
  const b = await registerUser({ firstName: 'WebSecond' });
  const endpoint = 'https://push.example/shared-ep';

  await request().post('/api/notifications/push/subscribe')
    .set('Authorization', a.auth)
    .send({ subscription: { endpoint, keys: { p256dh: 'k1', auth: 'a1' } }, label: 'Browser' });
  const again = await request().post('/api/notifications/push/subscribe')
    .set('Authorization', b.auth)
    .send({ subscription: { endpoint, keys: { p256dh: 'k2', auth: 'a2' } }, label: 'Browser' });
  assert.equal(again.status, 200);

  assert.equal((await subs(a)).length, 0, 'the previous account no longer holds the endpoint');
  const rowsB = await subs(b);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsB[0].endpoint, endpoint);
});

test('local-reminders flag round-trips (the server cron skips on-device schedulers)', async () => {
  const u = await registerUser({ firstName: 'Local' });

  const on = await request().post('/api/notifications/local-reminders')
    .set('Authorization', u.auth).send({ enabled: true });
  assert.equal(on.status, 200);
  assert.equal((await User.findById(u.user._id).lean()).localReminders, true);

  const off = await request().post('/api/notifications/local-reminders')
    .set('Authorization', u.auth).send({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await User.findById(u.user._id).lean()).localReminders, false);
});

// ── Household event notify relay (stateless push for invite/RSVP) ────────────
// The server can't read the sealed event; it relays client-chosen strings after
// verifying the event Record exists in the caller's household and every
// recipient is a housemate. Nothing is stored. Delivery itself no-ops in tests
// (recipients have no push subscriptions), so `sent` is asserted as 0 — the
// contract under test is validation + membership, not Expo transport.

// Owner + member in one household with one opaque event Record.
async function setupHouseholdWithEvent() {
  const owner = await registerUser({ firstName: 'Ada', lastName: 'Owner' });
  const member = await registerUser({ firstName: 'Ben', lastName: 'Member' });
  await enrollKeys(owner.auth);
  await enrollKeys(member.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });
  const created = await request().post('/api/records')
    .set('Authorization', owner.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(created.status, 201);
  return { owner, member, eventId: created.body._id };
}

const eventRequest = (auth, body) =>
  request().post('/api/notifications/event-request').set('Authorization', auth).send(body);
const eventResponse = (auth, body) =>
  request().post('/api/notifications/event-response').set('Authorization', auth).send(body);

test('event-request validates recipients, strings, and the event record', async () => {
  const { owner, member, eventId } = await setupHouseholdWithEvent();
  const base = { toUserIds: [member.user._id], title: 'Event invitation', eventId };

  for (const bad of [
    { ...base, toUserIds: [] },                                   // no recipients
    { ...base, toUserIds: Array.from({ length: 20 }, () => member.user._id) }, // too many
    { ...base, title: undefined },                                // no title
    { ...base, title: 'x'.repeat(121) },                          // title too long
    { ...base, body: 'x'.repeat(201) },                           // body too long
    { ...base, eventId: undefined },                              // no event
    { ...base, toUserIds: ['64b000000000000000000000'] },         // unknown recipient
  ]) {
    const res = await eventRequest(owner.auth, bad);
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 80));
  }

  // An eventId outside the caller's household is indistinguishable from absent.
  const stranger = await registerUser({ firstName: 'Sam' });
  const foreign = await request().post('/api/records')
    .set('Authorization', stranger.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  const res = await eventRequest(owner.auth, { ...base, eventId: foreign.body._id });
  assert.equal(res.status, 404);
});

test('event-request rejects cross-household recipients outright', async () => {
  const { owner, member, eventId } = await setupHouseholdWithEvent();
  const stranger = await registerUser({ firstName: 'Sam', lastName: 'Stranger' });
  // One bad recipient fails the whole request — never a silent partial send.
  const res = await eventRequest(owner.auth, {
    toUserIds: [member.user._id, stranger.user._id], title: 'Event invitation', eventId,
  });
  assert.equal(res.status, 400);
});

test('event-request succeeds for housemates, skipping the sender', async () => {
  const { owner, member, eventId } = await setupHouseholdWithEvent();
  // Including the sender is harmless — they're skipped, not an error.
  const res = await eventRequest(owner.auth, {
    toUserIds: [member.user._id, owner.user._id],
    title: 'Event invitation',
    body: 'Ada invited you to “Lake day” — accept or decline',
    eventId,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, 0, 'no push subscriptions in tests — validated and no-oped');
});

test('event-response relays to one housemate and enforces the same membership rules', async () => {
  const { owner, member, eventId } = await setupHouseholdWithEvent();

  const ok = await eventResponse(member.auth, {
    toUserId: owner.user._id, title: 'Invitation accepted',
    body: 'Ben accepted “Lake day”', eventId,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sent, 0);

  const stranger = await registerUser({ firstName: 'Sam' });
  const cross = await eventResponse(stranger.auth, {
    toUserId: owner.user._id, title: 'Invitation accepted', eventId,
  });
  // The stranger's household doesn't contain the event → 404 before membership.
  assert.equal(cross.status, 404);

  const missing = await eventResponse(member.auth, { title: 'Invitation accepted', eventId });
  assert.equal(missing.status, 400, 'toUserId is required');
});
