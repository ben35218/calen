const express = require('express');
const CustomCalendar = require('../models/CustomCalendar');
const CalendarInvitation = require('../models/CalendarInvitation');
const ResourceKeyEnvelope = require('../models/ResourceKeyEnvelope');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { pushToUser } = require('../services/notify');
const { normalizePhone } = require('../services/phone');
const {
  normalizeMemberEntry,
  normalizeOutsideEntry,
  normalizeCollaboratorEntry,
  effectiveCalendarAccess,
  isCalendarOutsideShared,
} = require('../services/calendarSharing');

const router = express.Router();
router.use(requireAuth);

// Whether the requester's household owns this calendar (the calendar's creator
// is a household member) — gates who may serve/mint the household-wrapped
// CalendarKey and who may rotate it.
const ownsCalendar = (cal, req) => req.scopeIds.some((id) => String(id) === String(cal.userId));

// Canonical key for an outside-share entry (email or phone).
const outsideKey = (e) => e?.email || e?.phone || '';

// Invitations addressed to a user: to their account, or (before claiming) to
// their email or saved phone.
function addressedToUser(user) {
  const or = [{ toUserId: user._id }];
  if (user.email) or.push({ toEmail: user.email.toLowerCase() });
  if (user.phone) or.push({ toPhone: user.phone });
  return or;
}

// Normalize a client outside-share list to `{ email|phone, access }` entries,
// applying loose phone normalization and dropping invalid/duplicate addresses.
function normalizeOutsideList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const e = normalizeOutsideEntry(raw);
    if (e.phone) {
      const phone = normalizePhone(e.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      out.push({ phone, access: e.access });
    } else {
      if (!e.email || seen.has(e.email)) continue;
      seen.add(e.email);
      out.push({ email: e.email, access: e.access });
    }
  }
  return out;
}

// Calendars this user can see: their own; a housemate's when shared with the
// household or with them specifically; and an outsider's once they accepted a
// calendar invitation (collaborators). The $in arms cover the legacy plain-id
// rows alongside the current subdoc shape.
function accessFilter(req) {
  return {
    $or: [
      { userId: req.user._id },
      { userId: { $in: req.scopeIds }, sharedWithHousehold: true },
      { userId: { $in: req.scopeIds }, 'sharedWith.userId': req.user._id },
      { userId: { $in: req.scopeIds }, sharedWith: req.user._id },
      { 'collaborators.userId': req.user._id },
      { collaborators: req.user._id },
    ],
  };
}

// Client payloads and legacy rows both normalize to the subdoc shapes.
function normalizeShared(cal) {
  return {
    ...cal,
    sharedWith: (cal.sharedWith || []).map(normalizeMemberEntry),
    sharedWithOutside: (cal.sharedWithOutside || []).map(normalizeOutsideEntry),
    collaborators: (cal.collaborators || []).map(normalizeCollaboratorEntry),
    householdAccess: cal.householdAccess === 'view' ? 'view' : 'full',
  };
}

// `mine` = editable (creator-only); `access` = the requester's effective event
// permission on it (View Only / Full Access). Sharing details are the owner's
// business: housemates don't see the outside emails, and outside collaborators
// don't see household member ids either (mirrors event invitations, where a
// recipient never sees other invitees).
function serialize(cal, req) {
  const obj = normalizeShared(cal.toObject ? cal.toObject() : cal);
  const mine = String(obj.userId) === String(req.user._id);
  const access = mine ? 'full' : effectiveCalendarAccess(obj, req.user._id, req.scopeIds) || 'view';
  if (!mine) {
    obj.sharedWithOutside = [];
    const sameHousehold = req.scopeIds.some((id) => String(id) === String(obj.userId));
    if (!sameHousehold) {
      obj.sharedWith = [];
      obj.sharedWithHousehold = false;
    }
  }
  delete obj.collaborators;
  return { ...obj, mine, access };
}

