// Admin web-app surfaces beyond monetization: user management, an E2EE-ops
// readiness dashboard, and an audit-log viewer. All routes are gated by
// requireAuth + requireAdmin. These are observability/support tools — they never
// expose household content (which is E2EE and unreadable server-side anyway),
// only metadata: roles, membership, key-enrollment state, and audit events.
//
//   GET  /api/admin/users                 → paginated user search
//   POST /api/admin/users/:id/role        → grant/revoke admin (audited)
//   GET  /api/admin/e2ee                  → per-household drop-readiness summary
//   GET  /api/admin/e2ee/:householdId     → per-member enrollment + client versions
//   POST /api/admin/e2ee/:householdId/nudge → push blocking members to update/enroll
//   GET  /api/admin/audit                 → paginated audit-log entries
//   GET  /api/admin/moderation            → paginated AI-content reports (Apple 1.2)
//   POST /api/admin/moderation/:id/status → mark a report reviewed/dismissed/open
//   GET  /api/admin/dnc                   → outbound-call do-not-call list
//   POST /api/admin/dnc                   → add a number (support request), audited
//   DELETE /api/admin/dnc/:id             → release a number, audited
//
// Pure request-independent logic lives in ./adminHelpers (unit-tested).

const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Household = require('../models/Household');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const AuditLog = require('../models/AuditLog');
const ContentReport = require('../models/ContentReport');
const Feedback = require('../models/Feedback');
const DncEntry = require('../models/DncEntry');
const { computeReadiness, versionSatisfied } = require('../services/dropReadiness');
const { pushToUser } = require('../services/notify');
const { suppress, release } = require('../services/dnc');
const { normalizePhone } = require('../services/phone');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  buildUserFilter, paginate, summarizeReadiness, validateRoleChange, blockingMembers,
} = require('./adminHelpers');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const MIN_APP_VERSION = () => process.env.E2EE_MIN_APP_VERSION || null;

// --- Users -----------------------------------------------------------------

