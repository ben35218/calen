const mongoose = require('mongoose');

// An outbound AI phone call placed by the calendar assistant (call_business).
// The row is created when the call is queued with Vapi; status/summary are
// refreshed from Vapi lazily on read (GET /api/calls) and whenever the chat's
// check_call_status tool runs. `seenAt` drives the unseen-result badge on the
// Calen icon: null on a finished call = the user hasn't viewed the outcome yet.
//
// E2EE note: only what already left the device to place the call is stored
// (event title/date/phone travel in the Vapi request); the full transcript is
// NOT persisted — it stays at Vapi and is fetched through on demand.
const schema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Stamped at creation so usage metering can bump the shared household pool
  // without a lookup on each lazy refresh. Absent on legacy/solo rows (then only
  // the per-user counter moves — enough for free-tier enforcement).
  householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  callId:  { type: String, required: true, unique: true }, // Vapi call id
  eventId: { type: String },
  eventTitle: String,
  eventDate:  String, // human label, e.g. "July 22, 2026"
  // For a call placed against ONE occurrence of a recurring event, the local
  // Y-M-D of that occurrence (e.g. "2026-08-07"). Scopes the confirmed-cancel /
  // reschedule dimming to that instance so one call doesn't strike the whole
  // series. Null for non-recurring events (unscoped — matches the event on every
  // day it renders, e.g. a multi-day span) and legacy rows.
  occurrenceDate: { type: String },
  action: { type: String, enum: ['cancel', 'reschedule'], required: true },
  phone:  String,
  // queued/ringing/in-progress → ended (terminal) or failed (terminal).
  status: { type: String, default: 'queued' },
  endedReason:     String,
  summary:         String, // Vapi's post-call outcome summary
  durationSeconds: Number,
  // Vapi's PassFail success evaluation of the call's goal. A 'confirmed'
  // cancel call marks the event cancelled and files an Invitations notice.
  outcome: { type: String, enum: ['confirmed', 'unconfirmed'] },
  // Set when the recipient asked, on THIS call, not to be called again (their
  // number was added to the do-not-call list — see services/dnc.js). The
  // suppression itself is platform-wide and invisible; this per-call flag lets
  // the outcome view show an explicit "asked not to be called" notice so the
  // user knows why Calen won't dial this number again. Set by the in-call
  // webhook (routes/calls.js) and, as a backstop, by applyVapiToRow from the
  // post-call analysis (spec: features/ai-assistant.md do-not-call).
  dncCaptured: { type: Boolean, default: false },
  // Once the call ends we charge its connected `durationSeconds` against the
  // household's weekly call-time budget exactly once. `metered` guards against
  // double-counting across the lazy status refreshes.
  metered: { type: Boolean, default: false },
  seenAt: Date,
  // When the user dismissed the outcome notice in the Invitations "New" tab
  // (separate from seenAt, which the assistant's Recent-calls card sets).
  acknowledgedAt: Date,
}, { timestamps: true });

schema.index({ userId: 1, createdAt: -1 });

// Vapi statuses that mean the call is finished (successfully or not).
const TERMINAL_STATUSES = ['ended', 'failed'];
schema.statics.isTerminal = (status) => TERMINAL_STATUSES.includes(status);

module.exports = mongoose.model('PhoneCall', schema);
