const mongoose = require('mongoose');

// Do-not-call suppression for outbound AI phone calls (spec: features/ai-assistant.md
// "Phone calls" → do-not-call). One row per suppressed phone number, checked
// before EVERY outbound call (services/dnc.js `isSuppressed`). Scope is
// platform-wide by number, not per-household: the recipient's right to stop
// automated calls is against Calen as a whole, so there is no householdId on the
// match path.
//
// Privacy: the raw number is NEVER stored. `numberHash` is an HMAC-SHA256 of the
// E.164 number (keyed by DNC_HASH_SECRET) — deterministic so a placement can
// match it, not reversible into a plaintext directory of who opted out. `last4`
// is kept only so an admin can recognize an entry (e.g. "•••1262"). This makes
// the model a deliberate plaintext/unsealed exception because it must be
// server-queryable before a call can be placed.
const schema = new mongoose.Schema({
  numberHash: { type: String, required: true, unique: true }, // HMAC-SHA256(E.164)
  last4:      { type: String },                               // display only
  // How the number got here. 'callee-request' = the person asked on the call;
  // 'inbound-sms' = a future STOP text; 'support'/'user' = added by hand.
  source: { type: String, enum: ['callee-request', 'inbound-sms', 'support', 'user'], required: true },
  note:   { type: String },
  active: { type: Boolean, default: true }, // an admin can release (active:false) without losing the record
  // Who added it, when known (admin/user actions; null for callee/sms).
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('DncEntry', schema);