// Reconcile `sharedWithOutside` edits with their invitations: new emails get a
// pending CalendarInvitation + email; removed emails are revoked (invitation
// deleted, accepted collaborator unseated); access changes flow onto the
// invitation and any seated collaborator. Never throws — sharing bookkeeping
// must not fail the save that triggered it.
async function syncOutsideInvitations(cal, prevEntries, req) {
  const prev = new Map((prevEntries || []).map((e) => [outsideKey(e), e]));
  const next = new Map((cal.sharedWithOutside || []).map((e) => [outsideKey(e), e]));
  const fromName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ');

  for (const [key, entry] of next) {
    const access = entry.access === 'full' ? 'full' : 'view';
    // Match a prior invitation by whichever address this entry carries.
    const addrMatch = entry.phone
      ? { calendarKey: cal.key, toPhone: entry.phone }
      : { calendarKey: cal.key, toEmail: entry.email };
    if (!prev.has(key)) {
      try {
        const recipient = entry.phone
          ? await User.findOne({ phone: entry.phone }).select('_id pushSubscriptions').lean()
          : await User.findOne({ email: entry.email }).select('_id pushSubscriptions').lean();
        await CalendarInvitation.create({
          fromUserId: req.user._id,
          fromName,
          fromEmail: req.user.email,
          toEmail: entry.email || undefined,
          toPhone: entry.phone || undefined,
          toUserId: recipient?._id,
          calendarKey: cal.key,
          calendarName: cal.name,
          color: cal.color,
          access,
        });
        // Outreach is device-composed — the owner's mail/Messages app sends the
        // invite (see mobile lib/shareInvite); the server sends no email/text.
        // Existing accounts also get a push nudge — the one channel the server
        // sends, since it needs their device tokens. Fire-and-forget, best-effort.
        if (recipient) {
          pushToUser(recipient, {
            title: 'Calendar shared with you',
            body: `${fromName || req.user.email} shared ${cal.name ? `“${cal.name}”` : 'a calendar'} with you`,
            data: { type: 'calendar_invitation', calendarKey: cal.key },
            tag: `calendar-invite-${cal.key}`,
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[calendars] invitation create failed:', err.message);
      }
    } else if ((prev.get(key).access === 'full' ? 'full' : 'view') !== access) {
      // Access changed: update the invitation and any seated collaborator.
      try {
        const inv = await CalendarInvitation.findOneAndUpdate(addrMatch, { access }, { new: true });
        if (inv?.toUserId) {
          await CustomCalendar.updateOne(
            { _id: cal._id, 'collaborators.userId': inv.toUserId },
            { $set: { 'collaborators.$.access': access } },
          );
        }
      } catch (err) {
        console.error('[calendars] invitation access update failed:', err.message);
      }
    }
  }

  let revoked = false;
  for (const [key, entry] of prev) {
    if (next.has(key)) continue;
    try {
      const inv = await CalendarInvitation.findOneAndDelete(
        entry.phone
          ? { calendarKey: cal.key, toPhone: entry.phone }
          : { calendarKey: cal.key, toEmail: entry.email },
      );
      if (inv?.toUserId) {
        await CustomCalendar.updateOne(
          { _id: cal._id },
          { $pull: { collaborators: { userId: inv.toUserId } } },
        );
      }
      revoked = true;
    } catch (err) {
      console.error('[calendars] invitation revoke failed:', err.message);
    }
  }
  // Signal-parity D1: an outside party losing access means the CalendarKey must
  // rotate so their wrapped key opens nothing further. Flag it for the owner's
  // next unlocked session (which rotates + re-seals the events — B1 machinery).
  // Only meaningful once a CalendarKey exists (calKeyVersion > 0).
  if (revoked && (cal.calKeyVersion || 0) > 0) {
    await CustomCalendar.updateOne({ _id: cal._id }, { $set: { calKeyRotationPending: true } }).catch(() => {});
  }
}

// ── Invitations addressed to me (registered before /:key routes) ────────────

router.get('/invitations', async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const phone = req.user.phone || '';
    const invitations = await CalendarInvitation
      .find({ $or: addressedToUser(req.user) })
      .sort('-createdAt');
    // Lazily claim email/phone-only invitations sent before this account existed.
    const unclaimed = invitations.filter(
      (i) => !i.toUserId && ((i.toEmail && i.toEmail === email) || (i.toPhone && i.toPhone === phone)),
    );
    if (unclaimed.length) {
      await CalendarInvitation.updateMany(
        { _id: { $in: unclaimed.map((i) => i._id) } },
        { toUserId: req.user._id },
      );
    }
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invitations/:id/accept', async (req, res) => {
  try {
    const invitation = await CalendarInvitation.findOne({
      _id: req.params.id,
      $or: addressedToUser(req.user),
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });

    invitation.toUserId = invitation.toUserId || req.user._id;
    invitation.status = 'accepted';
    invitation.respondedAt = new Date();
    await invitation.save();
    // Re-seat the collaborator at the invitation's current access level.
    await CustomCalendar.updateOne(
      { key: invitation.calendarKey },
      { $pull: { collaborators: { userId: req.user._id } } },
    );
    const cal = await CustomCalendar.findOneAndUpdate(
      { key: invitation.calendarKey },
      { $push: { collaborators: { userId: req.user._id, access: invitation.access === 'full' ? 'full' : 'view' } } },
      { new: true },
    ).lean();
    if (!cal) return res.status(404).json({ error: 'Calendar no longer exists' });
    res.json({ invitation, calendar: serialize(cal, req) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invitations/:id/decline', async (req, res) => {
  try {
    const invitation = await CalendarInvitation.findOne({
      _id: req.params.id,
      $or: addressedToUser(req.user),
    });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });

    // Declining after accepting also gives up access.
    if (invitation.status === 'accepted' && invitation.toUserId) {
      await CustomCalendar.updateOne(
        { key: invitation.calendarKey },
        { $pull: { collaborators: { userId: invitation.toUserId } } },
      );
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

// ── CalendarKeys (Signal-parity D1: per-resource content keys) ───────────────
// The events on an outside-shared calendar are sealed under a CalendarKey (not
// the household HDK), wrapped to the owning household (via its HDK) and to each
// accepted collaborator (via their identity public key). The server is blind to
// the key — it only ferries opaque `ResourceKeyEnvelope` rows, exactly like the
// HDK envelopes. See docs/SIGNAL-PARITY-PLAN.md §D1.

// Loose shape check for a wrapped-key blob (JSON envelope for the household wrap,
// b64url sealed box for a member wrap). The server never verifies crypto.
const isWrappedKey = (v) => typeof v === 'string' && v.length > 0 && v.length < 8192;

// The CalendarKey envelopes the caller can actually use for a calendar: the
// household wrap (when the caller's household owns the calendar) and/or the
// caller's own member wrap (when they're a collaborator). The client unwraps
// whichever it holds a key for. `/:key` params can't shadow the literal
// `/keys/...` routes below (different path shapes), but this one is registered
// under `/:key/keys` so it stays after them.
router.get('/:key/keys', async (req, res) => {
  try {
    const cal = await CustomCalendar.findOne({ key: req.params.key }).lean();
    if (!cal) return res.status(404).json({ error: 'Calendar not found' });
    const access = effectiveCalendarAccess(cal, req.user._id, req.scopeIds);
    if (!ownsCalendar(cal, req) && !access) return res.status(404).json({ error: 'Calendar not found' });

    const or = [];
    if (ownsCalendar(cal, req)) or.push({ recipient: 'household', resourceKey: cal.key });
    or.push({ recipient: 'member', resourceKey: cal.key, userId: req.user._id });
    const envelopes = or.length
      ? await ResourceKeyEnvelope.find({ resourceType: 'calendar', $or: or }).lean()
      : [];

    res.json({
      calendarKey: cal.key,
      currentKeyVersion: cal.calKeyVersion || 0,
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

// Owner mints or rotates the CalendarKey. `keyVersion` must be the calendar's
// current `calKeyVersion + 1` (compare-and-set, so concurrent mints can't both
// win). Carries the household wrap (required) and any collaborator wraps the
// owner could produce this session. Bumps `calKeyVersion`, clears the rotation
// flag. Used at first-share (v1) and on revoke/un-share (vN+1 + client re-seal).
router.post('/:key/keys', async (req, res) => {
  try {
    const cal = await CustomCalendar.findOne({ key: req.params.key }).lean();
    if (!cal) return res.status(404).json({ error: 'Calendar not found' });
    if (String(cal.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Only the calendar owner manages its key' });
    }
    const { keyVersion, household, members } = req.body || {};
    const current = cal.calKeyVersion || 0;
    if (keyVersion !== current + 1) {
      return res.status(409).json({ error: 'Key version moved — please retry', currentKeyVersion: current });
    }
    if (!household || !isWrappedKey(household.wrappedKey) || !Number.isInteger(household.hdkVersion)) {
      return res.status(400).json({ error: 'A household-wrapped CalendarKey is required' });
    }

    // Compare-and-set the calendar's version so only one mint from `current` wins.
    const claimed = await CustomCalendar.findOneAndUpdate(
      { key: cal.key, userId: req.user._id, calKeyVersion: current },
      { $set: { calKeyVersion: keyVersion, calKeyRotationPending: false } },
    );
    if (!claimed) return res.status(409).json({ error: 'Key already rotated — please retry' });

    await ResourceKeyEnvelope.updateOne(
      { resourceType: 'calendar', resourceKey: cal.key, keyVersion, recipient: 'household' },
      {
        $set: { householdId: req.user.householdId, hdkVersion: household.hdkVersion, wrappedKey: household.wrappedKey, wrappedByUserId: req.user._id },
      },
      { upsert: true },
    );
    await writeMemberWraps(cal.key, keyVersion, members, req.user._id);
    res.status(201).json({ ok: true, keyVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner adds collaborator wraps at the current version (the async approve-on-
// device step — no rotation). Used when a new collaborator accepts and the
// owner's next unlocked session wraps the CalendarKey to them.
router.post('/:key/keys/members', async (req, res) => {
  try {
    const cal = await CustomCalendar.findOne({ key: req.params.key }).lean();
    if (!cal) return res.status(404).json({ error: 'Calendar not found' });
    if (String(cal.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Only the calendar owner manages its key' });
    }
    const { keyVersion, members } = req.body || {};
    if (keyVersion !== (cal.calKeyVersion || 0)) {
      return res.status(409).json({ error: 'Key version moved — please retry', currentKeyVersion: cal.calKeyVersion || 0 });
    }
    const n = await writeMemberWraps(cal.key, keyVersion, members, req.user._id);
    res.json({ ok: true, wrapped: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist a batch of collaborator wraps for one CalendarKey version. Only seats
// wraps for users who are actually collaborators on the calendar (defense in
// depth: the owner can't hand the key to an arbitrary account). Returns the count.
async function writeMemberWraps(calendarKey, keyVersion, members, wrappedByUserId) {
  if (!Array.isArray(members) || !members.length) return 0;
  const cal = await CustomCalendar.findOne({ key: calendarKey }, 'collaborators').lean();
  const collabIds = new Set((cal?.collaborators || []).map((c) => String(c.userId || c)));
  let n = 0;
  for (const m of members) {
    if (!m || !isWrappedKey(m.wrappedKey) || !collabIds.has(String(m.userId))) continue;
    await ResourceKeyEnvelope.updateOne(
      { resourceType: 'calendar', resourceKey: calendarKey, keyVersion, recipient: 'member', userId: m.userId },
      { $set: { wrappedKey: m.wrappedKey, wrappedByUserId } },
      { upsert: true },
    );
    n++;
  }
  return n;
}

// The owner's background wrap-on-approve work list: for every outside-shared
// calendar they own, the accepted collaborators still missing a member wrap at
// the current CalendarKey version (their `identityPublicKey` included so the
// client can seal to it), plus the calendars flagged for a revoke-rotation.
router.get('/keys/pending', async (req, res) => {
  try {
    const owned = await CustomCalendar.find({ userId: req.user._id }).lean();
    // Outside-shared calendars need a CalendarKey; a calendar flagged for a
    // revoke-rotation stays on the list even after its last outside party left
    // (so the owner still rotates it, locking out the removed party's key).
    const shared = owned.filter((c) => isCalendarOutsideShared(c) || c.calKeyRotationPending);
    const out = [];
    for (const cal of shared) {
      const collabIds = (cal.collaborators || []).map((c) => c.userId || c);
      const version = cal.calKeyVersion || 0;
      const wrapped = version
        ? new Set((await ResourceKeyEnvelope.find({
            resourceType: 'calendar', resourceKey: cal.key, keyVersion: version, recipient: 'member',
          }).distinct('userId')).map(String))
        : new Set();
      const missing = collabIds.filter((id) => !wrapped.has(String(id)));
      const needsMint = version === 0; // never provisioned — mint v1 first
      if (!needsMint && !missing.length && !cal.calKeyRotationPending) continue;
      // Every collaborator's public key (a rotation re-wraps to ALL of them); the
      // client picks who to seal to (all on mint/rotate, `missing` in steady state).
      const users = await User.find(
        { _id: { $in: collabIds }, identityPublicKey: { $exists: true, $ne: null } },
        '_id identityPublicKey',
      ).lean();
      const byId = new Map(users.map((u) => [String(u._id), u.identityPublicKey]));
      const missingSet = new Set(missing.map(String));
      out.push({
        calendarKey: cal.key,
        currentKeyVersion: version,
        needsMint,
        rotationPending: !!cal.calKeyRotationPending,
        collaborators: (cal.collaborators || [])
          .map((c) => ({ userId: c.userId || c, access: c.access || 'view', identityPublicKey: byId.get(String(c.userId || c)) || null }))
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

// ── Calendar CRUD ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const cals = await CustomCalendar.find(accessFilter(req)).sort('createdAt').lean();
    res.json(cals.map((c) => serialize(c, req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A subscription's source URL. Clients send webcal:// links as pasted; both
// sides normalize (defense in depth). Anything not http(s) after that is
// rejected — the URL is fetched by member devices, never by this server.
function normalizeFeedUrl(raw) {
  const url = String(raw).trim().replace(/^webcal:\/\//i, 'https://');
  return /^https?:\/\//i.test(url) ? url : null;
}

// Sanitize a holiday-calendar config to its known fields (client-computed;
// the server only stores + relays it). Returns undefined when there's no valid
// country.
function normalizeHoliday(raw) {
  if (!raw || typeof raw !== 'object' || !raw.country) return undefined;
  const strs = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []);
  return {
    country: String(raw.country),
    selectedRegions: strs(raw.selectedRegions),
    disabledIds: strs(raw.disabledIds),
  };
}

router.post('/', async (req, res) => {
  try {
    const { key, name, color, alertsEnabled, sharedWithHousehold, householdAccess, sharedWith, sharedWithOutside, feedUrl, holiday } = req.body;
    const outside = normalizeOutsideList(sharedWithOutside);
    let feed;
    if (feedUrl) {
      feed = normalizeFeedUrl(feedUrl);
      if (!feed) return res.status(400).json({ error: 'invalid_feed_url' });
    }
    const hol = normalizeHoliday(holiday);
    const cal = await CustomCalendar.create({
      userId: req.user._id,
      key,
      name,
      color,
      alertsEnabled: alertsEnabled !== false,
      sharedWithHousehold: !!sharedWithHousehold,
      householdAccess: householdAccess === 'view' ? 'view' : 'full',
      sharedWith: (sharedWith || []).map(normalizeMemberEntry),
      sharedWithOutside: outside,
      ...(feed ? { feedUrl: feed } : {}),
      ...(hol ? { holiday: hol } : {}),
    });
    await syncOutsideInvitations(cal, [], req);
    res.status(201).json(serialize(cal, req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Only the creator edits or deletes; housemates and collaborators read via GET.
router.put('/:key', async (req, res) => {
  try {
    const { name, color, alertsEnabled, sharedWithHousehold, householdAccess, sharedWith, sharedWithOutside, holiday } = req.body;
    const existing = await CustomCalendar.findOne({ key: req.params.key, userId: req.user._id }).lean();
    if (!existing) return res.status(404).json({ error: 'Calendar not found' });

    const prevOutside = (existing.sharedWithOutside || []).map(normalizeOutsideEntry);
    const nextOutside = sharedWithOutside !== undefined
      ? normalizeOutsideList(sharedWithOutside)
      : prevOutside;

    const updates = {};
    if (name !== undefined)                updates.name                = name;
    if (color !== undefined)               updates.color               = color;
    if (alertsEnabled !== undefined)       updates.alertsEnabled       = alertsEnabled;
    if (sharedWithHousehold !== undefined) updates.sharedWithHousehold = sharedWithHousehold;
    if (householdAccess !== undefined)     updates.householdAccess     = householdAccess === 'view' ? 'view' : 'full';
    if (sharedWith !== undefined)          updates.sharedWith          = (sharedWith || []).map(normalizeMemberEntry);
    if (sharedWithOutside !== undefined)   updates.sharedWithOutside   = nextOutside;
    // Holiday config is editable (regions/disabled change on HolidaysScreen),
    // but only on a calendar that already is one.
    if (holiday !== undefined && existing.holiday) {
      const hol = normalizeHoliday({ country: existing.holiday.country, ...holiday });
      if (hol) updates.holiday = hol;
    }

    const cal = await CustomCalendar.findOneAndUpdate(
      { key: req.params.key, userId: req.user._id },
      updates,
      { new: true },
    ).lean();
    if (!cal) return res.status(404).json({ error: 'Calendar not found' });

    await syncOutsideInvitations(cal, prevOutside, req);
    res.json(serialize(cal, req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:key', async (req, res) => {
  try {
    const cal = await CustomCalendar.findOneAndDelete({ key: req.params.key, userId: req.user._id });
    if (!cal) return res.status(404).json({ error: 'Calendar not found' });
    await CalendarInvitation.deleteMany({ calendarKey: cal.key }).catch(() => {});
    // Signal-parity D1: the CalendarKey envelopes die with the calendar.
    await ResourceKeyEnvelope.deleteMany({ resourceType: 'calendar', resourceKey: cal.key }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
