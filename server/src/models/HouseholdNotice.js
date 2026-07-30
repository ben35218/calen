const mongoose = require('mongoose');

// A one-off membership notice addressed to a single user, shown in their
// Invitations inbox. Unlike push (fire-and-forget, `securityAlerts`), this is a
// persisted record so a user who was offline when it happened still sees it.
//
// Kinds:
//   - `removed`  — an owner removed this user from a shared household. Removal
//     silently moves the member into a fresh solo household, so without this
//     notice they'd have no in-app explanation for why their shared data
//     disappeared.
//   - `approved` — a member approved this user's request to join, so they're now
//     in the household. The invitation row is deleted on approval, so this notice
//     is the durable in-app record of the acceptance (mirroring the invite).
//
// Keyed by `userId` (not household) because by the time they read it their
// household has changed (they left one / joined one).
//
// E2EE note: the household NAME is sealed content the server can't read, so a
// notice carries only the actor's first name (already plaintext on User, as the
// invite push uses) — never the household name.
const householdNoticeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind:   { type: String, enum: ['removed', 'approved'], required: true },
  // First name of the member who acted (removed / approved them) — display
  // snapshot; may be empty.
  actorName: { type: String },
  // The household the notice concerns (the one left for `removed`, the one joined
  // for `approved`), for support/audit correlation.
  householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  // Set when the user dismisses the notice in the Invitations "New" tab.
  acknowledgedAt: Date,
}, { timestamps: true });

householdNoticeSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('HouseholdNotice', householdNoticeSchema);