// Search users by email or name (case-insensitive), paginated. Empty query →
// most recent first.
router.get('/users', async (req, res) => {
  try {
    const filter = buildUserFilter(req.query.q);
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('email firstName lastName role householdId clientVersion clientPlatform createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    // Attach household names in one round-trip.
    const hhIds = [...new Set(users.map((u) => u.householdId).filter(Boolean).map(String))];
    const households = hhIds.length
      ? await Household.find({ _id: { $in: hhIds } }).select('name').lean()
      : [];
    const nameById = Object.fromEntries(households.map((h) => [String(h._id), h.name]));

    res.json({
      items: users.map((u) => ({
        ...u,
        householdName: u.householdId ? nameById[String(u.householdId)] || null : null,
      })),
      total, page, pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grant or revoke admin. Guards against self-demotion; audited.
router.post('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body || {};
    const check = validateRoleChange({ targetId: req.params.id, actorId: req.user._id, role });
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    const before = await User.findById(req.params.id).select('email role householdId').lean();
    if (!before) return res.status(404).json({ error: 'User not found' });
    if (before.role === role) {
      return res.json({ _id: before._id, email: before.email, role: before.role });
    }

    await User.updateOne({ _id: req.params.id }, { $set: { role } });
    await AuditLog.create({
      userId: req.user._id,
      householdId: before.householdId || undefined,
      event: 'admin_role_changed',
      meta: { target: before.email, from: before.role, to: role },
    });
    res.json({ _id: before._id, email: before.email, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- E2EE ops --------------------------------------------------------------

// Per-household drop-readiness summary across the whole fleet.
router.get('/e2ee', async (_req, res) => {
  try {
    const households = await Household.find({})
      .select('name e2eeActive currentKeyVersion ownerId')
      .lean();
    const ids = households.map((h) => h._id);
    const [members, envelopes] = await Promise.all([
      User.find({ householdId: { $in: ids } }).select('householdId identityPublicKey clientVersion').lean(),
      HouseholdKeyEnvelope.find({ householdId: { $in: ids } }).select('householdId userId keyVersion').lean(),
    ]);

    const membersByHh = groupBy(members, 'householdId');
    const envelopesByHh = groupBy(envelopes, 'householdId');
    const minAppVersion = MIN_APP_VERSION();

    res.json(households.map((h) => {
      const s = summarizeReadiness({
        members: membersByHh[String(h._id)] || [],
        envelopes: envelopesByHh[String(h._id)] || [],
        currentKeyVersion: h.currentKeyVersion,
        minAppVersion,
      });
      return {
        _id: h._id,
        name: h.name,
        e2eeActive: !!h.e2eeActive,
        currentKeyVersion: h.currentKeyVersion,
        memberCount: (membersByHh[String(h._id)] || []).length,
        ready: s.ready,
        enrolled: s.enrolled,
        total: s.total,
        blockers: s.blockers,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-member enrollment + client-version detail for one household.
router.get('/e2ee/:householdId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.householdId)) {
      return res.status(400).json({ error: 'Invalid household id' });
    }
    const household = await Household.findById(req.params.householdId)
      .select('name e2eeActive currentKeyVersion ownerId').lean();
    if (!household) return res.status(404).json({ error: 'Household not found' });

    const [members, envelopes] = await Promise.all([
      User.find({ householdId: household._id })
        .select('email firstName lastName identityPublicKey clientVersion clientPlatform clientVersionAt').lean(),
      HouseholdKeyEnvelope.find({ householdId: household._id }).select('userId keyVersion').lean(),
    ]);
    const envByUser = Object.fromEntries(envelopes.map((e) => [String(e.userId), e.keyVersion]));

    const readiness = computeReadiness({
      members, envelopes, currentKeyVersion: household.currentKeyVersion, minAppVersion: MIN_APP_VERSION(),
    });

    res.json({
      ...household,
      ready: readiness.ready,
      reasons: readiness.reasons,
      members: members.map((m) => ({
        _id: m._id,
        email: m.email,
        name: [m.firstName, m.lastName].filter(Boolean).join(' '),
        isOwner: String(m._id) === String(household.ownerId),
        enrolled: !!m.identityPublicKey,
        keyVersion: envByUser[String(m._id)] ?? null,
        keyCurrent: (envByUser[String(m._id)] ?? -1) === household.currentKeyVersion && household.currentKeyVersion > 0,
        clientVersion: m.clientVersion || null,
        clientPlatform: m.clientPlatform || null,
        clientVersionAt: m.clientVersionAt || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push a reminder to every member currently blocking this household's drop
// (not enrolled, no current envelope, or on an incompatible build). Best-effort:
// members without a push subscription are simply skipped.
router.post('/e2ee/:householdId/nudge', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.householdId)) {
      return res.status(400).json({ error: 'Invalid household id' });
    }
    const household = await Household.findById(req.params.householdId)
      .select('name currentKeyVersion').lean();
    if (!household) return res.status(404).json({ error: 'Household not found' });

    const [members, envelopes] = await Promise.all([
      User.find({ householdId: household._id })
        .select('email identityPublicKey clientVersion pushSubscriptions').lean(),
      HouseholdKeyEnvelope.find({ householdId: household._id }).select('userId keyVersion').lean(),
    ]);
    const envByUser = Object.fromEntries(envelopes.map((e) => [String(e.userId), e.keyVersion]));
    const minAppVersion = MIN_APP_VERSION();

    const blocking = blockingMembers({
      members,
      envByUser,
      currentKeyVersion: household.currentKeyVersion,
      versionOk: (m) => versionSatisfied(m.clientVersion, minAppVersion),
    });

    const payload = {
      title: 'Action needed to secure your household',
      body: 'Open Calen and finish setup so your family can turn on encrypted sync.',
      data: { type: 'e2ee_nudge' },
    };
    // pushToUser resolves { sent, failed } even for a user with no devices, so
    // count members who actually had ≥1 device reached (not just fulfilled
    // promises) — that's what "notified" should mean.
    const results = await Promise.allSettled(blocking.map((m) => pushToUser(m, payload)));
    const notified = results.filter((r) => r.status === 'fulfilled' && (r.value?.sent || 0) > 0).length;
    const devices = results.reduce((n, r) => n + (r.status === 'fulfilled' ? (r.value?.sent || 0) : 0), 0);

    res.json({ blocking: blocking.length, notified, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Audit log -------------------------------------------------------------

router.get('/audit', async (req, res) => {
  try {
    const { householdId, event } = req.query;
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
    const filter = {};
    if (householdId && mongoose.isValidObjectId(householdId)) filter.householdId = householdId;
    if (event) filter.event = event;

    const [total, logs] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter).sort({ at: -1 }).skip(skip).limit(pageSize).lean(),
    ]);

    // Resolve user emails + household names for display.
    const userIds = [...new Set(logs.map((l) => l.userId).filter(Boolean).map(String))];
    const hhIds = [...new Set(logs.map((l) => l.householdId).filter(Boolean).map(String))];
    const [users, households] = await Promise.all([
      userIds.length ? User.find({ _id: { $in: userIds } }).select('email').lean() : [],
      hhIds.length ? Household.find({ _id: { $in: hhIds } }).select('name').lean() : [],
    ]);
    const emailById = Object.fromEntries(users.map((u) => [String(u._id), u.email]));
    const hhNameById = Object.fromEntries(households.map((h) => [String(h._id), h.name]));

    res.json({
      items: logs.map((l) => ({
        _id: l._id,
        event: l.event,
        at: l.at,
        meta: l.meta || {},
        userEmail: l.userId ? emailById[String(l.userId)] || null : null,
        householdName: l.householdId ? hhNameById[String(l.householdId)] || null : null,
        householdId: l.householdId || null,
      })),
      total, page, pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function groupBy(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = String(r[key]);
    (out[k] ||= []).push(r);
  }
  return out;
}

// --- Content moderation (Apple 1.2) ----------------------------------------

// Paginated AI-content reports, newest first, filterable by status. Unlike the
// rest of admin (which is content-blind), a report deliberately carries the
// flagged assistant message so it can actually be reviewed — the user chose to
// send it to us. Resolves the reporter's email for follow-up.
router.get('/moderation', async (req, res) => {
  try {
    const { status } = req.query;
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
    const filter = {};
    if (status && ['open', 'reviewed', 'dismissed'].includes(status)) filter.status = status;

    const [total, openCount, reports] = await Promise.all([
      ContentReport.countDocuments(filter),
      ContentReport.countDocuments({ status: 'open' }),
      ContentReport.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);

    const userIds = [...new Set(reports.map((r) => r.userId).filter(Boolean).map(String))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('email').lean()
      : [];
    const emailById = Object.fromEntries(users.map((u) => [String(u._id), u.email]));

    res.json({
      items: reports.map((r) => ({
        _id: r._id,
        surface: r.surface,
        content: r.content,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        reporterEmail: r.userId ? emailById[String(r.userId)] || null : null,
      })),
      total, openCount, page, pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Triage a report: open → reviewed/dismissed (or back to open). Audited.
router.post('/moderation/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['open', 'reviewed', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, reviewed, or dismissed' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const before = await ContentReport.findById(req.params.id).select('status').lean();
    if (!before) return res.status(404).json({ error: 'Not found' });
    const report = await ContentReport.findByIdAndUpdate(
      req.params.id, { $set: { status } }, { new: true },
    ).lean();
    if (before.status !== status) {
      await AuditLog.create({
        userId: req.user._id,
        event: 'moderation_status_changed',
        meta: { reportId: report._id, from: before.status, to: status },
      });
    }
    res.json({ _id: report._id, status: report.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- In-app feedback (questions / bugs / ideas) ----------------------------

// Paginated user-submitted feedback, newest first, filterable by status. Like
// moderation, a report deliberately carries the user's message + captured
// diagnostics so it can actually be acted on (spec: features/feedback.md).
// Resolves the reporter's email for follow-up.
router.get('/feedback', async (req, res) => {
  try {
    const { status } = req.query;
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
    const filter = {};
    if (status && ['new', 'triaged', 'resolved'].includes(status)) filter.status = status;

    const [total, newCount, rows] = await Promise.all([
      Feedback.countDocuments(filter),
      Feedback.countDocuments({ status: 'new' }),
      Feedback.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);

    const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean).map(String))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('email').lean()
      : [];
    const emailById = Object.fromEntries(users.map((u) => [String(u._id), u.email]));

    res.json({
      items: rows.map((r) => ({
        _id: r._id,
        type: r.type,
        message: r.message,
        contactEmail: r.contactEmail || null,
        diagnostics: r.diagnostics || {},
        status: r.status,
        createdAt: r.createdAt,
        reporterEmail: r.userId ? emailById[String(r.userId)] || null : null,
      })),
      total, newCount, page, pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Triage a feedback item: new → triaged/resolved (or back). Audited.
router.post('/feedback/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new', 'triaged', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'status must be new, triaged, or resolved' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const before = await Feedback.findById(req.params.id).select('status').lean();
    if (!before) return res.status(404).json({ error: 'Not found' });
    const fb = await Feedback.findByIdAndUpdate(
      req.params.id, { $set: { status } }, { new: true },
    ).lean();
    if (before.status !== status) {
      await AuditLog.create({
        userId: req.user._id,
        event: 'feedback_status_changed',
        meta: { feedbackId: fb._id, from: before.status, to: status },
      });
    }
    res.json({ _id: fb._id, status: fb.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Do-not-call suppression (outbound AI calls) ---------------------------

// The do-not-call list for outbound Calen calls (spec: ai-assistant.md). Admins
// support requests to be removed and can audit/release entries. Numbers are
// never shown — only the last four digits + how the opt-out was recorded — since
// the list stores an HMAC, not the raw number.
//
//   GET    /api/admin/dnc            → paginated suppression entries
//   POST   /api/admin/dnc { phone }  → add a number (source 'support'), audited
//   DELETE /api/admin/dnc/:id        → release an entry, audited
router.get('/dnc', async (req, res) => {
  try {
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
    const filter = req.query.active === 'all' ? {} : { active: true };
    const [total, entries] = await Promise.all([
      DncEntry.countDocuments(filter),
      DncEntry.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);
    res.json({
      items: entries.map((e) => ({
        _id: e._id,
        last4: e.last4 || null,
        source: e.source,
        note: e.note || null,
        active: e.active,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
      total, page, pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/dnc', async (req, res) => {
  try {
    const { phone, note } = req.body || {};
    if (!phone || !normalizePhone(phone)) {
      return res.status(400).json({ error: 'A valid phone number is required' });
    }
    const { entry } = await suppress(phone, {
      source: 'support', note, createdBy: req.user._id, userId: req.user._id,
    });
    res.status(201).json({ _id: entry._id, last4: entry.last4 || null, source: entry.source, active: entry.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/dnc/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const entry = await release(req.params.id, { by: req.user._id });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ _id: entry._id, active: entry.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
