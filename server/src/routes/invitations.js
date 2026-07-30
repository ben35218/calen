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
    await pushToUser(sender, {
      title: `Invitation ${action}`,
      body: `${name} ${action} “${invitation.event.title}”`,
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
      return res.status(400).json({ error: 'That person is in your household and already sees this event' });
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
    const invitations = await EventInvitation.find({ eventId: event._id }).sort({ createdAt: -1 }).lean();
    res.json(invitations);
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

    const guests = await EventInvitation.find({ eventId: invitation.eventId })
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
    const invitations = await EventInvitation.find(addressedToMe(req.user)).sort({ createdAt: -1 }).lean();
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

    if (invitation.status === 'accepted' && invitation.acceptedEventId) {
      // C3b: tombstone the recipient's opaque copy (keyed by their userId).
      await Record.updateOne(
        { _id: invitation.acceptedEventId, userId: invitation.toUserId },
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
