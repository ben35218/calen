const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { simpleParser } = require('mailparser');
const Trip = require('../models/Trip');
const TripItem = require('../models/TripItem');
const TripInvitation = require('../models/TripInvitation');
const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');
const User = require('../models/User');
const Household = require('../models/Household');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { rateLimit } = require('../middleware/rateLimit');
const { meter } = require('../middleware/usageMeter');
const { activity } = require('../middleware/activity');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { plaintextCreateBlocked, E2EE_REQUIRED_MESSAGE, stripSealedContent, stripSealedDoc } = require('../services/e2eePolicy');
const { isTripShared } = require('../services/tripSharing');
const { pushToUser } = require('../services/notify');
const { normalizePhone } = require('../services/phone');
const { resolvePlaceWithTz } = require('../services/geo');
const { getRates, convert } = require('../services/fx');

const client = new Anthropic();
const router = express.Router();
router.use(requireAuth);

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads', 'trips');
fs.mkdirSync(uploadDir, { recursive: true });

// octet-stream = E2EE ciphertext upload (Phase 4c); the plaintext mimetype rides
// in the body's fileType and the bytes are opaque to the server either way.
const ATTACH_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'message/rfc822', 'application/octet-stream'];

const isEml = (file) => file.mimetype === 'message/rfc822' || /\.eml$/i.test(file.originalname || '');
// Accept known types by mimetype, and .eml by extension (browsers report these
// inconsistently, sometimes as application/octet-stream).
const acceptUpload = (file) => ATTACH_TYPES.includes(file.mimetype) || isEml(file);

// Disk storage for kept attachments
const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ''}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, acceptUpload(file)),
});

// In-memory for one-shot extraction (file is only persisted if the booking is saved)
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, acceptUpload(file)),
});

function unlinkAttachments(items) {
  for (const it of items) {
    for (const a of it.attachments ?? []) {
      const p = path.join(uploadDir, a.storageKey);
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    }
  }
}

const TRIP_FIELDS = [
  'name', 'destination', 'destinationPlaceId', 'destinationTz',
  'status', 'candidateRanges', 'startDate', 'endDate', 'notes', 'color',
  // budget/baseCurrency are managed per-family via /:id/my-budget, not here.
];

const ITEM_FIELDS = [
  'type', 'title', 'start', 'end', 'location', 'placeId', 'address',
  'confirmation', 'cost', 'currency', 'url', 'phone', 'notes', 'details',
  'sharing', 'shares', 'paidByHouseholdId',
];

// Copy only allowed fields from src onto target. Date fields are coerced.
function pick(src, fields) {
  const out = {};
  for (const f of fields) {
    if (src[f] === undefined) continue;
    if (['startDate', 'endDate', 'start', 'end'].includes(f)) {
      out[f] = src[f] ? new Date(src[f]) : undefined;
    } else {
      out[f] = src[f];
    }
  }
  return out;
}

// A trip is accessible if it belongs to the user's household OR they're a collaborator.
function accessFilter(req) {
  return { $or: [{ userId: { $in: req.scopeIds } }, { collaborators: req.user._id }] };
}
// Trip-level admin (delete, manage sharing) is limited to the owning household.
function ownerFilter(req) {
  return { userId: { $in: req.scopeIds } };
}
// Whether the requester's household owns this trip — gates who may serve/mint/
// rotate the household-wrapped TripKey (Signal-parity D2). Unlike D1's calendars
// (creator-only), any member of the owning household manages the TripKey: trips
// are household-scoped, every member holds the HDK, and the compare-and-set on
// tripKeyVersion makes concurrent mints safe.
const ownsTrip = (trip, req) => req.scopeIds.some((id) => String(id) === String(trip.userId));
// Verify the user can access the trip; responds 404 and returns null if not.
async function requireTripAccess(req, res) {
  // sharedWithOutside/collaborators must ride along: the item create route calls
  // isTripShared(trip) to decide whether the E2EE mandate applies (a shared trip
  // may degrade to a plaintext write pre-TripKey; §D2).
  const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) })
    .select('_id userId sharedWithOutside collaborators').lean();
  if (!trip) { res.status(404).json({ error: 'Trip not found' }); return null; }
  return trip;
}

// Throttle abuse of the invite-accept endpoint: a handful of tries per minute is
// plenty for a real invite, but caps enumeration.
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many join attempts. Please wait a minute and try again.',
});

// ── Booking cost-sharing ──────────────────────────────────────────────────────
const sameId = (a, b) => String(a) === String(b);
const USES_HOUSEHOLD_DATA = new Set(['shared_separate', 'shared_one_separate']);

// Families participating in a booking (those who can see it). Always includes the
// creator's household.
function itemParticipants(item) {
  const ids = new Set([String(item.householdId)]);
  if (USES_HOUSEHOLD_DATA.has(item.sharing)) (item.householdData || []).forEach(e => ids.add(String(e.householdId)));
  else if (item.sharing === 'shared_shared') (item.shares || []).forEach(s => ids.add(String(s.householdId)));
  return ids;
}
// Private bookings → creator's household only; shared → participating families only.
function canSeeItem(item, familyId) {
  if (item.sharing === 'private' || !item.sharing) return sameId(item.householdId, familyId);
  return itemParticipants(item).has(String(familyId));
}
// Attachments are private to the uploading household, except on a single shared
// bill where there's one receipt everyone shares.
function canSeeAttachment(item, att, familyId) {
  if (item.sharing === 'shared_shared') return true;
  return sameId(att.householdId || item.householdId, familyId);
}

const PLAN_FIELDS = ['type', 'title', 'start', 'end', 'location', 'placeId', 'address', 'url', 'phone', 'notes', 'details'];

// Apply a request body onto a TripItem doc per its sharing mode.
// Returns storage keys of attachments removed because their family was dropped.
function applyItemBody(item, body, familyId) {
  for (const f of PLAN_FIELDS) {
    if (body[f] === undefined) continue;
    item[f] = (f === 'start' || f === 'end') ? (body[f] ? new Date(body[f]) : undefined) : body[f];
  }
  const sharing = body.sharing || item.sharing || 'private';
  const prevParticipants = itemParticipants(item);
  item.sharing = sharing;

  if (USES_HOUSEHOLD_DATA.has(sharing)) {
    const perHouseholdConfirm = sharing === 'shared_separate'; // separate = per-family conf/booked
    item.cost = undefined; item.currency = undefined;
    item.shares = []; item.paidByHouseholdId = undefined;
    if (perHouseholdConfirm) { item.confirmation = undefined; item.confirmed = undefined; }
    else { item.confirmation = body.confirmation || undefined; item.confirmed = !!body.confirmed; } // shared conf/booked

    const participants = (body.participants || []).map(String);
    if (familyId && !participants.includes(String(familyId))) participants.push(String(familyId));
    const existing = item.householdData || [];
    const byId = Object.fromEntries(existing.map(e => [String(e.householdId), e.toObject ? e.toObject() : e]));
    const next = participants.map(hid => byId[hid] || { householdId: hid });
    const mine = next.find(e => sameId(e.householdId, familyId));
    if (mine && body.myData) {
      const m = body.myData;
      mine.cost = m.cost ?? undefined;
      mine.currency = m.currency || undefined;
      if (perHouseholdConfirm) {
        mine.confirmation = m.confirmation || undefined;
        mine.partySize = m.partySize ?? undefined;
        mine.confirmed = !!m.confirmed;
      }
    }
    item.householdData = next;
  } else if (sharing === 'shared_shared') {
    item.cost = body.cost ?? undefined;
    item.currency = body.currency || undefined;
    item.confirmation = body.confirmation || undefined;
    item.confirmed = !!body.confirmed;
    item.shares = (body.shares || []).map(s => ({ householdId: s.householdId, amount: s.amount }));
    item.paidByHouseholdId = body.paidByHouseholdId || undefined;
    item.householdData = [];
  } else { // private
    item.cost = body.cost ?? undefined;
    item.currency = body.currency || undefined;
    item.confirmation = body.confirmation || undefined;
    item.confirmed = !!body.confirmed;
    item.shares = []; item.paidByHouseholdId = undefined; item.householdData = [];
  }

  // Removal cleanup: drop attachments belonging to families no longer participating.
  const now = itemParticipants(item);
  const removedFams = [...prevParticipants].filter(id => !now.has(id) && !sameId(id, item.householdId));
  const removedKeys = [];
  if (removedFams.length) {
    const removedSet = new Set(removedFams);
    item.attachments = (item.attachments || []).filter(a => {
      const owner = String(a.householdId || item.householdId);
      if (removedSet.has(owner)) { removedKeys.push(a.storageKey); return false; }
      return true;
    });
  }
  return removedKeys;
}

