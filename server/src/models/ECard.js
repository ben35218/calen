const mongoose = require('mongoose');

// A scheduled occasion e-card.
//
// PRIVACY NOTE — deliberate plaintext exception to E2EE. Unlike Contact/event
// content, an ECard is stored in PLAINTEXT (no encFields): the recipient emails
// and the card message must be readable by the server so the scheduler can
// deliver them on the occasion's date while the app is closed. This mirrors the
// existing email-invitation exception. The card is authored on-device from the
// household's decrypted contacts and POSTed in the clear by the author's choice.
// See specs/platform/crypto-e2ee.md "Deliberate plaintext exceptions".

const recipientSchema = new mongoose.Schema(
  { email: { type: String, required: true, trim: true, lowercase: true }, name: { type: String, trim: true } },
  { _id: false },
);

// A photo embedded in the card email (plaintext exception, like the message).
// The file lives on disk in UPLOAD_DIR (the shared multer store); the email
// embeds it inline via a CID attachment at send time.
const photoSchema = new mongoose.Schema({
  storageKey:  { type: String, required: true },
  contentType: { type: String, default: 'image/jpeg' },
});

const ecardSchema = new mongoose.Schema({
  // Author — drives the household scope and the send timezone.
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', index: true },
  // The occasion's subject contact (routing/dedupe only — opaque to the server).
  contactId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  kind:        { type: String, enum: ['birthday', 'anniversary', 'marriage', 'death', 'custom'], default: 'custom' },
  // Display noun / custom label carried into the email copy (author-written).
  occasionLabel: { type: String, trim: true },
  // The occasion's month/day — the card sends ONCE on its next occurrence.
  month:       { type: Number, required: true, min: 1, max: 12 },
  day:         { type: Number, required: true, min: 1, max: 31 },
  // Wall-clock send time in the author's timezone, `HH:mm`.
  sendTime:    { type: String, default: '09:00' },
  // Built-in template key (variant within a kind).
  template:    { type: String, trim: true },
  // Card typeface key ('sans' | 'serif' | 'elegant' | 'script'); empty = the
  // template's own default.
  font:        { type: String, trim: true },
  // The custom message (plaintext, deliberate exception).
  message:     { type: String, trim: true, maxlength: 2000 },
  // Author overrides for the card's framing lines. Empty = the defaults:
  // per-recipient "Dear <name>," / the template's sign-off phrase / the
  // author's first name.
  greeting:    { type: String, trim: true, maxlength: 120 },
  signoff:     { type: String, trim: true, maxlength: 120 },
  signature:   { type: String, trim: true, maxlength: 120 },
  // Photos embedded in the card (plaintext exception; capped at 3).
  photos:      { type: [photoSchema], default: [] },
  // Plaintext recipient emails (deliberate exception).
  recipients:  { type: [recipientSchema], default: [] },
  // A card sends ONCE, on its next occurrence. `active` is cleared and `sentAt`
  // stamped after a successful send, so it never fires again (no annual
  // recurrence); the hourly scheduler only queries `active: true` cards.
  active:      { type: Boolean, default: true },
  sentAt:      { type: Date, default: null },
}, { timestamps: true });

ecardSchema.index({ active: 1, month: 1, day: 1 });

module.exports = mongoose.model('ECard', ecardSchema);
