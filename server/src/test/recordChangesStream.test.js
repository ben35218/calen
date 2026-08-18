// Unit tests for the record change stream's failure handling (poke-and-pull's
// cross-instance lane, services/recordChanges.js). No DB: `Record.watch` is
// stubbed with EventEmitter streams, which is all the handler wiring sees.
//
// Pins:
//   (1) a stream ending via 'close' (no error!) schedules a restart and a new
//       stream is created — before this, only 'error' was handled, so a silent
//       close left the dead handle in place and every later start no-op'd;
//   (2) multiple death events for one stream (close + error + end) schedule
//       exactly ONE restart;
//   (3) the reconnect backoff doubles across consecutive failures and RESETS
//       to the initial interval once a reconnected stream proves healthy
//       (stays up streamHealthyAfterMs, or delivers a change event);
//   (4) the replica-set-unsupported error still disables the lane for good;
//   (5) stopChangeStream tears down without scheduling a restart.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { setTimeout: sleep } = require('timers/promises');

const Record = require('../models/Record');
const {
  startChangeStream, stopChangeStream, setTimings, streamStateForTest, resetStreamForTest,
} = require('../services/recordChanges');

// Tight timings so the assertions don't wait out production backoff.
const INITIAL = 20;
const HEALTHY = 30;
const MAX = 160;

let created = [];
function fakeStream() {
  const s = new EventEmitter();
  s.closed = false;
  s.close = () => { s.closed = true; };
  return s;
}
Record.watch = () => {
  const s = fakeStream();
  created.push(s);
  return s;
};

beforeEach(() => {
  resetStreamForTest();
  setTimings({ streamRetryInitialMs: INITIAL, streamHealthyAfterMs: HEALTHY, streamRetryMaxMs: MAX });
  created = [];
});

test("a 'close' without an error schedules a restart and a second stream comes up", async () => {
  startChangeStream();
  assert.equal(created.length, 1);
  assert.equal(streamStateForTest().active, true);

  created[0].emit('close');
  // The dead handle is released immediately (so a restart isn't no-op'd) and
  // the retry is on the clock.
  assert.equal(streamStateForTest().active, false);
  assert.equal(streamStateForTest().restartScheduled, true);

  await sleep(INITIAL + 15);
  assert.equal(created.length, 2, 'a fresh stream was created');
  assert.equal(streamStateForTest().active, true);
});

test('one death firing close + error + end schedules exactly one restart', async () => {
  startChangeStream();
  created[0].emit('close');
  created[0].emit('error', new Error('boom'));
  created[0].emit('end');

  await sleep(INITIAL * 3);
  assert.equal(created.length, 2, 'the burst of death events produced a single reconnect');
});

test('backoff doubles across failures and resets once the stream proves healthy', async () => {
  startChangeStream();
  assert.equal(streamStateForTest().retryMs, INITIAL);

  // Two quick deaths: the backoff climbs.
  created[0].emit('error', new Error('down 1'));
  assert.equal(streamStateForTest().retryMs, INITIAL * 2);
  await sleep(INITIAL + 15);
  assert.equal(created.length, 2);
  created[1].emit('close');
  assert.equal(streamStateForTest().retryMs, INITIAL * 4);

  // The next reconnect survives past streamHealthyAfterMs → backoff resets.
  await sleep(INITIAL * 2 + 15);
  assert.equal(created.length, 3);
  await sleep(HEALTHY + 15);
  assert.equal(streamStateForTest().retryMs, INITIAL, 'healthy stream resets the backoff');

  // And the reset is real: the next death waits the INITIAL interval again.
  created[2].emit('close');
  await sleep(INITIAL + 15);
  assert.equal(created.length, 4);
  stopChangeStream();
});

test('a change event also marks the stream healthy (quiet households need not wait)', async () => {
  startChangeStream();
  created[0].emit('error', new Error('down'));
  assert.equal(streamStateForTest().retryMs, INITIAL * 2);
  await sleep(INITIAL + 15);
  assert.equal(created.length, 2);

  // A delivered change is proof of health — no need to outlive the timer.
  created[1].emit('change', { operationType: 'noop' });
  assert.equal(streamStateForTest().retryMs, INITIAL, 'backoff reset on first change');
  stopChangeStream();
});

test('the replica-set-unsupported error disables the lane instead of retrying', async () => {
  startChangeStream();
  created[0].emit('error', Object.assign(new Error('only supported on replica sets'), { code: 40573 }));
  assert.equal(streamStateForTest().disabled, true);
  assert.equal(streamStateForTest().restartScheduled, false);

  await sleep(INITIAL + 15);
  startChangeStream(); // must stay a no-op
  assert.equal(created.length, 1);
});

test('stopChangeStream tears down without scheduling a restart', async () => {
  startChangeStream();
  const s = created[0];
  stopChangeStream();
  assert.equal(s.closed, true);
  assert.equal(streamStateForTest().active, false);
  // Even if the driver emits close after our intentional close(), no restart.
  s.emit('close');
  await sleep(INITIAL + 15);
  assert.equal(created.length, 1);
  assert.equal(streamStateForTest().restartScheduled, false);
});
