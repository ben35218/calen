const User = require('../models/User');

// Shared phone + share-target helpers for the invitation flows (household, trip,
// calendar, event). Sharing addresses a recipient by EMAIL or PHONE. Phone is a
// loosely-normalized string (accounts are still keyed by email); it resolves to
// an account only when someone has saved that number in their Account, so a
// phone invite reaches an existing member's Invitations inbox and is otherwise
// claimed lazily when they sign up with a matching number.

// Loose normalization: keep a single leading + and the digits. Enough to dedupe
// and match reliably across formatting differences without a full E.164 parse.
// Returns null when the result isn't a plausible phone number. The mobile client
// mirrors this in mobile/src/lib/invitees.ts — keep them in sync.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (s.startsWith('+') ? '+' : '') + digits;
}

// Strict E.164 normalization (+1XXXXXXXXXX for US/CA numbers) used for OUTBOUND
// AI calls and the do-not-call suppression key — a different, stricter need than
// `normalizePhone` above (which just dedupes invite addresses). Already-plus
// numbers pass through untouched so international numbers aren't mangled. Kept
// here so services/phoneCalls.js and services/dnc.js share one definition
// without a require cycle. phoneCalls.js re-exports `toE164` for back-compat.
function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(phone).startsWith('+')) return phone;
  return `+${digits}`;
}

// Last four digits, for privacy-preserving display of a suppressed number (a
// DncEntry stores the HMAC of the full number, never the raw value).
function last4(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-4);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Resolve an invite address to { toEmail, toPhone, toUserId }. Exactly one of
// email/phone should be provided. `toUserId` is set when the address matches an
// existing account (by email, or by saved phone). Throws a plain string (the
// caller maps it to a 400) when the address is malformed.
async function resolveShareTarget({ email, phone } = {}) {
  if (phone !== undefined && phone !== null && phone !== '') {
    const toPhone = normalizePhone(phone);
    if (!toPhone) throw 'A valid phone number is required';
    const recipient = await User.findOne({ phone: toPhone }).select('_id householdId').lean();
    return { toEmail: null, toPhone, toUserId: recipient?._id || null, recipient };
  }
  const toEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(toEmail)) throw 'Enter a valid email address';
  const recipient = await User.findOne({ email: toEmail }).select('_id householdId').lean();
  return { toEmail, toPhone: null, toUserId: recipient?._id || null, recipient };
}

module.exports = { normalizePhone, resolveShareTarget, EMAIL_RE, toE164, last4 };
