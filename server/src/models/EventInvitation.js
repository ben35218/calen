const mongoose = require('mongoose');
const crypto = require('crypto');

// A cross-household calendar-event invitation, addressed by EMAIL or by PHONE
// (SMS). Sharing an event outside the household is a deliberate step across the
// E2EE boundary. Two snapshot lanes (Signal-parity D3):
//   - PLAINTEXT `event`: for non-account email/SMS recipients (a recipient with
//     no keys can't receive ciphertext) — this is what the emailed/public .ics
//     is built from (scope contract #1).
//   - SEALED `sealedEvent`: when the invited address is an account with enrolled
//     keys, the organizer's device seals the snapshot to the recipient's
//     identity public key (an anonymous sealed box — crypto/openJsonFromMember);
//     no plaintext reaches the server. A lazily-claimed plaintext invite upgrades
//     to this on claim (the recipient re-seals to itself; see routes/invitations).
// The source CalendarEvent is never touched — accepting creates an independent
// copy owned by the recipient, so the snapshot here is the complete contract
// between the two households.
const eventInvitationSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Display snapshot of the sender, so the recipient's list renders without a
  // populate (and survives the sender later changing their name/email).
  fromName:   String,
  fromEmail:  String,

  // Exactly one of toEmail/toPhone is set. Phone invites are sent as a text
  // from the organizer's own device (no account resolution — accounts are
  // keyed by email) and carry the public .ics link below.
  toEmail:  { type: String, lowercase: true, trim: true },
  toPhone:  { type: String, trim: true },
  // Resolved when toEmail matches an account — at send time, or lazily on the
  // recipient's first fetch if they register later.
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Capability secret for the public (unauthenticated) .ics download link —
  // the SMS equivalent of the email's .ics attachment.
  shareToken: { type: String, default: () => crypto.randomBytes(16).toString('hex') },

  // The source event (informational — the snapshot below is authoritative).
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent' },
  // The PLAINTEXT snapshot lane (non-account email/SMS recipients). Absent when
  // the snapshot is sealed to a known account (sealedEvent below). `title`/
  // `startDate` are NOT schema-required — a sealed invite carries no plaintext —
  // but the pre('validate') hook requires one lane or the other.
  event: {
    title:        String,
    description:  String,
    location:     String,
    url:          String,
    phone:        String,
    startDate:    Date,
    endDate:      Date,
    allDay:       { type: Boolean, default: true },
    calendarType: { type: String, enum: ['activities', 'appointments'], default: 'activities' },
  },
  // The SEALED snapshot lane (D3): an anonymous sealed box (b64url) of the event
  // snapshot to the recipient's identityPublicKey. Opaque to the server; only
  // the recipient's unlocked device opens it. Mutually exclusive with a plaintext
  // `event` — a lazily-claimed plaintext invite drops `event` when this is set.
  sealedEvent: { type: String },

  // Signal-parity C3b: guestListVisible is a SEALED event field now, so the server
  // can't read it off the source event to gate the recipient's guest-list view.
  // The organizer's device stamps it onto the invitation at invite time; the
  // /:id/guests gate reads it here. Missing = visible (predates the setting).
  guestListVisible: { type: Boolean, default: true },

  // 'left'   = the recipient accepted, then later left the event (their copy is
  //            deleted but the organizer's invitee list still shows they were
  //            invited).
  // 'merged' = the two parties have since joined the SAME household, so the
  //            cross-household contract this row encodes no longer applies: the
  //            event is now shared by sync and the invitee lives on the event's
  //            sealed `householdInvitees` with an `EventRsvp` carrying the
  //            answer. Terminal and inert — a merged row is hidden from both
  //            inboxes and never acted on again; it is kept only as the audit
  //            trail of an invitation that predates the merge. Written by
  //            `POST /invitations/:id/merge` (routes/invitations.js).
  status:      { type: String, enum: ['pending', 'accepted', 'declined', 'left', 'merged'], default: 'pending' },
  respondedAt: Date,
  // When the invitation was reconciled into the shared household (status 'merged').
  mergedAt:    Date,
  // The recipient's copy created on accept — what a leave (recipient) or a
  // revoke (organizer) deletes.
  acceptedEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent' },
}, { timestamps: true });

eventInvitationSchema.pre('validate', function () {
  if (!this.toEmail && !this.toPhone) throw new Error('An invitee email or phone number is required');
  // Exactly one snapshot lane: a plaintext event (with the minimum display
  // fields) OR a sealed blob. A sealed invite carries no plaintext at all.
  const hasPlaintext = !!(this.event && this.event.title && this.event.startDate);
  if (!hasPlaintext && !this.sealedEvent) throw new Error('Event content is required');
});

eventInvitationSchema.index({ toEmail: 1, status: 1 });
eventInvitationSchema.index({ toUserId: 1, status: 1 });

module.exports = mongoose.model('EventInvitation', eventInvitationSchema);
