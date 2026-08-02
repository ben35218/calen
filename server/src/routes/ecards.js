const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ECard = require('../models/ECard');
const { FONTS } = require('../services/ecardTemplates');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Scheduled occasion e-cards. NOTE: intentionally NOT routed through the E2EE
// plaintext-create guard — an e-card is a deliberate plaintext exception (the
// server must read the recipient emails + message to deliver on schedule while
// the app is closed). See models/ECard.js and specs/platform/crypto-e2ee.md.

const KINDS = ['birthday', 'anniversary', 'marriage', 'death', 'custom'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PHOTOS = 3;

// Card photos share the app's disk upload store (see eventAttachments.js).
// Plaintext by design, like the card message — the server embeds them in the
// email at send time. Images only: the email inlines them via CID.
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, unique + path.extname(file.originalname));
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  // No HEIC: most email clients can't render it inline (the app's picker
  // re-encodes to JPEG anyway).
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)),
});

function unlinkPhotos(photos) {
  for (const p of photos || []) {
    if (!p.storageKey) continue;
    const fp = path.join(uploadDir, p.storageKey);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch { /* best-effort */ } }
  }
}

// Validate + normalise the client payload. Returns { value } or { error }.
function parseBody(body) {
  const month = Number(body.month);
  const day = Number(body.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: 'month must be 1–12' };
  if (!Number.isInteger(day) || day < 1 || day > 31) return { error: 'day must be 1–31' };
  const kind = KINDS.includes(body.kind) ? body.kind : 'custom';

  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const cleanRecipients = recipients
    .map((r) => ({ email: String(r?.email || '').trim().toLowerCase(), name: String(r?.name || '').trim() }))
    .filter((r) => r.email);
  if (!cleanRecipients.length) return { error: 'at least one recipient is required' };
  const bad = cleanRecipients.find((r) => !EMAIL_RE.test(r.email));
  if (bad) return { error: `invalid recipient email: ${bad.email}` };

  const sendTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.sendTime || '')) ? body.sendTime : '09:00';
  const message = String(body.message || '').slice(0, 2000);
  // Unknown font keys fall back to '' (the template's own default).
  const font = FONTS[String(body.font || '')] ? String(body.font) : '';

  return {
    value: {
      kind,
      occasionLabel: String(body.occasionLabel || '').trim() || undefined,
      month, day, sendTime,
      template: String(body.template || '').trim() || undefined,
      font,
      message,
      greeting: String(body.greeting || '').trim().slice(0, 120),
      signoff: String(body.signoff || '').trim().slice(0, 120),
      signature: String(body.signature || '').trim().slice(0, 120),
      recipients: cleanRecipients,
      personId: body.personId || undefined,
    },
  };
}

// List the household's e-cards (any member sees them; edits are author-only).
router.get('/', async (req, res) => {
  const scope = req.user.householdId
    ? { householdId: req.user.householdId }
    : { userId: req.user._id };
  const cards = await ECard.find(scope).sort({ month: 1, day: 1 }).lean();
  res.json(cards);
});

router.post('/', async (req, res) => {
  const { value, error } = parseBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const card = await ECard.create({
    ...value,
    userId: req.user._id,
    householdId: req.user.householdId || undefined,
  });
  res.status(201).json(card);
});

router.patch('/:id', async (req, res) => {
  const card = await ECard.findById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (String(card.userId) !== String(req.user._id)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body || {};
  // Full-object edits reuse the create validation; a bare `active` toggle skips it.
  if ('month' in b || 'day' in b || 'recipients' in b || 'message' in b || 'template' in b || 'sendTime' in b || 'kind' in b || 'occasionLabel' in b
    || 'font' in b || 'greeting' in b || 'signoff' in b || 'signature' in b) {
    const { value, error } = parseBody({ ...card.toObject(), ...b });
    if (error) return res.status(400).json({ error });
    Object.assign(card, value);
    // A meaningful edit re-arms the card for its next occurrence (a one-time
    // card that already sent is reactivated so the edit reschedules it).
    card.active = true;
    card.sentAt = null;
  }
  if ('active' in b) card.active = Boolean(b.active);
  await card.save();
  res.json(card);
});

router.delete('/:id', async (req, res) => {
  const card = await ECard.findById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (String(card.userId) !== String(req.user._id)) return res.status(403).json({ error: 'Forbidden' });
  unlinkPhotos(card.photos);
  await card.deleteOne();
  res.json({ ok: true });
});

// ── Card photos ──────────────────────────────────────────────────────────────
// Author-only mutations (like card edits); any household member can view.

router.post('/:id/photos', upload.single('photo'), async (req, res) => {
  const card = await ECard.findById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (String(card.userId) !== String(req.user._id)) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded (JPEG/PNG/GIF/WebP only)' });
  if ((card.photos || []).length >= MAX_PHOTOS) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: `A card can hold up to ${MAX_PHOTOS} photos` });
  }
  card.photos.push({ storageKey: req.file.filename, contentType: req.file.mimetype });
  await card.save();
  res.status(201).json(card);
});

router.delete('/:id/photos/:photoId', async (req, res) => {
  const card = await ECard.findById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (String(card.userId) !== String(req.user._id)) return res.status(403).json({ error: 'Forbidden' });
  const photo = card.photos.id(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  unlinkPhotos([photo]);
  photo.deleteOne();
  await card.save();
  res.json(card);
});

// Serve a photo's bytes (household-scoped, for the app's card preview).
router.get('/:id/photos/:photoId', async (req, res) => {
  const scope = req.user.householdId
    ? { householdId: req.user.householdId }
    : { userId: req.user._id };
  const card = await ECard.findOne({ _id: req.params.id, ...scope });
  if (!card) return res.status(404).json({ error: 'Not found' });
  const photo = card.photos.id(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  const fp = path.join(uploadDir, photo.storageKey);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found on disk' });
  res.setHeader('Content-Type', photo.contentType || 'image/jpeg');
  res.sendFile(fp);
});

module.exports = router;
