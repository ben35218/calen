const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const calendarEventSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed },
  // Built-in event calendars, plus user-defined ones: the mobile Calendars →
  // Add Calendar screen mints `custom-<slug>` ids on-device.
  calendarType:{ type: String, required: true, match: /^(activities|appointments|custom-[a-z0-9]+)$/ },
  title:       { type: String, required: requiredUntilSealed },
  description: String,
  location:    String,
  placeId:     String,
  url:         String,
  startDate:   { type: Date, required: requiredUntilSealed },
  endDate:     Date,
  allDay:      { type: Boolean, default: true },
  phone:       String,
  travelMinutes:    Number,
  travelDistanceKm: Number,
  reminderMinutes: Number,
  reminderAt:      Date,
  reminderSentAt:  Date,
  alert2Minutes:   Number,
  alert2At:        Date,
  alert2SentAt:    Date,
  // What each alert's lead time was set against: the event's start ('event',
  // the default and what an older record without the field means) or departure
  // ('leave' — "30 min before leaving"). Both are stored as minutes before the
  // EVENT in the fields above, so the scheduler needs nothing from these; they
  // carry the framing the client shows the setting back in.
  alertAnchor:     { type: String, enum: ['event', 'leave'] },
  alert2Anchor:    { type: String, enum: ['event', 'leave'] },
  // Who the alert goes to in a shared household: 'everyone' or 'owner' (creator).
  alertAudience:   { type: String, enum: ['everyone', 'owner'], default: 'everyone' },
  // Whether cross-household invitees may see who else is invited (the guests
  // endpoint in routes/invitations.js). Plaintext scope field, like alertAudience.
  guestListVisible: { type: Boolean, default: true },
  // Set when this event is a copy created by accepting a cross-household
  // invitation (routes/invitations.js). Its presence switches the client's
  // Delete action to "Leave event" (which retires the invitation too).
  invitationId: { type: mongoose.Schema.Types.ObjectId, ref: 'EventInvitation' },
  // Set when Calen's cancellation call got the business to confirm (services/
  // phoneCalls.js). Plaintext status field, like alertAudience; the event stays
  // on the calendar, marked cancelled.
  cancelled: Boolean,
  recurrence: {
    freq:     { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: Number, default: 1 },
    until:    Date,
    // Weekly: which weekdays it repeats on (0=Sun..6=Sat).
    daysOfWeek: { type: [Number], default: undefined },
    // Monthly "each": numbered dates of the month (1..31).
    daysOfMonth: { type: [Number], default: undefined },
    // Yearly: which months (1..12).
    months: { type: [Number], default: undefined },
    // Monthly "on the" / yearly "days of week": ordinal (1..5, -1=last,
    // -2=next to last) + day kind. For yearly it applies within each month.
    weekOfMonth: Number,
    weekdayKind: {
      type: String,
      enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'day', 'weekday', 'weekend'],
    },
  },

  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

module.exports = mongoose.model('CalendarEvent', calendarEventSchema);
