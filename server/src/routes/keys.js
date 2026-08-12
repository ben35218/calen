// E2EE key-material endpoints (Phase 1).
//
// The server is a blind store: it persists the user's identity PUBLIC key and
// their private key wrapped as opaque per-factor envelopes, and hands them back
// on unlock. It never sees a plaintext private key or the Household Data Key.
// All actual crypto happens client-side in @household/crypto.

const express = require('express');
const User = require('../models/User');
const Household = require('../models/Household');
const AuditLog = require('../models/AuditLog');
const DeviceLink = require('../models/DeviceLink');
const GuardianRecoveryRequest = require('../models/GuardianRecoveryRequest');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');
const CustomCalendar = require('../models/CustomCalendar');
const Record = require('../models/Record');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
  validateEnrollment, validateEnvelope, pickEnvelope, upsertFactor, removeFactor,
} = require('../services/keyEnvelope');
const { alertHousehold, alertUser, securityAlert } = require('../services/securityAlerts');

// F4 device-link slots live for a few minutes — long enough to scan + seal, short
// enough that an abandoned QR can't be completed later.
const LINK_TTL_MS = 5 * 60 * 1000;
// Guardian recovery slots live longer: the guardian may be on another device and
// need a moment to notice the request and approve.
const GUARDIAN_REQUEST_TTL_MS = 30 * 60 * 1000;
// A base64url string of a plausible key/ciphertext length (bounds abuse without
// parsing the opaque blob).
const isB64ish = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);

// Human label for an unlock factor in security alerts.
const FACTOR_LABELS = { password: 'password', passkey: 'Face ID / passkey', recovery: 'recovery code' };
const factorLabel = (f) => FACTOR_LABELS[f] || 'unlock method';

const router = express.Router();
router.use(requireAuth);

// Enrollment and factor changes are security-sensitive; a few per minute is
// plenty for a real user and blunts scripted abuse.
const keyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many key-management requests. Please wait a minute and try again.',
});

// Re-keying is destructive and is reached from a "I've lost everything" screen —
// a real user does it once. A tight cap makes scripted abuse of the escape hatch
// (churning a victim's identity key to force approval prompts) pointless.
const rekeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: 'Too many recovery attempts. Please wait an hour and try again.',
});

// Tighter cap on starting a recovery: the online defence against hammering the
// relay for the sealed inner (which a malicious guardian could then brute-force
// the 4-digit PIN against offline). See guardian-recovery.md security notes.
const guardianRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: 'Too many recovery attempts. Please wait before trying again.',
});

// The caller's own key material — used on login to decide whether to enroll and
// to fetch the envelopes needed to unlock. Returns the wrapped (ciphertext)
// private key; only the caller can decrypt it, so this is safe to return.
router.get('/me', (req, res) => {
  const u = req.user;
  res.json({
    enrolled: Boolean(u.identityPublicKey),
    identityPublicKey: u.identityPublicKey || null,
    wrappedPrivateKey: u.wrappedPrivateKey || [],
    keyEnrolledAt: u.keyEnrolledAt || null,
    keySchemaVersion: u.keySchemaVersion || 1,
    recoverySetupAt: u.recoverySetupAt || null,
  });
});

