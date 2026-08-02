const mongoose = require('mongoose');

// One push subscription per device the user opted in from. Two flavours:
//   - web:    Web Push (browser) — has `endpoint` + `keys`.
//   - native: a mobile app (Expo) — has `expoToken`.
// `platform` discriminates them so the push service can pick a transport.
const pushSubscriptionSchema = new mongoose.Schema({
  platform:  { type: String, enum: ['web', 'ios', 'android'], default: 'web' },
  endpoint:  { type: String },                      // web push only
  keys:      { p256dh: String, auth: String },      // web push only
  expoToken: { type: String },                      // native (Expo) only
  label:     String,        // user-agent / device hint for management
}, { _id: false, timestamps: true });

// A user's X25519 identity private key, stored server-side ONLY as ciphertext,
// wrapped independently by each enrolled unlock factor so any one can recover it
// (password-Argon2id / passkey-PRF / recovery-code). The server never holds a
// key that can decrypt these — it just persists opaque envelopes produced by the
// client (@household/crypto). See docs/E2EE-SYNC-PLAN.md §3.4.
const factorEnvelopeSchema = new mongoose.Schema({
  factor:   { type: String, enum: ['password', 'passkey', 'recovery'], required: true },
  nonce:    { type: String, required: true },   // secretbox nonce (b64url)
  ct:       { type: String, required: true },   // wrapped private key (b64url)
  // password (Argon2id) parameters — needed to re-derive the KEK on unlock.
  kdf:      { type: String, enum: ['argon2id'] },
  salt:     String,
  opslimit: Number,
  memlimit: Number,
  // passkey binding: which platform credential's PRF output unwraps this, plus
  // the PRF salt used. Multiple passkey factors may coexist (one per device),
  // keyed by credentialId.
  credentialId: String,
  prfSalt:      String,
}, { _id: false, timestamps: true });

// A WebAuthn credential this user can SIGN IN with (distinct from the passkey
// unlock *factor* envelopes above, which only wrap the E2EE private key). The
// public key is captured at registration via a server-verified ceremony, so
// /auth/passkey/login can verify assertion signatures.
const passkeyCredentialSchema = new mongoose.Schema({
  credentialId: { type: String, required: true },  // b64url
  publicKey:    { type: String, required: true },  // b64url COSE public key
  counter:      { type: Number, default: 0 },      // signature counter (0 on Apple platforms)
  transports:   { type: [String], default: [] },
}, { _id: false, timestamps: true });

