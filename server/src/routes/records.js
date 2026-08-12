const express = require('express');
const Record = require('../models/Record');
const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');
const CustomCalendar = require('../models/CustomCalendar');
const { requireAuth } = require('../middleware/auth');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { stampHousehold, E2EE_REQUIRED_MESSAGE } = require('../services/e2eePolicy');
const { canWriteCalendarType } = require('../services/calendarSharing');
const { reapEventAttachments } = require('../services/eventAttachmentReaper');
const { reapRecipePhotos } = require('../services/recipePhotoReaper');
const { recordTouched } = require('../services/recordChanges');

// Signal-parity C3 — the unified opaque-record API. Replaces the per-collection
// content routes (tasks/chores/events/contacts/…): the server stores/serves uniform
// records keyed on householdId + updatedAt, never knowing a row's type. Reads are
// a single LWW sync pull; writes are opaque create/update/delete. See the C3
// decision doc in docs/SIGNAL-PARITY-PLAN.md.
const router = express.Router();
router.use(requireAuth);

// The read scope, as an `$or` of match branches (mirrors calendarData/scopeClause
// but for the unified store):
//   - householdId — the C4 household attribution (the primary lane);
//   - userId ∈ scopeIds — a solo user's own records, and legacy rows;
//   - scope.resource ∈ (my member key envelopes) — the D1/D2 resource lane: a
//     cross-household collaborator reads a shared calendar's/trip's records via
//     the resource key they hold, never via the owner's householdId.
async function recordScope(req) {
  const or = [];
  if (req.household?._id) or.push({ householdId: req.household._id });
  or.push({ userId: { $in: req.scopeIds } });
  const myResources = await ResourceKeyEnvelope
    .find({ recipient: 'member', userId: req.user._id })
    .distinct('resourceKey');
  if (myResources.length) or.push({ 'scope.resource': { $in: myResources } });
  return { $or: or };
}

// Pull the opaque routing fields off a write body (never any content — that's
// inside `enc`). `scope` is the D1/D2 resource lane; only accepted when shaped.
function pickScope(body) {
  const s = body.scope;
  if (s && (s.kind === 'calendar' || s.kind === 'trip') && typeof s.resource === 'string' && Number.isInteger(s.version)) {
    return { scope: { kind: s.kind, resource: s.resource, version: s.version } };
  }
  return {};
}

// Calendar-lane write authorization (D1 access levels): a 'view' collaborator
// holds a member key envelope — recordScope grants them READS — but must not
// create/replace/tombstone the calendar's records; nor may a non-collaborator
// write records claiming someone else's calendar scope. Blocked only when the
// calendar is known and the caller's access is short of 'full' (null = the
// helper has no opinion — unknown/deleted key — and the recordScope match
// remains the rule). Trips are exempt: trip collaborators are full-access by
// design.
async function calendarWriteBlocked(req, scope) {
  if (!scope || scope.kind !== 'calendar') return false;
  const can = await canWriteCalendarType(
    CustomCalendar,
    { userId: req.user._id, scopeIds: req.scopeIds },
    scope.resource,
  );
  return can === false;
}
const VIEW_ONLY_MESSAGE = 'You have view-only access to this calendar';

// GET /records/sync?since=<iso> — the unified LWW pull. Every record in scope
// updated after `since`, tombstones included, so the client replica converges.
router.get('/sync', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : new Date(0);
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'invalid since' });
    const scope = await recordScope(req);
    const records = await Record.find({ ...scope, updatedAt: { $gt: since } })
      .sort('updatedAt')
      .lean();
    res.json({ records, serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /records — create an opaque record. The store is opaque-only: every record
// MUST carry ciphertext (there is no plaintext content lane here). The server
// stamps householdId authoritatively (C4) and the author userId for routing.
router.post('/', async (req, res) => {
  try {
    let enc;
    try { enc = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!enc.enc) return res.status(400).json({ error: E2EE_REQUIRED_MESSAGE });
    const data = {
      ...(isObjectId(req.body._id) ? { _id: req.body._id } : {}),
      ...enc,
      ...pickScope(req.body),
    };
    if (await calendarWriteBlocked(req, data.scope)) {
      return res.status(403).json({ error: VIEW_ONLY_MESSAGE });
    }
    stampHousehold(req.household, data); // C4: authoritative householdId
    // C4 author-hiding: on an e2eeActive household an HDK record (no resource
    // scope) attributes ONLY to householdId — the member-granular author is sealed
    // inside enc. Keep the plaintext userId for a solo user (no household, their
    // only scope), a resource-scoped record (cal/trip cross-household routing —
    // the documented deviation), or a not-yet-active household (dual-write window).
    const resourceScoped = !!data.enc?.ks;
    if (!req.household?._id || resourceScoped || !req.household.e2eeActive) {
      data.userId = req.user._id;
    }
    const record = await Record.create(data);
    // Poke-and-pull: tell the household's other devices something changed
    // (content-blind — they just re-run their sync cursor). Fire-and-forget.
    recordTouched({ householdId: record.householdId, userId: req.user._id, sessionId: req.sessionId });
    res.status(201).json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /records/:id — replace the ciphertext (LWW; the client re-seals and pushes).
// Scoped so a caller can only update a record in its own household / resource lane.
router.put('/:id', async (req, res) => {
  try {
    let enc;
    try { enc = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!enc.enc) return res.status(400).json({ error: E2EE_REQUIRED_MESSAGE });
    const scope = await recordScope(req);
    const updates = { ...enc, ...pickScope(req.body) };
    stampHousehold(req.household, updates);
    // D1 write authorization: check the STORED scope as well as the incoming
    // one — pickScope leaves the stored scope untouched when the body omits it,
    // so a view collaborator can't shed the calendar lane by dropping the field.
    const existing = await Record.findOne({ _id: req.params.id, ...scope }, 'scope').lean();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await calendarWriteBlocked(req, existing.scope) || await calendarWriteBlocked(req, updates.scope)) {
      return res.status(403).json({ error: VIEW_ONLY_MESSAGE });
    }
    const record = await Record.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      updates,
      { new: true, runValidators: true },
    );
    if (!record) return res.status(404).json({ error: 'Not found' });
    recordTouched({ householdId: record.householdId, userId: req.user._id, sessionId: req.sessionId });
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /records/:id — tombstone (soft delete) so the delete propagates to every
// replica through the sync cursor. Bumps updatedAt via timestamps.
router.delete('/:id', async (req, res) => {
  try {
    const scope = await recordScope(req);
    const existing = await Record.findOne({ _id: req.params.id, ...scope }, 'scope').lean();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await calendarWriteBlocked(req, existing.scope)) {
      return res.status(403).json({ error: VIEW_ONLY_MESSAGE });
    }
    const record = await Record.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      { deleted: true },
      { new: true, timestamps: true },
    );
    if (!record) return res.status(404).json({ error: 'Not found' });
    // C3b: replace the retired per-event delete cascade — reap any files that
    // referenced this record. Each is a no-op unless the record was of the type
    // that owns those files (an event's attachments, a recipe's photo); the
    // server stays content-blind and simply asks both.
    await reapEventAttachments(req.params.id).catch(() => {});
    await reapRecipePhotos(req.params.id).catch(() => {});
    recordTouched({ householdId: record.householdId, userId: req.user._id, sessionId: req.sessionId });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
