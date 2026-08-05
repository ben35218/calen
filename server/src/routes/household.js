const express = require('express');
const User = require('../models/User');
const Household = require('../models/Household');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const JoinRequest = require('../models/JoinRequest');
const HouseholdInvitation = require('../models/HouseholdInvitation');
const HouseholdNotice = require('../models/HouseholdNotice');
const AuditLog = require('../models/AuditLog');
const { requireAuth } = require('../middleware/auth');
const { resolveShareTarget } = require('../services/phone');
const { pushToUser } = require('../services/notify');
const { rateLimit } = require('../middleware/rateLimit');
const { dedupeCategoriesForScope } = require('../services/dedupeCategories');
const { validateHDKEnvelope, validateRotation, pickRecordEnc } = require('../services/householdKey');
const { computeReadiness, DROP_FIELDS, DROP_FIELDS_VERSION } = require('../services/dropReadiness');
const { e2eeRequired, stripSealedContent, AUTHOR_HIDDEN, E2EE_REQUIRED_MESSAGE } = require('../services/e2eePolicy');
const { alertHousehold, alertUser, securityAlert } = require('../services/securityAlerts');
const { dropPlaintext } = require('../scripts/dropPlaintext');
const { CONTENT_MODELS } = require('../services/contentModels');
const Record = require('../models/Record');
const { sharedTripIds, excludeSharedFilter } = require('../services/tripSharing');
const { outsideSharedCalendarKeys, excludeOutsideCalendarFilter } = require('../services/calendarSharing');
const CustomCalendar = require('../models/CustomCalendar');

const router = express.Router();
router.use(requireAuth);

// Throttle code-guessing on the join endpoint: a handful of tries per minute is
// plenty for a real invite, but makes brute-force enumeration infeasible.
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many join attempts. Please wait a minute and try again.',
});

async function membersOf(householdId) {
  return User.find({ householdId }, 'firstName lastName email').sort('firstName').lean();
}

// After a member leaves a household: delete it if now empty, otherwise transfer
// ownership to a remaining member if the departing user was the owner, and flag
// a key rotation so the departed member can't read future writes (§5.2). The
// departed member's stale envelopes are dropped — they're no longer a member.
async function handleDeparture(householdId, departedUserId) {
  if (!householdId) return;
  const members = await User.find({ householdId }, '_id').sort('createdAt').lean();
  if (!members.length) {
    // Invariant: never destroy key material while ciphertext that needs it still
    // exists. A memberless household is only safe to reap once its records are
    // gone — deleting the envelope out from under live records orphans them
    // permanently. If any remain, leave the household + envelope in place.
    if (await Record.exists({ householdId })) return;
    await Household.deleteOne({ _id: householdId });
    await HouseholdKeyEnvelope.deleteMany({ householdId });
    return;
  }
  const hh = await Household.findById(householdId);
  const update = {};
  if (hh && String(hh.ownerId) === String(departedUserId)) update.ownerId = members[0]._id;
  // Only rotate a household that actually has a key; a keyless one has nothing to
  // protect yet (its v1 mint will simply exclude the departed member).
  if (hh && (hh.currentKeyVersion || 0) >= 1) update.keyRotationPending = true;
  if (Object.keys(update).length) await Household.updateOne({ _id: householdId }, { $set: update });
  await HouseholdKeyEnvelope.deleteMany({ householdId, userId: departedUserId });
}

