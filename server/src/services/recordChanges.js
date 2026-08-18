// Real-time record-change fanout ("poke and pull"). When a record in a
// household changes, every other member's connected device gets a tiny poke —
// NEVER content, never a record id — and responds by running its normal
// /records/sync cursor pull. The channel stays content-blind by construction
// (the server can't read records anyway; the poke doesn't even name one), and
// because the cursor is the sole data path, a lost/duplicate/reordered poke is
// harmless: the next pull converges regardless.
//
// Two poke sources feed one delivery layer:
//   - the write routes (routes/records.js) call recordTouched() after each
//     successful write — the primary lane, and the only one that knows the
//     acting session (so the writer's own socket can be skipped);
//   - a MongoDB change stream on the Record collection (startChangeStream)
//     catches writes this process didn't handle — another instance, an admin
//     script, a migration. Suppressed for a channel that just emitted locally,
//     so single-instance deployments don't double-poke. Change streams need a
//     replica set (Atlas: always; mongodb-memory-server/standalone: no) — when
//     unavailable the bus simply runs in local-only mode.
//
// Delivery: in-process subscribers (the WebSocket layer, services/recordSocket)
// get a coalesced callback per channel; separately, a debounced DATA-ONLY silent
// push (`type: 'records_changed'`, no title/body) fans out to the household
// members' native devices so a backgrounded app can refresh its replica before
// the user next opens it. Pokes from the change stream schedule no push — only
// the instance that handled the write does, so multi-instance never double-sends.
//
// Channels: `hh:<householdId>` for household members, `u:<userId>` for a solo
// user (their own multi-device case). Resource-scoped collaborators (shared
// calendars/trips across households) are NOT poked in v1 — they converge via
// the normal pull triggers.
const { pushToUser } = require('./notify');

const subscribers = new Map();   // channel -> Set<fn({ exceptSessionId })>
const pendingPokes = new Map();  // channel -> { timer, sessionIds: Set<string|null> }
const pendingPushes = new Map(); // channel -> timer
const lastLocalTouch = new Map(); // channel -> ms timestamp

// Coalescing windows. Poke: absorb a burst of writes (a bulk save) into one
// send. Push: silent pushes wake devices — debounce harder. Overridable for
// tests (setTimings), never in production.
let timings = {
  pokeDelayMs: 250,
  pushDelayMs: 3000,
  streamSuppressMs: 2000,
  // Change-stream reconnect backoff: starts at the initial value, doubles per
  // failed attempt up to the max, and resets to the initial once a reconnected
  // stream proves healthy (see startChangeStream).
  streamRetryInitialMs: 5000,
  streamRetryMaxMs: 60_000,
  // "Demonstrably healthy" = the stream delivered a change event OR simply
  // stayed up this long — a quiet household may not write for hours, so
  // survival is evidence enough that the connection is good.
  streamHealthyAfterMs: 30_000,
};

function setTimings(next) {
  timings = { ...timings, ...next };
}

function channelFor(householdId, userId) {
  if (householdId) return `hh:${householdId}`;
  return userId ? `u:${userId}` : null;
}

// Subscribe a delivery callback (the socket layer). Returns the unsubscribe.
function subscribe(channel, fn) {
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) subscribers.delete(channel);
  };
}

function deliverPoke(channel, exceptSessionId) {
  const set = subscribers.get(channel);
  if (!set) return;
  for (const fn of set) {
    try { fn({ exceptSessionId }); } catch { /* one bad subscriber never blocks the rest */ }
  }
}

// Coalesced poke: one delivery per channel per window. The writer's session is
// excluded only when EVERY write in the window came from that same session —
// mixed writers mean everyone might be behind, so everyone gets poked.
function schedulePoke(channel, sessionId) {
  const pending = pendingPokes.get(channel);
  if (pending) {
    pending.sessionIds.add(sessionId ? String(sessionId) : null);
    return;
  }
  const entry = { sessionIds: new Set([sessionId ? String(sessionId) : null]), timer: null };
  entry.timer = setTimeout(() => {
    pendingPokes.delete(channel);
    const ids = [...entry.sessionIds];
    const except = ids.length === 1 && ids[0] ? ids[0] : null;
    deliverPoke(channel, except);
  }, timings.pokeDelayMs);
  if (entry.timer.unref) entry.timer.unref();
  pendingPokes.set(channel, entry);
}

// Debounced silent push to every member's native devices. Content-blind by
// design: the payload is only "your household's records changed". The writer's
// own devices are included on purpose — their OTHER devices (iPad, second
// phone) want the refresh, and the push is invisible.
function schedulePush(channel) {
  if (pendingPushes.has(channel)) return;
  const timer = setTimeout(() => {
    pendingPushes.delete(channel);
    fanoutSilentPush(channel).catch(() => {});
  }, timings.pushDelayMs);
  if (timer.unref) timer.unref();
  pendingPushes.set(channel, timer);
}

