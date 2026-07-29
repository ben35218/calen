// Integration tests for the notifications server surface (spec:
// features/notifications.md): push-device registration (web + native), the
// replace-on-re-register semantics, and the local-reminders flag the daily
// reminder cron honors. Reminder *scheduling* logic (9am-per-timezone fan-out,
// audience resolution, the E2EE-household skip) is unit-tested in
// server/src/jobs/scheduler.test.js; delivery is on-device.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

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
