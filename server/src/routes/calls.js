const express = require('express');
const mongoose = require('mongoose');
const PhoneCall = require('../models/PhoneCall');
// Signal-parity C3b: events live in the unified opaque store; these are pure
// existence/scope checks (by id), so they query `Record`, never event content.
const Record = require('../models/Record');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meterCallSeconds } = require('../middleware/usageMeter');
const { refreshPendingCalls, placeCall, fetchVapiCall, applyVapiToRow, markEventCancelledIfConfirmed } = require('../services/phoneCalls');
const { suppress, isSuppressed } = require('../services/dnc');

const router = express.Router();

// POST /api/calls/vapi/webhook — Vapi posts here when the in-call agent invokes
// the record_do_not_call tool (spec: ai-assistant.md do-not-call). It carries no
// user session, so it is UNAUTHENTICATED and mounted ABOVE `requireAuth`;
// instead it's authenticated by the shared VAPI_WEBHOOK_SECRET echoed back in
// the X-Vapi-Secret header — the same before-auth + shared-secret pattern the
// RevenueCat billing webhook uses. The number suppressed is the one Vapi
// actually dialed (`call.customer.number`), taken server-side — never a
// model-supplied number.
router.post('/vapi/webhook', async (req, res) => {
  try {
    const expected = process.env.VAPI_WEBHOOK_SECRET;
    if (expected && req.get('X-Vapi-Secret') !== expected) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    const msg = req.body?.message || {};
    const toolCalls = msg.toolCallList || msg.toolCalls || [];
    const isOptOut = (t) => (t.function?.name || t.name) === 'record_do_not_call';
    const dialed = msg.call?.customer?.number || msg.customer?.number;
    if (dialed && toolCalls.some(isOptOut)) {
      await suppress(dialed, { source: 'callee-request', note: 'Requested during the call.' });
      // Flag the originating call row so its outcome view tells the user this
      // number was added to the do-not-call list (the post-call analysis backstop
      // sets the same flag, so this is just the immediate path). Keyed by the Vapi
      // call id when present; harmless no-op otherwise.
      const callId = msg.call?.id;
      if (callId) await PhoneCall.updateOne({ callId }, { $set: { dncCaptured: true } });
    }
    // Vapi expects a results array keyed by each toolCallId.
    const results = toolCalls
      .filter(isOptOut)
      .map((t) => ({ toolCallId: t.id, result: "Recorded — this number won't be called again." }));
    res.json({ results });
  } catch (err) {
    console.error('Vapi webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth);

// Assistant-placed phone calls. The mobile app polls the list for the
// Calen-icon badge (unseen) and the Invitations "New" tab notice
// (unacknowledged outcome); reading the list refreshes any still-pending calls
// from Vapi, so there's no webhook. Calls are placed either by the chat's
// call_business tool or by the event view's "Call to Cancel" card below.

const serialize = (c) => ({
  _id: c._id,
  callId: c.callId,
  eventId: c.eventId,
  eventTitle: c.eventTitle,
  eventDate: c.eventDate,
  occurrenceDate: c.occurrenceDate ?? null,
  action: c.action,
  phone: c.phone ?? null,
  status: c.status,
  endedReason: c.endedReason ?? null,
  summary: c.summary ?? null,
  outcome: c.outcome ?? null,
  // The recipient asked, on this call, not to be called again — the outcome view
  // shows an explicit notice so the user knows why no future call will go out.
  dncCaptured: Boolean(c.dncCaptured),
  durationSeconds: c.durationSeconds ?? null,
  seen: Boolean(c.seenAt),
  acknowledged: Boolean(c.acknowledgedAt),
  createdAt: c.createdAt,
});

// GET /api/calls → recent calls, newest first.
router.get('/', async (req, res) => {
  try {
    await refreshPendingCalls(req.scopeIds);
    const calls = await PhoneCall.find({ userId: { $in: req.scopeIds } })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    res.json(calls.map(serialize));
  } catch (err) {
    console.error('Calls list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/suppressed?phone=<number> → is this business number on the
// do-not-call list? Lets the event's call screen disable the "Call to…" button
// with a reason instead of failing the placement on tap (spec: ai-assistant.md
// do-not-call). Returns only a boolean — attempting the call already reveals the
// same bit (403 DNC_SUPPRESSED). Must be declared BEFORE `/:id` so the literal
// path isn't captured as a call id.
router.get('/suppressed', async (req, res) => {
  try {
    res.json({ suppressed: await isSuppressed(req.query.phone) });
  } catch (err) {
    console.error('Calls suppressed-check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:id → one call: the stored record refreshed live from Vapi.
// No transcript or recording — those artifacts are disabled at Vapi entirely
// (placeCall's artifactPlan); the outcome summary is the record of the call.
// Non-fatal if Vapi is unreachable: the stored fields still render.
router.get('/:id', async (req, res) => {
  try {
    const row = await PhoneCall.findOne({ _id: req.params.id, userId: { $in: req.scopeIds } });
    if (!row) return res.status(404).json({ error: 'Call not found' });
    try {
      await applyVapiToRow(row, await fetchVapiCall(row.callId));
    } catch (e) {
      console.error(`Call detail Vapi fetch failed for ${row.callId}:`, e.message);
    }
    res.json(serialize(row));
  } catch (err) {
    console.error('Call detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/cancel-event → the event view's "Call to Cancel" card.
// The client sends the (decrypted) event snapshot — under E2EE the server
// can't read the stored row, but it CAN verify the id belongs to this
// household before dialing. Calen gets the event details plus the user's
// name/phone/email for identity verification on the call.
router.post('/cancel-event', requireAiEnabled, meterCallSeconds(), async (req, res) => {
  try {
    const ev = req.body?.event;
    if (!ev || !mongoose.isValidObjectId(ev._id) || !ev.title || !ev.startDate) {
      return res.status(400).json({ error: 'event with _id, title and startDate is required' });
    }
    if (!ev.phone) {
      return res.status(400).json({ error: 'This event has no business phone number. Add one first.' });
    }
    const owned = await Record.exists({ _id: ev._id, ...req.scopeFilter });
    if (!owned) return res.status(404).json({ error: 'Event not found' });

    // One active cancellation per event — placing a second call while the
    // first is still running would double-dial the business.
    const active = await PhoneCall.findOne({
      userId: { $in: req.scopeIds },
      eventId: String(ev._id),
      action: 'cancel',
      status: { $nin: ['ended', 'failed'] },
    }).lean();
    if (active) return res.status(409).json({ error: 'A cancellation call for this event is already in progress.', call: serialize(active) });

    // Contact details are per-call opt-in (spec) and this legacy route predates
    // the toggle — the caller gives only the user's name.
    const callerName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
    const row = await placeCall({
      userId: req.user._id,
      householdId: req.household?._id,
      event: { _id: ev._id, title: ev.title, startDate: ev.startDate, phone: ev.phone },
      action: 'cancel',
      callerName,
    });
    res.status(201).json(serialize(row));
  } catch (err) {
    if (err.code === 'DNC_SUPPRESSED') return res.status(403).json({ error: err.message });
    console.error('Cancel-event call error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/event-action → the event view's Event Action screen: Calen
// phones the business to cancel OR reschedule the appointment. Like
// /cancel-event (which it supersedes; that route stays for older clients), the
// client sends the decrypted event snapshot. The body also carries the user's
// answers from the screen: `feeAccepted` (proceed even if the business charges
// a cancellation/reschedule fee) and, for a reschedule, `windows` — the
// date/time windows to propose, pre-formatted labels in preference order.
router.post('/event-action', requireAiEnabled, meterCallSeconds(), async (req, res) => {
  try {
    const { event: ev, action, feeAccepted, windows, shareContact, occurrenceDate } = req.body || {};
    if (!ev || !mongoose.isValidObjectId(ev._id) || !ev.title || !ev.startDate) {
      return res.status(400).json({ error: 'event with _id, title and startDate is required' });
    }
    if (!['cancel', 'reschedule'].includes(action)) {
      return res.status(400).json({ error: 'action must be cancel or reschedule' });
    }
    if (!ev.phone) {
      return res.status(400).json({ error: 'This event has no business phone number. Add one first.' });
    }
    const windowLabels = (Array.isArray(windows) ? windows : [])
      .filter((w) => typeof w === 'string' && w.trim())
      .map((w) => w.trim().slice(0, 120))
      .slice(0, 5);
    if (action === 'reschedule' && !windowLabels.length) {
      return res.status(400).json({ error: 'At least one proposed time window is required to reschedule.' });
    }
    const owned = await Record.exists({ _id: ev._id, ...req.scopeFilter });
    if (!owned) return res.status(404).json({ error: 'Event not found' });

    // One active call per event, whatever its action — a second concurrent
    // call would double-dial the business.
    const active = await PhoneCall.findOne({
      userId: { $in: req.scopeIds },
      eventId: String(ev._id),
      status: { $nin: ['ended', 'failed'] },
    }).lean();
    if (active) return res.status(409).json({ error: 'A call for this event is already in progress.', call: serialize(active) });

    // The fee answer becomes a hard instruction on the call: pre-approved fees
    // are accepted; otherwise a fee stops the call so the user can decide.
    const feeKind = action === 'cancel' ? 'cancellation' : 'reschedule';
    const feeClause = feeAccepted
      ? `If the business mentions a ${feeKind} fee, the client has already agreed to pay it — accept the fee and proceed.`
      : `If the business says there is a ${feeKind} fee of any amount, do NOT proceed. Ask what the fee is, say you will check with the client and call back, then end the call politely leaving the appointment unchanged.`;

    const newDateTime =
      action === 'reschedule'
        ? windowLabels.length === 1
          ? windowLabels[0]
          : `one of the following windows, in order of preference: ${windowLabels.join('; ')}`
        : undefined;

    // Contact details are per-call opt-in (spec): phone/email ride along only
    // when the user enabled "Share my contact details if asked" on the screen.
    const callerName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
    const row = await placeCall({
      userId: req.user._id,
      householdId: req.household?._id,
      event: { _id: ev._id, title: ev.title, startDate: ev.startDate, phone: ev.phone },
      action,
      callerName,
      newDateTime,
      // Scope the call to a specific occurrence of a recurring event (a local
      // Y-M-D), so its confirmed outcome dims only that instance. Ignored for
      // non-recurring events (client sends none).
      occurrenceDate: typeof occurrenceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) ? occurrenceDate : undefined,
      additionalInstructions: feeClause,
      contact: shareContact === true
        ? {
            name: callerName,
            phone: req.user.phone || undefined,
            email: req.user.email || undefined,
          }
        : undefined,
    });
    res.status(201).json(serialize(row));
  } catch (err) {
    if (err.code === 'DNC_SUPPRESSED') return res.status(403).json({ error: err.message });
    console.error('Event-action call error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/calls/:id/link { eventId } — G1 alias link-back. The chat flow
// aliases record ids before they reach the model, so a call placed via
// call_business stores an alias in `eventId`. The assistant screen (which
// holds the alias map) calls this with the REAL id so the confirmed-cancel →
// event-cancelled flow keeps working. Only fills rows without a real id, and
// only with an event inside the caller's scope.
router.patch('/:id/link', async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ error: 'A valid eventId is required' });
    const row = await PhoneCall.findOne({ _id: req.params.id, userId: { $in: req.scopeIds } });
    if (!row) return res.status(404).json({ error: 'Call not found' });
    if (mongoose.isValidObjectId(row.eventId)) return res.json({ ok: true }); // already linked
    const event = await Record.findOne({ _id: eventId, ...req.scopeFilter }).select('_id').lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    row.eventId = String(eventId);
    await row.save();
    // If the outcome already landed while the row held an alias, apply it now.
    await markEventCancelledIfConfirmed(row);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/seen → mark every finished call seen (clears the Calen badge).
router.post('/seen', async (req, res) => {
  try {
    await PhoneCall.updateMany(
      { userId: { $in: req.scopeIds }, status: { $in: ['ended', 'failed'] }, seenAt: null },
      { $set: { seenAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Calls seen error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/:id/ack → dismiss the outcome notice in Invitations "New"
// (also counts as seen — a dismissed result shouldn't still badge the Calen icon).
router.post('/:id/ack', async (req, res) => {
  try {
    const row = await PhoneCall.findOne({ _id: req.params.id, userId: { $in: req.scopeIds } });
    if (!row) return res.status(404).json({ error: 'Call not found' });
    const now = new Date();
    row.acknowledgedAt = now;
    if (!row.seenAt) row.seenAt = now;
    await row.save();
    res.json(serialize(row));
  } catch (err) {
    console.error('Call ack error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
