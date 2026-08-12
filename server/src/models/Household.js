const mongoose = require('mongoose');
const { encFields } = require('./encFields');

const householdSchema = new mongoose.Schema({
  // Content since Signal-parity C2: sealed into the household-settings blob
  // (`enc`, with homeAddress) and nulled at the §9 drop. Admin/support then
  // identify households by id (see the C2 runbook note in the plan doc).
  name:     { type: String },
  ownerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Current Household Data Key version. 0 = no HDK minted yet; the owner mints
  // v1 (self-wrapped envelope) on first unlock. Bumped on lazy rotation (Phase 7).
  currentKeyVersion: { type: Number, default: 0 },
  // Set when a member is removed or leaves (§5.2 lazy rotation): the household
  // must mint HDK_vN+1 so the departed member can't read *future* writes. The
  // server can't generate a key, so this is a signal — the next remaining member
  // to unlock (self-healing, like the v1 mint) performs the rotation client-side
  // via POST /household/key/rotate, which clears the flag. Historical records
  // stay at their old version and remain readable by whoever holds that envelope.
  keyRotationPending: { type: Boolean, default: false },
  // When the current HDK version was minted (rotation or v1). Drives B2's
  // periodic-rotation cron (Signal-parity plan): a version older than
  // KEY_ROTATION_INTERVAL_DAYS gets keyRotationPending flagged so the next
  // unlocked member rotates — bounding how much ciphertext any one key covers.
  lastKeyRotationAt: { type: Date },
  // Per-household "plaintext is dead" signal. Flips true only at the §9 plaintext
  // drop, after which the server must not create readable content (the client
  // seeds encrypted records instead). Gates Contact.ensureSelf + the onboarding
  // self-Contact seed. Defaults false → identical pre-drop behavior.
  e2eeActive: { type: Boolean, default: false },
  // The DROP_FIELDS schema version this household's plaintext was last nulled at
  // (services/dropReadiness.DROP_FIELDS_VERSION). A committed drop stamps the
  // current version; a household dropped under an OLDER version still has the
  // newer content columns in plaintext and must run the re-seal + re-drop
  // backfill (scripts/reDropPlaintext.js). 0 = pre-versioning / never dropped.
  dropFieldsVersion: { type: Number, default: 0 },
  // Shared (household-level) settings — moved off User in Phase 3.
  timezone:           { type: String, default: 'America/Toronto' },
  homeAddress:        { type: String, default: '' },
  // Coarse home-area label (city + region/country, e.g. "Ottawa, Ontario,
  // Canada") derived client-side from homeAddress — or set by hand. Stored
  // PLAINTEXT like `timezone` (not sealed with homeAddress): it is coarse enough
  // to be non-sensitive, and the server-side cloud AI reads it to ground local
  // suggestions in the household's actual area instead of guessing from the
  // timezone. The street address itself is never sent to the model. See
  // ai-assistant.md "Home area is coarse, not the street address".
  homeCity:           { type: String, default: '' },
  lat:                { type: Number },
  lon:                { type: Number },
  // null = no shopping day configured yet. New households start unset so no
  // recurring grocery-shopping marker appears on the calendar until a member
  // picks a day in the grocery schedule.
  groceryShoppingDay: { type: Number, default: null },  // 0=Sun…6=Sat, null=unset
  // Shopping cadence; for 'biweekly', groceryAnchor (YYYY-MM-DD, any known
  // shopping day) fixes which alternating week is the shopping week.
  groceryFrequency:   { type: String, enum: ['weekly', 'biweekly'], default: 'weekly' },
  groceryAnchor:      { type: String, default: null },
  grocerySections:    { type: [String], default: () => ['Produce', 'Deli', 'Bakery', 'Meat & Seafood', 'Dairy', 'Frozen', 'Pantry', 'Other'] },
  reminderLeadDays:   { type: Number, default: 7 },

  // --- Monetization (all per-USER now — see User.js) ---
  // LEGACY (no longer written): add-on ownership before it moved to User.addons.
  // Storing it here detached the entitlement from the contact who bought it — a
  // household is a container you can leave, and leaving minted a fresh one with
  // an empty set, silently dropping add-ons the departing member had paid for
  // themselves (recoverable only by tapping Restore). Ownership now lives on
  // User.addons and the household-wide EFFECT is derived as the union across
  // members. Kept only as the source for scripts/backfillUserAddons.js and as a
  // rollback path; nothing reads it. See specs/features/billing-plans.md.
  addons: { type: [String], default: [] },
  // LEGACY (no longer written): household-level AI usage counters from before
  // the per-user billing restructure. AI usage, calls, and credits are per-USER
  // concerns — the live counters are User.usage / usageTokens / usageCallSeconds,
  // and fleet analytics sum those. Kept only so historical rows don't lose data.
  usage: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  usageTokens: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  usageCallSeconds: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Content-blind feature-activity counters for the admin analytics/adoption
  // views: { 'YYYY-MM-DD': { eventCreated, choreCreated, taskCompleted, ... } }.
  // Same shape/keying as `usage` but for non-AI actions; records only that an
  // action happened, never its payload (E2EE-safe). Written by activity().
  activity: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  // E2EE dual-write ciphertext (§9.1 P5): the household-settings blob. Seals
  // homeAddress/lat/lon, and — since Signal-parity C2 (DROP_FIELDS v2) — the
  // household `name` too; both are nulled from plaintext at the drop and read
  // from `enc`. Timezone stays plaintext.
  ...encFields,
}, { timestamps: true, minimize: false });

householdSchema.statics.createForOwner = async function createForOwner(ownerId, name) {
  return this.create({ name, ownerId });
};

module.exports = mongoose.model('Household', householdSchema);
