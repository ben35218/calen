const express = require('express');
const User = require('../models/User');
const Record = require('../models/Record');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const push = require('../services/push');
const { pushToUser } = require('../services/notify');
const { deviceFromReq } = require('../services/sessions');

// Push is the only notification channel. Alerts themselves are configured per
// item (event / chore / task); this route just manages a user's push devices.
const router = express.Router();
router.use(requireAuth);

router.get('/push/key', (req, res) => {
  res.json({ configured: push.isConfigured(), publicKey: push.publicKey() });
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { subscription, label } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    const { deviceId } = deviceFromReq(req);
    // Single-ownership (same rule as register-native below): the endpoint names
    // a browser install, so strip it from EVERY account before adding it fresh.
    await User.updateMany(
      { 'pushSubscriptions.endpoint': subscription.endpoint },
      { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } },
    );
    await User.updateOne({ _id: req.user._id },
      { $push: { pushSubscriptions: { endpoint: subscription.endpoint, keys: subscription.keys, label, ...(deviceId ? { deviceId } : {}) } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    await User.updateOne({ _id: req.user._id }, { $pull: { pushSubscriptions: { endpoint } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Native (mobile app) push registration. The Expo push token uniquely
// identifies the DEVICE (not the account), and APNs/FCM keep it valid across
// account switches — so registration enforces single ownership: the token is
// stripped from EVERY user before being added to the caller. Without that, a
// device whose best-effort sign-out unregister failed and then signed into
// another account would keep receiving the previous account's pushes (a
// cross-household content leak that DeviceNotRegistered pruning can never
// catch, because the token stays deliverable). The install's X-Device-Id is
// stored alongside so session revocation can prune this device's subscription.
router.post('/push/register-native', async (req, res) => {
  try {
    const { expoToken, platform, label } = req.body;
    if (!expoToken) return res.status(400).json({ error: 'Missing expoToken' });
    const plat = platform === 'ios' || platform === 'android' ? platform : 'ios';
    const { deviceId } = deviceFromReq(req);
    await User.updateMany(
      { 'pushSubscriptions.expoToken': expoToken },
      { $pull: { pushSubscriptions: { expoToken } } },
    );
    await User.updateOne({ _id: req.user._id },
      { $push: { pushSubscriptions: { platform: plat, expoToken, label, ...(deviceId ? { deviceId } : {}) } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/push/unregister-native', async (req, res) => {
  try {
    const { expoToken } = req.body;
    await User.updateOne({ _id: req.user._id }, { $pull: { pushSubscriptions: { expoToken } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Household event notify relay (stateless). The sender's device asks the
// server to push a client-chosen title/body to housemates — an event-invite
// request, or the accept/decline reply back to the creator. The server stores
// nothing and can't read the event; it only verifies the event record exists
// in the caller's household and that every recipient is a housemate.
// ---------------------------------------------------------------------------
const eventNotifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many notifications. Please try again shortly.' });

const MAX_RECIPIENTS = 19;
const MAX_TITLE = 120;
const MAX_BODY = 200;

// Shared validation: returns { error } or { recipients } (self excluded).
async function validateEventNotify(req, toUserIds) {
  const { title, body, eventId } = req.body || {};
  if (!req.user.householdId) return { error: 'You need a household to notify members' };
  if (!Array.isArray(toUserIds) || !toUserIds.length) return { error: 'Recipients are required' };
  if (toUserIds.length > MAX_RECIPIENTS) return { error: 'Too many recipients' };
  if (!title || typeof title !== 'string' || title.length > MAX_TITLE) return { error: 'A title is required' };
  if (body != null && (typeof body !== 'string' || body.length > MAX_BODY)) return { error: 'Body too long' };
  if (!eventId) return { error: 'Missing eventId' };
  const exists = await Record.exists({ _id: eventId, householdId: req.user.householdId, deleted: { $ne: true } });
  if (!exists) return { notFound: true };
  const users = await User.find({ _id: { $in: toUserIds } }).select('householdId pushSubscriptions');
  if (users.length !== new Set(toUserIds.map(String)).size) return { error: 'Unknown recipient' };
  if (users.some((u) => String(u.householdId) !== String(req.user.householdId))) {
    return { error: 'Recipients must be in your household' };
  }
  return { recipients: users.filter((u) => String(u._id) !== String(req.user._id)) };
}

// "Ben invited you to «Dinner» — accept or decline" → selected housemates.
router.post('/event-request', eventNotifyLimiter, async (req, res) => {
  try {
    const { title, body, eventId, toUserIds } = req.body || {};
    const v = await validateEventNotify(req, toUserIds);
    if (v.notFound) return res.status(404).json({ error: 'Event not found' });
    if (v.error) return res.status(400).json({ error: v.error });
    let sent = 0;
    for (const u of v.recipients) {
      const r = await pushToUser(u, {
        title, body,
        data: { type: 'household_event_request', eventId },
        tag: `hh-event-req-${eventId}`,
      });
      sent += r.sent;
    }
    res.json({ sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Alan accepted «Dinner»" → back to the event's creator.
router.post('/event-response', eventNotifyLimiter, async (req, res) => {
  try {
    const { title, body, eventId, toUserId } = req.body || {};
    const v = await validateEventNotify(req, toUserId ? [toUserId] : []);
    if (v.notFound) return res.status(404).json({ error: 'Event not found' });
    if (v.error) return res.status(400).json({ error: v.error });
    let sent = 0;
    for (const u of v.recipients) {
      const r = await pushToUser(u, {
        title, body,
        data: { type: 'household_event_response', eventId },
        tag: `hh-event-resp-${eventId}-${req.user._id}`,
      });
      sent += r.sent;
    }
    res.json({ sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A client toggles this when it schedules reminders on-device (Phase 5); the
// server reminder cron then skips this user so they aren't notified twice.
router.post('/local-reminders', async (req, res) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $set: { localReminders: !!req.body.enabled } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
