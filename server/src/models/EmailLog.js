const mongoose = require('mongoose');

// Outbound-email delivery ledger for the admin console. Every services/mailer.js
// send records one row keyed by `kind` (a services/emailCatalog.js key), so
// admins can monitor what left no-reply@householdcalendar.com and reconcile
// what didn't.
//
// Status is a small state machine:
//   sent       delivered to the SMTP server
//   dry        SMTP unconfigured — logged, not sent
//   canceled   skipped because the template is disabled, or an admin canceled a retry
//   suppressed recipient is on the EmailSuppression list (non-required mail)
//   queued     a transient/provider-blocked failure — parked in the OUTBOX for
//              retry (jobs/emailReconcile.js re-sends when nextAttemptAt is due)
//   failed     terminal — permanent bounce, or retries exhausted
//
// Bodies are normally NOT stored (recipients can be E2EE-household invitees;
// subject + kind is enough to monitor). The one exception is the transient
// `payload` sub-doc: while a row is `queued`, it holds exactly what's needed to
// re-send, and it is CLEARED the moment the row reaches any terminal state — an
// ephemeral outbox, not long-term retention. Rows are best-effort observability:
// a logging failure never blocks the send it describes.
const emailLogSchema = new mongoose.Schema({
  to:      { type: String, required: true },
  subject: { type: String, required: true },
  // Which template sent it (welcome, password_reset, …) — a catalog key.
  kind:    { type: String, default: 'other' },
  status:  { type: String, required: true, enum: ['sent', 'failed', 'dry', 'queued', 'suppressed', 'canceled'] },
  error:   { type: String },

  // Delivery/outbox bookkeeping.
  attempts:     { type: Number, default: 1 },          // send attempts so far
  responseCode: { type: Number },                      // last SMTP response code, when known
  failureKind:  { type: String, enum: ['transient', 'permanent', null], default: null },
  lastError:    { type: String },                      // most-recent failure message
  nextAttemptAt:{ type: Date },                        // when a `queued` row is due for retry
  // Transient outbox payload — present ONLY while `status:'queued'`. Cleared on
  // any terminal state. Attachments carry file paths (invite.ics text / e-card
  // photo paths), never decoded bodies beyond the email itself.
  payload: {
    from:        { type: String },
    text:        { type: String },
    html:        { type: String },
    attachments: { type: mongoose.Schema.Types.Mixed },
  },
}, { timestamps: { createdAt: 'at', updatedAt: false } });

emailLogSchema.index({ at: -1 });
emailLogSchema.index({ status: 1, at: -1 });
emailLogSchema.index({ kind: 1, at: -1 });
// Reconcile query: due queued rows, oldest first.
emailLogSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model('EmailLog', emailLogSchema);