// Shape an item for a viewer: hide other families' private fields/attachments and
// surface the viewer's own data + (for separate bookings) a confirmation summary.
function shapeItem(item, familyId, names) {
  const visibleAttachments = (item.attachments || []).filter(a => canSeeAttachment(item, a, familyId));
  if (!USES_HOUSEHOLD_DATA.has(item.sharing)) return { ...item, attachments: visibleAttachments };

  const data = item.householdData || [];
  const mine = data.find(e => sameId(e.householdId, familyId)) || {};
  const { householdData, cost, currency, ...rest } = item;
  const shaped = {
    ...rest,
    attachments: visibleAttachments,
    cost: mine.cost ?? null,
    currency: mine.currency ?? '',
    participants: data.map(e => String(e.householdId)),
  };
  if (item.sharing === 'shared_separate') {
    // confirmation + booked status are per-family
    const { confirmation, confirmed } = shaped;
    delete shaped.confirmation; delete shaped.confirmed;
    shaped.confirmation = mine.confirmation ?? '';
    shaped.myData = {
      cost: mine.cost ?? null, currency: mine.currency ?? '', confirmation: mine.confirmation ?? '',
      partySize: mine.partySize ?? null, confirmed: !!mine.confirmed,
    };
    shaped.confirmations = data.map(e => ({ householdId: e.householdId, name: names[String(e.householdId)] || 'A family', confirmed: !!e.confirmed }));
  } else {
    // shared_one_separate: confirmation # + booked are shared (kept from item); only cost is private
    shaped.myData = { cost: mine.cost ?? null, currency: mine.currency ?? '' };
  }
  return shaped;
}