async function fanoutSilentPush(channel) {
  const User = require('../models/User'); // lazy: keep module load order flexible
  const query = channel.startsWith('hh:')
    ? { householdId: channel.slice(3) }
    : { _id: channel.slice(2) };
  const users = await User.find(query).select('pushSubscriptions');
  for (const user of users) {
    if (!user.pushSubscriptions?.length) continue;
    await pushToUser(user, { silent: true, data: { type: 'records_changed' } });
  }
}

// The write routes' entry point: poke the channel's sockets and schedule the
// silent push. Fire-and-forget — never throws into a request handler.
function recordTouched({ householdId, userId, sessionId } = {}) {
  const channel = channelFor(householdId, userId);
  if (!channel) return;
  lastLocalTouch.set(channel, Date.now());
  schedulePoke(channel, sessionId);
  schedulePush(channel);
}

// ── Change stream (out-of-band writes) ──────────────────────────────────────

let stream = null;
// Current reconnect backoff; null = at the initial value (healthy).
let streamRetryMs = null;
let streamDisabled = false;
let streamDown = false;   // a death was logged; the next healthy stream logs recovery
let restartTimer = null;

function handleStreamEvent(ev) {
  if (!['insert', 'update', 'replace'].includes(ev.operationType)) return;
  const doc = ev.fullDocument;
  if (!doc) return;
  const channel = channelFor(doc.householdId, doc.userId);
  if (!channel) return;
  // A write this process just handled already poked (with session exclusion) —
  // don't double-poke the channel for the same burst.
  const local = lastLocalTouch.get(channel);
  if (local && Date.now() - local < timings.streamSuppressMs) return;
  schedulePoke(channel, null); // no push: only the writing instance pushes
}

function startChangeStream() {
  if (stream || streamDisabled) return;
  const Record = require('../models/Record');
  try {
    stream = Record.watch([], { fullDocument: 'updateLookup' });
  } catch (err) {
    console.warn('[recordChanges] change stream unavailable:', err.message);
    stream = null;
    return;
  }
  const s = stream;
  let died = false;    // one death → one teardown + one scheduled restart,
                       // however many of error/close/end fire for it
  let healthy = false;

  // Backoff reset: a reconnected stream is "demonstrably healthy" once it
  // delivers a change event or stays up streamHealthyAfterMs — only then does
  // the NEXT outage start over at the initial retry interval. Resetting on
  // mere reconnect would defeat the backoff when the server accepts the
  // connection and immediately drops it in a loop.
  const healthyTimer = setTimeout(markHealthy, timings.streamHealthyAfterMs);
  if (healthyTimer.unref) healthyTimer.unref();
  function markHealthy() {
    if (died || healthy) return;
    healthy = true;
    streamRetryMs = null;
    if (streamDown) {
      streamDown = false;
      console.error('[recordChanges] change stream recovered — cross-instance poke fanout restored');
    }
  }

  s.on('change', (ev) => {
    markHealthy();
    handleStreamEvent(ev);
  });

  // A stream can die every way a socket can: 'error', but also a clean
  // 'close'/'end' with no error at all (primary stepdown, idle LB reset).
  // Before this handled only 'error', a silent close left `stream` non-null,
  // so every later startChangeStream() no-op'd and cross-instance poke fanout
  // stayed dead until the process restarted.
  const onDeath = (label) => (err) => {
    if (died) return;
    died = true;
    clearTimeout(healthyTimer);
    try { s.close(); } catch { /* already closed */ }
    if (stream === s) stream = null;
    if (s.__intentionalClose) return; // stopChangeStream — no restart
    const unsupported = err && (err.code === 40573 || /only supported on replica sets/i.test(err.message || ''));
    if (unsupported) {
      // Standalone mongod (dev/tests) — local-only mode is the whole story.
      streamDisabled = true;
      console.warn('[recordChanges] change streams unsupported here — running local-only');
      return;
    }
    const wait = streamRetryMs ?? timings.streamRetryInitialMs;
    streamDown = true;
    console.error(
      `[recordChanges] change stream ${label}${err ? `: ${err.message}` : ''} — cross-instance poke fanout down, reconnecting in ${wait}ms`,
    );
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startChangeStream();
    }, wait);
    if (restartTimer.unref) restartTimer.unref();
    streamRetryMs = Math.min(wait * 2, timings.streamRetryMaxMs);
  };
  s.on('error', onDeath('error'));
  s.on('close', onDeath('closed'));
  s.on('end', onDeath('ended'));
}

// Tear the stream down without scheduling a restart (shutdown / tests).
function stopChangeStream() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const s = stream;
  stream = null;
  if (s) {
    s.__intentionalClose = true;
    try { s.close(); } catch { /* already closed */ }
  }
}

// Test-only visibility into the reconnect state machine.
function streamStateForTest() {
  return {
    active: Boolean(stream),
    retryMs: streamRetryMs ?? timings.streamRetryInitialMs,
    disabled: streamDisabled,
    restartScheduled: Boolean(restartTimer),
  };
}
function resetStreamForTest() {
  stopChangeStream();
  streamRetryMs = null;
  streamDisabled = false;
  streamDown = false;
}

module.exports = {
  channelFor, subscribe, recordTouched, startChangeStream, stopChangeStream, setTimings,
  streamStateForTest, resetStreamForTest,
};
