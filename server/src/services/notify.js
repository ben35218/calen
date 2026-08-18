const User = require('../models/User');
const PushTicket = require('../models/PushTicket');
const push = require('./push');

// Push is the only notification channel. Alerts are configured per item
// (event / chore / task) and routed to an audience (everyone vs. the item's
// creator); birthdays always go to everyone. This module just fans a payload
// out to a user's subscribed devices and prunes dead subscriptions.

// Prune a push subscription the platform has expired (web 404/410, Expo
// DeviceNotRegistered). Matches web subs by endpoint, native subs by expoToken.
async function pruneSubscription(userId, sub) {
  const match = sub.expoToken ? { expoToken: sub.expoToken } : { endpoint: sub.endpoint };
  await User.updateOne({ _id: userId }, { $pull: { pushSubscriptions: match } }).catch(() => {});
}

// Remember a native send's Expo ticket so the receipt pass
// (jobs/pushReceipts.js) can fetch its delivery receipt later. Expo reports
// most DeviceNotRegistered results only in the receipt (~15 min after the
// send), so pruning on the immediate ticket alone leaves dead tokens
// accumulating forever. Fire-and-forget: losing a ticket only defers the
// prune to a later send's receipt.
function recordPushTicket(userId, sub, ticket) {
  if (!ticket?.id || !sub?.expoToken) return;
  PushTicket.create({ ticketId: ticket.id, userId, expoToken: sub.expoToken }).catch(() => {});
}

// Send a push payload to every device a user has subscribed.
// Returns { sent, failed } counts. No-ops cleanly when push isn't configured
// or the user has no subscriptions.
async function pushToUser(user, payload) {
  if (!push.isConfigured()) return { sent: 0, failed: 0 };
  const subs = user.pushSubscriptions || [];
  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      const ticket = await push.sendToSubscription(sub, payload);
      recordPushTicket(user._id, sub, ticket);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pruneSubscription(user._id, sub);
      }
    }
  }
  return { sent, failed };
}

module.exports = { pushToUser, pruneSubscription };

