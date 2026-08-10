// The client half of the record-change poke channel ("poke and pull"). While
// the app is foregrounded and signed in, one WebSocket to /api/records/ws stays
// open; the server sends `{"type":"changed"}` when a housemate writes a record,
// and the client responds by scheduling its normal cursor sync
// (lib/calendarData.scheduleRevalidate) — the socket itself never carries data,
// so a dropped/duplicate poke is harmless and reconnect recovery is just
// "revalidate once on open".
//
// Connection policy: connect on start (sign-in / app foreground), exponential
// backoff with jitter on failure (1s → 30s), backoff reset once a connection
// opens, everything torn down on stop (background / sign-out). The manager is
// dependency-injected so the reconnect logic is unit-testable without a real
// socket (mirrors records.ts's RecordSyncDeps seam).

export interface RecordSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface RecordSocketDeps {
  // Create a socket, or null when a connection can't even be attempted yet
  // (no auth token) — treated as a failed attempt and retried with backoff.
  connect: () => RecordSocketLike | null;
  onPoke: () => void;
  minBackoffMs: number;
  maxBackoffMs: number;
  random: () => number; // injectable jitter source
}

export interface RecordSocketManager {
  start(): void;
  stop(): void;
  isConnected(): boolean;
}

const defaultDeps = (): RecordSocketDeps => ({
  connect: () => {
    const { getCachedToken } = require('./secureToken');
    const token = getCachedToken();
    if (!token) return null;
    const { API_URL } = require('../config');
    const url = `${API_URL.replace(/^http/, 'ws')}/records/ws`;
    // RN's WebSocket accepts an options bag with headers as the third argument
    // (not in the DOM lib types, hence the cast).
    return new (WebSocket as any)(url, null, {
      headers: { Authorization: `Bearer ${token}` },
    }) as RecordSocketLike;
  },
  onPoke: () => require('./calendarData').scheduleRevalidate(),
  minBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  random: Math.random,
});

export function createRecordSocket(overrides: Partial<RecordSocketDeps> = {}): RecordSocketManager {
  const deps = { ...defaultDeps(), ...overrides };
  let running = false;
  let connected = false;
  let socket: RecordSocketLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = deps.minBackoffMs;

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (!running || retryTimer) return;
    const jittered = backoffMs * (0.5 + deps.random() / 2); // 50–100% of the step
    backoffMs = Math.min(backoffMs * 2, deps.maxBackoffMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, jittered);
  };

  const teardown = () => {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(); } catch { /* already closed */ }
    socket = null;
    connected = false;
  };

  const open = () => {
    if (!running || socket) return;
    let next: RecordSocketLike | null = null;
    try { next = deps.connect(); } catch { next = null; }
    if (!next) {
      scheduleRetry();
      return;
    }
    socket = next;
    socket.onopen = () => {
      connected = true;
      backoffMs = deps.minBackoffMs;
      // Catch up on anything that happened while disconnected — the cursor
      // makes this exact, however long the gap was.
      deps.onPoke();
    };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg?.type === 'changed') deps.onPoke();
      } catch { /* not ours */ }
    };
    const onGone = () => {
      teardown();
      scheduleRetry();
    };
    socket.onclose = onGone;
    socket.onerror = onGone;
  };

  return {
    start() {
      if (running) return;
      running = true;
      backoffMs = deps.minBackoffMs;
      open();
    },
    stop() {
      running = false;
      clearRetry();
      teardown();
    },
    isConnected: () => connected,
  };
}
