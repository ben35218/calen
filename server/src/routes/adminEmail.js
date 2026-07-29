// Admin email surfaces: the outbound no-reply@ send log (EmailLog rows written
// by services/mailer.js) and the support@ mailbox (live IMAP via
// services/supportMail.js — nothing mirrored into Mongo). requireAdmin-gated
// like the rest of the admin console.
//
//   GET  /api/admin/email/log                    → paginated outbound sends
//   GET  /api/admin/email/support/status         → configured? + per-mailbox unread
//   GET  /api/admin/email/support/messages       → paginated summaries (?mailbox=)
//   GET  /api/admin/email/support/messages/:uid  → full parsed message (marks read)
//   POST /api/admin/email/support/messages/:uid/reply   { text }
//   POST /api/admin/email/support/messages/:uid/move    { destination }
//   POST /api/admin/email/support/messages/:uid/seen    { seen }

const express = require('express');
const EmailLog = require('../models/EmailLog');
const AuditLog = require('../models/AuditLog');
const EmailLifecycleConfig = require('../models/EmailLifecycleConfig');
const EmailSuppression = require('../models/EmailSuppression');
const supportMail = require('../services/supportMail');
const mailer = require('../services/mailer');
const { runEmailReconcile } = require('../jobs/emailReconcile');
const { CATALOG, STAGES } = require('../services/emailCatalog');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { paginate } = require('./adminHelpers');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Admins reading user email is privacy-relevant — every read/reply/move leaves
// an audit row. Best-effort (never fails the request); meta is uid + mailbox
// only, never content or addresses.
function audit(req, event, meta) {
  AuditLog.create({ userId: req.user._id, event, meta }).catch(() => {});
}

// --- Outbound (no-reply@) log ------------------------------------------------

