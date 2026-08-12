const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Household = require('../models/Household');
const Contact = require('../models/Contact');
const Category = require('../models/Category');
const { requireAuth, signToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { sendPasswordResetCode, sendNewDeviceAlert, sendWelcome } = require('../services/mailer');
const { deleteUserAndData } = require('../services/accountDeletion');
const { seedDefaultCategories, seedDefaultSubcategories } = require('../seed');
const { createSession, revokeSession, deviceFromReq } = require('../services/sessions');
const { pushToUser } = require('../services/notify');

const router = express.Router();

// Per-IP throttles on the unauthenticated endpoints (the limiter falls back to
// req.ip when there's no req.user). Generous for real users, hostile to
// credential stuffing / code brute-forcing. The register cap stays high enough
// that the integration-test harness (many registrations per file) never trips it.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many sign-in attempts. Please try again in a few minutes.' });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'Too many accounts created from this network. Please try again later.' });
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many reset requests. Please try again in a few minutes.' });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many reset attempts. Please try again in a few minutes.' });
// Authed but credential-changing — keyed per user once requireAuth has run.
const credChangeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please try again in a few minutes.' });

// Passkey sign-in ceremonies (WebAuthn challenge + assertion verify).
router.use('/passkey', require('./authPasskey'));

// The login/register/reset response body, one shape everywhere. Creates the
// F2 session row backing the token; `quiet` skips the new-device alert
// (registration — the account is seconds old).
async function sessionResponse(user, req, { quiet = false } = {}) {
  const sid = await createSession(user._id, req, { quiet });
  return {
    token: signToken(String(user._id), sid),
    user: {
      _id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName,
      role: user.role, hasPassword: user.hasPassword !== false,
      e2eePasswordStale: !!user.e2eePasswordStale,
      // Per-user $4.99 app unlock — the mobile hard paywall keys off this (and
      // re-caches it on every login/refresh).
      appUnlocked: !!user.appUnlocked,
    },
  };
}

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, firstName, lastName, passwordless } = req.body;
    if (!email || !password || !firstName) return res.status(400).json({ error: 'email, password and first name required' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Passwordless signups send an on-device random secret as `password` (it wraps
    // the E2EE envelope) and flag `passwordless` so we record that no real password
    // exists — the unlock UI then offers recovery/passkey instead of a password.
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      email, passwordHash, firstName, lastName: lastName || '', hasPassword: !passwordless,
    });

    // Every new user starts in their own household (others can join via its code later).
    const household = await Household.createForOwner(user._id, `${firstName}'s Household`);
    user.householdId = household._id;
    await user.save();

    // Starter AI credits, so the assistant can be tried before the first pack
    // purchase. Idempotent (ledger-keyed) and best-effort — a grant failure
    // must never fail signup.
    try {
      const { grantStarterCredits } = require('../services/credits');
      const { getConfig } = require('../middleware/usageMeter');
      await grantStarterCredits(user._id, await getConfig());
    } catch (err) {
      console.error('[register] starter credit grant failed:', err.message);
    }

    // Welcome email (onboarding lifecycle). Fire-and-forget — the mailer never
    // throws, and a mail hiccup must not fail signup.
    sendWelcome(user).catch(() => {});

    // Signal-parity C3b: the server no longer seeds PLAINTEXT content (default
    // categories + subcategories + the self-Contact) into per-collection tables —
    // those tables are gone, and content lives in the opaque store. The client
    // seeds them ENCRYPTED after first unlock (lib/categories.ensureDefaultCategories
    // + the self-Contact createSelf via /records), so a fresh mandated household is
    // born with no plaintext content and no stragglers to seal.

    res.status(201).json(await sessionResponse(user, req, { quiet: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    res.json(await sessionResponse(user, req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Forgot password ──────────────────────────────────────────────────────────
// Step 1: email a short-lived 6-digit code. Always answers { ok: true } so the
// endpoint can't be used to probe which emails have accounts.
router.post('/forgot', forgotLimiter, async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });

    const user = await User.findOne({ email });
    if (user) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      user.resetCodeHash = await bcrypt.hash(code, 12);
      user.resetCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      user.resetCodeAttempts = 0;
      await user.save();
      await sendPasswordResetCode(user, code); // never throws (mailer contract)
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: verify the code and set the new password, then sign the user in.
// NOTE (E2EE): this changes only the LOGIN password. The password-wrapped key
// envelope still needs the old password — the client unlocks with a passkey or
// recovery code afterwards and re-wraps (rewrapForNewPassword). The server
// deliberately leaves the stale envelope in place: removing it could strip the
// account's last factor and make the data unrecoverable.
router.post('/reset', resetLimiter, async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const { code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'email, code and new password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const user = await User.findOne({ email });
    const expired = !user?.resetCodeHash || !user.resetCodeExpiresAt || user.resetCodeExpiresAt < new Date();
    if (expired || user.resetCodeAttempts >= 5) {
      return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
    }

    const valid = await bcrypt.compare(String(code), user.resetCodeHash);
    if (!valid) {
      user.resetCodeAttempts += 1;
      await user.save();
      return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
    }

    // ── Registration-lock analog (Signal-parity F1) ──────────────────────────
    // Email possession alone must not take over a protected account (one with
    // enrolled keys + confirmed recovery). A reset is immediate only from a
    // KNOWN device — proven by a valid session token for this same account in
    // the Authorization header (the "reset while signed in on my own phone"
    // case). Anything else opens a hold window with loud notifications; the
    // reset only completes after it elapses (request a fresh code then), and
    // any signed-in device can cancel it. Takeover becomes slow and noisy.
    const protectedAccount = Boolean(user.identityPublicKey && user.recoverySetupAt);
    if (protectedAccount && !(await isKnownDevice(req, user))) {
      const holdHours = Number(process.env.RESET_COOLDOWN_HOURS || 24);
      if (!user.resetHoldUntil) {
        user.resetHoldUntil = new Date(Date.now() + holdHours * 60 * 60 * 1000);
        // Keep the code single-use: this verify consumed it. The completing
        // request after the hold brings a fresh one.
        user.resetCodeHash = undefined;
        user.resetCodeExpiresAt = undefined;
        user.resetCodeAttempts = 0;
        await user.save();
        const device = deviceFromReq(req);
        pushToUser(user, {
          title: 'Password reset requested',
          body: `A password reset was requested from ${device.deviceName}. It completes ${user.resetHoldUntil.toLocaleString()} unless you cancel it in Sign-in & Security.`,
          tag: `reset-${user._id}`,
        }).catch(() => {});
        sendNewDeviceAlert(user, device, { holdUntil: user.resetHoldUntil }).catch(() => {});
        return res.status(202).json({ holdUntil: user.resetHoldUntil });
      }
      if (user.resetHoldUntil > new Date()) {
        // Window still open — report it (idempotent; no new notifications).
        user.resetCodeHash = undefined;
        user.resetCodeExpiresAt = undefined;
        await user.save();
        return res.status(202).json({ holdUntil: user.resetHoldUntil });
      }
      // Hold elapsed without a cancel — fall through and apply the reset.
    }
    user.resetHoldUntil = undefined;

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.hasPassword = true; // the user now knows a real password (even if formerly passwordless)
    // The E2EE password factor is still wrapped under the OLD password, so the new
    // one can't unwrap it — flag it stale so the unlock UI steers to the recovery
    // code/passkey instead of a dead password field. Only when the account is
    // actually E2EE-enrolled (has a password factor to go stale); a never-enrolled
    // account has nothing to re-wrap. Cleared when the client re-wraps the factor.
    if (user.identityPublicKey) user.e2eePasswordStale = true;
    user.resetCodeHash = undefined;
    user.resetCodeExpiresAt = undefined;
    user.resetCodeAttempts = 0;
    await user.save();
    res.json({ ...(await sessionResponse(user, req)), e2eeEnrolled: Boolean(user.identityPublicKey) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Known device (F1) — the reset skips the hold window when either:
//  - the Authorization header carries a valid session token for THIS user
//    ("I forgot my password but I'm signed in on my own phone"); or
//  - the request's X-Device-Id matches an existing device-session row: the
//    install signed in to this account before and was never revoked. Sign-out
//    is client-local (the row persists), so signing out alone doesn't demote a
//    device — explicitly removing it in Sign-in & Security does. The id is an
//    unguessable keychain-held 128-bit value, but it IS client-supplied: a
//    deliberate, weak recognition signal that only skips the hold; it never
//    authenticates a session by itself.
async function isKnownDevice(req, user) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (String(payload.userId) === String(user._id)) {
        // Sid-carrying tokens must still be live sessions; legacy sid-less
        // tokens count as known (they'll be upgraded by the sliding refresh).
        if (!payload.sid) return true;
        if ((user.sessions || []).some((s) => String(s._id) === String(payload.sid))) return true;
      }
    } catch { /* fall through to the device-id check */ }
  }
  const { deviceId } = deviceFromReq(req);
  return Boolean(deviceId) && (user.sessions || []).some((s) => s.deviceId === deviceId);
}

// Cancel a pending held reset (F1) from any signed-in device — the "that
// wasn't me" button. Also clears any outstanding code.
router.post('/reset/cancel', requireAuth, async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user._id },
      { $unset: { resetHoldUntil: 1, resetCodeHash: 1, resetCodeExpiresAt: 1 }, $set: { resetCodeAttempts: 0 } },
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Device sessions (Signal-parity F2) ───────────────────────────────────────

router.get('/sessions', requireAuth, (req, res) => {
  const rows = (req.user.sessions || [])
    .map((s) => ({
      _id: s._id, deviceName: s.deviceName, platform: s.platform,
      createdAt: s.createdAt, lastSeenAt: s.lastSeenAt,
      current: String(s._id) === String(req.sessionId),
    }))
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  res.json({ sessions: rows, pendingResetHoldUntil: req.user.resetHoldUntil || null });
});

router.delete('/sessions/:sid', requireAuth, async (req, res) => {
  try {
    const removed = await revokeSession(req.user._id, req.params.sid);
    if (!removed) return res.status(404).json({ error: 'No such device session' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// Change login email. Re-auth mirrors password change (biometric-first with a
// current-password fallback, see specs/features/auth-identity.md): the client
// confirms a fresh device unlock and omits `currentPassword`, or sends it for
// server-side verification when biometric isn't available. `currentPassword` is
// therefore optional; verified with `bcrypt` when present.
router.put('/email', requireAuth, credChangeLimiter, async (req, res) => {
  try {
    const { email, currentPassword } = req.body;
    const newEmail = email?.trim().toLowerCase();
    if (!newEmail) return res.status(400).json({ error: 'email is required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) return res.status(400).json({ error: 'Enter a valid email address' });

    const user = await User.findById(req.user._id);
    if (currentPassword) {
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    if (newEmail === user.email) return res.json({ _id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName });
    const taken = await User.findOne({ email: newEmail });
    if (taken) return res.status(409).json({ error: 'That email is already in use' });

    user.email = newEmail;
    await user.save();
    res.json({ _id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password. Re-auth is biometric-first with a current-password fallback
// (see specs/features/auth-identity.md): when the client can confirm a fresh
// device biometric it omits `currentPassword` and the change proceeds on the
// authenticated session. When biometric isn't available the client sends
// `currentPassword` and we verify it here. `currentPassword` is therefore
// optional; when present it MUST match. The biometric branch is enforced
// on-device, so `requireAuth` + `credChangeLimiter` remain the server gates.
router.put('/password', requireAuth, credChangeLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'New password is required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const user = await User.findById(req.user._id);
    if (currentPassword) {
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.hasPassword = true;
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanent, irreversible account deletion (Apple 5.1.1(v)). Re-authenticate
// with the password before wiping — this is destructive and the session token
// alone shouldn't be enough. Deletes the user and all their data (see
// services/accountDeletion); the now-invalid session 401s on its next request.
router.delete('/account', requireAuth, credChangeLimiter, async (req, res) => {
  try {
    const { password } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Passwordless accounts (passkey / OAuth) never know their `passwordHash`
    // — it's a random on-device secret — so we can't re-auth with a password.
    // The valid session token (requireAuth) is the identity proof here.
    if (user.hasPassword !== false) {
      if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Password is incorrect' });
    }

    await deleteUserAndData(user);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
