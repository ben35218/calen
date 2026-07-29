// Passkey SIGN-IN (WebAuthn server ceremonies). Mounted under /api/auth/passkey.
//
// Distinct from /api/keys' passkey *factor* envelopes (which wrap the E2EE
// private key and never touch authentication): here the server verifies real
// WebAuthn signatures, so it stores each credential's public key at
// registration (User.passkeyCredentials) and checks assertions against it.
// The mobile client registers the credential for sign-in and enrolls its PRF
// output as an unlock factor in the same ceremony, so one Face ID tap both
// signs in and unlocks E2EE.
//
// Config:
//   PASSKEY_RP_ID   — relying-party domain (must match the app's associated
//                     domain / the mobile PASSKEY_RP_ID). Dev default: localhost.
//   PASSKEY_ORIGINS — comma-separated expected WebAuthn origins. Defaults to
//                     https://<rp-id> (what iOS reports); add the Android
//                     android:apk-key-hash:<hash> origin for Play builds.

const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const crypto = require('crypto');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { requireAuth, signToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { alertHousehold, securityAlert } = require('../services/securityAlerts');
const { createSession } = require('../services/sessions');

const router = express.Router();

const rpID = process.env.PASSKEY_RP_ID || 'localhost';
const rpName = 'Calen';
const expectedOrigin = (process.env.PASSKEY_ORIGINS || `https://${rpID}`)
  .split(',').map((o) => o.trim()).filter(Boolean);

// Pending challenges. In-process (like middleware/rateLimit) — fine for a
// single instance; move to a shared store if this ever scales out.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const challenges = new Map(); // key -> { challenge, userId, expiresAt }
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of challenges) {
    if (now >= entry.expiresAt) challenges.delete(key);
  }
}, CHALLENGE_TTL_MS);
if (typeof sweep.unref === 'function') sweep.unref();

function putChallenge(key, challenge, userId) {
  challenges.set(key, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}
// One-shot read: a challenge can never be asserted against twice.
function takeChallenge(key) {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || Date.now() >= entry.expiresAt) return null;
  return entry;
}

const challengeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many passkey attempts. Please try again in a few minutes.' });
const assertLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many passkey attempts. Please try again in a few minutes.' });

// ── Registration (authed; called from the "add passkey" flow) ────────────────

router.post('/register-options', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: String(user._id),
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: 'none',
      excludeCredentials: (user.passkeyCredentials || []).map((c) => ({
        id: isoBase64URL.toBuffer(c.credentialId),
        type: 'public-key',
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    putChallenge(`reg:${user._id}`, options.challenge, String(user._id));
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/register', requireAuth, async (req, res) => {
  try {
    const entry = takeChallenge(`reg:${req.user._id}`);
    if (!entry) return res.status(400).json({ error: 'Registration expired — try again' });

    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verified || !registrationInfo) return res.status(400).json({ error: 'Passkey registration could not be verified' });

    const credentialId = isoBase64URL.fromBuffer(registrationInfo.credentialID);
    const user = await User.findById(req.user._id);
    user.passkeyCredentials = [
      ...(user.passkeyCredentials || []).filter((c) => c.credentialId !== credentialId),
      {
        credentialId,
        publicKey: isoBase64URL.fromBuffer(registrationInfo.credentialPublicKey),
        counter: registrationInfo.counter,
        transports: req.body.response?.transports || [],
      },
    ];
    await user.save();
    await AuditLog.create({
      userId: user._id, householdId: user.householdId, event: 'passkey_signin_added',
    });
    securityAlert(alertHousehold(user.householdId, {
      title: 'Security change',
      body: `A passkey that can sign in to ${user.firstName}'s account was added. If this wasn't ${user.firstName}, review Security now.`,
      tag: `passkey-${user._id}`,
    }));
    res.status(201).json({ credentialId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Sign-in (public, rate-limited) ───────────────────────────────────────────

// Step 1: challenge for sign-in. Two modes:
//
//  - Username-first (email supplied): constrain the assertion to this account's
//    registered passkeys and hand back each credential's E2EE PRF salt (public
//    metadata), so a single assertion signs in AND unlocks encrypted data in one
//    gesture.
//  - Usernameless (no email): the passkeys are discoverable (registered with
//    `residentKey: 'required'`), so issue a challenge with an EMPTY
//    allowCredentials and let the platform's account picker choose. The user is
//    resolved from the returned credential id at /login. No PRF salt can be sent
//    (we don't know who's signing in yet), so the client unlocks E2EE right
//    after auth (device-key cache, then a passkey assertion) rather than inline.
router.post('/challenge', challengeLimiter, async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();

    if (!email) {
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: [], // discoverable-credential (usernameless) flow
      });
      const challengeId = crypto.randomBytes(16).toString('base64url');
      putChallenge(challengeId, options.challenge, null); // no user bound yet
      return res.json({ challengeId, challenge: options.challenge, rpId: rpID, allowCredentials: [] });
    }

    const user = await User.findOne({ email });
    const creds = user?.passkeyCredentials || [];
    if (!creds.length) {
      return res.status(404).json({ error: 'Passkey sign-in is not set up for that account' });
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: isoBase64URL.toBuffer(c.credentialId),
        type: 'public-key',
        transports: c.transports?.length ? c.transports : undefined,
      })),
    });

    const challengeId = crypto.randomBytes(16).toString('base64url');
    putChallenge(challengeId, options.challenge, String(user._id));

    const prfSaltByCred = new Map(
      (user.wrappedPrivateKey || [])
        .filter((f) => f.factor === 'passkey' && f.credentialId && f.prfSalt)
        .map((f) => [f.credentialId, f.prfSalt]),
    );
    res.json({
      challengeId,
      challenge: options.challenge,
      rpId: rpID,
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        prfSalt: prfSaltByCred.get(c.credentialId) || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 2: verify the assertion and issue a session token (same response shape
// as /auth/login).
router.post('/login', assertLimiter, async (req, res) => {
  try {
    const { challengeId, response } = req.body;
    if (!challengeId || !response?.id) return res.status(400).json({ error: 'challengeId and assertion response are required' });

    const entry = takeChallenge(challengeId);
    if (!entry) return res.status(400).json({ error: 'Sign-in expired — try again' });

    // Username-first challenges bound a userId; usernameless (discoverable) ones
    // didn't, so resolve the account from the credential the authenticator
    // returned. credentialId is unique across accounts (see the User index).
    const user = entry.userId
      ? await User.findById(entry.userId)
      : await User.findOne({ 'passkeyCredentials.credentialId': response.id });
    const cred = user?.passkeyCredentials?.find((c) => c.credentialId === response.id);
    if (!cred) return res.status(401).json({ error: 'Unknown passkey' });

    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      authenticator: {
        credentialID: isoBase64URL.toBuffer(cred.credentialId),
        credentialPublicKey: isoBase64URL.toBuffer(cred.publicKey),
        counter: cred.counter,
      },
    });
    if (!verified) return res.status(401).json({ error: 'Passkey could not be verified' });

    cred.counter = authenticationInfo.newCounter;
    await user.save();

    const sid = await createSession(user._id, req);
    res.json({
      token: signToken(String(user._id), sid),
      user: { _id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role },
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

module.exports = router;
