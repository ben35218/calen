const mongoose = require('mongoose');

// In-app feedback: a signed-in user's question, bug report, or idea, submitted
// from Profile → "Help & feedback" (spec: features/feedback.md). Durable so an
// admin can triage it — not a fire-and-forget email. Deliberately PLAINTEXT (a
// narrow exception to the E2EE mandate): it is support content the operator must
// be able to read, and the user chose to send it to us. Keep the exception
// narrow — `diagnostics` carries only non-sensitive device/app context.
const feedbackSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  householdId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  type:         { type: String, enum: ['question', 'bug', 'idea'], default: 'question', index: true },
  // The user's message. Capped — enough to act on, not an essay.
  message:      { type: String, default: '', maxlength: 4000 },
  // Optional reply-to (defaults to the account email on the client, editable).
  contactEmail: { type: String, default: '' },
  // Auto-captured client context so a report is actionable without a round-trip.
  // Never household content, secrets, or precise location.
  diagnostics: {
    appVersion:  { type: String, default: '' },
    buildNumber: { type: String, default: '' },
    platform:    { type: String, default: '' },
    osVersion:   { type: String, default: '' },
    deviceModel: { type: String, default: '' },
    route:       { type: String, default: '' },
    locale:      { type: String, default: '' },
  },
  status:       { type: String, enum: ['new', 'triaged', 'resolved'], default: 'new', index: true },
}, { timestamps: true });

module.exports = mongoose.model('Feedback', feedbackSchema);
