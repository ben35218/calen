const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const Feedback = require('../models/Feedback');

// In-app "Help & feedback" (spec: features/feedback.md). A signed-in user asks a
// question, reports a bug, or suggests an idea from the app. Stored durably for
// admin triage (admin portal Feedback view) — deliberately plaintext, since it's
// support content the operator must be able to read. Rate-limited so it can't be
// used to flood the queue. Mirrors moderation.js in shape.
const router = express.Router();
router.use(requireAuth);

const feedbackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many submissions. Please try again shortly.' });

const TYPES = ['question', 'bug', 'idea'];
const cap = (v, max) => String(v == null ? '' : v).slice(0, max);

router.post('/', feedbackLimiter, async (req, res) => {
  try {
    const { type, message, contactEmail, diagnostics } = req.body || {};
    const text = cap(message, 4000).trim();
    if (!text) return res.status(400).json({ error: 'A message is required.' });
    const d = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
    const fb = await Feedback.create({
      userId: req.user._id,
      householdId: req.user.householdId || null,
      type: TYPES.includes(type) ? type : 'question',
      message: text,
      contactEmail: cap(contactEmail, 200).trim(),
      diagnostics: {
        appVersion:  cap(d.appVersion, 40),
        buildNumber: cap(d.buildNumber, 40),
        platform:    cap(d.platform, 20),
        osVersion:   cap(d.osVersion, 40),
        deviceModel: cap(d.deviceModel, 80),
        route:       cap(d.route, 80),
        locale:      cap(d.locale, 20),
      },
    });
    res.status(201).json({ ok: true, id: fb._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
