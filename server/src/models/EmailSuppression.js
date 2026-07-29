const mongoose = require('mongoose');

// Outbound-email suppression list — the email counterpart to DncEntry (do-not-
// call). One row per address we should stop mailing, checked by
// services/mailer.js before every NON-required send. A permanent SMTP failure
// (hard bounce / 5xx) auto-suppresses; an admin can also add/release by hand.
//
// Scope + privacy: address-level and platform-wide (a bounce is about the
// mailbox, not a household). Unlike DncEntry, the address is stored in the
// clear: it must be queryable on the send path (`isSuppressed`), and it's the
// same no-reply@ recipient already recorded on EmailLog rows — no extra
// exposure. Required security mail (password reset, security alert) bypasses
// this list entirely, so a bounced address never blocks account recovery.
const schema = new mongoose.Schema({
  email:  { type: String, required: true, unique: true, lowercase: true, trim: true },
  // Why it's suppressed. 'hard_bounce'/'complaint' are set automatically from a
  // permanent delivery failure; 'manual' is an admin add.
  reason: { type: String, enum: ['hard_bounce', 'complaint', 'manual'], required: true },
  // Where it came from: the reconcile/send path ('delivery') or an admin.
  source: { type: String, enum: ['delivery', 'admin'], default: 'delivery' },
  note:   { type: String },
  active: { type: Boolean, default: true }, // released = active:false (record kept)
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // admin adds only
}, { timestamps: true });

schema.index({ active: 1, updatedAt: -1 });

// Is this address currently suppressed? Cheap, indexed, best-effort (a lookup
// failure must never block a send — the caller treats a throw as "not suppressed").
schema.statics.isSuppressed = async function isSuppressed(email) {
  if (!email) return false;
  const row = await this.findOne({ email: String(email).toLowerCase().trim(), active: true }).lean();
  return !!row;
};

// Upsert a suppression, reactivating a previously-released row. Idempotent on email.
schema.statics.suppress = async function suppress({ email, reason, source = 'delivery', note, createdBy }) {
  if (!email) return null;
  return this.findOneAndUpdate(
    { email: String(email).toLowerCase().trim() },
    { $set: { reason, source, active: true, ...(note ? { note } : {}), ...(createdBy ? { createdBy } : {}) } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('EmailSuppression', schema);
