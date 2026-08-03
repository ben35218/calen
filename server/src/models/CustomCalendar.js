const mongoose = require('mongoose');

// Per-person permission on a shared calendar: View Only ('view') or Full
// Access ('full' — may create/edit/delete events on the calendar).
const ACCESS = ['view', 'full'];

// A user-created calendar (mobile Calendars → Add Calendar). `key` is the
// client-minted id that events reference via calendarType (`custom-<slug>`),
// so the record's Mongo _id never leaks into event rows. Sharing tiers: the
// whole household (one access level for everyone), specific members, and
// outside emails (each gets a CalendarInvitation; accepting lands the user in
// `collaborators` with the access their email entry carries).
//
// Legacy shape note: sharedWith/sharedWithOutside/collaborators were plain
// ObjectId/String arrays before access levels; routes/calendars.js normalizes
// old rows on read (members/collaborators → their historical capability:
// members could edit household events → 'full'; outside was read-only →
// 'view'), and rows rewrite to the new shape on their next save.
const customCalendarSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key:    { type: String, required: true, unique: true, match: /^custom-[a-z0-9]+$/ },
  name:   { type: String, required: true },
  color:  { type: String, default: '#1976D2' },
  // When off, events on this calendar never display alerts (client-enforced).
  alertsEnabled:       { type: Boolean, default: true },
  // ICS subscription source. Present => this is a subscribed (read-only)
  // calendar: clients fetch/parse the feed themselves (E2EE — the server must
  // never hold the events), so no CalendarEvent rows ever carry its key.
  feedUrl: { type: String, trim: true, maxlength: 2048 },
  // Present => a holiday calendar (read-only): its events are the country's
  // holidays computed client-side from this config (like feedUrl), never
  // stored. Sharing this record syncs the config so housemates' devices show
  // the same holidays. selectedRegions = opted-in provinces/states;
  // disabledIds = cultural/religious holidays turned off.
  holiday: {
    country: { type: String },
    selectedRegions: { type: [String], default: undefined },
    disabledIds: { type: [String], default: undefined },
  },
  sharedWithHousehold: { type: Boolean, default: false },
  householdAccess:     { type: String, enum: ACCESS, default: 'full' },
  sharedWith: [{
    _id: false,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    access: { type: String, enum: ACCESS, default: 'full' },
  }],
  // Outside-household addresses (email OR phone) this calendar is shared with.
  sharedWithOutside: [{
    _id: false,
    email:  { type: String, lowercase: true, trim: true },
    phone:  { type: String, trim: true },
    access: { type: String, enum: ACCESS, default: 'view' },
  }],
  // Outside-household users who ACCEPTED their invitation. Their event access —
  // and (Signal-parity D1) their CalendarKey wrap — follows from here.
  collaborators: [{
    _id: false,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    access: { type: String, enum: ACCESS, default: 'view' },
    // Set by POST /keys/rekey when this collaborator mints a NEW identity key
    // (the lost-every-factor recovery). Their old CalendarKey envelope was
    // deleted with it, so they'd otherwise reappear as a missing member and the
    // owner's background pass would re-wrap to the new key on its own. That
    // would make "take over the mailbox, reset the password, re-key" a silent
    // route into someone else's calendar — so while this is set the automatic
    // wrap is SUPPRESSED and only an explicit owner approval
    // (POST /:key/keys/approve) re-grants. Cleared by that approval.
    keyChangedAt: { type: Date },
    // Set when the re-keyed collaborator asks for access back
    // (POST /:key/access-request). Drives the owner's approval prompt; without
    // it a key change stays suppressed but silent. Cleared by the approval.
    reapprovalRequestedAt: { type: Date },
  }],
  // Signal-parity D1: the current CalendarKey version for this outside-shared
  // calendar. 0/undefined = no CalendarKey yet (never outside-shared, or an old
  // plaintext-lane calendar pending migration). Events on the calendar seal under
  // the CalendarKey at this version instead of the household HDK. Bumped on
  // revoke/un-share (rotate + re-seal) via ResourceKeyEnvelope.
  calKeyVersion:         { type: Number, default: 0 },
  // Set when a collaborator/outside email is removed: the owner's next unlocked
  // session must rotate the CalendarKey so the removed party's key opens nothing.
  calKeyRotationPending: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('CustomCalendar', customCalendarSchema);
