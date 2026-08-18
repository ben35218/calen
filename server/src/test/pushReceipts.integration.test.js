// Integration tests for the Expo push RECEIPT pass (jobs/pushReceipts.js).
//
// A send's immediate ticket misses most DeviceNotRegistered results — Expo
// reports them in the receipt, fetched later. Pins:
//   (1) a successful native send persists its ticket (PushTicket row with the
//       owning userId + exact expoToken, so the prune can be targeted);
//   (2) a receipt reporting DeviceNotRegistered prunes exactly that
//       subscription row (same effect as the ticket-level 410 prune);
//   (3) a receipt with status ok leaves the subscription alone;
//   (4) a non-DeviceNotRegistered receipt error is log-only — the device isn't
//       gone, so the subscription must survive;
//   (5) processed rows are deleted; a ticket with no receipt yet stays queued.
// The Expo transport is stubbed (axios for the send, push.fetchExpoReceipts
// for the receipts) — the contract under test is persistence + pruning.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { startDb, stopDb, request, registerUser } = require('./harness');

const User = require('../models/User');
const PushTicket = require('../models/PushTicket');
const pushService = require('../services/push');
const { pushToUser } = require('../services/notify');
const { runPushReceiptCheck } = require('../jobs/pushReceipts');

// Every stored ticket is old enough for its receipt "immediately".
process.env.PUSH_RECEIPT_DELAY_MS = '0';

before(startDb);
after(stopDb);

const origAxiosPost = axios.post;
const origFetchReceipts = pushService.fetchExpoReceipts;
function restoreStubs() {
  axios.post = origAxiosPost;
  pushService.fetchExpoReceipts = origFetchReceipts;
}

// Register a user and give them a native subscription through the real API.
let tokenSeq = 0;
async function userWithNativeSub() {
  const u = await registerUser({ firstName: 'Push' });
  const expoToken = `ExponentPushToken[rcpt-${tokenSeq++}]`;
  const reg = await request().post('/api/notifications/push/register-native')
    .set('Authorization', u.auth).send({ expoToken, platform: 'ios' });
  assert.equal(reg.status, 200);
  return { ...u, expoToken };
}

const subsOf = async (userId) =>
  (await User.findById(userId).select('pushSubscriptions').lean()).pushSubscriptions || [];

test('a native send persists its Expo ticket for the receipt pass', async (t) => {
  t.after(restoreStubs);
  const u = await userWithNativeSub();
  axios.post = async () => ({ data: { data: [{ status: 'ok', id: 'ticket-persist-1' }] } });

  const user = await User.findById(u.user._id);
  const res = await pushToUser(user, { title: 'Hi', body: 'there' });
  assert.equal(res.sent, 1);

  // create() is fire-and-forget — give it a beat.
  await new Promise((r) => setTimeout(r, 50));
  const row = await PushTicket.findOne({ ticketId: 'ticket-persist-1' }).lean();
  assert.ok(row, 'the ticket was stored');
  assert.equal(String(row.userId), String(u.user._id));
  assert.equal(row.expoToken, u.expoToken);
});

test('a DeviceNotRegistered receipt prunes the subscription; an ok receipt does not', async (t) => {
  t.after(restoreStubs);
  const dead = await userWithNativeSub();
  const alive = await userWithNativeSub();
  await PushTicket.create([
    { ticketId: 'ticket-dead-1', userId: dead.user._id, expoToken: dead.expoToken },
    { ticketId: 'ticket-ok-1', userId: alive.user._id, expoToken: alive.expoToken },
  ]);

  pushService.fetchExpoReceipts = async (ids) => {
    assert.ok(ids.includes('ticket-dead-1') && ids.includes('ticket-ok-1'));
    return {
      'ticket-dead-1': { status: 'error', message: 'device gone', details: { error: 'DeviceNotRegistered' } },
      'ticket-ok-1': { status: 'ok' },
    };
  };

  const out = await runPushReceiptCheck();
  assert.equal(out.pruned, 1);

  assert.equal((await subsOf(dead.user._id)).length, 0, 'the dead token row is pruned');
  assert.equal((await subsOf(alive.user._id)).length, 1, 'a delivered send leaves the row alone');
  // Both tickets are consumed — the pass never re-reads a fetched receipt.
  assert.equal(await PushTicket.countDocuments({ ticketId: { $in: ['ticket-dead-1', 'ticket-ok-1'] } }), 0);
});

test('other receipt errors are log-only, and a missing receipt stays queued', async (t) => {
  t.after(restoreStubs);
  const u = await userWithNativeSub();
  await PushTicket.create([
    { ticketId: 'ticket-toobig-1', userId: u.user._id, expoToken: u.expoToken },
    { ticketId: 'ticket-pending-1', userId: u.user._id, expoToken: u.expoToken },
  ]);

  pushService.fetchExpoReceipts = async () => ({
    'ticket-toobig-1': { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
    // ticket-pending-1 has no receipt yet.
  });

  await runPushReceiptCheck();

  assert.equal((await subsOf(u.user._id)).length, 1, 'a non-DeviceNotRegistered error never prunes');
  assert.equal(await PushTicket.countDocuments({ ticketId: 'ticket-toobig-1' }), 0, 'the errored receipt is consumed');
  assert.equal(await PushTicket.countDocuments({ ticketId: 'ticket-pending-1' }), 1, 'the unready ticket waits for the next run');
});

test('a failed getReceipts call keeps every ticket for the next run', async (t) => {
  t.after(restoreStubs);
  const u = await userWithNativeSub();
  await PushTicket.create({ ticketId: 'ticket-retry-1', userId: u.user._id, expoToken: u.expoToken });
  pushService.fetchExpoReceipts = async () => { throw new Error('expo down'); };

  const out = await runPushReceiptCheck();
  assert.deepEqual(out, { checked: 0, pruned: 0 });
  assert.equal(await PushTicket.countDocuments({ ticketId: 'ticket-retry-1' }), 1);
});