router.get('/log', async (req, res) => {
  try {
    const { status, kind, q } = req.query;
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
    const filter = {};
    if (status) filter.status = status;
    if (kind) filter.kind = kind;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ to: rx }, { subject: rx }];
    }

    const [total, items] = await Promise.all([
      EmailLog.countDocuments(filter),
      // Never ship the transient outbox payload (bodies) to the console — it's
      // for the retry machinery, not for reading.
      EmailLog.find(filter).sort({ at: -1 }).skip(skip).limit(pageSize).select('-payload').lean(),
    ]);
    res.json({ items, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// At-a-glance outbox health for the log view header.
router.get('/log/stats', async (_req, res) => {
  try {
    const [queued, failed, suppressed] = await Promise.all([
      EmailLog.countDocuments({ status: 'queued' }),
      EmailLog.countDocuments({ status: 'failed' }),
      EmailSuppression.countDocuments({ active: true }),
    ]);
    res.json({ queued, failed, suppressed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force a queued (outbox) row due now, then run a bounded reconcile pass so the
// admin sees the result immediately. Only `queued` rows carry a payload and are
// retriable; a `failed` row has none (its payload was cleared on give-up).
router.post('/log/:id/retry', async (req, res) => {
  try {
    const row = await EmailLog.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    if (row.status !== 'queued') {
      return res.status(409).json({ error: `Only queued emails can be retried (this one is ${row.status}).` });
    }
    row.nextAttemptAt = new Date();
    await row.save();
    const summary = await runEmailReconcile();
    const fresh = await EmailLog.findById(req.params.id).select('-payload').lean();
    res.json({ email: fresh, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a queued retry — drop it from the outbox without sending.
router.post('/log/:id/cancel', async (req, res) => {
  try {
    const row = await EmailLog.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    if (row.status !== 'queued') {
      return res.status(409).json({ error: `Only queued emails can be canceled (this one is ${row.status}).` });
    }
    row.status = 'canceled';
    row.payload = undefined;
    row.nextAttemptAt = undefined;
    await row.save();
    res.json({ email: await EmailLog.findById(req.params.id).select('-payload').lean() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run the whole outbox reconcile pass on demand. Audited.
router.post('/reconcile', async (req, res) => {
  try {
    const summary = await runEmailReconcile();
    audit(req, 'email_reconcile_run', summary);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Lifecycle catalog (the send map, admin-editable metadata) ----------------

// Merged view: the code-owned catalog + the admin overlay + stage grouping.
router.get('/catalog', async (_req, res) => {
  try {
    const cfg = await EmailLifecycleConfig.getSingleton();
    const templates = CATALOG.map((e) => ({
      ...e,
      config: cfg.templates[e.key] || { enabled: true, subjectOverride: '', note: '' },
    }));
    res.json({ stages: STAGES, templates, retry: cfg.retry, suppressionEnabled: cfg.suppressionEnabled !== false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate the editable overlay before writing. Keys must exist in the catalog;
// required templates can't be disabled (the toggle is ignored, but reject an
// explicit attempt so the UI and API agree).
function validateCatalog(body) {
  const errors = [];
  const known = new Set(CATALOG.map((e) => e.key));
  const required = new Set(CATALOG.filter((e) => e.required).map((e) => e.key));
  for (const [key, t] of Object.entries(body.templates || {})) {
    if (!known.has(key)) { errors.push(`unknown template "${key}"`); continue; }
    if (t.enabled !== undefined && typeof t.enabled !== 'boolean') errors.push(`${key}.enabled must be boolean`);
    if (t.enabled === false && required.has(key)) errors.push(`${key} is required and cannot be disabled`);
    if (t.subjectOverride !== undefined && typeof t.subjectOverride !== 'string') errors.push(`${key}.subjectOverride must be a string`);
    if (t.subjectOverride && t.subjectOverride.length > 200) errors.push(`${key}.subjectOverride is too long`);
  }
  const r = body.retry;
  if (r) {
    if (r.maxAttempts !== undefined && (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > 12)) errors.push('retry.maxAttempts must be an integer 1–12');
    if (r.baseMinutes !== undefined && (!(r.baseMinutes > 0) || r.baseMinutes > 1440)) errors.push('retry.baseMinutes must be > 0 and ≤ 1440');
    if (r.capMinutes !== undefined && (!(r.capMinutes > 0) || r.capMinutes > 10080)) errors.push('retry.capMinutes must be > 0 and ≤ 10080');
  }
  if (body.suppressionEnabled !== undefined && typeof body.suppressionEnabled !== 'boolean') errors.push('suppressionEnabled must be boolean');
  return errors;
}

router.put('/catalog', async (req, res) => {
  try {
    const errors = validateCatalog(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const doc = await EmailLifecycleConfig.getSingleton();
    const before = JSON.parse(JSON.stringify({ templates: doc.templates, retry: doc.retry, suppressionEnabled: doc.suppressionEnabled }));

    if (req.body.templates) {
      for (const [key, t] of Object.entries(req.body.templates)) {
        doc.templates[key] = { ...(doc.templates[key] || {}), ...t };
      }
      doc.markModified('templates');
    }
    if (req.body.retry) { doc.retry = { ...doc.retry, ...req.body.retry }; doc.markModified('retry'); }
    if (req.body.suppressionEnabled !== undefined) doc.suppressionEnabled = req.body.suppressionEnabled;
    await doc.save();
    mailer.invalidateEmailConfigCache();

    const after = { templates: doc.templates, retry: doc.retry, suppressionEnabled: doc.suppressionEnabled };
    const changed = diffPaths(before, after);
    if (changed.length) audit(req, 'email_config_changed', { changed });

    res.json({ stages: STAGES, templates: CATALOG.map((e) => ({ ...e, config: doc.templates[e.key] })), retry: doc.retry, suppressionEnabled: doc.suppressionEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Render a template with its catalog sample data — no send, no log.
router.get('/catalog/:key/preview', (req, res) => {
  const preview = mailer.renderPreview(req.params.key);
  if (!preview) return res.status(404).json({ error: 'No preview for this template (unknown or not yet implemented).' });
  res.json(preview);
});

// --- Suppression list ---------------------------------------------------------

router.get('/suppressions', async (req, res) => {
  try {
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
    const filter = {};
    if (req.query.active === 'true') filter.active = true;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.email = rx;
    }
    const [total, items] = await Promise.all([
      EmailSuppression.countDocuments(filter),
      EmailSuppression.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);
    res.json({ items, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/suppressions', async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    const row = await EmailSuppression.suppress({ email, reason: 'manual', source: 'admin', note: req.body?.note, createdBy: req.user._id });
    audit(req, 'email_suppressed', { email, reason: 'manual' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/suppressions/:id', async (req, res) => {
  try {
    const row = await EmailSuppression.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true });
    if (!row) return res.status(404).json({ error: 'Suppression not found' });
    audit(req, 'email_released', { email: row.email });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaf-level diff for the email_config_changed audit row (values recorded —
// enable flags / subjects / retry numbers, never a body). Capped for meta size.
function diffPaths(before, after, prefix = '', out = []) {
  if (out.length >= 40) return out;
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const a = before?.[k];
    const b = after?.[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') diffPaths(a, b, path, out);
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return out;
}

// --- Support mailbox ----------------------------------------------------------

// Every support route funnels through here so an unconfigured mailbox is a
// clean 503 the UI can explain, not a connection error.
function requireSupport(req, res, next) {
  if (!supportMail.isConfigured()) {
    return res.status(503).json({ error: 'Support mailbox is not configured (SUPPORT_EMAIL_USER/PASS)' });
  }
  next();
}

function validMailbox(value) {
  return supportMail.MAILBOXES.includes(value) ? value : 'INBOX';
}

router.get('/support/status', async (_req, res) => {
  if (!supportMail.isConfigured()) return res.json({ configured: false, boxes: [] });
  try {
    const s = await supportMail.status();
    res.json({ configured: true, ...s });
  } catch (err) {
    res.status(502).json({ error: `Support mailbox unreachable: ${err.message}` });
  }
});

router.get('/support/messages', requireSupport, async (req, res) => {
  try {
    const { page, pageSize } = paginate(req.query, { defaultSize: 25, maxSize: 100 });
    const data = await supportMail.listMessages({
      mailbox: validMailbox(req.query.mailbox), page, pageSize,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/support/messages/:uid', requireSupport, async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid uid' });
    const mailbox = validMailbox(req.query.mailbox);
    const msg = await supportMail.getMessage({ mailbox, uid });
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    audit(req, 'support_message_read', { uid, mailbox });
    res.json(msg);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/support/messages/:uid/reply', requireSupport, async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid uid' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Reply text is required' });
    const mailbox = validMailbox(req.body?.mailbox);
    const result = await supportMail.reply({ mailbox, uid, text });
    audit(req, 'support_reply_sent', { uid, mailbox });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/support/messages/:uid/move', requireSupport, async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid uid' });
    const destination = req.body?.destination;
    if (!supportMail.MAILBOXES.includes(destination)) {
      return res.status(400).json({ error: 'Invalid destination mailbox' });
    }
    const mailbox = validMailbox(req.body?.mailbox);
    const result = await supportMail.move({ mailbox, uid, destination });
    audit(req, 'support_message_moved', { uid, from: mailbox, to: destination });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/support/messages/:uid/seen', requireSupport, async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid uid' });
    const result = await supportMail.setSeen({
      mailbox: validMailbox(req.body?.mailbox), uid, seen: !!req.body?.seen,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
