const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Household = require('../models/Household');
const { scopeClause } = require('../services/scope');

// Single place session JWTs are minted (login, register, reset, passkey login,
// sliding refresh) so the expiry policy can't drift between routes. `sid` is
// the User.sessions subdoc id backing this token (Signal-parity F2): removing
// that row revokes the token. Sid-less tokens predate the registry — accepted,
// and upgraded to a session-backed token at the sliding refresh below.
function signToken(userId, sid) {
  const payload = sid ? { userId, sid: String(sid) } : { userId };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

// One structured line per rejected token (never the token itself): which route,
// why (jwt expired / malformed / invalid signature / revoked session / any other
// error the try block caught), and whether it came from the header or ?token=.
// A client that signs out on 401 is only debuggable with this — Render's request
// log carries no path or status.
function logAuthReject(req, reason, source, token) {
  console.warn(JSON.stringify({
    msg: 'auth_reject',
    reason,
    method: req.method,
    path: (req.originalUrl || req.url || '').split('?')[0],
    source,
    tokenLen: token ? token.length : 0,
    tokenParts: token ? token.split('.').length : 0,
    ua: (req.get('user-agent') || '').slice(0, 60),
  }));
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  // Also accept token as a query param for browser-native requests (iframes, download links)
  const token = (header?.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId).select('-passwordHash');
    if (!user) {
      logAuthReject(req, 'user_not_found', header ? 'header' : 'query', token);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Session revocation (F2): a sid-carrying token is only valid while its
    // session row exists. "Sign out device" deletes the row → instant 401 here.
    let session = null;
    if (payload.sid) {
      session = (user.sessions || []).find((s) => String(s._id) === String(payload.sid));
      if (!session) {
        logAuthReject(req, 'session_revoked', header ? 'header' : 'query', token);
        return res.status(401).json({ error: 'Session revoked' });
      }
    }
    req.user = user;
    req.sessionId = payload.sid || null;
    // Sliding session: past the token's half-life, hand back a fresh token so an
    // active user never hits the hard 7-day expiry. Clients watch for this
    // header (exposed via CORS) and replace their stored token. A legacy sid-less
    // token is upgraded here: it gets a session row so it becomes revocable.
    if (payload.iat && payload.exp) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp - nowSec < (payload.exp - payload.iat) / 2) {
        let sid = payload.sid;
        if (!sid) {
          const { createSession } = require('../services/sessions');
          sid = await createSession(user._id, req, { quiet: true });
        }
        res.set('X-Refreshed-Token', signToken(String(user._id), sid));
      }
    }
    // Throttled per-session heartbeat (piggybacks the lastActiveAt cadence) so
    // the Devices list shows a meaningful "last seen".
    if (session && Date.now() - session.lastSeenAt.getTime() > 60 * 60 * 1000) {
      User.updateOne(
        { _id: user._id, 'sessions._id': session._id },
        { $set: { 'sessions.$.lastSeenAt': new Date() } },
      ).catch(() => {});
    }
    // Throttled engagement stamp (≤ once/hour/user) for the analytics DAU/WAU/MAU
    // + retention views. Content-blind and fire-and-forget so it never adds
    // latency or fails a request.
    const nowMs = Date.now();
    if (!user.lastActiveAt || nowMs - user.lastActiveAt.getTime() > 60 * 60 * 1000) {
      User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date(nowMs) } }).catch(() => {});
    }
    // Household scope: ids of all members sharing this household (incl. self).
    // Data is scoped by `userId: { $in: req.scopeIds }`, so a member's own
    // documents are automatically shared once they join a household.
    if (user.householdId) {
      const [members, household] = await Promise.all([
        User.find({ householdId: user.householdId }, '_id').lean(),
        Household.findById(user.householdId),
      ]);
      req.scopeIds = members.map((m) => m._id);
      if (!req.scopeIds.length) req.scopeIds = [user._id];
      req.household = household;   // shared settings (timezone, homeAddress, …) live here
    } else {
      req.scopeIds = [user._id];
      req.household = null;
    }
    // Signal-parity C4 (hide record authorship): the household-scoped read/write
    // filter for content collections. Once a sealed record's member-granular
    // plaintext `userId` is nulled (author sealed inside `enc`), scoping by
    // `userId ∈ scopeIds` would miss it — so we scope by the plaintext
    // `householdId` the write rule stamps. The `$or` keeps this a strict
    // superset-safe equivalent of the old filter (a legacy record with only
    // `userId` is still found; a sealed record with only `householdId` too), so
    // no data backfill is needed. A solo user (no household) stays per-user.
    // See the §C4 decision doc in docs/SIGNAL-PARITY-PLAN.md.
    req.scopeFilter = scopeClause(req.scopeIds, req.household?._id);
    next();
  } catch (err) {
    logAuthReject(
      req,
      `${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 120)}`,
      header?.startsWith('Bearer ') ? 'header' : 'query',
      token,
    );
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Gate admin-only surfaces (monetization config, household/plan management).
// Must run AFTER requireAuth so `req.user` is populated.
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, signToken };
