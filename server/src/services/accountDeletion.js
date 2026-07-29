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
  // is fine: the send is independent of the log.
  if (user.email) {
    mailer.sendAccountDeletedConfirmation({ email: user.email, firstName: user.firstName }).catch(() => {});
  }

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

module.exports = { deleteUserAndData };
