const express = require('express');
const crypto = require('crypto');
// Signal-parity C3b: events live in the unified opaque store. Source-event checks
// are scope/existence lookups against `Record`; the accepted copy is created from
// the recipient's client-sealed ciphertext (the server can't build readable
// content). The plaintext .ics lane stays for non-account/SMS invites (D3).
const Record          = require('../models/Record');
const EventInvitation = require('../models/EventInvitation');
const User            = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { stampHousehold } = require('../services/e2eePolicy');
const { buildEventICS }       = require('../services/ics');
const { pushToUser }          = require('../services/notify');
const { normalizePhone }      = require('../services/phone');

// Cross-household event invitations (models/EventInvitation.js). The sender
// invites by EMAIL or by PHONE. Outreach is device-composed, matching the other
// sharing flows (households-sharing.md): the server records the invitation and
// sends NO email or text. An email that belongs to an account gets a push +
// the in-app Invitations inbox instead; a non-account email is composed from
// the organizer's own mail app (with the public .ics link below); a phone is
// texted from the organizer's device (prefilled Messages composer).

const router = express.Router();

// Public (unauthenticated) .ics download, gated by the invitation's shareToken
// capability secret — this is the link an SMS invite carries, so recipients
// without an account can import the event. Registered before requireAuth.
router.get('/public/:id/ics', async (req, res) => {
  try {
    const invitation = await EventInvitation.findById(req.params.id).lean();
    const key = String(req.query.k || '');
    const ok =
      invitation?.shareToken &&
      key.length === invitation.shareToken.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(invitation.shareToken));
    if (!ok) return res.status(404).json({ error: 'Invitation not found' });

    // A sealed invite (D3) has no plaintext snapshot to build an .ics from —
    // sealed invites are email-to-account, never SMS, so the public link is
    // only ever hit for a plaintext invitation.
    if (!invitation.event || !invitation.event.title) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="invite.ics"');
    res.send(buildEventICS({ uid: invitation._id, event: invitation.event }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth);

// An invitation addressed to this user — matched by resolved id or by email,
// so invites sent before the recipient registered still reach them.
function addressedToMe(user) {
  return { $or: [{ toUserId: user._id }, { toEmail: user.email }] };
}

// ── Merge reconciliation: the two parties have since joined one household ────
//
// An EventInvitation is the contract BETWEEN two households: the organizer keeps
// their event, the recipient owns an independent copy, and neither ever sees the
// other's record. When the two people later join the same household that premise
// dissolves — both now hold the same HDK and sync the same rows — and, left
// alone, every surface built on the old premise misbehaves:
//   - join carry-over moves the recipient's copy into the shared household, so
//     the same event appears TWICE on one calendar (and the copy stays read-only,
//     with a "Leave event" action, because `invitationId` is sealed inside it);
//   - `POST /:id/leave` would tombstone a record the whole household now shares
//     (the recipient "leaving" deletes the event out of the organizer's calendar);
//   - the recipient is absent from the event's sealed `householdInvitees`, so
//     they show on no invitee chip and their accept/decline is stranded here
//     instead of in an `EventRsvp` that the calendar actually reads.
//
// The fix is deterministic, not heuristic: this row already carries an exact
// correlation key (`eventId` = the organizer's original, `acceptedEventId` = the
// recipient's copy), so nothing has to be matched on title/time. The RECIPIENT's
// device drives it — the same actor that drives join carry-over, and the only one
// that can author their own `EventRsvp` (the responder identity is the C4 `author`
// folded inside the ciphertext). It lists its work at `GET /reconcile`, does the
// sealed half on-device (lib/invitationMerge), and retires each row through
// `POST /:id/merge`, which tombstones the duplicate copy. See
// specs/features/calendar.md § Invitees & sharing.

// Statuses that still describe a live cross-household relationship. 'merged' is
// terminal, so a reconciled row is never reconsidered — this is what makes the
// pass idempotent across the retries it is expected to take.
const UNMERGED = ['pending', 'accepted', 'declined', 'left'];

// True once the organizer and the recipient are in the SAME household — the state
// in which this invitation's actions (accept / leave / revoke) would mint or
// destroy a record the household jointly owns. Guards those lanes for the window
// between the join and the recipient's device running the reconcile pass.
//
// Deliberately compares the two PARTIES to each other rather than either of them
// to the caller's household: the caller is the organizer on one lane (revoke) and
// the recipient on the others, so a caller-relative check would compare one party
// to their own household and always match. An invitation with no resolved
// `toUserId` (a phone invite, or an email that has never registered) has no
// second party to share anything with.
async function partiesShareHousehold(invitation) {
  if (!invitation.toUserId) return false;
  const [from, to] = await Promise.all([
    User.findById(invitation.fromUserId).select('householdId').lean(),
    User.findById(invitation.toUserId).select('householdId').lean(),
  ]);
  const a = from?.householdId;
  const b = to?.householdId;
  return !!(a && b && String(a) === String(b));
}

const MERGED_CONFLICT =
  'You and the organizer now share a household, so this event is shared directly — ' +
  'change who is invited on the event itself.';

// Resolve an invited email (or phone) so the organizer's device can decide two
// things before reaching out: whether to seal the snapshot (D3 — a match with an
// enrolled identity key gets a sealed box; anyone else gets the plaintext lane),
// and whether to open a composer at all (an existing account gets push + the
// in-app inbox instead of device-composed outreach — see households-sharing.md).
// The public key is safe to hand out — it's the same fingerprint used for
// out-of-band safety-number checks, and `POST /` already reveals account
// existence (as do the other invite endpoints, for phone too). Not exposed for
// the caller's own household (they see the event directly — this is the
// cross-household invite surface). Phone lookups return existence only — sealed
// invites are email-to-account, so the key never applies.
router.get('/lookup', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const phone = normalizePhone(String(req.query.phone || ''));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !phone) {
      return res.status(400).json({ error: 'A valid email address or phone number is required' });
    }
    const u = email
      ? await User.findOne({ email }).select('_id identityPublicKey householdId').lean()
      : await User.findOne({ phone }).select('_id householdId').lean();
    const sameHousehold = u && req.user.householdId && String(u.householdId) === String(req.user.householdId);
    res.json({
      userExists: !!u,
      identityPublicKey: email && u && !sameHousehold ? (u.identityPublicKey || null) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push "Ben accepted/declined «Lake day»" to the sender's devices. Fire-and-
// forget: a reply must land even if the sender has no push subscriptions.
function notifySender(invitation, responder, action) {
  (async () => {
    const sender = await User.findById(invitation.fromUserId);
    if (!sender) return;
    const name = [responder.firstName, responder.lastName].filter(Boolean).join(' ') || responder.email;
    // Sealed (D3) invites have no plaintext snapshot — fall back to a generic body.
    const body = invitation.event?.title
      ? `${name} ${action} “${invitation.event.title}”`
      : `${name} ${action} your event invitation`;
    await pushToUser(sender, {
      title: `Invitation ${action}`,
      body,
      tag: `invitation-reply-${invitation._id}`,
    });
  })().catch(() => {});
}

// Snapshot fields the client supplies (decrypted on-device — post-drop the
// server can't read the event's own plaintext, mirroring shared trips).
function pickSnapshot(src) {
  if (!src) return null;
  const { title, description, location, url, phone, startDate, endDate, allDay, calendarType } = src;
  if (!title || !startDate) return null;
  return {
    title, description, location, url, phone,
    startDate: new Date(startDate),
    endDate:   endDate ? new Date(endDate) : undefined,
    allDay:    allDay !== false,
    calendarType: calendarType === 'appointments' ? 'appointments' : 'activities',
  };
}

// Send an invitation: { eventId, email | phone, event: {snapshot} }.
router.post('/', async (req, res) => {
  try {
    const { eventId, email, phone } = req.body;

    let toEmail = null;
    let toPhone = null;
    if (phone !== undefined) {
      toPhone = normalizePhone(phone);
      if (!toPhone) return res.status(400).json({ error: 'A valid phone number is required' });
    } else {
      toEmail = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
        return res.status(400).json({ error: 'A valid email address is required' });
      }
      if (toEmail === req.user.email) {
        return res.status(400).json({ error: "You can't invite yourself" });
      }
    }

    // Signal-parity C3b: the source event lives in the opaque store — verify it's
    // in the caller's scope (by id) without reading its content.
    const source = await Record.exists({ _id: eventId, ...req.scopeFilter });
    if (!source) return res.status(404).json({ error: 'Event not found' });

    // D3 sealed lane: the client sealed the snapshot to the recipient's identity
    // key (opaque here). Otherwise the plaintext lane — the client supplies the
    // decrypted snapshot (the server can no longer read the sealed source).
    const sealedEvent = typeof req.body.sealedEvent === 'string' ? req.body.sealedEvent : null;
    const snapshot = sealedEvent ? null : pickSnapshot(req.body.event);
    if (!snapshot && !sealedEvent) return res.status(400).json({ error: 'Event content is required' });
    // guestListVisible is a sealed event field now — the organizer's device sends
    // it so the guest-list gate below can read it off the invitation, not the event.
    const guestListVisible = req.body.guestListVisible !== false;

    // Accounts are keyed by email, so only email invites resolve a recipient.
    const recipient = toEmail
      ? await User.findOne({ email: toEmail }).select('_id householdId identityPublicKey').lean()
      : null;
    if (recipient && req.user.householdId && String(recipient.householdId) === String(req.user.householdId)) {
      return res.status(400).json({ error: 'That contact is in your household and already sees this event' });
    }
    // A sealed blob is only meaningful for an account with keys to open it.
    if (sealedEvent && !(recipient && recipient.identityPublicKey)) {
      return res.status(400).json({ error: 'That address has no encryption keys to seal to' });
    }

    // Re-inviting the same address/number for the same event refreshes the
    // pending invite (and resends) instead of stacking duplicates. Switching
    // lanes (e.g. the recipient just enrolled keys) clears the other lane.
    let invitation = await EventInvitation.findOne({
      eventId,
      ...(toEmail ? { toEmail } : { toPhone }),
      status: 'pending',
    });
    if (invitation) {
      if (sealedEvent) { invitation.sealedEvent = sealedEvent; invitation.event = undefined; }
      else { invitation.event = snapshot; invitation.sealedEvent = undefined; }
      invitation.guestListVisible = guestListVisible;
      await invitation.save();
    } else {
      invitation = await EventInvitation.create({
        fromUserId: req.user._id,
        fromName:   [req.user.firstName, req.user.lastName].filter(Boolean).join(' '),
        fromEmail:  req.user.email,
        toEmail:    toEmail || undefined,
        toPhone:    toPhone || undefined,
        toUserId:   recipient?._id,
        eventId,
        guestListVisible,
        ...(sealedEvent ? { sealedEvent } : { event: snapshot }),
      });
    }

    // Outreach is device-composed — the server sends no invite email or text
    // (the response carries the shareToken the client's email/SMS .ics link
    // needs). An existing account gets a push nudge instead — the one channel
    // the server sends, since it needs the recipient's device tokens. The
    // sealed lane keeps the plaintext title out of the push: the invite is
    // named in-app, where the recipient can decrypt it. Fire-and-forget,
    // best-effort (no token / permission denied just means inbox-only).
    if (recipient) {
      const senderName = invitation.fromName || req.user.email;
      (async () => {
        const account = await User.findById(recipient._id).select('pushSubscriptions');
        if (!account) return;
        await pushToUser(account, {
          title: 'Event invitation',
          body: snapshot?.title
            ? `${senderName} invited you to “${snapshot.title}”`
            : `${senderName} invited you to an event`,
          data: { type: 'event_invitation', invitationId: String(invitation._id) },
          tag: `event-invite-${invitation._id}`,
        });
      })().catch(() => {});
    }

    res.status(201).json({ invitation, userExists: !!recipient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The organizer's invitee list for one of their events. Gated on the event
// being in the caller's household scope, so a recipient (who only holds a
// copy) never sees who else was invited.
router.get('/sent', async (req, res) => {
  try {
    // C3b: existence/scope check against the opaque store.
    const event = await Record.findOne({ _id: req.query.eventId, ...req.scopeFilter }).select('_id').lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // 'merged' rows are inert history: that invitee is a housemate now and shows
    // as a household invitee chip on the event instead of an outside guest.
    const invitations = await EventInvitation
      .find({ eventId: event._id, status: { $ne: 'merged' } }).sort({ createdAt: -1 }).lean();
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /invitations/reconcile — invitations addressed to ME whose organizer is now
// a housemate, i.e. the ones the merge pass has to retire. Recipient-driven by
// design (see the note above `UNMERGED`), so this only ever lists rows where the
// caller is the `toUserId`; the organizer's own device does nothing.
//
// `sourceExists` tells the device which shape the merge takes: the organizer's
// event still being there means converge onto it (add me to its invitees, record
// my answer, drop my duplicate copy); it being gone means my copy is the only
// survivor, so it is unlinked into an ordinary household event instead.
router.get('/reconcile', async (req, res) => {
  try {
    if (!req.household) return res.json({ invitations: [] });
    const rows = await EventInvitation
      .find({ toUserId: req.user._id, status: { $in: UNMERGED } })
      .sort({ createdAt: 1 }).lean();
    if (!rows.length) return res.json({ invitations: [] });

    // One membership lookup per distinct organizer, not per invitation.
    const fromIds = [...new Set(rows.map((r) => String(r.fromUserId)))];
    const housemates = await User
      .find({ _id: { $in: fromIds }, householdId: req.household._id }, '_id').lean();
    const isHousemate = new Set(housemates.map((u) => String(u._id)));

    const mine = rows.filter((r) => isHousemate.has(String(r.fromUserId)));
    const sourceIds = mine.map((r) => r.eventId).filter(Boolean);
    const liveSources = sourceIds.length
      ? await Record.find({ _id: { $in: sourceIds }, deleted: { $ne: true } }, '_id').lean()
      : [];
    const live = new Set(liveSources.map((r) => String(r._id)));

    res.json({
      invitations: mine.map((r) => ({
        _id: String(r._id),
        eventId: r.eventId ? String(r.eventId) : null,
        acceptedEventId: r.acceptedEventId ? String(r.acceptedEventId) : null,
        status: r.status,
        respondedAt: r.respondedAt,
        organizerUserId: String(r.fromUserId),
        sourceExists: !!(r.eventId && live.has(String(r.eventId))),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /invitations/:id/merge — retire one reconciled invitation. The device has
// already done the sealed half (added itself to the source event's
// `householdInvitees`, written its `EventRsvp`, or unlinked an orphaned copy);
// this is the plaintext half the server can do: drop the now-duplicate copy and
// mark the row terminal.
//
// The copy is tombstoned rather than hard-deleted so the delete reaches the
// recipient's other devices through the /records sync cursor, and it is addressed
// by `_id` alone: authorization is holding an invitation addressed to you (this
// is your own accepted copy), and the row may still be sitting in the household
// you left if carry-over hasn't reached it yet. When the organizer's source event
// is gone there is no duplicate — the copy IS the event now — so nothing is
// tombstoned and the device keeps it.
router.post('/:id/merge', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({ _id: req.params.id, toUserId: req.user._id });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    // Idempotent: a retried pass (or a second device) finds it already retired.
    if (invitation.status === 'merged') return res.json({ ok: true, merged: false, tombstoned: false });
    if (!UNMERGED.includes(invitation.status)) return res.status(400).json({ error: 'Invitation cannot be merged' });
    if (!(await partiesShareHousehold(invitation))) {
      return res.status(409).json({ error: 'You do not share a household with the organizer' });
    }

    // Only an ACCEPTED invitation ever minted a copy, and it is only a duplicate
    // while the organizer's original still exists.
    const sourceLives = invitation.eventId
      ? !!(await Record.exists({ _id: invitation.eventId, deleted: { $ne: true } }))
      : false;
    let tombstoned = false;
    if (invitation.status === 'accepted' && invitation.acceptedEventId && sourceLives) {
      await Record.updateOne({ _id: invitation.acceptedEventId }, { deleted: true }, { timestamps: true });
      tombstoned = true;
    }

    invitation.status = 'merged';
    invitation.mergedAt = new Date();
    await invitation.save();

    res.json({ ok: true, merged: true, tombstoned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The guest list as seen by a RECIPIENT of one invitation: who else the organizer
// invited, gated on guestListVisible. Signal-parity C3b: that flag is now a SEALED
// event field, so the organizer's device stamps it onto the invitation at invite
// time and the gate reads it there (the server can't read the sealed source
// event). Missing flag means visible — invitations predate the setting.
router.get('/:id/guests', async (req, res) => {
  try {
    const invitation = await EventInvitation
      .findOne({ _id: req.params.id, ...addressedToMe(req.user) }).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });

    if (invitation.guestListVisible === false) {
      return res.json({ visible: false, guests: [] });
    }

    const guests = await EventInvitation.find({ eventId: invitation.eventId, status: { $ne: 'merged' } })
      .select('toEmail toPhone status').sort({ createdAt: 1 }).lean();
    res.json({
      visible: true,
      organizer: { name: invitation.fromName, email: invitation.fromEmail },
      guests,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Invitations addressed to me, newest first. The client splits them into the
// New (pending) and Replied (accepted/declined) tabs.
router.get('/', async (req, res) => {
  try {
    // Claim email-only invites for accounts created after the invite was sent.
    await EventInvitation.updateMany(
      { toEmail: req.user.email, toUserId: null },
      { $set: { toUserId: req.user._id } },
    );
    // A merged invitation is not an invitation any more — the event is shared by
    // sync and the answer lives on an EventRsvp, so the inbox must not offer it.
    const invitations = await EventInvitation
      .find({ ...addressedToMe(req.user), status: { $ne: 'merged' } }).sort({ createdAt: -1 }).lean();
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upgrade a plaintext invitation to a sealed one (D3 lazily-claimed upgrade).
// When a user registers after being invited and their inbox claims the invite,
// their unlocked device seals the still-plaintext snapshot to its OWN identity
// key and posts it here; the server stores the blob and drops the plaintext, so
// the snapshot no longer sits in the clear at rest. No-op if already sealed.
router.post('/:id/seal', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({ _id: req.params.id, ...addressedToMe(req.user) });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    const sealedEvent = typeof req.body?.sealedEvent === 'string' ? req.body.sealedEvent : null;
    if (!sealedEvent) return res.status(400).json({ error: 'A sealed snapshot is required' });
    if (!invitation.sealedEvent) {
      invitation.sealedEvent = sealedEvent;
      invitation.event = undefined;
      invitation.toUserId = req.user._id;
      await invitation.save();
    }
    res.json({ invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept: the recipient owns an INDEPENDENT copy of the event (edits don't sync
// with the sender's original). Signal-parity C3b: the server can't build readable
// content, so the recipient's device seals its own copy — folding `invitationId`
// inside the ciphertext (which flips the client's Delete action to "Leave") — and
// passes the opaque `enc` + its client-minted `_id`. The server stores it as a
// Record it can't read, in the recipient's household scope, and links it to the
// invitation. (The decrypted snapshot the client seals came from `invitation.event`
// or, for a D3 sealed invite, the recipient's own decrypt.)
router.post('/:id/accept', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({ _id: req.params.id, ...addressedToMe(req.user) });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.status !== 'pending') return res.status(400).json({ error: 'Already replied' });
    // The organizer is a housemate now, so this event already syncs to us —
    // accepting would mint a second copy of a record we can see. The merge pass
    // turns this row into a household invite (householdInvitees + EventRsvp)
    // instead; until it runs, refuse rather than duplicate.
    if (await partiesShareHousehold(invitation)) {
      return res.status(409).json({
        error: 'You share a household with the organizer now — this event is already on your calendar.',
      });
    }

    let enc;
    try { enc = pickRecordEnc(req.body); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!enc.enc || !isObjectId(req.body._id)) {
      return res.status(400).json({ error: 'A sealed event copy (_id + enc) is required' });
    }
    const data = { _id: req.body._id, userId: req.user._id, ...enc };
    stampHousehold(req.household, data); // recipient's household attribution (C4)
    const event = await Record.create(data);

    invitation.status = 'accepted';
    invitation.respondedAt = new Date();
    invitation.toUserId = req.user._id;
    invitation.acceptedEventId = event._id;
    await invitation.save();

    notifySender(invitation, req.user, 'accepted');
    res.json({ invitation, event: { _id: event._id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/decline', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({ _id: req.params.id, ...addressedToMe(req.user) });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.status !== 'pending') return res.status(400).json({ error: 'Already replied' });

    invitation.status = 'declined';
    invitation.respondedAt = new Date();
    invitation.toUserId = req.user._id;
    await invitation.save();

    notifySender(invitation, req.user, 'declined');
    res.json({ invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave an event the recipient previously accepted: deletes their copy and
// retires the invitation to 'left' (still visible in the organizer's list).
router.post('/:id/leave', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({ _id: req.params.id, ...addressedToMe(req.user) });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.status !== 'accepted') return res.status(400).json({ error: 'Not attending this event' });
    // Once the organizer is a housemate, "leave" would tombstone a record the
    // whole household shares — deleting the event out of everyone's calendar.
    // Refuse for the window between the join and the recipient's device running
    // the merge pass, which retires this row (and drops the duplicate) properly.
    if (await partiesShareHousehold(invitation)) {
      return res.status(409).json({ error: MERGED_CONFLICT });
    }

    if (invitation.acceptedEventId) {
      // C3b: tombstone the recipient's opaque copy so the delete propagates to
      // their other devices via the /records sync cursor.
      await Record.updateOne({ _id: invitation.acceptedEventId, ...req.scopeFilter }, { deleted: true }, { timestamps: true });
    }
    invitation.status = 'left';
    invitation.respondedAt = new Date();
    await invitation.save();

    res.json({ invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The organizer removes an invitee (or cancels a pending invite): deletes the
// invitation and, if it was accepted, the recipient's copy of the event.
router.delete('/:id', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({ _id: req.params.id, fromUserId: { $in: req.scopeIds } });
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    // Symmetric with /leave: the recipient is a housemate now, so their "copy" is
    // a record this household shares. Uninviting them must not delete it — they
    // come off the event's sealed householdInvitees instead.
    if (await partiesShareHousehold(invitation)) {
      return res.status(409).json({ error: MERGED_CONFLICT });
    }

    if (invitation.status === 'accepted' && invitation.acceptedEventId) {
      // C3b: tombstone the recipient's opaque copy. Addressed by `_id` alone —
      // the invitation is the authorization, and the plaintext `userId` this
      // once matched on is dropped the moment the copy is carried into an
      // e2eeActive household (routes/household.js carry-over), which silently
      // turned every revoke after a join into a no-op that stranded the copy.
      await Record.updateOne(
        { _id: invitation.acceptedEventId },
        { deleted: true },
        { timestamps: true },
      );
    }
    await invitation.deleteOne();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The invitation's .ics, for re-download / manual import (auth also accepts a
// ?token= query param, so this works as a plain download link).
router.get('/:id/ics', async (req, res) => {
  try {
    const invitation = await EventInvitation.findOne({
      _id: req.params.id,
      $or: [{ toUserId: req.user._id }, { toEmail: req.user.email }, { fromUserId: req.user._id }],
    }).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    // A sealed invite carries no plaintext to render — the recipient's app
    // builds the .ics client-side from the decrypted snapshot.
    if (!invitation.event || !invitation.event.title) {
      return res.status(404).json({ error: 'No calendar file for a sealed invitation' });
    }

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="invite.ics"');
    res.send(buildEventICS({ uid: invitation._id, event: invitation.event }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
