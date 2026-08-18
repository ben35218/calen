const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { pushToUser } = require('./notify');
const { sendNewDeviceAlert } = require('./mailer');

// Device sessions (Signal-parity plan F2/F3). A session row is created whenever
// a credential sign-in mints a token; its subdoc id rides in the JWT as `sid`.
// Deleting the row revokes the token (middleware/auth checks membership).
// Creation on an unfamiliar device also fans out the F3 "new sign-in" alert to
// the account email + the user's other devices — the loud takeover signal.

const MAX_SESSIONS = 20;

// Device identity comes from client-sent headers (the mobile api client sets
// them). Spoofable — fine: they label/key the rows and tune alert noise; they
// never grant a session (revocation keys on the JWT `sid`). `deviceId` is the
// install's stable random UUID — unlike the name it is unique per install and
// unguessable, so it can safely key row coalescing, the familiar-device check,
// and (routes/auth isKnownDevice) the F1 reset-hold skip for an install that
// signed in before but has since signed out.
function deviceFromReq(req) {
  return {
    deviceId: (req.get('x-device-id') || '').slice(0, 64) || undefined,
    deviceName: (req.get('x-device-name') || '').slice(0, 80) || 'Unknown device',
    platform: (req.get('x-device-platform') || '').slice(0, 20),
  };
}

// Create a session row for this sign-in and return its id (the JWT `sid`).
// A sign-in from a known install (matching `deviceId`) REPLACES that install's
// row — fresh sid (revoking the install's previous token), updated labels and
// lastSeenAt, original createdAt — so one install = one Devices row. Sign-ins
// without the header (legacy clients) append as before. `quiet` suppresses the
// new-device alert (registration: the account is seconds old, no one to warn).
async function createSession(userId, req, { quiet = false } = {}) {
  const device = deviceFromReq(req);
  const sid = new mongoose.Types.ObjectId();
  const user = await User.findById(userId, 'sessions email firstName pushSubscriptions');
  if (!user) return sid; // account vanished mid-flight; token will 401 anyway

  // This install's existing row, if any. Only ever matched on the unguessable
  // deviceId — NEVER on name+platform, which are non-unique ("iPhone") and
  // attacker-choosable: merging on them would hide a second real device and
  // let an attacker fold into an existing row, suppressing the F3 alert.
  const existing = device.deviceId
    ? user.sessions.find((s) => s.deviceId === device.deviceId)
    : undefined;

  // Unfamiliar device (F3 alert trigger) = no row for this install id; legacy
  // sign-ins without the id fall back to the old name+platform heuristic.
  // Checked BEFORE the new row is added.
  const familiar = device.deviceId
    ? Boolean(existing)
    : user.sessions.some(
        (s) => s.deviceName === device.deviceName && s.platform === device.platform,
      );

  const row = {
    _id: sid,
    ...device,
    createdAt: existing ? existing.createdAt : new Date(),
    lastSeenAt: new Date(),
  };
  const sessions = [
    ...user.sessions.filter((s) => s !== existing).map((s) => s.toObject()),
    row,
  ]
    // Cap by recency of use, not creation — a long-lived install keeps its
    // original createdAt and must not be the first row dropped.
    .sort((a, b) => new Date(a.lastSeenAt) - new Date(b.lastSeenAt))
    .slice(-MAX_SESSIONS);
  await User.updateOne({ _id: userId }, { $set: { sessions } });
  await AuditLog.create({
    userId, event: 'session_created', meta: { device: device.deviceName, platform: device.platform },
  });

  if (!quiet && !familiar) {
    // F3: loud on every unfamiliar device. Push goes to the user's already-
    // subscribed devices (the new one has no subscription yet), email as the
    // out-of-band channel an attacker-held device can't suppress.
    const body = `New sign-in to your account from ${device.deviceName}${device.platform ? ` (${device.platform})` : ''}. If this wasn't you, open Sign-in & Security and sign that device out.`;
    pushToUser(user, { title: 'New device signed in', body, tag: `signin-${userId}` }).catch(() => {});
    sendNewDeviceAlert(user, device).catch?.(() => {});
  }
  return sid;
}

// Revoke one session row. Returns true when something was removed.
// Also prunes the revoked device's push subscription: the session row's
// deviceId matches the deviceId stamped on pushSubscriptions at
// register-native/subscribe time. A remotely signed-out device 401s on every
// call from then on, so it can never run its own unregister — without this
// prune the revoked device would keep receiving the account's pushes forever
// (the token stays APNs/FCM-valid, so DeviceNotRegistered never fires).
// Legacy rows without a deviceId can't be linked and are left as-is.
async function revokeSession(userId, sid) {
  const holder = await User.findOne(
    { _id: userId, 'sessions._id': sid },
    { 'sessions.$': 1 },
  ).lean();
  const deviceId = holder?.sessions?.[0]?.deviceId;
  const res = await User.updateOne(
    { _id: userId },
    {
      $pull: {
        sessions: { _id: sid },
        ...(deviceId ? { pushSubscriptions: { deviceId } } : {}),
      },
    },
  );
  if (res.modifiedCount) {
    await AuditLog.create({ userId, event: 'session_revoked', meta: { sid: String(sid) } });
  }
  return !!res.modifiedCount;
}

module.exports = { createSession, revokeSession, deviceFromReq, MAX_SESSIONS };
