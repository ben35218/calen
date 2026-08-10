// The WebSocket half of the record-change poke channel (services/recordChanges).
// Mobile clients hold a socket at /api/records/ws; when a housemate writes a
// record, the connected devices receive `{"type":"changed"}` and run their
// normal /records/sync cursor pull. The socket carries pokes ONLY — no content,
// no record ids — so it adds nothing to the server's knowledge (Signal-parity:
// the server already sees encrypted write traffic; this reveals no more).
//
// Auth mirrors requireAuth's session semantics without the Express middleware:
// a Bearer token (Authorization header — RN's WebSocket supports headers — or
// ?token= for parity with requireAuth's query fallback), verified against
// JWT_SECRET, and a sid-carrying token is only honored while its session row
// exists (F2 revocation: signing out a device kills its socket auth on the
// next connect). An ALREADY-OPEN socket of a freshly revoked session lives
// until it disconnects — accepted: pokes are content-blind ("something
// changed", no content/id/author), and the revoked session's actual pull hits
// requireAuth and 401s, so the residual exposure is nil.
//
// The channel is snapshotted at connect (household or solo). A user who joins/
// leaves a household mid-connection is re-channeled on their next connect —
// the client reconnects on foreground, so the staleness window is short.
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const User = require('../models/User');
const { channelFor, subscribe } = require('./recordChanges');

const WS_PATH = '/api/records/ws';
const HEARTBEAT_MS = 30_000;

async function authenticate(req) {
  const url = new URL(req.url, 'http://internal');
  const header = req.headers.authorization;
  const token = (header?.startsWith('Bearer ') ? header.slice(7) : null) || url.searchParams.get('token');
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
  const user = await User.findById(payload.userId).select('householdId sessions');
  if (!user) return null;
  if (payload.sid && !(user.sessions || []).some((s) => String(s._id) === String(payload.sid))) {
    return null; // session revoked
  }
  return {
    channel: channelFor(user.householdId, user._id),
    sessionId: payload.sid ? String(payload.sid) : null,
  };
}

function attachRecordSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://internal').pathname; } catch { pathname = null; }
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    authenticate(req)
      .then((ctx) => {
        if (!ctx || !ctx.channel) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, ctx);
        });
      })
      .catch(() => socket.destroy());
  });

  wss.on('connection', (ws, req, ctx) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const unsubscribe = subscribe(ctx.channel, ({ exceptSessionId }) => {
      // Skip the writer's own socket — its device already has the write locally.
      if (exceptSessionId && ctx.sessionId && exceptSessionId === ctx.sessionId) return;
      if (ws.readyState === ws.OPEN) ws.send('{"type":"changed"}');
    });
    ws.on('close', unsubscribe);
    ws.on('error', () => ws.terminate());
  });

  // Standard ws liveness reaping: a socket that missed a whole heartbeat round
  // is dead (device slept, network dropped) — terminate so its subscription
  // frees up. The client reconnects with backoff.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

module.exports = { attachRecordSocket, WS_PATH };
