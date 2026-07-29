const crypto = require('crypto');
const DncEntry = require('../models/DncEntry');
const AuditLog = require('../models/AuditLog');
const { toE164, last4 } = require('./phone');

// Do-not-call suppression for outbound AI calls (spec: features/ai-assistant.md).
// The recipient of a Calen call can stop future automated calls; this is where
// that suppression is stored and enforced. Every placement runs `isSuppressed`
// before dialing (services/phoneCalls.js `placeCall`), and a suppressed number
// is refused on every entry point via `DoNotCallError`.
//
// Scope is platform-wide by phone number — one opt-out blocks every household.
// The list stores only an HMAC of the E.164 number (never the raw value); see
// models/DncEntry.js for the privacy rationale.

// Thrown by placeCall when the target number is on the do-not-call list. Routes
// and the chat call_business tool map it to a clear user-facing refusal.
class DoNotCallError extends Error {
  constructor(message = 'This number has asked not to receive automated calls and can no longer be called.') {
    super(message);
    this.name = 'DoNotCallError';
    this.code = 'DNC_SUPPRESSED';
    this.status = 403;
  }
}

// The HMAC key. A dedicated DNC_HASH_SECRET is required in production so the
// suppression list survives independently of auth-secret rotation; outside
// production it falls back to JWT_SECRET (already present in every env) and, if
// even that is absent (bare unit tests), a fixed dev constant so hashing stays
// deterministic within a run.
function hashSecret() {
  const s = process.env.DNC_HASH_SECRET || process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DNC_HASH_SECRET (or JWT_SECRET) must be set to enforce do-not-call');
  }
  return 'dev-dnc-secret';
}

// Deterministic HMAC of the normalized number — the match key.
function numberHash(phone) {
  return crypto.createHmac('sha256', hashSecret()).update(toE164(phone)).digest('hex');
}

// Is this number on the do-not-call list? Called before every outbound call.
// A hashing/config failure is logged and treated as "not suppressed" rather than
// throwing — a broken secret must not silently block all calls (an admin sees
// nothing suppressed and the log explains why), but see hashSecret(): production
// requires the secret up front, so this only trips in a misconfigured env.
async function isSuppressed(phone) {
  if (!phone) return false;
  let hash;
  try {
    hash = numberHash(phone);
  } catch (e) {
    console.error('DNC isSuppressed hashing failed:', e.message);
    return false;
  }
  const entry = await DncEntry.findOne({ numberHash: hash, active: true }).select('_id').lean();
  return Boolean(entry);
}

// Add a number to the do-not-call list. Idempotent: upserts on the hash and only
// audits when the entry is newly created or flipped active (so the analysis
// backstop and repeated support adds don't spam the audit log). Returns the
// entry and whether this call changed suppression state.
async function suppress(phone, { source = 'callee-request', note, createdBy, userId, householdId } = {}) {
  const hash = numberHash(phone);
  const before = await DncEntry.findOne({ numberHash: hash }).lean();
  const wasActive = Boolean(before && before.active);

  const entry = await DncEntry.findOneAndUpdate(
    { numberHash: hash },
    {
      $set: { active: true, source, ...(note !== undefined ? { note } : {}), ...(createdBy ? { createdBy } : {}) },
      $setOnInsert: { numberHash: hash, last4: last4(phone) },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  const changed = !wasActive;
  if (changed) {
    await AuditLog.create({
      userId, householdId,
      event: 'dnc_suppressed',
      meta: { source, last4: entry.last4, ...(createdBy ? { by: String(createdBy) } : {}) },
    });
  }
  return { entry, changed };
}

// Release a number (admin only). Sets active:false rather than deleting, so the
// history of the request survives. Referenced by entry id (admins never handle
// the raw number). Returns the updated entry, or null if not found.
async function release(entryId, { by, householdId } = {}) {
  const entry = await DncEntry.findById(entryId);
  if (!entry) return null;
  if (entry.active) {
    entry.active = false;
    await entry.save();
    await AuditLog.create({
      userId: by, householdId,
      event: 'dnc_released',
      meta: { source: entry.source, last4: entry.last4, ...(by ? { by: String(by) } : {}) },
    });
  }
  return entry;
}

module.exports = { DoNotCallError, numberHash, isSuppressed, suppress, release };
