const User = require('../models/User');
const { pushToUser } = require('./notify');

// Security alerts (Signal-parity plan A1/F3): fan a notification out to every
// member of a household when key material, unlock factors, or membership
// change — including the actor's own other devices, so an account compromise
// that adds a factor is visible to the victim. Alerts are best-effort and must
// never fail the request that triggered them.

async function alertHousehold(householdId, { title, body, tag, excludeUserId } = {}) {
  if (!householdId) return;
  // excludeUserId: skip one member (e.g. the just-approved joiner, who gets their
  // own dedicated notification instead of the household-wide one about them).
  const filter = excludeUserId ? { householdId, _id: { $ne: excludeUserId } } : { householdId };
  const users = await User.find(filter, 'pushSubscriptions');
  for (const u of users) {
    await pushToUser(u, { title, body, tag: tag || 'security', url: '/profile' }).catch(() => {});
  }
}

async function alertUser(userId, { title, body, tag, data }) {
  const u = await User.findById(userId, 'pushSubscriptions');
  if (u) await pushToUser(u, { title, body, tag: tag || 'security', url: '/profile', ...(data ? { data } : {}) }).catch(() => {});
}

// Fire-and-forget wrapper: callers await nothing and errors only log.
function securityAlert(promise) {
  promise.catch((err) => console.warn('[securityAlerts]', err.message));
}

module.exports = { alertHousehold, alertUser, securityAlert };
