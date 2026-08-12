const mongoose = require('mongoose');
const crypto = require('crypto');

// Guardian recovery relay slot (specs/features/guardian-recovery.md).
//
// A user who lost every unlock factor (but is still signed in, vault locked)
// opens a request carrying a one-shot ephemeral X25519 public key. Their
// nominated GUARDIAN (a household member) fetches it, unseals the user's stored
// `outer` envelope to the still-PIN-locked `inner`, re-seals that to the
// ephemeral key, and posts it back as `sealedPayload`. The requesting device
// polls, opens with the ephemeral private key, and then the user's 4-digit PIN
// yields the identity private key.
//
// Blind relay: the server only ferries opaque ciphertext. Cross-user (unlike the
// same-account DeviceLink): `userId` is the contact recovering, `guardianUserId`
// the member approving — both must be in the same household, enforced in routes.
const schema = new mongoose.Schema({
  requestId: { type: String, unique: true, index: true, default: () => crypto.randomBytes(16).toString('hex') },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // recovering
  guardianUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // b64url ephemeral public key the recovering device generated for this handoff.
  ephemeralPublicKey: { type: String, required: true },
  // Safety number of the ephemeral key, shown on both screens for out-of-band
  // verification before the guardian approves (same trust step as device-link).
  fingerprint: { type: String, required: true },
  // The opaque re-sealed inner the guardian posts; the server never reads it.
  sealedPayload: { type: String },
  status:    { type: String, enum: ['pending', 'sealed'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GuardianRecoveryRequest', schema);