const userSchema = new mongoose.Schema({
  email:             { type: String, required: true, unique: true, lowercase: true },
  passwordHash:      { type: String, required: true },
  // Whether the user knows a real password. Passwordless signups still carry a
  // `passwordHash` (a random on-device secret that wraps the E2EE envelope), so
  // presence of the hash can't tell us this — this flag can. Drives the unlock
  // UI: offer the password factor only when true. Legacy accounts default true;
  // set false on passwordless registration, true again if a password is ever set.
  hasPassword:       { type: Boolean, default: true },
  // True when the E2EE `password` factor can no longer decrypt the private key
  // because the login password was reset (forgot-password): the factor envelope
  // is still wrapped under the OLD password, so the NEW one won't unwrap it. The
  // server can't re-wrap (it never holds the key), so the unlock UI must stop
  // offering the password factor and steer the user to their recovery code /
  // passkey. Cleared once the client re-wraps the factor under the new password
  // (PUT /keys/factors with a `password` factor). See docs/PASSWORDLESS-E2EE-PLAN.md.
  e2eePasswordStale: { type: Boolean, default: false },

  // Forgot-password reset code: bcrypt hash of a short-lived 6-digit code sent
  // by email. Attempts are counted so the code can't be brute-forced.
  resetCodeHash:      { type: String },
  resetCodeExpiresAt: { type: Date },
  resetCodeAttempts:  { type: Number, default: 0 },
  // Registration-lock analog (Signal-parity F1): a reset from an UNKNOWN device
  // on a protected account doesn't apply immediately — it opens this hold
  // window (with loud notifications) and only completes after it elapses.
  // Cleared on completion, cancel, or a known-device reset.
  resetHoldUntil:     { type: Date },

  // Device sessions (Signal-parity F2). Every issued JWT carries the subdoc id
  // of one of these rows (`sid`); a row's removal revokes that token on its
  // next request. Sid-less tokens predate the registry and are upgraded on the
  // sliding refresh. `deviceId` is the client install's stable random UUID
  // (X-Device-Id) — a sign-in from a known install REPLACES its row instead of
  // appending, so one physical install = one row. Absent on rows from legacy
  // clients. Capped (least-recently-seen dropped) in services/sessions.js.
  sessions: {
    type: [new mongoose.Schema({
      deviceId:   { type: String },
      deviceName: { type: String, default: 'Unknown device' },
      platform:   { type: String, default: '' },
      createdAt:  { type: Date, default: Date.now },
      lastSeenAt: { type: Date, default: Date.now },
    })],
    default: [],
  },

  // Passkey sign-in credentials (WebAuthn public halves). See schema above.
  passkeyCredentials: { type: [passkeyCredentialSchema], default: [] },

  // ── E2EE key material (Phase 1) ──────────────────────────────────────────
  // Plaintext public half of the identity keypair; used by household members to
  // wrap the Household Data Key to this user (Phase 2). Absent until enrolled.
  identityPublicKey: { type: String },
  wrappedPrivateKey: { type: [factorEnvelopeSchema], default: [] },
  keyEnrolledAt:     { type: Date },
  keySchemaVersion:  { type: Number, default: 1 },
  // Set once the user has confirmed a non-password recovery factor (saved their
  // recovery code and/or enrolled a passkey). Gates the §5 password retirement:
  // we never remove the password factor until this is set, so no account is left
  // with the password as its sole unlock. See docs/PASSWORDLESS-E2EE-PLAN.md §2.
  recoverySetupAt:   { type: Date },
  // Optional dual-control guardian recovery (specs/features/guardian-recovery.md).
  // `outer` is the identity private key under TWO locks — a 4-digit PIN (inner,
  // Argon2id) then an anonymous sealed box to the guardian's identity key — so the
  // server (and the guardian alone) can't open it. Server stores it blind; set
  // when armed, cleared on disarm / guardian removal / key change.
  guardianRecovery: {
    guardianUserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    guardianFingerprint: { type: String }, // safety number of the guardian key at arm time
    outer:             { type: String },   // opaque sealed blob; never server-readable
    armedAt:           { type: Date },
  },
  // Access role. 'admin' unlocks the monetization/admin web app surfaces.
  role:              { type: String, enum: ['user', 'admin'], default: 'user', index: true },

  // --- Monetization (per-user: unlock + prepaid credits) ---
  // RevenueCat app_user_id this user is keyed to (the mobile app logs the RC SDK
  // in with the user id; webhooks carry it back). May hold an aliased anonymous
  // id from a pre-login purchase.
  revenueCatId:      { type: String, index: true },
  // The $4.99 one-time app unlock (non-consumable IAP, entitlement `app_unlock`).
  // Per-USER: every member buys their own. Granted/revoked only by the webhook
  // or the admin override POST /monetization-config/unlock.
  appUnlocked:       { type: Boolean, default: false },
  appUnlockedAt:     { type: Date },
  unlockProductId:   { type: String },
  // Prepaid AI-credit balance in integer MILLICREDITS (1 credit = $0.01 retail =
  // 1000 Mc). Grants go through CreditLedger.grant (ledgered, idempotent); usage
  // debits are fire-and-forget but ALSO ledgered (CreditLedger.debit via
  // services/credits.debitUsageMc — kind 'usage' + action). May go NEGATIVE
  // after a refund — enforcement blocks at <= 0, UI floors display at 0.
  creditBalanceMc:   { type: Number, default: 0 },
  // The optional monthly "Calen AI" plan (auto-renewable subscription, RC
  // entitlement `calen_ai`). Active while a paid period is current; each
  // period's credits are granted by the webhook (CreditLedger kind 'plan').
  // Granted credits are ordinary balance — they survive plan expiry.
  aiPlanActive:      { type: Boolean, default: false },
  aiPlanExpiresAt:   { type: Date },
  householdId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Household' }, // family the user belongs to
  personId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Person' },    // optional link to the People roster
  firstName:         { type: String, required: true, trim: true },
  lastName:          { type: String, trim: true, default: '' },
  // Plaintext phone (like email) so sharing flows can resolve a phone number to
  // an account. Sparse-indexed: absent on accounts that never set one. Stored
  // loosely normalized (leading + and digits) via services/phone.js.
  phone:             { type: String, trim: true, default: '', index: true },
  birthday:          { type: Date },
  // Lead-time (days) used by the tasks/chores "due-soon" list filter. Not a
  // notification setting — alerts are configured per item now.
  reminderLeadDays:  { type: Number, default: 7 },
  // Push opt-ins (web + native) — push is the only notification delivery channel.
  pushSubscriptions: { type: [pushSubscriptionSchema], default: [] },
  // Set by a client that schedules reminders on-device (Phase 5): the server
  // reminder cron then skips this user to avoid double-notifying. See §7.
  localReminders:    { type: Boolean, default: false },
  // Personal default wall-clock time (`HH:mm`, local) that DAY-BASED alerts
  // (tasks/chores/birthdays with no per-item reminderTime) fire at. null = the
  // 9am default (ALERT_HOUR). The reminder cron runs hourly, so it honors only
  // the HOUR of this value; the on-device scheduler honors the full HH:mm. Set
  // from the Account screen (personal, like `timezone`).
  dayAlertTime:      { type: String, default: null },
  // Server-side mirror of the device's AI consent toggle (synced via /settings).
  // middleware/aiConsent.js refuses AI routes when false, so a bypassed client
  // can't ship content to the model for a user who turned AI off.
  aiEnabled:         { type: Boolean, default: true },
  // Last app version this user reported (§9 readiness gate: the whole-household
  // migration requires every member on a compatible app before the drop).
  clientVersion:     { type: String },
  clientPlatform:    { type: String },  // 'web' | 'ios' | 'android'
  clientVersionAt:   { type: Date },
  // Last authenticated request from this user, stamped (throttled) by
  // requireAuth. Content-blind engagement signal powering the admin analytics
  // DAU/WAU/MAU + retention views. Absent until the user's first request post-deploy.
  lastActiveAt:      { type: Date, index: true },

  // Per-user weekly AI-action usage: { 'YYYY-MM-DD': { chat, scan, ... } }, same
  // shape/keying as Household.usage. Analytics-only (feeds the "By feature"
  // breakdown on the Credits screen + admin analytics) — enforcement is the
  // prepaid credit balance above. See usageMeter.
  usage: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Per-user weekly TOKEN usage: { 'YYYY-MM-DD': { tokens } } where tokens =
  // input+output+cache read+write. Analytics-only; credits are the enforced unit.
  usageTokens: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Per-user weekly assistant CALL-TIME usage in connected seconds:
  // { 'YYYY-MM-DD': { seconds } }. Analytics-only. See usageMeter.
  usageCallSeconds: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Per-user weekly chat WEB-SEARCH usage: { 'YYYY-MM-DD': { count, costMc } }
  // (executed server-side web_search tool searches + their raw per-search API
  // fee). Analytics/reconciliation-only; the debit is the flat per-search
  // price. See usageMeter.recordWebSearches.
  usageWebSearches: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // AI calls refused with 402 after the credit balance ran out:
  // { 'YYYY-MM-DD': { action: count } }. Analytics-only — feeds the admin
  // AI-usage abuse view (hammering the API after the block is the signal).
  usageBlocked: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  timezone:          { type: String, default: 'America/Toronto' },
  homeAddress:       { type: String, default: '' },
  // Coarse home-area label (city + region/country) — see Household.homeCity.
  // Kept here as the pre-household fallback, mirroring homeAddress/timezone.
  homeCity:          { type: String, default: '' },
  lat:               { type: Number },
  lon:               { type: Number },
  aboutMe:             { type: String, trim: true },
  // null = unset; new users don't get a default shopping day (they configure it).
  groceryShoppingDay:  { type: Number, default: null },  // 0=Sun...6=Sat, null=unset
  // Shopping cadence (see Household.js); kept on User for pre-household fallback.
  groceryFrequency:    { type: String, enum: ['weekly', 'biweekly'], default: 'weekly' },
  groceryAnchor:       { type: String, default: null },
  grocerySections:     { type: [String], default: () => ['Produce', 'Deli', 'Bakery', 'Meat & Seafood', 'Dairy', 'Frozen', 'Pantry', 'Other'] },
}, { timestamps: true, toJSON: { virtuals: true } });

// Convenience getter so existing code using req.user.name keeps working
userSchema.virtual('name').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ');
});

// Usernameless passkey sign-in resolves the account from the asserted credential
// id (POST /auth/passkey/login with no email), so that lookup must be indexed.
// WebAuthn credential ids are globally unique, so at most one user matches.
userSchema.index({ 'passkeyCredentials.credentialId': 1 });

module.exports = mongoose.model('User', userSchema);
