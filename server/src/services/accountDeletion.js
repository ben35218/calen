// Permanent account + data deletion (Apple Guideline 5.1.1(v): an app that
// supports account creation must let the user delete the account, and its data,
// from inside the app).
//
// Strategy: sweep every user-scoped collection by iterating the model registry
// so new content models are covered automatically — anything keyed by `userId`
// gets purged without being listed here. Key envelopes (HouseholdKeyEnvelope)
// carry `userId`, so the user's wrapped-key material goes with them.
const mongoose = require('mongoose');
const User = require('../models/User');
const Household = require('../models/Household');
const AuditLog = require('../models/AuditLog');
const mailer = require('./mailer');

// Models the userId/email sweep must never touch (handled specially or global).
const SKIP_MODELS = new Set(['User', 'Household', 'AuditLog', 'MonetizationConfig']);

// Best-effort RevenueCat subscriber purge (billing-plans.md "Account deletion
// × billing"): removes RC's copy of the purchase history for the user id and
// any stored alias — data minimization matching the full-wipe promise. It does
// NOT (and cannot) cancel a store subscription; only Apple manages those,
// which is why the client warns and the good-bye email reminds. Optional:
// skipped silently unless REVENUECAT_SECRET_API_KEY is configured, and it must
// never fail or stall the deletion itself (per-request timeout, errors eaten).
async function purgeRevenueCatSubscriber(user) {
  const key = process.env.REVENUECAT_SECRET_API_KEY;
  if (!key) return;
  const ids = [...new Set([String(user._id), user.revenueCatId].filter(Boolean))];
  await Promise.all(ids.map((id) =>
    fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  ));
}

// Delete `user` and everything they own. Handles the shared-household cases:
//   • last member out  → household + household-scoped records are deleted too
//   • others remain     → ownership is handed to the oldest remaining member and
//                         lazy key rotation (§5.2) is flagged so the removed
//                         member's key can't read future writes
// Returns a per-collection count of what was removed (content-blind).
async function deleteUserAndData(user) {
  const userId = user._id;
  const householdId = user.householdId || null;
  const deleted = {};

  // Account-deleted confirmation (account lifecycle) — sent BEFORE the purge,
  // while the address is still valid. Best-effort; the mailer never throws. The
  // EmailLog row it writes is itself swept below (email-keyed PII removal), which
  // is fine: the send is independent of the log. `hadActiveAiPlan` makes the
  // email carry the Apple-keeps-billing reminder — deleting the account can't
  // cancel the store subscription, and this pointer must survive app access.
  if (user.email) {
    mailer.sendAccountDeletedConfirmation({
      email: user.email,
      firstName: user.firstName,
      hadActiveAiPlan: Boolean(user.aiPlanActive),
    }).catch(() => {});
  }

  // RevenueCat's subscriber record goes with the account (best-effort, never
  // blocking — see purgeRevenueCatSubscriber).
  await purgeRevenueCatSubscriber(user);

  // 1. Every collection scoped to this user's own id.
  for (const [name, Model] of Object.entries(mongoose.models)) {
    if (SKIP_MODELS.has(name)) continue;
    if (!Model.schema.path('userId')) continue;
    const res = await Model.deleteMany({ userId });
    if (res.deletedCount) deleted[name] = res.deletedCount;
  }

  // 2. Records that reference the user only by email address (invitations,
  //    delivered-email logs) — PII that must go even though it isn't userId-keyed.
  if (user.email) {
    for (const [name, Model] of Object.entries(mongoose.models)) {
      if (SKIP_MODELS.has(name)) continue;
      const emailPath = ['email', 'toEmail', 'inviteeEmail', 'to'].find((p) => Model.schema.path(p));
      if (!emailPath) continue;
      const res = await Model.deleteMany({ [emailPath]: user.email });
      if (res.deletedCount) deleted[name] = (deleted[name] || 0) + res.deletedCount;
    }
  }

  // 3. Household disposition.
  if (householdId) {
    const otherMembers = await User.countDocuments({ householdId, _id: { $ne: userId } });
    if (otherMembers === 0) {
      // Sole member — take the household and any household-scoped records with it.
      for (const [name, Model] of Object.entries(mongoose.models)) {
        if (SKIP_MODELS.has(name)) continue;
        if (!Model.schema.path('householdId')) continue;
        const res = await Model.deleteMany({ householdId });
        if (res.deletedCount) deleted[name] = (deleted[name] || 0) + res.deletedCount;
      }
      await Household.deleteOne({ _id: householdId });
    } else {
      // Family remains. Reassign ownership if the departing user held it, and
      // flag lazy HDK rotation so the removed member can't read future writes.
      const household = await Household.findById(householdId);
      if (household) {
        if (String(household.ownerId) === String(userId)) {
          const heir = await User.findOne({ householdId, _id: { $ne: userId } }).sort({ createdAt: 1 });
          if (heir) household.ownerId = heir._id;
        }
        household.keyRotationPending = true;
        await household.save();
      }
    }
  }

  // 4. Drop the user's audit trail, then delete the user and leave a single
  //    content-free tombstone so deletions stay auditable without retaining PII.
  await AuditLog.deleteMany({ userId });
  await User.deleteOne({ _id: userId });
  await AuditLog.create({
    userId,
    householdId,
    event: 'account_deleted',
    meta: { at: new Date() },
  });

  return { deleted };
}

module.exports = { deleteUserAndData, purgeRevenueCatSubscriber };
