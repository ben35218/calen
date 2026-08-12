const mongoose = require('mongoose');

// Server-side audit trail for the E2EE key/membership lifecycle plus sensitive
// admin actions. Records who did what and when — never any content. Phase 2
// writes `hdk_minted` and `member_approved`; the admin-action events are written
// from the admin web app's routes. See docs/E2EE-SYNC-PLAN.md §4.5.
const AUDIT_EVENTS = [
  'hdk_minted', 'member_approved', 'member_removed', 'hdk_rotated', 'hdk_retired', 'key_enrolled',
  // Lost-every-factor recovery (specs/platform/crypto-e2ee.md "Re-key"): the
  // account abandoned its identity key for a fresh one. Meta carries how many
  // of its own records were left unreadable and how many envelopes were
  // cleared — never content.
  'key_rekeyed',
  // The solo "start fresh" that can ride a re-key: nobody else held the HDK, so
  // the household's permanently unreadable records were purged and its key
  // version reset for a fresh mint. Meta carries the purge count — never content.
  'hdk_reset',
  // A calendar owner re-wrapped their CalendarKey to a re-keyed collaborator's
  // NEW identity. The deliberate, human-approved half of that recovery.
  'calendar_access_reapproved',
  'factor_added', 'factor_removed', // unlock-factor envelope changes (Signal-parity A1)
  // Guardian recovery lifecycle (specs/features/guardian-recovery.md). Meta is
  // the guardian's userId only — never the PIN, envelope, or any key material.
  'guardian_armed',    // user nominated a household member as recovery guardian
  'guardian_disarmed', // user removed their guardian envelope
  'guardian_approved', // guardian re-sealed the inner envelope for a recovery request
  'passkey_signin_added',           // a WebAuthn sign-in credential was registered
  'session_created', 'session_revoked', // device sign-in lifecycle (Signal-parity F2/F3)
  'device_linked',   // a device received the E2EE keys via QR linking (Signal-parity F4)
  'account_deleted', // user permanently deleted their account from the app (5.1.1(v))
  'plaintext_dropped', // §9 point-of-no-return: household went E2EE-live
  'plaintext_redropped', // Signal-parity pass-2 re-drop: newer DROP_FIELDS columns nulled after re-seal
  // Admin-console actions (who changed what from the admin web app):
  'admin_role_changed', // an admin granted/revoked another user's admin role
  'plan_changed',       // legacy: an admin manually overrode a household's plan (subscription era)
  'unlock_changed',     // an admin manually granted/revoked a user's app unlock
  'credits_adjusted',   // an admin manually adjusted a user's credit balance
  'config_changed',     // an admin saved the monetization config (meta: changed leaf paths)
  'moderation_status_changed', // an admin triaged a content report (meta: reportId, from, to)
  'feedback_status_changed', // an admin triaged in-app feedback (meta: feedbackId, from, to)
  // Do-not-call suppression for outbound AI calls (spec: features/ai-assistant.md).
  // Meta carries source + last4 + actor — never the full number.
  'dnc_suppressed', // a number was added to the do-not-call list (callee request / admin / sms)
  'dnc_released',   // an admin released a number from the do-not-call list
  // Support-mailbox access — a privacy-relevant surface (admins reading user
  // email), so every read/reply/move is accountable. Meta is uid+mailbox only,
  // never message content or addresses.
  'support_message_read',
  'support_reply_sent',
  'support_message_moved',
  // Email lifecycle admin actions (spec: features/email-lifecycle.md). Meta is
  // config leaf paths / counts / the recipient address only — never a body.
  'email_config_changed',  // an admin saved the email lifecycle config (meta: changed paths)
  'email_suppressed',      // an admin added an address to the suppression list
  'email_released',        // an admin released an address from the suppression list
  'email_reconcile_run',   // an admin manually triggered the delivery reconcile pass (meta: summary)
  // Release QA (spec: features/release-qa.md). Meta is ids/counts about our own
  // release process — never product content.
  'qa_release_created',        // an admin opened a release record for a build
  'qa_release_status_changed', // planning → testing → submitted → released / rolled-back
  'qa_cases_imported',         // a plan document was imported (meta: sourceDoc + the four counts)
  'qa_run_completed',          // a test run was closed (meta: runId, releaseId, result count)
  'qa_release_signed_off',     // the sign-off gate accepted (meta: coverage at the moment of signing)
];

const auditLogSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  event: {
    type: String,
    required: true,
    enum: AUDIT_EVENTS,
  },
  meta: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: { createdAt: 'at', updatedAt: false } });

auditLogSchema.index({ householdId: 1, at: -1 });
auditLogSchema.index({ event: 1, at: -1 }); // event-filtered admin queries

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
AuditLog.EVENTS = AUDIT_EVENTS;

module.exports = AuditLog;
