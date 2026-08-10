// Integration test for the real-time record-change poke channel (poke-and-pull).
// Pins:
//   (1) a housemate's record write pokes the other member's open WebSocket with
//       `{"type":"changed"}` — and nothing more (no content, no record id);
//   (2) the writer's own socket is NOT poked (session exclusion);
//   (3) the socket endpoint rejects a missing/garbage token;
//   (4) the silent push payload is data-only (no title/body, _contentAvailable)
//       so nothing ever surfaces visibly on the device.
// The change stream lane is intentionally not exercised: mongodb-memory-server
// runs a standalone mongod (no replica set), which is exactly the local-only
// fallback mode recordChanges is built to degrade to.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const {
  startDb, stopDb, getApp, request, b64u, registerUser, enrollKeys, joinHousehold,
} = require('./harness');

const Household = require('../models/Household');
const { attachRecordSocket, WS_PATH } = require('../services/recordSocket');
const { setTimings } = require('../services/recordChanges');
const { buildExpoMessage } = require('../services/push');

let server = null;
let port = null;

before(async () => {
  await startDb();
  // Near-instant coalescing so the assertions don't wait out production debounce.
  setTimings({ pokeDelayMs: 10, pushDelayMs: 10 });
  server = http.createServer(getApp());
  attachRecordSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) {
    // server.close() alone waits for every connection to finish its close
    // handshake — a WS client whose FIN raced the test's exit can wedge the
    // whole suite (no per-test timeout under `npm test`). Force-drop first.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await stopDb();
});

function opaqueEnc() {
  return { alg: 'xchacha20poly1305-ietf-v2', nonce: b64u(32), ct: b64u(120) };
}

// Open a socket for a user's token and wait until it's connected.
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Collect messages for `ms`, then resolve with what arrived.
function collectMessages(ws, ms = 400) {
  const seen = [];
  ws.on('message', (data) => seen.push(String(data)));
  return new Promise((resolve) => setTimeout(() => resolve(seen), ms));
}

async function setupActiveHousehold() {
  const owner = await registerUser({ firstName: 'Ada' });
  await enrollKeys(owner.auth);
  await request().post('/api/household/key')
    .set('Authorization', owner.auth).send({ keyVersion: 1, wrappedHDK: b64u(96) });
  const joiner = await registerUser({ firstName: 'Grace' });
  await enrollKeys(joiner.auth);
  await joinHousehold({ joiner, approver: owner, keyVersion: 1 });
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  await Household.updateOne({ _id: hh.body._id }, { $set: { e2eeActive: true } });
  return { owner, joiner };
}

test('a housemate write pokes the other member; the writer is excluded', async () => {
  const { owner, joiner } = await setupActiveHousehold();
  const ownerWs = await connectWs(owner.token);
  const joinerWs = await connectWs(joiner.token);
  const ownerSeen = collectMessages(ownerWs);
  const joinerSeen = collectMessages(joinerWs);

  const created = await request().post('/api/records')
    .set('Authorization', owner.auth)
    .send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.equal(created.status, 201);

  const [ownerMsgs, joinerMsgs] = await Promise.all([ownerSeen, joinerSeen]);
  assert.deepEqual(joinerMsgs, ['{"type":"changed"}'], 'the housemate is poked, content-blind');
  assert.deepEqual(ownerMsgs, [], "the writer's own session is not poked");
  ownerWs.close();
  joinerWs.close();
});

test('an update and a delete poke too', async () => {
  const { owner, joiner } = await setupActiveHousehold();
  const created = await request().post('/api/records')
    .set('Authorization', owner.auth)
    .send({ enc: opaqueEnc(), keyVersion: 1 });

  const joinerWs = await connectWs(joiner.token);
  let seen = collectMessages(joinerWs);
  await request().put(`/api/records/${created.body._id}`)
    .set('Authorization', owner.auth)
    .send({ enc: opaqueEnc(), keyVersion: 1 });
  assert.deepEqual(await seen, ['{"type":"changed"}'], 'update pokes');

  seen = collectMessages(joinerWs);
  await request().delete(`/api/records/${created.body._id}`)
    .set('Authorization', owner.auth);
  assert.deepEqual(await seen, ['{"type":"changed"}'], 'tombstone pokes');
  joinerWs.close();
});

test('the socket endpoint rejects a missing or invalid token', async () => {
  for (const suffix of ['', '?token=garbage']) {
    const failed = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}${suffix}`);
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
    });
    assert.equal(failed, true, `unauthenticated connect must fail (${suffix || 'no token'})`);
  }
});

test('the silent push message is data-only — nothing user-visible', () => {
  const msg = buildExpoMessage(
    { expoToken: 'ExponentPushToken[xyz]', platform: 'ios' },
    { silent: true, data: { type: 'records_changed' } },
  );
  assert.deepEqual(msg, {
    to: 'ExponentPushToken[xyz]',
    data: { type: 'records_changed' },
    _contentAvailable: true,
  });
  assert.ok(!('title' in msg) && !('body' in msg), 'no visible surface');
});
