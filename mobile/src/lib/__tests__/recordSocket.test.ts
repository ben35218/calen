// Unit tests for the poke-socket connection manager (lib/recordSocket): poke
// dispatch, reconnect backoff, backoff reset on success, null-connect retry,
// and stop() teardown. Everything runs on injected deps + fake timers — no real
// WebSocket, network, or config involved.
import { createRecordSocket, RecordSocketLike } from '../recordSocket';

class FakeSocket implements RecordSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() { this.closed = true; }
}

function makeManager(connectImpl?: () => RecordSocketLike | null) {
  const sockets: FakeSocket[] = [];
  const connect = jest.fn(
    connectImpl ??
      (() => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      }),
  );
  const onPoke = jest.fn();
  const manager = createRecordSocket({
    connect,
    onPoke,
    minBackoffMs: 1000,
    maxBackoffMs: 8000,
    random: () => 1, // jitter factor pinned to 100% → delay === backoff step
  });
  return { manager, connect, onPoke, sockets };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('open revalidates once, and each changed-poke revalidates again', () => {
  const { manager, onPoke, sockets } = makeManager();
  manager.start();
  const socket = sockets[0];

  socket.onopen!();
  expect(onPoke).toHaveBeenCalledTimes(1); // catch-up on connect
  expect(manager.isConnected()).toBe(true);

  socket.onmessage!({ data: '{"type":"changed"}' });
  expect(onPoke).toHaveBeenCalledTimes(2);

  socket.onmessage!({ data: '{"type":"something-else"}' });
  socket.onmessage!({ data: 'not json' });
  expect(onPoke).toHaveBeenCalledTimes(2); // foreign messages are ignored
});

test('a dropped connection reconnects with doubling backoff, capped', () => {
  const { manager, connect, sockets } = makeManager();
  manager.start();
  expect(connect).toHaveBeenCalledTimes(1);

  // Fail without ever opening: 1000 → 2000 → 4000 → 8000 → 8000 (cap)
  const expectDelays = [1000, 2000, 4000, 8000, 8000];
  for (let i = 0; i < expectDelays.length; i++) {
    sockets[i].onclose!();
    jest.advanceTimersByTime(expectDelays[i] - 1);
    expect(connect).toHaveBeenCalledTimes(i + 1); // not yet
    jest.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(i + 2);
  }
});

test('a successful open resets the backoff', () => {
  const { manager, connect, sockets } = makeManager();
  manager.start();
  sockets[0].onclose!();
  jest.advanceTimersByTime(1000); // first retry after min backoff
  expect(connect).toHaveBeenCalledTimes(2);

  sockets[1].onopen!(); // success — backoff must reset to the floor
  sockets[1].onclose!();
  jest.advanceTimersByTime(1000);
  expect(connect).toHaveBeenCalledTimes(3);
});

test('connect returning null (no token yet) retries with backoff', () => {
  const { manager, connect } = makeManager(() => null);
  manager.start();
  expect(connect).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1000);
  expect(connect).toHaveBeenCalledTimes(2);
});

test('stop() closes the socket and cancels reconnects', () => {
  const { manager, connect, sockets } = makeManager();
  manager.start();
  const socket = sockets[0];
  socket.onopen!();

  manager.stop();
  expect(socket.closed).toBe(true);
  expect(manager.isConnected()).toBe(false);

  jest.advanceTimersByTime(60_000);
  expect(connect).toHaveBeenCalledTimes(1); // no zombie reconnect loop

  // And a late event from the torn-down socket is inert (handlers cleared).
  expect(socket.onclose).toBeNull();
});
