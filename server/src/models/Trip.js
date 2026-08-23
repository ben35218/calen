const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const tripSchema = new mongoose.Schema({
  userId:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:               { type: String, required: requiredUntilSealed },
  destination:        String,
  destinationPlaceId: String,
  destinationTz:      String,   // display label only, e.g. "Europe/Rome"
  startDate:          Date,
  endDate:            Date,
  notes:              String,
  budget:             Number,                                  // planned spend, in baseCurrency
  baseCurrency:       { type: String, default: 'CAD' },        // currency the roll-up totals into
  collaborators:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // outside-household users who accepted a share
  // Outside-household addresses (email OR phone) the owner shared this trip with.
  // Each gets a TripInvitation; accepting lands the user in `collaborators`.
  // Mirrors a shared calendar's sharedWithOutside (models/CustomCalendar.js).
  sharedWithOutside:  [{
    _id: false,
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
  }],
  // Per-family budget for this trip (the owning family + each collaborator family).
  householdBudgets:   [{
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
    budget:      Number,
    baseCurrency: { type: String, default: 'CAD' },
  }],
  // Settle-up payments recorded between families (offsets the computed debts).
  settlePayments:     [{
    fromHouseholdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
    toHouseholdId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
    amount:          Number,
    currency:        { type: String, default: 'CAD' },
    date:            { type: Date, default: Date.now },
    note:            String,
  }],
  // Signal-parity D2: the current TripKey version for this shared trip. 0 = no
  // TripKey yet (never shared, or an old plaintext-lane trip pending migration).
  // A shared trip's Trip + TripItems (+ shared_shared attachments) seal under the
  // TripKey at this version instead of the household HDK; bumped on revoke/un-
  // share (rotate + re-seal) via ResourceKeyEnvelope. Mirrors CustomCalendar.
  tripKeyVersion:         { type: Number, default: 0 },
  // Set when a collaborator/outside party is removed: the owning household's next
  // unlocked session must rotate the TripKey so the removed party's key opens
  // nothing further.
  tripKeyRotationPending: { type: Boolean, default: false },
  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

module.exports = mongoose.model('Trip', tripSchema);