// Current household + members.
router.get('/', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const members = await membersOf(req.household._id);
    res.json({
      _id: req.household._id,
      name: req.household.name,
      // The sealed settings blob (name + homeAddress — C2): post-drop the
      // client decrypts the name from here.
      enc: req.household.enc,
      keyVersion: req.household.keyVersion,
      ownerId: req.household.ownerId,
      isOwner: String(req.household.ownerId) === String(req.user._id),
      e2eeActive: !!req.household.e2eeActive,
      // Signal-parity pass-2: this household was dropped under an older
      // DROP_FIELDS version and still has newer columns in plaintext — the
      // client runs the re-seal-all backfill (dropMigration.reencryptForReDrop).
      resealNeeded: !!req.household.e2eeActive && (req.household.dropFieldsVersion || 0) < DROP_FIELDS_VERSION,
      members,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// §9 drop readiness gate (read-only): is every member enrolled + holding a
// current-version key envelope? Powers the household-wide readiness checklist
// before the plaintext drop. See docs/E2EE-SYNC-PLAN.md §9.2.
router.get('/e2ee/readiness', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const [members, envelopes] = await Promise.all([
      User.find({ householdId: req.household._id }).select('email identityPublicKey clientVersion clientPlatform').lean(),
      HouseholdKeyEnvelope.find({ householdId: req.household._id }).select('userId keyVersion').lean(),
    ]);
    res.json({
      e2eeActive: !!req.household.e2eeActive,
      ...computeReadiness({
        members,
        envelopes,
        currentKeyVersion: req.household.currentKeyVersion,
        minAppVersion: process.env.E2EE_MIN_APP_VERSION || null,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// §9 straggler re-encrypt pass. Records created before dual-write (or minted
// server-side, e.g. from a template) lack an `enc` blob and would be lost at the
// drop. This returns, per collection, the plaintext content fields of records
// missing ciphertext, so the owner's device can seal them under the current HDK
// and POST them back to /e2ee/seal. Household-scoped; capped per collection.
router.get('/e2ee/stragglers', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const LIMIT = 500;
    const collections = [];
    let total = 0;
    // Shared trips (and their items) stay plaintext for cross-household
    // collaborators, so they're not stragglers — never offer them for sealing.
    // Same for events on outside-shared custom calendars (§9.5).
    const sharedIds = await sharedTripIds(CONTENT_MODELS.Trip, req.scopeIds);
    const sharedCalKeys = await outsideSharedCalendarKeys(CustomCalendar, req.scopeIds);
    for (const [collection, Model] of Object.entries(CONTENT_MODELS)) {
      const fields = DROP_FIELDS[collection];
      if (!fields) continue;
      const projection = fields.reduce((p, f) => ((p[f] = 1), p), { keyVersion: 1 });
      const rows = await Model.find({
        // req.scopeFilter is itself an $or (householdId ∪ userId), so it must be
        // $and-combined with the enc $or — spreading both into one object would
        // clobber the scoping $or and leak across households.
        $and: [req.scopeFilter, { $or: [{ enc: { $exists: false } }, { enc: null }] }],
        ...excludeSharedFilter(collection, sharedIds),
        ...excludeOutsideCalendarFilter(collection, sharedCalKeys),
      }).select(projection).limit(LIMIT).lean();
      if (rows.length) { collections.push({ collection, fields, records: rows }); total += rows.length; }
    }
    res.json({ total, collections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write a client-sealed `enc` blob onto an existing record (the seal step of the
// straggler pass). Content-blind: validates the ciphertext shape + collection
// allowlist + household scope, and sets only enc/keyVersion.
router.post('/e2ee/seal', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const { collection, _id } = req.body || {};
    const Model = CONTENT_MODELS[collection];
    if (!Model) return res.status(400).json({ error: 'unknown collection' });
    let encFields;
    try { encFields = pickRecordEnc(req.body); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!encFields.enc) return res.status(400).json({ error: 'enc required' });
    // Signal-parity C3b: route the seal to the right store. The 9 author-hidden
    // collections migrated into the unified `Record` store (the source of truth
    // post-cutover) — their re-seal target is `Record`, keyed by the same `_id`
    // (the re-seal-all / straggler passes still READ the per-collection tables to
    // get the plaintext to fold + the collection for a v1 decrypt, but the v2
    // ciphertext lands in `Record`; requires migrateToRecords.js to have run — the
    // documented C3b ops order). Trip/TripItem stay their own collections (the C4
    // routing deviation), so they re-seal in place.
    const target = AUTHOR_HIDDEN.has(collection) ? Record : Model;
    const r = await target.updateOne(
      { _id, ...req.scopeFilter },
      { $set: encFields },
    );
    if (!r.matchedCount) return res.status(404).json({ error: 'record not found in your household' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B1 (Signal-parity plan) — eager re-encryption after rotation. Returns, per
// collection, the enc-bearing records still sealed under an OLD key version so
// an unlocked device can decrypt them (version→HDK map) and re-seal them under
// the current version via /e2ee/seal. Once this drains to zero, /key/retire
// (B3) can delete the old envelopes — upgrading member removal from "protects
// future data" to "protects everything".
router.get('/e2ee/old-versions', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const current = req.household.currentKeyVersion || 0;
    if (current < 2) return res.json({ total: 0, collections: [] }); // nothing older than v1 can exist
    const LIMIT = 500;
    const collections = [];
    let total = 0;
    // The D1/D2 guard (shared for reads + retire): a resource-sealed record's
    // keyVersion is a resource-key version (CalendarKey/TripKey), not an HDK
    // version — never re-seal it under the HDK.
    const hdkOld = { enc: { $exists: true, $ne: null }, keyVersion: { $lt: current }, 'enc.ks': { $nin: ['cal', 'trip'] } };
    // Signal-parity C3b: the 9 author-hidden collections live in the unified
    // `Record` store (opaque — no collection field). The client decrypts each
    // OPAQUELY (openOpaqueRecord recovers the type from the v2 ciphertext) and
    // re-seals it through /records. Returned under the pseudo-collection 'Record'.
    const recordRows = await Record.find({ ...req.scopeFilter, ...hdkOld })
      .select('enc keyVersion').limit(LIMIT).lean();
    if (recordRows.length) { collections.push({ collection: 'Record', records: recordRows }); total += recordRows.length; }
    // Trip / TripItem stay their own collections (the C4 routing deviation) — the
    // client decrypts them BY collection and re-seals via /e2ee/seal (which routes
    // them back in place).
    for (const collection of ['Trip', 'TripItem']) {
      const rows = await CONTENT_MODELS[collection].find({ ...req.scopeFilter, ...hdkOld })
        .select('enc keyVersion').limit(LIMIT).lean();
      if (rows.length) { collections.push({ collection, records: rows }); total += rows.length; }
    }
    res.json({ total, collections, currentKeyVersion: current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-seal + re-drop backfill (Signal-parity pass-2 insert). A household dropped
// under an OLDER DROP_FIELDS version still carries the fields ADDED since (v2:
// nextDueDate, odometer reading/notes, meal notes, category names — the
// household name rides in the settings blob) in plaintext, and its old `enc`
// blobs predate those fields. This endpoint lists every content record that
// still has a plaintext DROP_FIELDS value (or no `enc` at all), together with
// its current `enc`, so the owner's unlocked device can decrypt-merge-reseal:
// fold the plaintext fields into a fresh `enc` under the current subset. Only
// AFTER that (marked via /e2ee/reseal-complete) may scripts/reDropPlaintext.js
// null the plaintext — never before, since the old enc doesn't contain them.
router.get('/e2ee/reseal-all', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const LIMIT = 1000;
    const collections = [];
    let total = 0;
    // Same plaintext-lane exemptions as the straggler/drop paths (§9.3/§9.5).
    const sharedIds = await sharedTripIds(CONTENT_MODELS.Trip, req.scopeIds);
    const sharedCalKeys = await outsideSharedCalendarKeys(CustomCalendar, req.scopeIds);
    for (const [collection, Model] of Object.entries(CONTENT_MODELS)) {
      const fields = DROP_FIELDS[collection];
      if (!fields) continue;
      // "Needs re-seal" = a plaintext content column is still set, OR the record
      // carries no ciphertext yet (a straggler predating this collection's enc).
      const plaintextSet = fields.map((f) => ({ [f]: { $nin: [null, undefined] } }));
      // Signal-parity C4: an HDK-sealed record that still carries a plaintext
      // `userId` needs re-sealing too, so the backfill folds the author into `enc`
      // before the re-drop nulls the column. (A resource-sealed `enc.ks` record
      // keeps its userId — the §C4 routing deviation — so it's excluded here.)
      const authorPending = AUTHOR_HIDDEN.has(collection)
        ? [{ enc: { $exists: true }, 'enc.ks': { $exists: false }, userId: { $nin: [null, undefined] } }]
        : [];
      const rows = await Model.find({
        // C3b/C4: scope by household (not userId ∈ scopeIds) so author-nulled
        // sealed records — which carry no plaintext userId but may still hold a v4
        // plaintext routing column to fold in — are found by the re-seal pass.
        // req.scopeFilter is an $or, so $and-combine it with the "needs re-seal" $or
        // (spreading both would clobber the scoping $or → cross-household leak).
        $and: [
          req.scopeFilter,
          { $or: [...plaintextSet, ...authorPending, { enc: { $exists: false } }, { enc: null }] },
        ],
        ...excludeSharedFilter(collection, sharedIds),
        ...excludeOutsideCalendarFilter(collection, sharedCalKeys),
      }).select([...fields, 'enc', 'keyVersion', 'userId'].reduce((p, f) => ((p[f] = 1), p), {}))
        .limit(LIMIT).lean();
      if (rows.length) { collections.push({ collection, fields, records: rows }); total += rows.length; }
    }
    res.json({ total, collections, dropFieldsVersion: DROP_FIELDS_VERSION });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark the re-seal-all pass complete: every enc-bearing record now carries the
// current DROP_FIELDS in its ciphertext, so the re-drop script may null the
// plaintext. The client calls this only after re-sealing every record with zero
// failures. Stamping the current version is the machine-checkable interlock the
// script demands before the irreversible null (NEVER null before re-sealing).
router.post('/e2ee/reseal-complete', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    await Household.updateOne({ _id: req.household._id }, { $set: { dropFieldsVersion: DROP_FIELDS_VERSION } });
    res.json({ ok: true, dropFieldsVersion: DROP_FIELDS_VERSION });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Join carry-over: rescue records stranded in a household the caller left ──
//
// Moving between households used to be a one-line `User.householdId` flip, on the
// premise that "your own data comes with you" — true when the read scope was
// `userId ∈ scopeIds`. Signal-parity C4 ended that: an e2eeActive household's
// records are stamped with ITS householdId and have their plaintext `userId`
// dropped (see routes/records.js), so after a move the joiner's own records match
// neither branch of `scopeClause` and are sealed under a key the destination
// household doesn't hold. They aren't lost — `handleDeparture` refuses to reap a
// household that still holds ciphertext — but they're invisible.
//
// The server can't re-seal (it never holds an HDK), so the joiner's unlocked
// device drives the move: list the stranded rows here, decrypt them under the old
// household's HDK, re-seal under the new one, and PUT each back. Authorization is
// **envelope-holding**: we only serve ciphertext from a household the caller still
// has a HouseholdKeyEnvelope for — key material they already possess, so this
// reveals nothing they couldn't already read.

// Households the caller holds key material for but is no longer a member of.
async function orphanedHouseholdsFor(userId, currentHouseholdId) {
  const envelopes = await HouseholdKeyEnvelope
    .find({ userId }, 'householdId keyVersion wrappedHDK').lean();
  const byHousehold = new Map();
  for (const e of envelopes) {
    if (currentHouseholdId && String(e.householdId) === String(currentHouseholdId)) continue;
    const key = String(e.householdId);
    if (!byHousehold.has(key)) byHousehold.set(key, { householdId: key, envelopes: [] });
    byHousehold.get(key).envelopes.push({ keyVersion: e.keyVersion, wrappedHDK: e.wrappedHDK });
  }
  return [...byHousehold.values()];
}

// Only HDK-sealed, live rows move. A resource-scoped record (`enc.ks` 'cal'/'trip')
// is deliberately excluded: it routes by `scope.resource` to collaborators in ANY
// household (the D1/D2 lane), so it is already reachable from the new household and
// re-stamping its householdId would break the owner-side rotation accounting.
const CARRYOVER_FILTER = {
  deleted: { $ne: true },
  enc: { $exists: true, $ne: null },
  'enc.ks': { $nin: ['cal', 'trip'] },
};

// GET /household/carryover — the caller's stranded records, grouped by the
// household they're marooned in, with that household's envelopes so the device can
// unwrap the key needed to read them.
router.get('/carryover', async (req, res) => {
  try {
    // No destination household means nowhere to carry anything TO — listing
    // ciphertext the caller couldn't move would be pointless, not just harmless.
    if (!req.household) return res.json({ total: 0, households: [] });
    const LIMIT = 500;
    const orphans = await orphanedHouseholdsFor(req.user._id, req.household._id);
    const households = [];
    let total = 0;
    for (const orphan of orphans) {
      const records = await Record
        .find({ householdId: orphan.householdId, ...CARRYOVER_FILTER })
        .select('enc keyVersion scope').limit(LIMIT).lean();
      if (!records.length) continue;
      households.push({ ...orphan, records });
      total += records.length;
    }
    res.json({ total, households });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /household/carryover/:id — the device posts one record re-sealed under the
// destination household's HDK; the server re-stamps its householdId. This MOVES
// the row (keeping its `_id`) rather than copying it, so attachments, invitations,
// and every other reference by event/task id survive the merge intact.
router.put('/carryover/:id', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    let enc;
    try { enc = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!enc.enc) return res.status(400).json({ error: E2EE_REQUIRED_MESSAGE });

    const record = await Record.findById(req.params.id).select('householdId enc').lean();
    if (!record) return res.status(404).json({ error: 'No such record' });
    // Already carried over (a retried pass) — idempotent success, not an error.
    if (String(record.householdId) === String(req.household._id)) return res.json({ ok: true, moved: false });

    // The only authorization that matters: the caller must still hold a key
    // envelope for the household this record lives in.
    const holdsKey = await HouseholdKeyEnvelope.exists({
      householdId: record.householdId, userId: req.user._id,
    });
    if (!holdsKey) return res.status(403).json({ error: 'Not your record' });

    // C4: an HDK record in an e2eeActive household attributes to the household
    // only — the author stays sealed inside `enc`, exactly as a fresh write would.
    const update = { ...enc, householdId: req.household._id };
    const unset = req.household.e2eeActive ? { userId: 1 } : {};
    await Record.updateOne(
      { _id: record._id },
      { $set: update, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { timestamps: true },
    );
    res.json({ ok: true, moved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /household/carryover/complete — drain and reap. Once the live records are
// out, the tombstones left behind carry no content and only exist to block the
// reap `handleDeparture` skipped, so delete them and retire the empty household.
// Left alone (and reported back) if resource-scoped records still route through it.
router.post('/carryover/complete', async (req, res) => {
  try {
    // Symmetric with the listing: without a destination nothing was carried over,
    // so there is nothing drained and certainly nothing safe to reap.
    if (!req.household) return res.json({ ok: true, reaped: 0, remaining: [] });
    const orphans = await orphanedHouseholdsFor(req.user._id, req.household._id);
    let reaped = 0;
    const remaining = [];
    for (const orphan of orphans) {
      const members = await User.countDocuments({ householdId: orphan.householdId });
      if (members > 0) continue; // still someone else's live household — never touch it
      const live = await Record.countDocuments({ householdId: orphan.householdId, ...CARRYOVER_FILTER });
      if (live > 0) { remaining.push(orphan.householdId); continue; }
      // Anything left is a tombstone or a resource-lane row. Tombstones go; a
      // resource-lane row must keep its household (and therefore its key) alive.
      await Record.deleteMany({ householdId: orphan.householdId, deleted: true });
      if (await Record.exists({ householdId: orphan.householdId })) { remaining.push(orphan.householdId); continue; }
      await Household.deleteOne({ _id: orphan.householdId });
      await HouseholdKeyEnvelope.deleteMany({ householdId: orphan.householdId });
      reaped++;
    }
    res.json({ ok: true, reaped, remaining });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B3 — retire old key versions. Only when NOTHING is still sealed under them:
// re-sealed records AND attachment file keys (Manual, TripItem attachments are
// wrapped under a specific HDK version — deleting an envelope they still need
// would orphan the file). On success the old HouseholdKeyEnvelope rows are
// deleted, so a compromised member key exposes the current version only.
router.post('/key/retire', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const current = req.household.currentKeyVersion || 0;
    if (current < 2) return res.json({ ok: true, retired: 0 });

    // D1/D2: resource-sealed records use resource-key versions — exclude them from
    // the HDK-version retirement accounting (see /e2ee/old-versions).
    const hdkOld = { enc: { $exists: true, $ne: null }, keyVersion: { $lt: current }, 'enc.ks': { $nin: ['cal', 'trip'] } };
    let remaining = 0;
    // C3b: the 9 author-hidden collections live in the unified Record store; Trip/
    // TripItem stay their own. Count old-version HDK records across both.
    remaining += await Record.countDocuments({ ...req.scopeFilter, ...hdkOld });
    for (const collection of ['Trip', 'TripItem']) {
      remaining += await CONTENT_MODELS[collection].countDocuments({ ...req.scopeFilter, ...hdkOld });
    }
    const Manual = require('../models/Manual');
    remaining += await Manual.countDocuments({
      userId: { $in: req.scopeIds }, encrypted: true, keyVersion: { $lt: current },
    });
    remaining += await CONTENT_MODELS.TripItem.countDocuments({
      userId: { $in: req.scopeIds },
      attachments: { $elemMatch: { encrypted: true, keyVersion: { $lt: current } } },
    });
    if (remaining > 0) return res.status(409).json({ error: 'old-version records remain', remaining });

    const del = await HouseholdKeyEnvelope.deleteMany({
      householdId: req.household._id, keyVersion: { $lt: current },
    });
    if (del.deletedCount) {
      await AuditLog.create({
        userId: req.user._id, householdId: req.household._id, event: 'hdk_retired',
        meta: { retiredBelow: current, envelopes: del.deletedCount },
      });
    }
    res.json({ ok: true, retired: del.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// §9 born-encrypted activation. A brand-new mandated household (typically a solo
// owner who just enrolled → minted HDK → sealed their seeded self-Person) flips
// itself E2EE-live on first login: verify the policy applies, then reuse the
// household-scoped plaintext drop. Idempotent — 'already-active' is success, and
// an exempt/grandfathered household is left for the managed drop instead. The
// client seals any stragglers and retries when this reports 'stragglers'.
router.post('/e2ee/activate', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    if (!e2eeRequired(req.household)) {
      return res.json({ status: 'not-required', e2eeActive: !!req.household.e2eeActive });
    }
    const result = await dropPlaintext(req.household._id, { commit: true });
    const hh = await Household.findById(req.household._id).select('e2eeActive').lean();
    res.json({ ...result, e2eeActive: !!hh?.e2eeActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clients report their app version so the readiness gate can confirm every
// member is on a compatible build before the drop (§9). Idempotent stamp.
router.post('/e2ee/client-version', async (req, res) => {
  try {
    const { version, platform } = req.body || {};
    if (!version) return res.status(400).json({ error: 'version required' });
    await User.updateOne({ _id: req.user._id }, {
      $set: { clientVersion: String(version), clientPlatform: platform || undefined, clientVersionAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const { name } = req.body;
    const update = {};
    if (name) update.name = name;
    // Re-sealed settings blob from the client (the name is content — C2).
    try { Object.assign(update, pickRecordEnc(req.body)); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    // Steady-state write rule: a rename on an e2eeActive household stores only
    // the re-sealed blob, never the plaintext name (C2).
    stripSealedContent('Household', req.household, update);
    if (Object.keys(update).length) await Household.updateOne({ _id: req.household._id }, { $set: update });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── HDK envelopes (approve-to-join key material) ────────────────────────────

// The caller's own HDK envelope(s) for their current household, plus the
// household's current key version. The client unwraps `wrappedHDK` with its
// private key to obtain the HDK. An empty `envelopes` with `currentKeyVersion`
// > 0 means "you're a member but nobody has wrapped the key to you yet" — the
// pending-approval state.
router.get('/key', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const envelopes = await HouseholdKeyEnvelope
      .find({ householdId: req.household._id, userId: req.user._id }, 'keyVersion wrappedHDK')
      .lean();
    res.json({
      householdId: req.household._id,
      currentKeyVersion: req.household.currentKeyVersion || 0,
      isOwner: String(req.household.ownerId) === String(req.user._id),
      // Signals the client to drive a lazy rotation (§5.2) after unlock.
      keyRotationPending: !!req.household.keyRotationPending,
      // All the caller's envelopes across versions — the client unwraps each so
      // it can still decrypt historical records sealed under an older HDK.
      envelopes: envelopes.map((e) => ({ keyVersion: e.keyVersion, wrappedHDK: e.wrappedHDK })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner mints HDK v1: self-wrap. Guarded to the owner and to households that
// have no key yet (currentKeyVersion === 0), so the mint is idempotent under a
// race — a second attempt sees version 1 and 409s. See §5 / HDK-minting decision.
router.post('/key', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    if (String(req.household.ownerId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Only the household owner mints the key' });
    }
    const err = validateHDKEnvelope(req.body);
    if (err) return res.status(400).json({ error: err });
    if (req.body.keyVersion !== 1) return res.status(400).json({ error: 'The initial key must be version 1' });

    // Atomically claim v1: only succeeds while the household is still at 0.
    const claimed = await Household.findOneAndUpdate(
      { _id: req.household._id, currentKeyVersion: 0 },
      { $set: { currentKeyVersion: 1, lastKeyRotationAt: new Date() } },
    );
    if (!claimed) return res.status(409).json({ error: 'Household key already exists' });

    await HouseholdKeyEnvelope.create({
      householdId: req.household._id,
      userId: req.user._id,
      keyVersion: 1,
      wrappedHDK: req.body.wrappedHDK,
      wrappedByUserId: req.user._id,
    });
    await AuditLog.create({
      userId: req.user._id, householdId: req.household._id, event: 'hdk_minted', meta: { keyVersion: 1 },
    });
    res.status(201).json({ keyVersion: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Member removal + lazy HDK rotation (Phase 7 / §5.2) ──────────────────────

// The identity public keys of the current household members (those who've
// enrolled), so a rotating member can wrap the new HDK to everyone at once.
router.get('/member-keys', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const members = await User.find(
      { householdId: req.household._id, identityPublicKey: { $exists: true, $ne: null } },
      '_id identityPublicKey',
    ).lean();
    res.json(members.map((m) => ({ userId: m._id, identityPublicKey: m.identityPublicKey })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner removes another member: the member is moved to a fresh solo household
// (their own records travel with them, scoped by userId) and this household is
// flagged for rotation via handleDeparture so the removed member can't read
// future writes. The owner cannot remove themselves — they use /leave.
router.post('/members/:userId/remove', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    if (String(req.household.ownerId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Only the household owner can remove members' });
    }
    const targetId = req.params.userId;
    if (String(targetId) === String(req.user._id)) {
      return res.status(400).json({ error: 'Use “leave household” to remove yourself' });
    }
    const target = await User.findOne({ _id: targetId, householdId: req.household._id }, 'firstName');
    if (!target) return res.status(404).json({ error: 'That member is not in your household' });

    const oldId = req.household._id;
    const fresh = await Household.createForOwner(target._id, `${target.firstName}'s Household`);
    await User.updateOne({ _id: target._id }, { $set: { householdId: fresh._id } });
    await JoinRequest.deleteMany({ requesterUserId: target._id, status: 'pending' });
    await handleDeparture(oldId, target._id);
    await AuditLog.create({
      userId: target._id, householdId: oldId, event: 'member_removed', meta: { removedBy: req.user._id },
    });
    // A persisted in-app notice for the removed member: they've already been
    // moved to a solo household (so the household push above no longer reaches
    // them), and they need an explanation for why the shared data is gone. Shown
    // in their Invitations inbox until dismissed. Best-effort — never fail the
    // removal on a notice write.
    await HouseholdNotice.create({
      userId: target._id, kind: 'removed', actorName: req.user.firstName || '', householdId: oldId,
    }).catch(() => {});
    // Notify the removed member directly on their own devices — the household
    // alert below can't reach them (they've been moved out of `oldId`), so
    // without this they'd get no push about the removal.
    securityAlert(alertUser(target._id, {
      title: 'Removed from a household',
      body: `${req.user.firstName} removed you from the household. Your own data has moved with you.`,
      tag: `removed-${oldId}`,
    }));
    securityAlert(alertHousehold(oldId, {
      title: 'Member removed',
      body: `${target.firstName} was removed from the household by ${req.user.firstName}. The encryption key will rotate.`,
      tag: `member-${oldId}`,
    }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete a lazy rotation: a remaining member generated a fresh HDK_vN+1 and
// wrapped it to every current member. We atomically bump currentKeyVersion
// (compare-and-set on version = keyVersion-1, so concurrent rotations can't both
// win), write the new-version envelopes, and clear the pending flag. Old-version
// envelopes are kept — remaining members still read historical records with them.
router.post('/key/rotate', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const current = req.household.currentKeyVersion || 0;
    if (current < 1) return res.status(409).json({ error: 'Household key is not ready yet' });

    const err = validateRotation(req.body);
    if (err) return res.status(400).json({ error: err });
    if (req.body.keyVersion !== current + 1) {
      return res.status(409).json({ error: 'Key version moved — please retry' });
    }

    // The envelopes must cover every current member that can hold a key; refuse a
    // partial rotation that would lock someone out.
    const members = await User.find(
      { householdId: req.household._id, identityPublicKey: { $exists: true, $ne: null } },
      '_id',
    ).lean();
    const provided = new Set(req.body.envelopes.map((e) => String(e.userId)));
    const missing = members.filter((m) => !provided.has(String(m._id)));
    if (missing.length) return res.status(400).json({ error: 'Rotation must cover every enrolled member' });

    // Compare-and-set the version so only one rotation from `current` wins.
    const claimed = await Household.findOneAndUpdate(
      { _id: req.household._id, currentKeyVersion: current },
      { $set: { currentKeyVersion: req.body.keyVersion, keyRotationPending: false, lastKeyRotationAt: new Date() } },
    );
    if (!claimed) return res.status(409).json({ error: 'Key already rotated — please retry' });

    await Promise.all(req.body.envelopes.map((e) => HouseholdKeyEnvelope.updateOne(
      { householdId: req.household._id, userId: e.userId, keyVersion: req.body.keyVersion },
      {
        $set: { wrappedHDK: e.wrappedHDK, wrappedByUserId: req.user._id },
        $setOnInsert: { householdId: req.household._id, userId: e.userId, keyVersion: req.body.keyVersion },
      },
      { upsert: true },
    )));
    await AuditLog.create({
      userId: req.user._id, householdId: req.household._id, event: 'hdk_rotated',
      meta: { keyVersion: req.body.keyVersion },
    });
    securityAlert(alertHousehold(req.household._id, {
      title: 'Household key rotated',
      body: `${req.user.firstName} rotated your household's encryption key (now v${req.body.keyVersion}).`,
      tag: `hdk-${req.household._id}`,
    }));
    res.json({ ok: true, keyVersion: req.body.keyVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invite by email (replaces the shared join code) ──────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The invitations addressed to a user: to their account, or (before it's claimed)
// to their email or saved phone. Used by the inbox/accept/decline endpoints.
function addressedToUser(user) {
  const or = [{ toUserId: user._id }];
  if (user.email) or.push({ toEmail: user.email.toLowerCase() });
  if (user.phone) or.push({ toPhone: user.phone });
  return or;
}

// A member invites an email OR phone number to join the household. Creates (or
// refreshes) a HouseholdInvitation; email invites are emailed, phone invites are
// texted from the inviter's own device. The recipient accepts from their
// Invitations inbox, which opens a JoinRequest a member then approves on-device.
router.post('/invitations', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });

    let target;
    try { target = await resolveShareTarget({ email: req.body?.email, phone: req.body?.phone }); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    const { toEmail, toPhone, toUserId, recipient } = target;

    if ((toEmail && toEmail === (req.user.email || '').toLowerCase()) ||
        (toPhone && toPhone === (req.user.phone || ''))) {
      return res.status(400).json({ error: "You can't invite yourself" });
    }
    if (recipient && String(recipient.householdId) === String(req.household._id)) {
      return res.status(400).json({ error: 'That person is already in your household' });
    }

    const fromName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ');
    // One live invitation per (household, address); refresh its sender snapshot
    // and re-open it if a prior one was declined.
    const match = toEmail
      ? { householdId: req.household._id, toEmail }
      : { householdId: req.household._id, toPhone };
    const invitation = await HouseholdInvitation.findOneAndUpdate(
      match,
      {
        $set: {
          fromUserId: req.user._id, fromName, fromEmail: req.user.email,
          // Post-drop the name is sealed (C2) — null switches the email + inbox
          // to sender-name framing.
          householdName: req.household.name || null, toUserId,
          toEmail: toEmail || undefined, toPhone: toPhone || undefined,
          status: 'pending', respondedAt: null, joinRequestId: null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    // Outreach is device-composed: the server never sends the invite email/text
    // (nor handles the invitee's address beyond the discovery record above). The
    // inviter's device composes both channels — mailto: for email, sms: for phone
    // — from the response's userExists flag. See mobile lib/shareInvite.
    //
    // Existing account? Nudge their registered devices too — this is the one push
    // the server does send, since it needs the recipient's tokens. Best-effort (no
    // token / permission denied) and fire-and-forget: `recipient` from
    // resolveShareTarget lacks the subscription list, so load the full user here.
    if (recipient) {
      const householdName = req.household.name || null;
      const senderName = fromName || req.user.email;
      (async () => {
        const account = await User.findById(recipient._id).select('pushSubscriptions');
        if (!account) return;
        await pushToUser(account, {
          title: 'Household invite',
          body: householdName
            ? `${senderName} invited you to join “${householdName}”`
            : `${senderName} invited you to join their household`,
          data: { type: 'household_invite', invitationId: String(invitation._id) },
          tag: `household-invite-${invitation._id}`,
        });
      })().catch(() => {});
    }
    res.status(201).json({ invitation, userExists: !!recipient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pending/most-recent invitations this household has sent (members see the list).
router.get('/invitations', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const invitations = await HouseholdInvitation
      .find({ householdId: req.household._id }).sort('-createdAt').lean();
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revoke a sent invitation (and any pending join request it opened).
router.delete('/invitations/:id', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const invitation = await HouseholdInvitation.findOneAndDelete({
      _id: req.params.id, householdId: req.household._id,
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.joinRequestId) {
      await JoinRequest.deleteOne({ _id: invitation.joinRequestId, status: 'pending' }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Invitations addressed to me, newest first (my Invitations inbox).
router.get('/invitations/mine', async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const phone = req.user.phone || '';
    const invitations = await HouseholdInvitation
      .find({ $or: addressedToUser(req.user) })
      .sort('-createdAt');
    // Lazily claim email/phone-only invitations sent before this account existed.
    const unclaimed = invitations.filter(
      (i) => !i.toUserId && ((i.toEmail && i.toEmail === email) || (i.toPhone && i.toPhone === phone)),
    );
    if (unclaimed.length) {
      await HouseholdInvitation.updateMany(
        { _id: { $in: unclaimed.map((i) => i._id) } },
        { toUserId: req.user._id },
      );
    }
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept an invitation → open (or refresh) a JoinRequest pinning my public key.
// Membership isn't granted here: a member still approves on-device (wrapping the
// HDK), exactly as before — the invitation just replaced the shared code.
router.post('/invitations/:id/accept', joinLimiter, async (req, res) => {
  try {
    if (!req.user.identityPublicKey) {
      return res.status(400).json({ error: 'Set up your encryption key before joining a household' });
    }
    const invitation = await HouseholdInvitation.findOne({
      _id: req.params.id,
      $or: addressedToUser(req.user),
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (String(invitation.householdId) === String(req.user.householdId)) {
      return res.status(400).json({ error: "You're already in this household" });
    }

    // One live request per (requester, target); refresh the pinned public key.
    const request = await JoinRequest.findOneAndUpdate(
      { householdId: invitation.householdId, requesterUserId: req.user._id, status: 'pending' },
      { $set: { requesterPublicKey: req.user.identityPublicKey } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    invitation.toUserId = req.user._id;
    invitation.status = 'accepted';
    invitation.respondedAt = new Date();
    invitation.joinRequestId = request._id;
    await invitation.save();
    res.status(201).json({ status: 'pending', requestId: request._id, name: invitation.householdName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invitations/:id/decline', async (req, res) => {
  try {
    const invitation = await HouseholdInvitation.findOne({
      _id: req.params.id,
      $or: addressedToUser(req.user),
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    // Declining after accepting also withdraws the pending join request.
    if (invitation.joinRequestId) {
      await JoinRequest.deleteOne({ _id: invitation.joinRequestId, status: 'pending' }).catch(() => {});
    }
    invitation.toUserId = req.user._id;
    invitation.status = 'declined';
    invitation.respondedAt = new Date();
    invitation.joinRequestId = null;
    await invitation.save();
    res.json({ invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Membership notices ──────────────────────────────────────────────────────

// One-off notices addressed to me (today: "you were removed"), newest first, so
// the Invitations inbox can surface them alongside invitations. Undismissed ones
// are "New"; dismissed ones fall into the response history.
router.get('/notices', async (req, res) => {
  try {
    const notices = await HouseholdNotice
      .find({ userId: req.user._id }).sort('-createdAt').lean();
    res.json(notices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss a notice (stamps acknowledgedAt; moves it out of the "New" tab).
router.post('/notices/:id/ack', async (req, res) => {
  try {
    const notice = await HouseholdNotice.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { acknowledgedAt: new Date() } },
      { new: true },
    );
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    res.json({ notice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Approve-on-device join ──────────────────────────────────────────────────

// The caller's own pending/most-recent join request (joiner polls this while
// waiting for a family member to approve).
router.get('/join-requests/mine', async (req, res) => {
  try {
    const request = await JoinRequest
      .findOne({ requesterUserId: req.user._id })
      .sort('-createdAt')
      .lean();
    if (!request) return res.json({ status: 'none' });
    const target = await Household.findById(request.householdId, 'name').lean();
    res.json({ status: request.status, requestId: request._id, name: target?.name || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel one's own pending request.
router.delete('/join-requests/mine', async (req, res) => {
  try {
    await JoinRequest.deleteMany({ requesterUserId: req.user._id, status: 'pending' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pending requests to join the caller's household (for members to approve). Each
// carries the requester's pinned public key so the client can show a fingerprint
// for out-of-band verification and wrap the HDK to it.
router.get('/join-requests', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const requests = await JoinRequest
      .find({ householdId: req.household._id, status: 'pending' })
      .sort('createdAt')
      .lean();
    const users = await User.find(
      { _id: { $in: requests.map((r) => r.requesterUserId) } },
      'firstName lastName email',
    ).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json(requests.map((r) => {
      const u = byId.get(String(r.requesterUserId)) || {};
      return {
        _id: r._id,
        requesterUserId: r.requesterUserId,
        requesterPublicKey: r.requesterPublicKey,
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        email: u.email || null,
        createdAt: r.createdAt,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve a pending request: the approving member has wrapped the current HDK to
// the requester's public key (client-side) and posts the envelope here. The
// server writes the HouseholdKeyEnvelope, moves the requester into the household,
// and merges their categories — this is the point membership actually changes.
router.post('/join-requests/:id/approve', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const version = req.household.currentKeyVersion || 0;
    if (version < 1) return res.status(409).json({ error: 'Your household key is not ready yet' });

    const err = validateHDKEnvelope(req.body);
    if (err) return res.status(400).json({ error: err });
    if (req.body.keyVersion !== version) {
      return res.status(409).json({ error: 'Household key version changed — please retry' });
    }

    const request = await JoinRequest.findOne({ _id: req.params.id, status: 'pending' });
    if (!request || String(request.householdId) !== String(req.household._id)) {
      return res.status(404).json({ error: 'No pending request found' });
    }

    // The requester's live key must still match what the approver verified and
    // wrapped to; otherwise the key changed mid-flight and we refuse.
    const requester = await User.findById(
      request.requesterUserId,
      'identityPublicKey householdId',
    );
    if (!requester) return res.status(404).json({ error: 'Requester no longer exists' });
    if (requester.identityPublicKey !== request.requesterPublicKey) {
      return res.status(409).json({ error: 'Requester key changed — ask them to request again' });
    }

    await HouseholdKeyEnvelope.updateOne(
      { householdId: req.household._id, userId: requester._id, keyVersion: version },
      {
        $set: { wrappedHDK: req.body.wrappedHDK, wrappedByUserId: req.user._id },
        $setOnInsert: { householdId: req.household._id, userId: requester._id, keyVersion: version },
      },
      { upsert: true },
    );

    // Move the requester into this household and clean up the household they
    // left. Their DATA does not travel with this flip — an e2eeActive household's
    // records are stamped with its householdId and sealed under its HDK, so they
    // stay behind until the joiner's unlocked device re-seals them across (the
    // carry-over pass above / lib/joinCarryover). `handleDeparture` deliberately
    // leaves the old household + its envelopes standing while that ciphertext
    // exists, which is what keeps the carry-over possible.
    const oldId = requester.householdId;
    await User.updateOne(
      { _id: requester._id },
      { $set: { householdId: req.household._id } },
    );
    // (No add-on bookkeeping here: ownership lives on `User.addons` and takes
    // effect as the union across household members, so a joiner's purchases
    // travel with them automatically — and are not surrendered to the household
    // they leave. See specs/features/billing-plans.md.)
    if (String(oldId) !== String(req.household._id)) await handleDeparture(oldId, requester._id);

    // Merge the joiner's default categories into the destination set so identical
    // defaults don't surface as duplicates (existing members' copies win).
    const members = await User.find({ householdId: req.household._id }, '_id').lean();
    const memberIds = members.map((m) => m._id);
    const preferred = memberIds.filter((id) => String(id) !== String(requester._id));
    await dedupeCategoriesForScope(memberIds, preferred);

    await JoinRequest.updateOne(
      { _id: request._id },
      { $set: { status: 'approved', resolvedByUserId: req.user._id } },
    );
    // The invitation has done its job — clear it from both inboxes.
    await HouseholdInvitation.deleteMany({
      householdId: req.household._id, toUserId: requester._id,
    }).catch(() => {});
    await AuditLog.create({
      userId: requester._id, householdId: req.household._id, event: 'member_approved',
      meta: { approvedBy: req.user._id, keyVersion: version },
    });
    // Durable in-app record of the acceptance for the joiner — the invitation row
    // is deleted above, so this is what surfaces in their Invitations inbox
    // (mirroring how the invite itself appeared). Best-effort.
    await HouseholdNotice.create({
      userId: requester._id, kind: 'approved', actorName: req.user.firstName || '', householdId: req.household._id,
    }).catch(() => {});
    // Tell the joiner directly that they're in (their own push, not the
    // household-wide security alert below — which they're excluded from so they
    // don't also get the "a new member was approved" notice about themselves).
    securityAlert(alertUser(requester._id, {
      title: 'You’re in!',
      body: `${req.user.firstName} approved you — you now share the household.`,
      tag: `household-approved-${req.household._id}`,
    }));
    securityAlert(alertHousehold(req.household._id, {
      title: 'New household member',
      body: `${req.user.firstName} approved a new member — they can now read household data.`,
      tag: `member-${req.household._id}`,
      excludeUserId: requester._id,
    }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject a pending request.
router.post('/join-requests/:id/reject', async (req, res) => {
  try {
    if (!req.household) return res.status(404).json({ error: 'No household' });
    const request = await JoinRequest.findOneAndUpdate(
      { _id: req.params.id, householdId: req.household._id, status: 'pending' },
      { $set: { status: 'rejected', resolvedByUserId: req.user._id } },
    );
    if (!request) return res.status(404).json({ error: 'No pending request found' });
    // Retire the invitation the reject answers, so the person sees it was declined.
    await HouseholdInvitation.updateMany(
      { householdId: req.household._id, toUserId: request.requesterUserId, status: 'accepted' },
      { $set: { status: 'declined', respondedAt: new Date(), joinRequestId: null } },
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave the current household → start a fresh solo one. Only meaningful when you
// share the household with someone: leaving hands the shared data to the others
// and drops you into your own fresh space. A SOLE member has no one to leave and
// nothing to hand over — their household IS their data — so this is a no-op that
// keeps them where they are. (Tearing it down would send handleDeparture through
// its empty-household branch, which deletes the household + its ONLY key envelope
// while the encrypted records stay behind, orphaning every one of them with no
// key left to reopen it — silent, irreversible data loss.)
router.post('/leave', async (req, res) => {
  try {
    const oldId = req.user.householdId;
    if (oldId) {
      const others = await User.countDocuments({ householdId: oldId, _id: { $ne: req.user._id } });
      if (others === 0) {
        return res.json({ message: 'Already in your own household', householdId: oldId });
      }
    }
    const fresh = await Household.createForOwner(req.user._id, `${req.user.firstName}'s Household`);
    await User.updateOne({ _id: req.user._id }, { $set: { householdId: fresh._id } });
    if (String(oldId) !== String(fresh._id)) await handleDeparture(oldId, req.user._id);
    res.json({ message: 'Left', householdId: fresh._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
