const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const recurrenceSchema = new mongoose.Schema({
  type: { type: String, enum: ['interval', 'calendar', 'one-time'], required: true },
  intervalValue: Number,
  intervalUnit: { type: String, enum: ['days', 'weeks', 'months', 'years'] },
  months: [Number],      // for calendar type: which months; for yearly interval: anchor month [1–12]
  dayOfMonth: Number,    // 1–31 anchor day for monthly/yearly intervals and calendar type
  dayOfWeek: Number,     // 0=Sun … 6=Sat anchor for weekly intervals, or weekday for monthly weekOfMonth
  weekOfMonth: Number,   // 1–4 or -1 (last) — which occurrence of dayOfWeek in the month
  // Per-occurrence scoping, mirroring CalendarEvent's recurrence. `skipDates`
  // are YYYY-MM-DD occurrences struck out one at a time ("Delete This Task
  // Only"); `until` ends the series ("Delete All Future"). Both live INSIDE
  // recurrence so the existing TASK_ENC subset seals them with the rule.
  skipDates: [String],
  until: Date,
}, { _id: false });

const taskSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
  categoryId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  title: { type: String, required: requiredUntilSealed },
  // MaterialCommunityIcons glyph (from the source template or user-picked);
  // the mobile app falls back to the category icon when this is absent.
  icon: String,
  description: String,
  instructions: String,
  recurrence: recurrenceSchema,
  estimatedDurationMins: Number,
  estimatedCost: Number,
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  seasonal: Boolean,
  lastCompletedAt: Date,
  nextDueDate: Date,
  // Per-task alerts (days before the due date), mirroring chores. Default 0 =
  // alert on the due date itself. null = no alert. Delivered via push.
  reminderDaysBefore: { type: Number, default: 0 },
  alert2DaysBefore:   { type: Number, default: null },
  // Wall-clock time of day the alerts fire, `HH:mm` local. null = the 9am
  // default (ALERT_HOUR, client-side). Applies to both alert offsets.
  reminderTime:       { type: String, default: null },
  // Who the alert goes to in a shared household: 'everyone' or 'owner' (the
  // member who created the task). Only meaningful with >1 member.
  alertAudience: { type: String, enum: ['everyone', 'owner'], default: 'everyone' },
  // Explicit recipients: when non-empty, the alert reaches only these members
  // (overrides alertAudience). Empty = fall back to alertAudience ('everyone').
  alertUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  active: { type: Boolean, default: true },
  templateId: String,
  // Mileage-based tracking
  intervalKm:    Number,   // e.g. 50000 — service every 50,000 km
  lastServiceKm: Number,   // odometer reading at last completion
  nextDueKm:     Number,   // lastServiceKm + intervalKm
  // Set on a copy created by "Save for This … Only" (see maintenance.md): the
  // series this was detached from and the day it stands in for. The link lets
  // "Resume schedule" leave that day skipped instead of double-booking it.
  detachedFrom: { type: mongoose.Schema.Types.ObjectId },
  detachedDate: String,
  // Set on a series created by "Save for Future …": the truncated series it
  // forked from, so a list can collapse the pair to one card.
  splitFrom: { type: mongoose.Schema.Types.ObjectId },
  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

module.exports = mongoose.model('MaintenanceTask', taskSchema);
