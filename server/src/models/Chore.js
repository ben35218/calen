const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const recurrenceSchema = new mongoose.Schema({
  type: { type: String, enum: ['interval', 'calendar', 'one-time'], required: true },
  intervalValue: Number,
  intervalUnit: { type: String, enum: ['days', 'weeks', 'months', 'years'] },
  months: [Number],
  dayOfMonth: Number,
  dayOfWeek: Number,
  weekOfMonth: Number,
}, { _id: false });

const choreSchema = new mongoose.Schema({
  userId:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed },
  title:                { type: String, required: requiredUntilSealed },
  instructions:         String,
  description:          String, // legacy — superseded by `instructions`
  recurrence:           recurrenceSchema,
  assignedTo:           { type: mongoose.Schema.Types.ObjectId, ref: 'Person' },
  nextDueDate:          Date,
  // Alerts (days before the due date). Default 0 = alert on the due date itself.
  // null = no alert. Delivered via push.
  reminderDaysBefore:   { type: Number, default: 0 },
  alert2DaysBefore:     { type: Number, default: null },
  // Wall-clock time of day the alerts fire, `HH:mm` local. null = the 9am
  // default (ALERT_HOUR, client-side). Applies to both alert offsets.
  reminderTime:         { type: String, default: null },
  // Who the alert goes to in a shared household: 'everyone' or 'owner' (creator).
  alertAudience:        { type: String, enum: ['everyone', 'owner'], default: 'everyone' },
  active:               { type: Boolean, default: true },
  templateId:           String,
  icon:                 { type: String, default: 'mdi-broom' },
  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

module.exports = mongoose.model('Chore', choreSchema);
