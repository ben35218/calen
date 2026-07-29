const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const EventAttachment = require('../models/EventAttachment');
// Signal-parity C3b: events live in the unified opaque store; the attachment
// authz check only needs the event's existence in the caller's scope (by id).
const Record = require('../models/Record');
const { requireAuth } = require('../middleware/auth');

// Mounted at /calendar. Only the attachment paths (…/events/:id/attachments,
// …/attachments/:id) live here now — the calendar aggregate + event CRUD routes
// that used to share this mount were retired in C3b (event CRUD moved to the
// opaque /records store).
const router = express.Router();
router.use(requireAuth);

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // E2EE ciphertext uploads are opaque bytes; the plaintext mimetype rides in
    // the body's `fileType`. The client sends the ciphertext part as
    // `application/octet-stream`, but iOS/CFNetwork OVERRIDES a `.bin` part's
    // content-type to `application/macbinary` (and other platforms may pick other
    // generic-binary labels), so accept the whole opaque-binary family — otherwise
    // multer silently drops the file and the route 400s with "No file uploaded".
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/heic', 'image/webp',
      'application/pdf',
      'application/octet-stream', 'application/macbinary', 'application/x-macbinary',
      'application/x-binary', 'application/binary',
    ];
    return cb(null, allowed.includes(file.mimetype));
  },
});

// The event must belong to the requester's household scope. Mirrors how receipts
// gate on their item; cross-household calendar collaborators can't attach files.
async function findEvent(req) {
  return Record.findOne({ _id: req.params.eventId, ...req.scopeFilter }).select('_id').lean();
}

// List an event's attachments (newest first).
router.get('/events/:eventId/attachments', async (req, res) => {
  try {
    const event = await findEvent(req);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const attachments = await EventAttachment.find({ eventId: event._id }).sort({ createdAt: -1 }).lean();
    res.json(attachments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a file attachment to an event. Mirrors the receipts upload, incl. the
// E2EE ciphertext path (opaque bytes + wrapped per-file key + client-minted _id).
router.post('/events/:eventId/attachments/upload', upload.single('file'), async (req, res) => {
  try {
    const event = await findEvent(req);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const encrypted = req.body.encrypted === 'true' || req.body.encrypted === true;
    const clientId = /^[a-f0-9]{24}$/i.test(req.body._id || '') ? req.body._id : undefined;

    const attachment = await EventAttachment.create({
      ...(clientId ? { _id: clientId } : {}),
      userId: req.user._id,
      eventId: event._id,
      title: req.body.title || req.file.originalname,
      storageKey: req.file.filename,
      fileType: encrypted ? (req.body.fileType || 'application/octet-stream') : req.file.mimetype,
      fileSizeBytes: req.file.size,
      encrypted,
      ...(encrypted ? { wrappedFileKey: req.body.wrappedFileKey, keyVersion: Number(req.body.keyVersion) || undefined } : {}),
    });
    res.status(201).json(attachment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attachments/:id/download', async (req, res) => {
  try {
    const attachment = await EventAttachment.findOne({ _id: req.params.id, ...req.scopeFilter });
    if (!attachment) return res.status(404).json({ error: 'Not found' });

    const filepath = path.join(uploadDir, attachment.storageKey);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });

    if (attachment.encrypted) {
      // Opaque ciphertext — the client fetches, unwraps the file key, and decrypts.
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.sendFile(filepath);
    }
    res.setHeader('Content-Type', attachment.fileType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.title}"`);
    res.sendFile(filepath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/attachments/:id', async (req, res) => {
  try {
    const attachment = await EventAttachment.findOneAndDelete({ _id: req.params.id, ...req.scopeFilter });
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    if (attachment.storageKey) {
      const filepath = path.join(uploadDir, attachment.storageKey);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
