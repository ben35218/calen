const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

// Apple-Contacts-style labeled value (mobile/home/work/anniversary/…). Related
// names extend it with an optional link to another Person. Under E2EE these ride
// inside the sealed `enc` blob (client mirror: lib/personFields); the plaintext
// columns exist for the pre-E2EE seed path and schema honesty.
const labeledValue = new mongoose.Schema(
  { label: { type: String, trim: true }, value: { type: String, trim: true } },
  { _id: false },
);
const relatedName = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    value: { type: String, trim: true },
    personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person' },
  },
  { _id: false },
);

const personSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed, index: true },
  // When set, this Person is the self-record for that household member's User
  // account. Self records are always type 'family' and cannot be deleted.
  accountId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
  type:         { type: String, enum: ['family', 'friend', 'service'], required: true },
  // `name` is the canonical composed display name. firstName/lastName are the
  // Apple-Contacts-style structured components the client edits and recomposes
  // `name` from; both ride inside the sealed `enc` blob under E2EE (client
  // mirror: lib/personFields + encSubsets PERSON_ENC). Optional — legacy records
  // and single-name (service) contacts carry only `name`.
  name:         { type: String, required: requiredUntilSealed, trim: true },
  firstName:    { type: String, trim: true },
  lastName:     { type: String, trim: true },
  relationship: { type: String, trim: true },  // e.g. "spouse", "daughter", "neighbor"
  birthday:     { type: Date },
  notes:        { type: String, trim: true },
  // When true, this person's birthday + dates are excluded from the Occasions
  // calendar (the shared engine skips them). Sealed content under E2EE.
  occasionsHidden: { type: Boolean, default: false },
  // Multi-value labeled fields (Apple-Contacts-style). `dates` values are
  // YYYY-MM-DD; their label carries the occasion KIND — 'anniversary',
  // 'marriage', and 'death' are recognised, any other label is a custom
  // occasion. Both `dates` and the dedicated `birthday` field surface on the
  // Occasions calendar (see shared/calendar occasionKindFromLabel).
  // company/jobTitle apply to every type (company supersedes the old
  // service-only businessName).
  phones:       [labeledValue],
  emails:       [labeledValue],
  addresses:    [labeledValue],
  dates:        [labeledValue],
  urls:         [labeledValue],
  relatedNames: [relatedName],
  jobTitle:     { type: String, trim: true },
  company:      { type: String, trim: true },
  // Legacy single-value fields, superseded by the arrays above. Retained so
  // records created before the multi-value cutover keep resolving; the client
  // folds them into the arrays on read and clears them on the next save.
  address:      { type: String, trim: true },
  businessName: { type: String, trim: true },
  phone:        { type: String, trim: true },
  email:        { type: String, trim: true },
  // The device address-book id this Person was imported from, when applicable.
  // Lets a later import warn before re-creating the same contact. Opaque + not
  // sensitive content, so it stays plaintext (never in the enc blob).
  deviceContactId: { type: String, trim: true, index: true, sparse: true },
  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

// Ensure the given User has a linked self-record in the People roster, creating
// one from the account's profile fields on first call. Idempotent and cheap
// (indexed findOne when the record already exists). Returns the self Person.
personSchema.statics.ensureSelf = async function (user) {
  let self = await this.findOne({ accountId: user._id });
  if (!self) {
    // Under E2EE the server can't create readable content. Once the household's
    // plaintext has been dropped, the client owns seeding an *encrypted* self-
    // Person after first unlock — so the server must not create a plaintext one.
    // Pre-drop (e2eeActive false, the default), behavior is unchanged.
    const Household = mongoose.model('Household');
    const hh = user.householdId
      ? await Household.findById(user.householdId).select('e2eeActive').lean()
      : null;
    if (hh?.e2eeActive) return null; // client seeds the encrypted self-Person
    self = await this.create({
      userId:    user._id,
      accountId: user._id,
      type:      'family',
      name:      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.firstName,
      birthday:  user.birthday,
      address:   user.homeAddress || undefined,
      notes:     user.aboutMe || undefined,
    });
  }
  if (!user.personId || String(user.personId) !== String(self._id)) {
    await mongoose.model('User').updateOne({ _id: user._id }, { $set: { personId: self._id } });
  }
  return self;
};

module.exports = mongoose.model('Person', personSchema);