// ── Trips ──────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const filter = accessFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const trips = await Trip.find(filter).sort({ startDate: 1, createdAt: -1 }).lean();
    // The outside-share list is the owning household's business — strip it from
    // trips a collaborator only has guest access to.
    for (const t of trips) {
      if (!req.scopeIds.some((id) => String(id) === String(t.userId))) t.sharedWithOutside = [];
    }
    res.json(trips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trip-share invitations addressed to me (before /:id so it isn't shadowed) ─

// Invitations addressed to a user: to their account, or (before claiming) to
// their email or saved phone.
function addressedToUser(user) {
  const or = [{ toUserId: user._id }];
  if (user.email) or.push({ toEmail: user.email.toLowerCase() });
  if (user.phone) or.push({ toPhone: user.phone });
  return or;
}

router.get('/invitations', async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const phone = req.user.phone || '';
    const invitations = await TripInvitation
      .find({ $or: addressedToUser(req.user) })
      .sort('-createdAt');
    // Lazily claim email/phone-only invitations sent before this account existed.
    const unclaimed = invitations.filter(
      (i) => !i.toUserId && ((i.toEmail && i.toEmail === email) || (i.toPhone && i.toPhone === phone)),
    );
    if (unclaimed.length) {
      await TripInvitation.updateMany(
        { _id: { $in: unclaimed.map((i) => i._id) } },
        { toUserId: req.user._id },
      );
    }
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept → become a collaborator on the trip (live access to it and its items).
router.post('/invitations/:id/accept', joinLimiter, async (req, res) => {
  try {
    const invitation = await TripInvitation.findOne({
      _id: req.params.id,
      $or: addressedToUser(req.user),
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });

    invitation.toUserId = invitation.toUserId || req.user._id;
    invitation.status = 'accepted';
    invitation.respondedAt = new Date();
    await invitation.save();

    const trip = await Trip.findByIdAndUpdate(
      invitation.tripId,
      { $addToSet: { collaborators: req.user._id } },
      { new: true },
    ).select('name').lean();
    if (!trip) return res.status(404).json({ error: 'Trip no longer exists' });
    res.json({ invitation, tripId: invitation.tripId, name: trip.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invitations/:id/decline', async (req, res) => {
  try {
    const invitation = await TripInvitation.findOne({
      _id: req.params.id,
      $or: addressedToUser(req.user),
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });

    // Declining after accepting also gives up access.
    if (invitation.status === 'accepted' && invitation.toUserId) {
      await Trip.updateOne({ _id: invitation.tripId }, { $pull: { collaborators: invitation.toUserId } });
    }
    invitation.toUserId = invitation.toUserId || req.user._id;
    invitation.status = 'declined';
    invitation.respondedAt = new Date();
    await invitation.save();
    res.json({ invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) })
      .populate('collaborators', 'firstName lastName email').lean();
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const familyId = req.user.householdId;
    const raw = await TripItem.find({ tripId: trip._id })
      .populate('userId', 'firstName lastName')   // "added by" attribution
      .sort('start').lean();

    // Family-name map for confirmation status on shared_separate bookings.
    const famIds = [...new Set(raw.flatMap(i => (i.householdData || []).map(e => String(e.householdId))))];
    const households = famIds.length ? await Household.find({ _id: { $in: famIds } }, 'name').lean() : [];
    const names = Object.fromEntries(households.map(h => [String(h._id), h.name]));

    // Legacy items may lack householdId (created before household stamping was added).
    // Resolve their owning household via the creator's userId so visibility matches
    // what the budget endpoint counts.
    const legacyRaw = raw.filter(i => !i.householdId);
    const legacyUserIds = legacyRaw.map(i => i.userId?._id || i.userId).filter(Boolean);
    const legacyUsers = legacyUserIds.length
      ? await User.find({ _id: { $in: legacyUserIds } }, 'householdId').lean()
      : [];
    const legacyHouseholdMap = Object.fromEntries(legacyUsers.map(u => [String(u._id), String(u.householdId)]));

    const items = raw
      .filter(i => {
        if (canSeeItem(i, familyId)) return true;
        if (!i.householdId) {
          const uid = i.userId?._id || i.userId;
          return legacyHouseholdMap[String(uid)] === String(familyId);
        }
        return false;
      })
      .map(i => shapeItem(i, familyId, names));             // strip other families' private fields
    const isOwner = req.scopeIds.some(id => String(id) === String(trip.userId));
    // The outside-share list (and who else collaborates) is the owner's business;
    // a collaborator only sees that the trip is shared, not the guest list.
    if (!isOwner) { trip.sharedWithOutside = []; trip.collaborators = []; }
    res.json({ trip, items, isOwner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The household that owns the trip (family of the trip's creator).
async function ownerFamilyId(trip) {
  const owner = await User.findById(trip.userId, 'householdId').lean();
  return owner?.householdId || null;
}

// Families participating in a trip: the owner's family plus each collaborator's.
async function tripFamilyIds(trip) {
  const userIds = [trip.userId, ...(trip.collaborators || [])];
  const users = await User.find({ _id: { $in: userIds } }, 'householdId').lean();
  return [...new Set(users.map(u => String(u.householdId)).filter(Boolean))];
}

// A family's budget entry on the trip (with legacy Trip.budget fallback for the owner family).
function familyBudgetEntry(trip, familyId, ownerFamId) {
  const entry = (trip.householdBudgets || []).find(b => String(b.householdId) === String(familyId));
  const baseCurrency = (entry?.baseCurrency || trip.baseCurrency || 'CAD').toUpperCase();
  let budget = entry ? (entry.budget ?? null) : null;
  if (!entry && ownerFamId && String(familyId) === String(ownerFamId)) budget = trip.budget ?? null;
  return { budget, baseCurrency };
}

// Resolve each item's "owning family": the snapshot householdId, or (for legacy
// items) the creator's current household.
async function itemFamilyResolver(items) {
  const missing = items.filter(i => !i.householdId).map(i => i.userId);
  let byUser = {};
  if (missing.length) {
    const users = await User.find({ _id: { $in: missing } }, 'householdId').lean();
    byUser = Object.fromEntries(users.map(u => [String(u._id), u.householdId]));
  }
  return (i) => i.householdId || byUser[String(i.userId)] || null;
}

// Per-FAMILY budget roll-up — totals only the requesting user's family's share of each booking.
router.get('/:id/budget', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) }).lean();
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const items = await TripItem.find({ tripId: trip._id }, 'type cost currency sharing shares householdData householdId userId').lean();

    const familyId = req.user.householdId;
    const ownerFamId = await ownerFamilyId(trip);
    const { budget, baseCurrency: base } = familyBudgetEntry(trip, familyId, ownerFamId);
    const familyOf = await itemFamilyResolver(items);

    const ratesEntry = await getRates(base);
    const rates = ratesEntry?.rates;
    const round = (n) => Math.round(n * 100) / 100;

    const byTypeMap = {};
    const unconvertedMap = {};
    let total = 0, costedCount = 0, myItemCount = 0;

    for (const it of items) {
      // This family's portion of the booking (in the booking's currency), or null if uncosted.
      let portion = null, participates = false, cur = base;
      if (it.sharing === 'shared_shared') {
        const s = (it.shares || []).find(x => String(x.householdId) === String(familyId));
        participates = !!s;
        if (s) portion = s.amount ?? null;
        cur = (it.currency || base).toUpperCase();
      } else if (USES_HOUSEHOLD_DATA.has(it.sharing)) {
        const e = (it.householdData || []).find(x => String(x.householdId) === String(familyId));
        participates = !!e;                       // each family pays its own bill
        if (e) { portion = e.cost ?? null; cur = (e.currency || base).toUpperCase(); }
      } else { // private
        participates = String(familyOf(it)) === String(familyId);
        if (participates) { portion = it.cost ?? null; cur = (it.currency || base).toUpperCase(); }
      }
      if (!participates) continue;
      myItemCount++;
      if (portion == null || Number.isNaN(portion)) continue;  // uncosted for my family
      cur = cur.toUpperCase();
      const conv = convert(portion, cur, base, rates);
      if (conv == null) { unconvertedMap[cur] = (unconvertedMap[cur] || 0) + portion; continue; }
      total += conv;
      byTypeMap[it.type] = (byTypeMap[it.type] || 0) + conv;
      costedCount++;
    }

    const byType = Object.entries(byTypeMap)
      .map(([type, amount]) => ({ type, amount: round(amount) }))
      .sort((a, b) => b.amount - a.amount);
    const unconverted = Object.entries(unconvertedMap).map(([currency, amount]) => ({ currency, amount: round(amount) }));

    res.json({
      baseCurrency: base,
      budget,
      total: round(total),
      remaining: budget != null ? round(budget - total) : null,
      byType,
      unconverted,
      ratesAvailable: !!rates,
      rateDate: ratesEntry?.date || null,
      itemCount: myItemCount,
      costedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Families participating in the trip (owner family + each collaborator's family).
router.get('/:id/families', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) }).select('userId collaborators').lean();
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const ids = await tripFamilyIds(trip);
    const households = await Household.find({ _id: { $in: ids } }, 'name').lean();
    res.json(households.map(h => ({ householdId: h._id, name: h.name })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set the requesting user's FAMILY budget for the trip.
router.put('/:id/my-budget', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) });
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const familyId = req.user.householdId;
    const budget = (req.body.budget === '' || req.body.budget == null) ? undefined : Number(req.body.budget);
    const baseCurrency = (req.body.baseCurrency || 'CAD').toUpperCase();
    const entry = trip.householdBudgets.find(b => String(b.householdId) === String(familyId));
    if (entry) { entry.budget = budget; entry.baseCurrency = baseCurrency; }
    else trip.householdBudgets.push({ householdId: familyId, budget, baseCurrency });
    await trip.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Settle-up: net balances between families from shared-bill bookings, in the viewer's currency.
router.get('/:id/settlement', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) }).lean();
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const items = await TripItem.find({ tripId: trip._id, sharing: 'shared_shared' }, 'title type cost currency shares paidByHouseholdId householdId').lean();

    const familyId = req.user.householdId;
    const ownerFamId = await ownerFamilyId(trip);
    const base = familyBudgetEntry(trip, familyId, ownerFamId).baseCurrency;
    const ratesEntry = await getRates(base);
    const rates = ratesEntry?.rates;
    const round = (n) => Math.round(n * 100) / 100;

    // directed debts[ower][creditor] = amount in base, with the contributing
    // bookings tracked alongside so the breakdown can link back to them.
    const debts = {};
    const contribs = {};   // contribs[ower][creditor] = [{ itemId, title, type, amount }]
    const famSet = new Set();
    const addContrib = (ower, payer, line) => {
      debts[ower] = debts[ower] || {};
      debts[ower][payer] = (debts[ower][payer] || 0) + line.amount;
      contribs[ower] = contribs[ower] || {};
      (contribs[ower][payer] = contribs[ower][payer] || []).push(line);
    };
    for (const it of items) {
      const payer = String(it.paidByHouseholdId || it.householdId || '');
      if (!payer) continue;
      famSet.add(payer);
      for (const s of (it.shares || [])) {
        const ower = String(s.householdId);
        if (ower === payer || s.amount == null) continue;
        const conv = convert(s.amount, (it.currency || base).toUpperCase(), base, rates);
        if (conv == null) continue;
        famSet.add(ower);
        addContrib(ower, payer, { itemId: String(it._id), title: it.title || 'Booking', type: it.type || 'other', amount: conv });
      }
    }

    // Recorded payments pay down a family's debt: a payment F→T offsets what F
    // owes T. Kept separate from bookings so each shows as its own line.
    const payConv = {};    // payConv[from][to] = amount paid, in base
    for (const p of (trip.settlePayments || [])) {
      const from = String(p.fromHouseholdId || '');
      const to = String(p.toHouseholdId || '');
      if (!from || !to || from === to || p.amount == null) continue;
      const conv = convert(p.amount, (p.currency || base).toUpperCase(), base, rates);
      if (conv == null) continue;
      famSet.add(from); famSet.add(to);
      payConv[from] = payConv[from] || {};
      payConv[from][to] = (payConv[from][to] || 0) + conv;
    }

    // Net each unordered pair into a single directed balance, and attach the
    // signed lines (bookings + payments) that add up to it. A positive line
    // increases what `from` owes `to`; a negative line offsets it.
    const fams = [...famSet];
    const balances = [];
    for (let i = 0; i < fams.length; i++) {
      for (let j = i + 1; j < fams.length; j++) {
        const a = fams[i], b = fams[j];
        const net = (debts[a]?.[b] || 0) - (debts[b]?.[a] || 0)
          - (payConv[a]?.[b] || 0) + (payConv[b]?.[a] || 0);
        const amt = round(Math.abs(net));
        if (amt < 0.01) continue;
        const [from, to] = net > 0 ? [a, b] : [b, a];
        const lines = [
          ...(contribs[from]?.[to] || []).map(l => ({ kind: 'booking', ...l, amount: round(l.amount) })),
          ...(contribs[to]?.[from] || []).map(l => ({ kind: 'booking', ...l, amount: round(-l.amount) })),
        ];
        if (payConv[from]?.[to]) lines.push({ kind: 'payment', amount: round(-payConv[from][to]) });
        if (payConv[to]?.[from]) lines.push({ kind: 'payment', amount: round(payConv[to][from]) });
        balances.push({ from, to, amount: amt, lines });
      }
    }

    // Participating families: those in shared bills plus every trip family, so the
    // settle page can offer a from/to choice even once everyone is square.
    const tripFamIds = await tripFamilyIds(trip);
    tripFamIds.forEach(id => famSet.add(id));
    const households = await Household.find({ _id: { $in: [...famSet] } }, 'name').lean();
    const nameOf = Object.fromEntries(households.map(h => [String(h._id), h.name]));
    const named = id => nameOf[String(id)] || 'A family';

    const payments = (trip.settlePayments || [])
      .map(p => ({
        _id: p._id,
        from: String(p.fromHouseholdId || ''),
        to: String(p.toHouseholdId || ''),
        fromName: named(p.fromHouseholdId),
        toName: named(p.toHouseholdId),
        amount: p.amount,
        currency: (p.currency || base).toUpperCase(),
        date: p.date,
        note: p.note || '',
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      baseCurrency: base,
      ratesAvailable: !!rates,
      myHouseholdId: String(familyId),
      households: tripFamIds.map(id => ({ householdId: id, name: named(id) })),
      balances: balances.map(b => ({ ...b, fromName: named(b.from), toName: named(b.to) })),
      payments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a settle-up payment between two families on the trip.
router.post('/:id/settle-payments', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) });
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const from = String(req.body.from || '');
    const to = String(req.body.to || '');
    const amount = Number(req.body.amount);
    if (!from || !to) return res.status(400).json({ error: 'Both families are required' });
    if (from === to) return res.status(400).json({ error: 'Pick two different families' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
    const famIds = await tripFamilyIds(trip);
    if (!famIds.includes(from) || !famIds.includes(to)) {
      return res.status(400).json({ error: 'Both families must be on this trip' });
    }
    trip.settlePayments.push({
      fromHouseholdId: from,
      toHouseholdId: to,
      amount,
      currency: (req.body.currency || trip.baseCurrency || 'CAD').toUpperCase(),
      date: req.body.date ? new Date(req.body.date) : new Date(),
      note: (req.body.note || '').trim() || undefined,
    });
    await trip.save();
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/settle-payments/:paymentId', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) });
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const before = trip.settlePayments.length;
    trip.settlePayments = trip.settlePayments.filter(p => String(p._id) !== String(req.params.paymentId));
    if (trip.settlePayments.length === before) return res.status(404).json({ error: 'Payment not found' });
    await trip.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', activity('tripCreated'), async (req, res) => {
  try {
    let enc;
    try { enc = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: msg }); }
    if (plaintextCreateBlocked(req.household, enc.enc)) {
      return res.status(400).json({ error: E2EE_REQUIRED_MESSAGE });
    }
    const data = {
      ...(isObjectId(req.body._id) ? { _id: req.body._id } : {}),
      userId: req.user._id, ...pick(req.body, TRIP_FIELDS), ...enc,
    };
    // Steady-state write rule: a sealed (private) trip stores no plaintext
    // content. A brand-new trip is never shared yet, so it always carries enc.
    stripSealedContent('Trip', req.household, data);
    const trip = await Trip.create(data);
    res.status(201).json(trip);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    let enc;
    try { enc = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: msg }); }
    // Signal-parity D2: a shared trip seals under its TripKey (enc.ks === 'trip')
    // rather than staying plaintext — so an edit keeps its ciphertext like any
    // other record; the client picks the TripKey vs HDK seal. No shared-trip
    // enc-strip anymore.
    const set = { ...pick(req.body, TRIP_FIELDS), ...enc };
    // Steady-state write rule: a sealed trip (TripKey or HDK) re-stores no
    // plaintext content (name/destination/notes ride in enc). The plaintext lane
    // (a legacy shared trip not yet migrated to a TripKey) writes without enc, so
    // this is a no-op there and its plaintext survives until the owner reconciles.
    stripSealedContent('Trip', req.household, set);
    const trip = await Trip.findOneAndUpdate(
      { _id: req.params.id, ...accessFilter(req) },
      set,
      { new: true },
    );
    if (!trip) return res.status(404).json({ error: 'Not found' });
    res.json(trip);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const trip = await Trip.findOneAndDelete({ _id: req.params.id, ...ownerFilter(req) });
    if (!trip) return res.status(404).json({ error: 'Not found' });
    const items = await TripItem.find({ tripId: trip._id }).lean();
    unlinkAttachments(items);
    await TripItem.deleteMany({ tripId: trip._id });
    // Signal-parity D2: the TripKey envelopes die with the trip.
    await ResourceKeyEnvelope.deleteMany({ resourceType: 'trip', resourceKey: String(trip._id) }).catch(() => {});
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trip items (bookings) ────────────────────────────────────────────────────────

router.post('/:id/items', async (req, res) => {
  try {
    const trip = await requireTripAccess(req, res);
    if (!trip) return;
    const item = new TripItem({
      ...(isObjectId(req.body._id) ? { _id: req.body._id } : {}),
      userId: req.user._id,
      householdId: req.user.householdId,   // creator's family (snapshot)
      tripId: trip._id,
    });
    applyItemBody(item, req.body, req.user.householdId);
    // Signal-parity D2: a shared trip's items seal under the TripKey (enc.ks ===
    // 'trip'); private-trip items seal under the HDK. Either way the client sends
    // ciphertext, which stripSealedDoc's write rule strips the plaintext for. The
    // mandate (plaintextCreateBlocked) is enforced only on UNSHARED trips, so a
    // shared trip degrades to a plaintext write when a client can't yet provision
    // the TripKey (graceful degrade, same as D1's calendars).
    try {
      const enc = pickRecordEnc(req.body);
      if (!isTripShared(trip) && plaintextCreateBlocked(req.household, enc.enc)) {
        return res.status(400).json({ error: E2EE_REQUIRED_MESSAGE });
      }
      Object.assign(item, enc);
      stripSealedDoc('TripItem', req.household, item);
    } catch (msg) { return res.status(400).json({ error: msg }); }
    await item.save();
    res.status(201).json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/items/:itemId', async (req, res) => {
  try {
    const trip = await requireTripAccess(req, res);
    if (!trip) return;
    const item = await TripItem.findOne({ _id: req.params.itemId, tripId: req.params.id });
    if (!item || !canSeeItem(item, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    // Only the household that created a booking can make it private (which would
    // otherwise remove the other families from it).
    if (req.body.sharing === 'private' && !sameId(item.householdId, req.user.householdId)) {
      return res.status(403).json({ error: 'Only the household that created this booking can make it private' });
    }
    const removedKeys = applyItemBody(item, req.body, req.user.householdId);
    // Signal-parity D2: a shared trip's items seal under the TripKey (enc.ks ===
    // 'trip'); private-trip items under the HDK. stripSealedDoc strips the
    // plaintext for either. A legacy plaintext-lane item (no enc) survives untouched.
    try {
      Object.assign(item, pickRecordEnc(req.body));
      stripSealedDoc('TripItem', req.household, item);
    } catch (msg) { return res.status(400).json({ error: msg }); }
    await item.save();
    // Unlink files of families that were dropped from the booking.
    for (const key of removedKeys) {
      const p = path.join(uploadDir, key);
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    }
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    if (!await requireTripAccess(req, res)) return;
    const item = await TripItem.findOne({ _id: req.params.itemId, tripId: req.params.id });
    if (!item || !canSeeItem(item, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    // Only the creating household can delete; others must "leave" instead.
    if (!sameId(item.householdId, req.user.householdId)) {
      return res.status(403).json({ error: 'Only the household that created this booking can delete it. Use "Leave booking" instead.' });
    }
    await item.deleteOne();
    unlinkAttachments([item]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave a booking shared by another household — removes only your family's data.
router.post('/:id/items/:itemId/leave', async (req, res) => {
  try {
    if (!await requireTripAccess(req, res)) return;
    const item = await TripItem.findOne({ _id: req.params.itemId, tripId: req.params.id });
    if (!item || !canSeeItem(item, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    const fam = req.user.householdId;
    if (sameId(item.householdId, fam)) {
      return res.status(400).json({ error: 'You created this booking — delete it instead' });
    }
    if (USES_HOUSEHOLD_DATA.has(item.sharing)) {
      item.householdData = (item.householdData || []).filter(e => !sameId(e.householdId, fam));
    }
    if (item.sharing === 'shared_shared') {
      item.shares = (item.shares || []).filter(s => !sameId(s.householdId, fam));
    }
    const removedKeys = [];
    item.attachments = (item.attachments || []).filter(a => {
      if (sameId(a.householdId, fam)) { removedKeys.push(a.storageKey); return false; }
      return true;
    });
    await item.save();
    for (const key of removedKeys) {
      const p = path.join(uploadDir, key);
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    }
    res.json({ message: 'Left booking' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Attachments (confirmation files) ─────────────────────────────────────────────

router.post('/:id/items/:itemId/attachments', attachmentUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (PDF or image)' });
    const trip = await requireTripAccess(req, res);
    if (!trip) { fs.unlink(path.join(uploadDir, req.file.filename), () => {}); return; }
    const item = await TripItem.findOne({ _id: req.params.itemId, tripId: req.params.id });
    if (!item || !canSeeItem(item, req.user.householdId)) {
      fs.unlink(path.join(uploadDir, req.file.filename), () => {});
      return res.status(404).json({ error: 'Booking not found' });
    }
    // E2EE (Phase 4c + Signal-parity D2): the client may upload ciphertext + the
    // wrapped per-file key and a client-minted _id (the file key's AAD binds to
    // it). The wrap is under whichever key the file's readers hold — the HDK for a
    // private / per-family booking, or the TripKey for a shared_shared booking's
    // one shared receipt (the wrap envelope's ks tells the client which). The
    // server is blind to that choice; it only stores the opaque wrappedFileKey, so
    // encrypted uploads are now allowed on shared bookings too (§9.3 lane retired).
    const encrypted = req.body.encrypted === 'true' || req.body.encrypted === true;
    if (encrypted && !req.body.wrappedFileKey) {
      fs.unlink(path.join(uploadDir, req.file.filename), () => {});
      return res.status(400).json({ error: 'wrappedFileKey required for an encrypted attachment' });
    }
    item.attachments.push({
      ...(isObjectId(String(req.body._id || '')) ? { _id: req.body._id } : {}),
      storageKey: req.file.filename,
      filename: encrypted ? (req.body.title || 'attachment') : req.file.originalname,
      fileType: encrypted ? (req.body.fileType || 'application/octet-stream') : req.file.mimetype,
      fileSizeBytes: req.file.size,
      householdId: req.user.householdId,   // uploader's family (private unless one shared bill)
      ...(encrypted ? { encrypted: true, wrappedFileKey: req.body.wrappedFileKey, keyVersion: Number(req.body.keyVersion) || undefined } : {}),
    });
    await item.save();
    res.status(201).json(item.attachments[item.attachments.length - 1]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/items/:itemId/attachments/:attId/download', async (req, res) => {
  try {
    if (!await requireTripAccess(req, res)) return;
    const item = await TripItem.findOne({ _id: req.params.itemId, tripId: req.params.id });
    if (item && !canSeeItem(item, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    const att = item?.attachments.id(req.params.attId);
    if (!att || !canSeeAttachment(item, att, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    const filepath = path.join(uploadDir, att.storageKey);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File missing on disk' });
    // Encrypted attachments are ciphertext on disk — fileType holds the plaintext
    // mimetype for the client to restore after decrypting, not what we serve.
    res.setHeader('Content-Type', att.encrypted ? 'application/octet-stream' : (att.fileType || 'application/octet-stream'));
    res.setHeader('Content-Disposition', `inline; filename="${(att.filename || 'attachment').replace(/"/g, '')}"`);
    res.sendFile(filepath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/items/:itemId/attachments/:attId', async (req, res) => {
  try {
    if (!await requireTripAccess(req, res)) return;
    const item = await TripItem.findOne({ _id: req.params.itemId, tripId: req.params.id });
    if (item && !canSeeItem(item, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    const att = item?.attachments.id(req.params.attId);
    if (!att || !canSeeAttachment(item, att, req.user.householdId)) return res.status(404).json({ error: 'Not found' });
    const filepath = path.join(uploadDir, att.storageKey);
    if (fs.existsSync(filepath)) fs.unlink(filepath, () => {});
    att.deleteOne();
    await item.save();
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI auto-fill from a confirmation (PDF / image / pasted text) ──────────────────

const TYPES = ['flight', 'hotel', 'car-rental', 'restaurant', 'activity', 'transit', 'other'];

const CLAUDE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXTRACT_PROMPT = `You are extracting a SINGLE travel booking from a confirmation — a flight ticket/itinerary, hotel reservation, car rental, restaurant reservation, activity/tour ticket, or train/ferry booking. Identify the booking type and pull out the structured details.

Rules:
- All times are LOCAL to where they occur (a flight's departure time is in the departure city's local time, arrival time in the arrival city's local time).
- Use 24-hour HH:mm for times and YYYY-MM-DD for dates.
- For flights/transit, "departure"/"arrival" names should be the airport or station (include the IATA/station code if shown, e.g. "Toronto Pearson (YYZ)").
- For hotel/car-rental/restaurant/activity, use start/end (e.g. check-in/check-out, pick-up/drop-off, reservation time).
- If a field is unknown, use null. Do NOT invent values.`;

const EXTRACT_SCHEMA = `{
  "type": "flight|hotel|car-rental|restaurant|activity|transit|other",
  "title": "short label, e.g. 'Toronto to Rome' or 'Hotel Roma'",
  "departure": { "name": "airport/station name or code", "date": "YYYY-MM-DD", "time": "HH:mm" },
  "arrival":   { "name": "airport/station name or code", "date": "YYYY-MM-DD", "time": "HH:mm" },
  "start": { "date": "YYYY-MM-DD", "time": "HH:mm" },
  "end":   { "date": "YYYY-MM-DD", "time": "HH:mm" },
  "location": "address or place (hotel/restaurant/activity/car)",
  "airline": "", "flightNumber": "", "seat": "", "mode": "", "roomType": "",
  "confirmation": "", "cost": 0, "currency": "", "url": "", "phone": "", "notes": ""
}`;

async function buildDraft(p) {
  const type = TYPES.includes(p.type) ? p.type : 'other';
  const num = (v) => (typeof v === 'number' ? v : (v ? Number(v) || null : null));
  const draft = {
    type,
    title: p.title || '',
    confirmation: p.confirmation || '',
    cost: num(p.cost),
    currency: p.currency || '',
    url: p.url || '',
    phone: p.phone || '',
    notes: p.notes || '',
    details: {},
  };

  if (type === 'flight' || type === 'transit') {
    const kind = type === 'flight' ? 'airport' : 'transit';
    const [dep, arr] = await Promise.all([
      p.departure?.name ? resolvePlaceWithTz(p.departure.name, kind) : null,
      p.arrival?.name ? resolvePlaceWithTz(p.arrival.name, kind) : null,
    ]);
    draft.departure = {
      name: dep?.description || p.departure?.name || '',
      placeId: dep?.placeId || '',
      tz: dep?.tz || '',
      date: p.departure?.date || '',
      time: p.departure?.time || '',
    };
    draft.arrival = {
      name: arr?.description || p.arrival?.name || '',
      placeId: arr?.placeId || '',
      tz: arr?.tz || '',
      date: p.arrival?.date || '',
      time: p.arrival?.time || '',
    };
    draft.details = type === 'flight'
      ? { airline: p.airline || '', flightNumber: p.flightNumber || '', seat: p.seat || '' }
      : { mode: p.mode || '' };
  } else {
    draft.start = { date: p.start?.date || '', time: p.start?.time || '' };
    draft.end = { date: p.end?.date || '', time: p.end?.time || '' };
    draft.location = p.location || '';
    if (type === 'hotel' && p.roomType) draft.details.roomType = p.roomType;
  }
  return draft;
}

router.post('/:id/items/from-confirmation', meter('scan'), requireAiEnabled, memoryUpload.single('file'), async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) }).lean();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const file = req.file;
    const text = req.body?.text?.trim();
    if (!file && !text) return res.status(400).json({ error: 'Provide a confirmation file or pasted text' });

    const content = [];
    let emailText = '';

    if (file && isEml(file)) {
      // Parse the email: use its body text, and forward any PDF/image attachments
      // (airlines often attach the e-ticket) to Claude as well.
      const parsed = await simpleParser(file.buffer);
      emailText = (parsed.text || stripHtml(parsed.html || '') || parsed.subject || '').slice(0, 20000);
      for (const att of parsed.attachments || []) {
        if (content.length >= 4) break;
        const ct = att.contentType || '';
        const b64 = att.content?.toString('base64');
        if (!b64) continue;
        if (ct === 'application/pdf') {
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
        } else if (CLAUDE_IMAGE_TYPES.includes(ct)) {
          content.push({ type: 'image', source: { type: 'base64', media_type: ct, data: b64 } });
        }
      }
    } else if (file) {
      const b64 = file.buffer.toString('base64');
      content.push(file.mimetype === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
        : { type: 'image', source: { type: 'base64', media_type: file.mimetype, data: b64 } });
    }

    const combinedText = [emailText, text].filter(Boolean).join('\n\n');
    content.push({
      type: 'text',
      text: `${EXTRACT_PROMPT}\n\n${combinedText ? `Confirmation text:\n${combinedText}\n\n` : ''}Respond with ONLY valid JSON matching this schema (no markdown):\n${EXTRACT_SCHEMA}`,
    });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content }],
    });

    const raw = message.content[0].text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new SyntaxError('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);

    const draft = await buildDraft(parsed);
    res.json(draft);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not read that confirmation. Try entering the booking manually.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Sharing a trip with outside emails (invitations → collaborators) ──────────
//
// Mirrors shared-calendar sharing (routes/calendars.js): the owner keeps a list
// of outside emails on the trip; each new email gets a TripInvitation + email,
// each removed email revokes the invitation and unseats the collaborator. The
// recipient accepts from their Invitations inbox to become a collaborator.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Canonical key for an outside-share entry (email or phone), used to dedupe and
// to diff the previous vs. next lists in syncTripInvitations.
const entryKey = (e) => e?.email || e?.phone || '';

// Normalize the client's outside-share list into `{ email }` or `{ phone }`
// entries. Accepts either objects ({ email } / { phone }) or bare email strings
// (legacy clients that sent `emails: string[]`).
function normalizeRecipients(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (raw && raw.phone !== undefined && raw.phone !== null && raw.phone !== '') {
      const phone = normalizePhone(raw.phone);
      if (phone && !seen.has(phone)) { seen.add(phone); out.push({ phone }); }
      continue;
    }
    const email = String(raw?.email ?? raw ?? '').trim().toLowerCase();
    if (EMAIL_RE.test(email) && !seen.has(email)) { seen.add(email); out.push({ email }); }
  }
  return out;
}

// Reconcile a trip's outside recipients with their invitations: new addresses
// get a pending TripInvitation (emailed, or texted from the owner's device for a
// phone); removed ones are revoked (invitation deleted, accepted collaborator
// unseated). Never throws — sharing bookkeeping must not fail the save that
// triggered it.
//
// `snapshot` = the plaintext { tripName, destination } for the invitation display
// row. Signal-parity D2: a shared trip's name/destination are sealed under the
// TripKey, so the server can't read them off the Trip — the owner's device passes
// them for the invitee's inbox (a bounded disclosure to the contact being granted
// access, never written back to the Trip). Falls back to the trip's own plaintext
// (a non-e2ee / not-yet-migrated trip).
async function syncTripInvitations(trip, prevEntries, req, snapshot = {}) {
  const prev = new Map((prevEntries || []).map((e) => [entryKey(e), e]));
  const next = new Map((trip.sharedWithOutside || []).map((e) => [entryKey(e), e]));
  const fromName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ');
  const tripName = snapshot.tripName || trip.name || 'Our trip';
  const destination = snapshot.destination || trip.destination;

  for (const [key, entry] of next) {
    if (prev.has(key)) continue;
    try {
      const recipient = entry.phone
        ? await User.findOne({ phone: entry.phone }).select('_id pushSubscriptions').lean()
        : await User.findOne({ email: entry.email }).select('_id pushSubscriptions').lean();
      await TripInvitation.create({
        fromUserId: req.user._id,
        fromName,
        fromEmail: req.user.email,
        toEmail: entry.email || undefined,
        toPhone: entry.phone || undefined,
        toUserId: recipient?._id,
        tripId: trip._id,
        tripName,
        destination,
      });
      // Outreach is device-composed — the owner's mail/Messages app sends the
      // invite (see mobile lib/shareInvite); the server sends no email/text.
      // Existing accounts also get a push nudge — the one channel the server
      // sends, since it needs their device tokens. Fire-and-forget, best-effort.
      if (recipient) {
        pushToUser(recipient, {
          title: 'Trip shared with you',
          body: `${fromName || req.user.email} shared ${tripName ? `“${tripName}”` : 'a trip'} with you`,
          data: { type: 'trip_invitation', tripId: String(trip._id) },
          tag: `trip-invite-${trip._id}`,
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[trips] invitation create failed:', err.message);
    }
  }

  let revoked = false;
  for (const [key, entry] of prev) {
    if (next.has(key)) continue;
    try {
      const inv = await TripInvitation.findOneAndDelete(
        entry.phone
          ? { tripId: trip._id, toPhone: entry.phone }
          : { tripId: trip._id, toEmail: entry.email },
      );
      if (inv?.toUserId) {
        await Trip.updateOne({ _id: trip._id }, { $pull: { collaborators: inv.toUserId } });
      }
      revoked = true;
    } catch (err) {
      console.error('[trips] invitation revoke failed:', err.message);
    }
  }
  // Signal-parity D2: an outside party losing access means the TripKey must rotate
  // so their wrapped key opens nothing further — flag it for the owning
  // household's next unlocked session (which rotates + re-seals). Only meaningful
  // once a TripKey exists (tripKeyVersion > 0).
  if (revoked && (trip.tripKeyVersion || 0) > 0) {
    await Trip.updateOne({ _id: trip._id }, { $set: { tripKeyRotationPending: true } }).catch(() => {});
  }
}

// Set the trip's outside-share emails. Household (owner) only. Signal-parity D2:
// sharing no longer flips the trip to plaintext (the `409 decrypt_required` lane
// is retired). The trip + its items stay sealed and migrate onto a TripKey on the
// owning household's next unlocked session (GET /trips/keys/pending → mint + wrap
// + re-seal). Because the Trip's name/destination are sealed, the client passes a
// plaintext { tripName, destination } snapshot for the invitation display rows.
router.put('/:id/share', async (req, res) => {
  try {
    const existing = await Trip.findOne({ _id: req.params.id, ...ownerFilter(req) })
      .select('sharedWithOutside collaborators tripKeyVersion name destination').lean();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    // Accept `recipients: [{email?|phone?}]` (new) or `emails: string[]` (legacy).
    const nextEntries = normalizeRecipients(req.body?.recipients ?? req.body?.emails);
    const snapshot = { tripName: req.body?.tripName, destination: req.body?.destination };

    const trip = await Trip.findOneAndUpdate(
      { _id: existing._id },
      { $set: { sharedWithOutside: nextEntries } },
      { new: true },
    ).lean();
    // Carry the prior tripKeyVersion so the revoke-rotation flag fires correctly.
    await syncTripInvitations({ ...trip, tripKeyVersion: existing.tripKeyVersion }, existing.sharedWithOutside || [], req, snapshot);
    res.json({ sharedWithOutside: trip.sharedWithOutside });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disable sharing — clears every outside email + collaborator and deletes the
// invitations. Household only. Signal-parity D2: flag a TripKey rotation so the
// removed parties' wraps open nothing (the trip's own records re-seal onto the
// fresh version + HDK-lazy on the owner's next unlock).
router.delete('/:id/share', async (req, res) => {
  try {
    const trip = await Trip.findOneAndUpdate(
      { _id: req.params.id, ...ownerFilter(req) },
      { $set: { sharedWithOutside: [], collaborators: [] } },
      { new: true },
    );
    if (!trip) return res.status(404).json({ error: 'Not found' });
    await TripInvitation.deleteMany({ tripId: trip._id }).catch(() => {});
    if ((trip.tripKeyVersion || 0) > 0) {
      await Trip.updateOne({ _id: trip._id }, { $set: { tripKeyRotationPending: true } }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop collaborating on a shared trip (a guest removes themselves). Also retires
// their invitation so they aren't shown as a pending collaborator, and flags the
// TripKey for rotation so their wrap is superseded (D2).
router.post('/:id/leave-share', async (req, res) => {
  try {
    await Trip.updateOne({ _id: req.params.id }, { $pull: { collaborators: req.user._id } });
    await TripInvitation.updateOne(
      { tripId: req.params.id, toUserId: req.user._id },
      { $set: { status: 'declined', respondedAt: new Date() } },
    ).catch(() => {});
    await Trip.updateOne(
      { _id: req.params.id, tripKeyVersion: { $gt: 0 } },
      { $set: { tripKeyRotationPending: true } },
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a specific collaborator. Household only. Pulls them from collaborators,
// drops their email from the share list, and deletes their invitation (so the
// revoke is complete and they can't be re-seated). Flags a TripKey rotation (D2).
router.delete('/:id/collaborators/:userId', async (req, res) => {
  try {
    const inv = await TripInvitation.findOneAndDelete({ tripId: req.params.id, toUserId: req.params.userId });
    const pull = { collaborators: req.params.userId };
    if (inv?.toEmail) pull.sharedWithOutside = { email: inv.toEmail };
    else if (inv?.toPhone) pull.sharedWithOutside = { phone: inv.toPhone };
    const trip = await Trip.findOneAndUpdate(
      { _id: req.params.id, ...ownerFilter(req) },
      { $pull: pull },
      { new: true },
    );
    if (!trip) return res.status(404).json({ error: 'Not found' });
    if ((trip.tripKeyVersion || 0) > 0) {
      await Trip.updateOne({ _id: trip._id }, { $set: { tripKeyRotationPending: true } }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TripKeys (Signal-parity D2: per-resource content keys) ───────────────────
// A shared trip's Trip + TripItems (+ shared_shared attachments) seal under a
// TripKey (not the household HDK), wrapped to the owning household (via its HDK)
// and to each accepted collaborator (via their identity key). The server is blind
// to the key — it only ferries opaque `ResourceKeyEnvelope` rows (resourceType
// 'trip', resourceKey = the Trip _id), exactly like D1's calendars. See §D2.

// Loose shape check for a wrapped-key blob (server never verifies crypto).
const isWrappedKey = (v) => typeof v === 'string' && v.length > 0 && v.length < 8192;

// Persist a batch of collaborator wraps for one TripKey version. Only seats wraps
// for users who are actually collaborators on the trip (defense in depth: the
// owner can't hand the key to an arbitrary account). Returns the count.
async function writeTripMemberWraps(tripId, keyVersion, members, wrappedByUserId) {
  if (!Array.isArray(members) || !members.length) return 0;
  const trip = await Trip.findById(tripId, 'collaborators').lean();
  const collabIds = new Set((trip?.collaborators || []).map((c) => String(c)));
  let n = 0;
  for (const m of members) {
    if (!m || !isWrappedKey(m.wrappedKey) || !collabIds.has(String(m.userId))) continue;
    await ResourceKeyEnvelope.updateOne(
      { resourceType: 'trip', resourceKey: String(tripId), keyVersion, recipient: 'member', userId: m.userId },
      { $set: { wrappedKey: m.wrappedKey, wrappedByUserId } },
      { upsert: true },
    );
    n++;
  }
  return n;
}

// The owner's background wrap-on-approve work list: for every shared trip their
// household owns, the accepted collaborators still missing a member wrap at the
// current TripKey version (their identityPublicKey included so the client can seal
// to it), plus trips flagged for a revoke-rotation. Registered before /:id-shaped
// routes can't shadow it (distinct two-segment literal path).
router.get('/keys/pending', async (req, res) => {
  try {
    const owned = await Trip.find({ userId: { $in: req.scopeIds } })
      .select('_id collaborators sharedWithOutside tripKeyVersion tripKeyRotationPending').lean();
    // Shared trips need a TripKey; a trip flagged for a revoke-rotation stays on
    // the list even after its last outside party left (so the owner still rotates
    // it, locking out the removed party's key).
    const shared = owned.filter((t) => isTripShared(t) || t.tripKeyRotationPending);
    const out = [];
    for (const trip of shared) {
      const collabIds = (trip.collaborators || []).map((c) => c);
      const version = trip.tripKeyVersion || 0;
      const wrapped = version
        ? new Set((await ResourceKeyEnvelope.find({
            resourceType: 'trip', resourceKey: String(trip._id), keyVersion: version, recipient: 'member',
          }).distinct('userId')).map(String))
        : new Set();
      const missing = collabIds.filter((id) => !wrapped.has(String(id)));
      const needsMint = version === 0; // never provisioned — mint v1 first
      if (!needsMint && !missing.length && !trip.tripKeyRotationPending) continue;
      const users = await User.find(
        { _id: { $in: collabIds }, identityPublicKey: { $exists: true, $ne: null } },
        '_id identityPublicKey',
      ).lean();
      const byId = new Map(users.map((u) => [String(u._id), u.identityPublicKey]));
      const missingSet = new Set(missing.map(String));
      out.push({
        tripId: String(trip._id),
        currentKeyVersion: version,
        needsMint,
        rotationPending: !!trip.tripKeyRotationPending,
        collaborators: collabIds
          .map((id) => ({ userId: id, identityPublicKey: byId.get(String(id)) || null }))
          .filter((c) => c.identityPublicKey),
        missingMembers: users
          .filter((u) => missingSet.has(String(u._id)))
          .map((u) => ({ userId: u._id, identityPublicKey: u.identityPublicKey })),
      });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The TripKey envelopes the caller can use for a trip: the household wrap (their
// household owns the trip) and/or their own member wrap (they're a collaborator).
router.get('/:id/keys', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...accessFilter(req) }).select('_id userId').lean();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const owns = ownsTrip(trip, req);
    const or = [];
    if (owns) or.push({ recipient: 'household', resourceKey: String(trip._id) });
    or.push({ recipient: 'member', resourceKey: String(trip._id), userId: req.user._id });
    const envelopes = await ResourceKeyEnvelope.find({ resourceType: 'trip', $or: or }).lean();
    const fresh = await Trip.findById(trip._id, 'tripKeyVersion').lean();
    res.json({
      tripId: String(trip._id),
      currentKeyVersion: fresh?.tripKeyVersion || 0,
      household: envelopes
        .filter((e) => e.recipient === 'household')
        .map((e) => ({ keyVersion: e.keyVersion, hdkVersion: e.hdkVersion, wrappedKey: e.wrappedKey })),
      member: envelopes
        .filter((e) => e.recipient === 'member')
        .map((e) => ({ keyVersion: e.keyVersion, wrappedKey: e.wrappedKey })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner mints or rotates the TripKey. `keyVersion` must be the trip's current
// `tripKeyVersion + 1` (compare-and-set, so concurrent mints can't both win).
// Carries the household wrap (required) and any collaborator wraps this session
// could produce. Used at first-share (v1) and on revoke/un-share (vN+1 + re-seal).
router.post('/:id/keys', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...ownerFilter(req) }).select('_id userId tripKeyVersion').lean();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const { keyVersion, household, members } = req.body || {};
    const current = trip.tripKeyVersion || 0;
    if (keyVersion !== current + 1) {
      return res.status(409).json({ error: 'Key version moved — please retry', currentKeyVersion: current });
    }
    if (!household || !isWrappedKey(household.wrappedKey) || !Number.isInteger(household.hdkVersion)) {
      return res.status(400).json({ error: 'A household-wrapped TripKey is required' });
    }
    // Compare-and-set the trip's version so only one mint from `current` wins.
    const claimed = await Trip.findOneAndUpdate(
      { _id: trip._id, tripKeyVersion: current },
      { $set: { tripKeyVersion: keyVersion, tripKeyRotationPending: false } },
    );
    if (!claimed) return res.status(409).json({ error: 'Key already rotated — please retry' });

    await ResourceKeyEnvelope.updateOne(
      { resourceType: 'trip', resourceKey: String(trip._id), keyVersion, recipient: 'household' },
      { $set: { householdId: req.user.householdId, hdkVersion: household.hdkVersion, wrappedKey: household.wrappedKey, wrappedByUserId: req.user._id } },
      { upsert: true },
    );
    await writeTripMemberWraps(trip._id, keyVersion, members, req.user._id);
    res.status(201).json({ ok: true, keyVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner adds collaborator wraps at the current version (the async approve-on-
// device step — no rotation).
router.post('/:id/keys/members', async (req, res) => {
  try {
    const trip = await Trip.findOne({ _id: req.params.id, ...ownerFilter(req) }).select('_id tripKeyVersion').lean();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const { keyVersion, members } = req.body || {};
    if (keyVersion !== (trip.tripKeyVersion || 0)) {
      return res.status(409).json({ error: 'Key version moved — please retry', currentKeyVersion: trip.tripKeyVersion || 0 });
    }
    const n = await writeTripMemberWraps(trip._id, keyVersion, members, req.user._id);
    res.json({ ok: true, wrapped: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