// Mark that the user has confirmed account recovery — saved their recovery code
// and/or enrolled a passkey (a non-password unlock factor). Idempotent; the flag
// only ever moves from unset → set. Gates password retirement (§5); no key
// material is touched here. See docs/PASSWORDLESS-E2EE-PLAN.md §2.4.
router.post('/recovery-complete', keyLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.identityPublicKey) {
      return res.status(409).json({ error: 'Enroll keys before confirming recovery' });
    }
    if (!user.recoverySetupAt) {
      user.recoverySetupAt = new Date();
      await user.save();
    }
    res.json({ recoverySetupAt: user.recoverySetupAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// First-time enrollment: store the identity public key + initial factor set.
// Idempotency: enrolling an already-enrolled account is rejected — re-keying a
// user (lost all factors) is the household re-admission / re-enroll flow in a
// later phase, not a silent overwrite here.
router.post('/enroll', keyLimiter, async (req, res) => {
  try {
    const err = validateEnrollment(req.body);
    if (err) return res.status(400).json({ error: err });

    const user = await User.findById(req.user._id);
    if (user.identityPublicKey) {
      return res.status(409).json({ error: 'Keys already enrolled for this account' });
    }

    user.identityPublicKey = req.body.identityPublicKey;
    user.wrappedPrivateKey = req.body.factors.map(pickEnvelope);
    user.keyEnrolledAt = new Date();
    user.keySchemaVersion = 1;
    await user.save();

    await AuditLog.create({ userId: user._id, householdId: user.householdId, event: 'key_enrolled' });
    res.status(201).json({ enrolled: true, keyEnrolledAt: user.keyEnrolledAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Re-key: a fresh identity for an account that lost every unlock factor ────
//
// The escape hatch for a locked FREE VIEWER (billing-plans.md "Free viewer
// mode"): someone a calendar was shared with, who reset their forgotten
// password and therefore can no longer unwrap the identity key their
// CalendarKey envelope is sealed to. Re-wrapping to their EXISTING public key
// would be useless — what they lost is the private half — so getting them back
// in has to mint a NEW identity keypair for the owner to wrap to.
//
// This is a deliberate, narrow hole in the "no re-key" invariant
// (specs/platform/crypto-e2ee.md): it recovers ACCESS, never DATA. Everything
// sealed to the old identity stays sealed forever — there is still no
// server-side override and no backdoor. That costs a viewer nothing (the events
// belong to the calendar's owner, who re-wraps) and costs an account with
// records of its own everything, which is what the guard below is for.
//
// Re-keying deliberately grants NOTHING by itself. It clears the caller's now-
// dead envelopes and stamps `keyChangedAt` on every collaboration, which
// SUPPRESSES the owner's automatic wrap-on-approve pass. Access returns only
// when the owner approves the request (POST /calendars/:key/access-request →
// the owner's prompt → POST /calendars/:key/keys/approve). Without that
// suppression, deleting the envelopes here would drop the caller straight back
// into `missingMembers` and the owner's next unlock would silently re-grant —
// turning mailbox takeover → password reset → re-key into a way to inherit
// someone else's calendar without them ever seeing it.
router.post('/rekey', rekeyLimiter, async (req, res) => {
  try {
    const err = validateEnrollment(req.body);
    if (err) return res.status(400).json({ error: err });

    const user = await User.findById(req.user._id);
    if (!user.identityPublicKey) {
      return res.status(409).json({ error: 'Enroll keys before re-keying' });
    }
    // A re-key that reuses the old public key would clear every envelope and
    // grant nothing back — almost certainly a client bug, never a useful call.
    if (req.body.identityPublicKey === user.identityPublicKey) {
      return res.status(400).json({ error: 'Re-keying requires a new identity key' });
    }

    // Data-loss guard. The caller's household records are sealed under an HDK
    // this re-key abandons: in a solo household they become unreadable by
    // anyone, forever; with other members they survive, but only a member
    // re-sealing the HDK to the new identity brings the caller back. Either way
    // it must be a decision, never a side effect — so the client has to say it
    // understands before this proceeds. A pure viewer has no records and never
    // sees this.
    // "Recoverable" means someone else actually HOLDS a copy of the HDK — a
    // fellow member with an envelope of their own can re-seal it to the new
    // identity. A member row alone (never enrolled, never approved) can't.
    const [recordCount, peerEnvelopes] = await Promise.all([
      Record.countDocuments({ householdId: user.householdId, deleted: false }),
      HouseholdKeyEnvelope.countDocuments({ householdId: user.householdId, userId: { $ne: user._id } }),
    ]);
    if (recordCount > 0 && req.body.confirmDataLoss !== true) {
      return res.status(409).json({
        error: 'Re-keying abandons the data this account has already encrypted',
        code: 'confirm_data_loss',
        recordCount,
        recoverableByHousehold: peerEnvelopes > 0,
      });
    }

    user.identityPublicKey = req.body.identityPublicKey;
    user.wrappedPrivateKey = req.body.factors.map(pickEnvelope);
    user.keyEnrolledAt = new Date();
    user.keySchemaVersion = 1;
    // The new factor set wraps under the CURRENT password, so the post-reset
    // stale flag is spent. The fresh recovery code minted alongside it is
    // unconfirmed until the client's one-time modal is completed again, which
    // is what re-arms the born-encrypted drop gate.
    user.e2eePasswordStale = false;
    user.recoverySetupAt = undefined;
    // A guardian armed against the OLD identity can never open the new one.
    // Drop it rather than leave a dead backstop that still reads as armed.
    user.guardianRecovery = undefined;
    await user.save();

    // Every envelope sealed to the old identity is undecryptable noise now.
    const [hdk, resource] = await Promise.all([
      HouseholdKeyEnvelope.deleteMany({ userId: user._id }),
      ResourceKeyEnvelope.deleteMany({ recipient: 'member', userId: user._id }),
    ]);

    // Suppress every owner's automatic re-wrap until they approve (see above).
    // Matches the collaborator SUBDOC shape only; legacy plain-ObjectId rows
    // (pre-access-levels) carry no per-collaborator fields to stamp and are
    // rewritten to the subdoc shape on their next save, at which point the
    // owner's reconcile treats them normally.
    await CustomCalendar.updateMany(
      { 'collaborators.userId': user._id },
      { $set: { 'collaborators.$[c].keyChangedAt': new Date() } },
      { arrayFilters: [{ 'c.userId': user._id }] },
    );

    // The caller's copy of the HDK died with the old identity. Whether anyone
    // ELSE still holds one decides what happens to the household:
    //  - a fellow envelope-holder exists → the data survives, and only a member
    //    re-sealing HDK v(N+1) to the new key re-admits the caller. Nothing did
    //    that automatically — the caller sat `pending` until someone happened to
    //    rotate — so flag the rotation the same way a departure does; the next
    //    unlocked member's lazy-rotation pass wraps everyone, new key included.
    //  - nobody does → every record is sealed under a key that no longer exists
    //    anywhere, forever. Keeping the ciphertext (and a currentKeyVersion that
    //    points at it) would strand the account: the v1 mint is guarded to
    //    version 0, so the session unlocks but can never save again. The caller
    //    has already confirmed the loss above, so purge the dead rows and reset
    //    the key version — the ordinary owner mint then issues a fresh HDK and
    //    the account starts clean. Orphaned attachment files are left to the
    //    upload store's sweep.
    let householdReset = false;
    const household = user.householdId ? await Household.findById(user.householdId) : null;
    if (household && (household.currentKeyVersion || 0) > 0) {
      if (peerEnvelopes > 0) {
        if (!household.keyRotationPending) {
          household.keyRotationPending = true;
          await household.save();
        }
      } else {
        const purged = await Record.deleteMany({ householdId: household._id });
        await Promise.all([
          HouseholdKeyEnvelope.deleteMany({ householdId: household._id }),
          ResourceKeyEnvelope.deleteMany({ recipient: 'household', householdId: household._id }),
        ]);
        household.currentKeyVersion = 0;
        household.keyRotationPending = false;
        await household.save();
        householdReset = true;
        await AuditLog.create({
          userId: user._id, householdId: household._id, event: 'hdk_reset',
          meta: { recordsPurged: purged.deletedCount },
        });
      }
    }

    await AuditLog.create({
      userId: user._id, householdId: user.householdId, event: 'key_rekeyed',
      meta: { recordCount, envelopesCleared: hdk.deletedCount + resource.deletedCount, householdReset },
    });
    // Loud by design: a changed identity key is exactly the event safety numbers
    // exist to surface. The caller is excluded — they just did this on purpose.
    securityAlert(alertHousehold(user.householdId, {
      title: 'Security change',
      body: `${user.firstName} re-enrolled with a new encryption key, so their security code has changed. Compare the new code with them before trusting it.`,
      tag: `rekey-${user._id}`,
      excludeUserId: user._id,
    }));

    res.status(201).json({
      enrolled: true,
      keyEnrolledAt: user.keyEnrolledAt,
      envelopesCleared: hdk.deletedCount + resource.deletedCount,
      // The solo start-fresh happened: the household's dead ciphertext is gone
      // and its key version is back to 0, so the client's next
      // ensureHouseholdKey mints a fresh HDK and the account can save again.
      householdReset,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add or replace a single unlock factor (enroll a passkey, rotate the
// password-wrapped envelope after a password change, regenerate a recovery
// code). The public key and private key are unchanged — only the wrapping.
router.put('/factors', keyLimiter, async (req, res) => {
  try {
    const err = validateEnvelope(req.body);
    if (err) return res.status(400).json({ error: err });

    const user = await User.findById(req.user._id);
    if (!user.identityPublicKey) {
      return res.status(409).json({ error: 'Enroll keys before managing factors' });
    }
    const hadFactor = user.wrappedPrivateKey.length;
    user.wrappedPrivateKey = upsertFactor(user.wrappedPrivateKey, req.body);
    const added = user.wrappedPrivateKey.length > hadFactor;
    // Re-wrapping the password factor under the current password clears the
    // post-reset "stale" flag, so the unlock UI offers password again.
    if (req.body.factor === 'password') user.e2eePasswordStale = false;
    await user.save();
    // Alert only on a genuinely NEW factor — a re-wrap of an existing envelope
    // (password change, self-heal) is routine and would train users to ignore
    // the alert that matters: an attacker adding an unlock method. A new passkey
    // factor is skipped too: the same gesture registers a sign-in credential via
    // /auth/passkey/register, which already fires the alert (avoid the double).
    if (added) {
      await AuditLog.create({
        userId: user._id, householdId: user.householdId, event: 'factor_added',
        meta: { factor: req.body.factor },
      });
      if (req.body.factor !== 'passkey') {
        securityAlert(alertHousehold(user.householdId, {
          title: 'Security change',
          body: `A ${factorLabel(req.body.factor)} was added to ${user.firstName}'s account. If this wasn't ${user.firstName}, review Security now.`,
          tag: `factor-${user._id}`,
        }));
      }
    }
    res.json({ factors: user.wrappedPrivateKey.map((f) => ({ factor: f.factor, credentialId: f.credentialId })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a factor — but never the last one, or the account's data becomes
// unrecoverable by design. Passkey removal targets a specific credentialId.
router.delete('/factors/:factor', keyLimiter, async (req, res) => {
  try {
    const { factor } = req.params;
    const { credentialId } = req.query;
    const user = await User.findById(req.user._id);
    if (!user.identityPublicKey) {
      return res.status(409).json({ error: 'No keys enrolled' });
    }
    const remaining = removeFactor(user.wrappedPrivateKey, factor, credentialId);
    if (remaining.length === user.wrappedPrivateKey.length) {
      return res.status(404).json({ error: 'No matching factor to remove' });
    }
    if (remaining.length === 0) {
      return res.status(400).json({ error: 'Cannot remove your last unlock factor — enroll another first' });
    }
    user.wrappedPrivateKey = remaining;
    await user.save();
    await AuditLog.create({
      userId: user._id, householdId: user.householdId, event: 'factor_removed', meta: { factor },
    });
    securityAlert(alertHousehold(user.householdId, {
      title: 'Security change',
      body: `A ${factorLabel(factor)} was removed from ${user.firstName}'s account.`,
      tag: `factor-${user._id}`,
    }));
    res.json({ factors: user.wrappedPrivateKey.map((f) => ({ factor: f.factor, credentialId: f.credentialId })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── QR device linking (Signal-parity F4) ────────────────────────────────────
// A blind relay between two of the SAME account's devices. The new (locked)
// device opens a slot and shows a QR with its ephemeral public key; the existing
// (unlocked) device seals the account secret to that key and posts the opaque
// ciphertext here; the new device polls and opens it locally. The server never
// sees plaintext key material — only ferries the sealed blob. Every endpoint is
// scoped to `req.user._id`, so only the account's own devices can participate.

// New device: open a link slot. Returns the linkId the QR carries alongside the
// ephemeral public key.
router.post('/link/start', keyLimiter, async (req, res) => {
  try {
    const { ephemeralPublicKey, deviceName } = req.body || {};
    if (!isB64ish(ephemeralPublicKey, 128)) {
      return res.status(400).json({ error: 'A valid ephemeral public key is required' });
    }
    // One live slot per device attempt; clear this account's stale/abandoned
    // slots so a pending list can't grow unbounded.
    await DeviceLink.deleteMany({ userId: req.user._id, status: { $ne: 'sealed' } });
    const link = await DeviceLink.create({
      userId: req.user._id,
      ephemeralPublicKey,
      deviceName: typeof deviceName === 'string' ? deviceName.slice(0, 100) : undefined,
      expiresAt: new Date(Date.now() + LINK_TTL_MS),
    });
    res.status(201).json({ linkId: link.linkId, expiresAt: link.expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Existing (unlocked) device: submit the sealed handoff for a scanned linkId.
// Fires a security alert to all the account's devices — linking a device shares
// the keys, so it must be as loud as adding an unlock factor.
router.post('/link/complete', keyLimiter, async (req, res) => {
  try {
    const { linkId, sealedPayload } = req.body || {};
    if (typeof linkId !== 'string' || !isB64ish(sealedPayload, 8192)) {
      return res.status(400).json({ error: 'linkId and sealedPayload are required' });
    }
    // Scope to the caller's own account + a live, still-pending slot.
    const link = await DeviceLink.findOne({ linkId, userId: req.user._id });
    if (!link || link.status !== 'pending' || link.expiresAt.getTime() < Date.now()) {
      return res.status(404).json({ error: 'That link code is invalid or has expired' });
    }
    link.sealedPayload = sealedPayload;
    link.status = 'sealed';
    await link.save();
    await AuditLog.create({ userId: req.user._id, householdId: req.user.householdId, event: 'device_linked' });
    securityAlert(alertUser(req.user._id, {
      title: 'New device linked',
      body: `A device (${link.deviceName || 'unnamed'}) was linked to ${req.user.firstName}'s account and now holds your encryption keys. If this wasn't you, remove it in Security and rotate your keys.`,
      tag: `link-${req.user._id}`,
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// New device: poll the slot. Once sealed, returns the opaque payload and burns
// the slot (single-use) so the ciphertext can't be replayed.
router.get('/link/:linkId', async (req, res) => {
  try {
    const link = await DeviceLink.findOne({ linkId: req.params.linkId, userId: req.user._id });
    if (!link || link.expiresAt.getTime() < Date.now()) {
      return res.status(404).json({ error: 'That link has expired' });
    }
    if (link.status !== 'sealed') return res.json({ status: link.status });
    const sealedPayload = link.sealedPayload;
    await DeviceLink.deleteOne({ _id: link._id }); // burn on delivery
    res.json({ status: 'sealed', sealedPayload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A household member's identity PUBLIC key — needed to wrap the Household Data
// Key to them (Phase 2 approve-to-join). Scoped to the caller's household.
router.get('/public/:userId', async (req, res) => {
  try {
    const inScope = req.scopeIds.some((id) => String(id) === String(req.params.userId));
    if (!inScope) return res.status(404).json({ error: 'User not in your household' });
    const target = await User.findById(req.params.userId).select('identityPublicKey firstName');
    if (!target || !target.identityPublicKey) {
      return res.status(404).json({ error: 'That member has not enrolled keys yet' });
    }
    res.json({ userId: target._id, identityPublicKey: target.identityPublicKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Guardian recovery, dual-control (specs/features/guardian-recovery.md) ─────
// Opt-in backstop: a household member helps the user back in, but neither party
// alone can open the key (guardian's sealed box + the user's 4-digit PIN). The
// server stores the opaque `outer` blob blind and blind-relays the re-sealed
// handoff — it never sees the key or the PIN.

// The caller's own guardian status (drives the Recovery methods row).
router.get('/guardian', async (req, res) => {
  try {
    const g = req.user.guardianRecovery;
    if (!g || !g.outer) return res.json({ armed: false });
    const guardian = await User.findById(g.guardianUserId).select('firstName lastName');
    res.json({
      armed: true,
      guardianUserId: g.guardianUserId,
      guardianName: guardian ? guardian.name : null,
      armedAt: g.armedAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Arm (or replace) guardian recovery. The guardian MUST be an enrolled member of
// the caller's household. The user's vault is unlocked client-side to build
// `outer`; the server only stores it.
router.put('/guardian', keyLimiter, async (req, res) => {
  try {
    const { guardianUserId, guardianFingerprint, outer } = req.body || {};
    if (!guardianUserId || typeof guardianFingerprint !== 'string' || !isB64ish(outer, 8192)) {
      return res.status(400).json({ error: 'guardianUserId, guardianFingerprint and outer are required' });
    }
    if (String(guardianUserId) === String(req.user._id)) {
      return res.status(400).json({ error: 'Choose another household member as your guardian' });
    }
    const inScope = req.scopeIds.some((id) => String(id) === String(guardianUserId));
    if (!inScope) return res.status(404).json({ error: 'That member is not in your household' });
    const guardian = await User.findById(guardianUserId).select('identityPublicKey');
    if (!guardian || !guardian.identityPublicKey) {
      return res.status(409).json({ error: 'That member has not set up their key yet' });
    }

    const user = await User.findById(req.user._id);
    if (!user.identityPublicKey) return res.status(409).json({ error: 'Enroll keys first' });
    user.guardianRecovery = { guardianUserId, guardianFingerprint, outer, armedAt: new Date() };
    await user.save();
    await AuditLog.create({ userId: user._id, householdId: user.householdId, event: 'guardian_armed', meta: { guardianUserId } });
    securityAlert(alertUser(user._id, {
      title: 'Recovery guardian set',
      body: `A household member can now help you recover your account (with your PIN). If this wasn't ${user.firstName}, remove it in Privacy & data now.`,
      tag: `guardian-${user._id}`,
    }));
    res.json({ armed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Disarm — remove the envelope. Cancels any in-flight request too.
router.delete('/guardian', keyLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.guardianRecovery = undefined;
    await user.save();
    await GuardianRecoveryRequest.deleteMany({ userId: user._id });
    await AuditLog.create({ userId: user._id, householdId: user.householdId, event: 'guardian_disarmed' });
    res.json({ armed: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recovering device (signed in, vault locked): open a request. Notifies the
// guardian. Requires an armed envelope whose guardian is STILL a household member.
router.post('/guardian/request', guardianRequestLimiter, async (req, res) => {
  try {
    const { ephemeralPublicKey, fingerprint } = req.body || {};
    if (!isB64ish(ephemeralPublicKey, 128) || typeof fingerprint !== 'string') {
      return res.status(400).json({ error: 'A valid ephemeral public key and fingerprint are required' });
    }
    const g = req.user.guardianRecovery;
    if (!g || !g.outer) return res.status(409).json({ error: 'No recovery guardian is set up on this account' });
    // A guardian removed from the household can no longer approve — refuse to
    // even start (defence-in-depth; approve re-checks too).
    const stillMember = req.scopeIds.some((id) => String(id) === String(g.guardianUserId));
    if (!stillMember) return res.status(409).json({ error: 'Your recovery guardian has left the household. Set up recovery again.' });

    await GuardianRecoveryRequest.deleteMany({ userId: req.user._id, status: 'pending' });
    const reqDoc = await GuardianRecoveryRequest.create({
      userId: req.user._id,
      guardianUserId: g.guardianUserId,
      ephemeralPublicKey,
      fingerprint,
      expiresAt: new Date(Date.now() + GUARDIAN_REQUEST_TTL_MS),
    });
    securityAlert(alertUser(g.guardianUserId, {
      title: 'Recovery request',
      body: `${req.user.firstName} is trying to recover their account and asked you to approve it. Open Privacy & data to help.`,
      tag: `guardian-req-${req.user._id}`,
      // Typed so the app's foregrounded pop-up lane reacts (a foreground push
      // shows no banner; the type triggers the same alert the next open would).
      data: { type: 'guardian_recovery_request', requestId: reqDoc.requestId },
    }));
    res.status(201).json({ requestId: reqDoc.requestId, expiresAt: reqDoc.expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardian: list pending requests awaiting my approval, with the requester's
// `outer` blob (which I unseal locally) + the ephemeral key to re-seal to.
router.get('/guardian/requests', async (req, res) => {
  try {
    const reqs = await GuardianRecoveryRequest.find({ guardianUserId: req.user._id, status: 'pending' })
      .sort({ createdAt: -1 }).limit(10);
    const out = [];
    for (const r of reqs) {
      if (r.expiresAt.getTime() < Date.now()) continue;
      const requester = await User.findById(r.userId).select('firstName lastName guardianRecovery');
      // Only surface if the requester still names me as guardian and holds a blob.
      if (!requester?.guardianRecovery?.outer) continue;
      if (String(requester.guardianRecovery.guardianUserId) !== String(req.user._id)) continue;
      out.push({
        requestId: r.requestId,
        userId: r.userId,
        requesterName: requester.name,
        fingerprint: r.fingerprint,
        ephemeralPublicKey: r.ephemeralPublicKey,
        outer: requester.guardianRecovery.outer,
      });
    }
    res.json({ requests: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardian: post the re-sealed inner for a request I own. Alerts the requester.
router.post('/guardian/approve', keyLimiter, async (req, res) => {
  try {
    const { requestId, sealedPayload } = req.body || {};
    if (typeof requestId !== 'string' || !isB64ish(sealedPayload, 8192)) {
      return res.status(400).json({ error: 'requestId and sealedPayload are required' });
    }
    const reqDoc = await GuardianRecoveryRequest.findOne({ requestId, guardianUserId: req.user._id });
    if (!reqDoc || reqDoc.status !== 'pending' || reqDoc.expiresAt.getTime() < Date.now()) {
      return res.status(404).json({ error: 'That recovery request is invalid or has expired' });
    }
    reqDoc.sealedPayload = sealedPayload;
    reqDoc.status = 'sealed';
    await reqDoc.save();
    await AuditLog.create({ userId: reqDoc.userId, householdId: req.user.householdId, event: 'guardian_approved', meta: { guardianUserId: req.user._id } });
    securityAlert(alertUser(reqDoc.userId, {
      title: 'Recovery approved',
      body: `${req.user.firstName} approved your recovery. Enter your recovery PIN to finish.`,
      tag: `guardian-approved-${reqDoc.userId}`,
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recovering device: poll for the sealed handoff. Burned on delivery (single-use).
router.get('/guardian/request/:requestId', async (req, res) => {
  try {
    const reqDoc = await GuardianRecoveryRequest.findOne({ requestId: req.params.requestId, userId: req.user._id });
    if (!reqDoc || reqDoc.expiresAt.getTime() < Date.now()) {
      return res.status(404).json({ error: 'That recovery request has expired' });
    }
    if (reqDoc.status !== 'sealed') return res.json({ status: reqDoc.status });
    const sealedPayload = reqDoc.sealedPayload;
    await GuardianRecoveryRequest.deleteOne({ _id: reqDoc._id }); // burn on delivery
    res.json({ status: 'sealed', sealedPayload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
