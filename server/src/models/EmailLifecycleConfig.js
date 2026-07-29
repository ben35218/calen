const mongoose = require('mongoose');
const { CATALOG, DEFAULT_RETRY, defaultTemplateConfig } = require('../services/emailCatalog');

// Admin-editable overlay on the code-owned email catalog (services/emailCatalog.js).
// Exactly ONE document (singleton), mirroring MonetizationConfig. The admin
// "Email lifecycle" page reads and writes it; services/mailer.js reads it before
// every send to honor per-template enable/subject overrides and the retry policy.
//
// Bodies are NOT here — only metadata. `templates[key]` = { enabled,
// subjectOverride, note }; `retry` = the outbox backoff policy;
// `suppressionEnabled` gates whether the suppression list is consulted at all.

const DEFAULTS = {
  templates: defaultTemplateConfig(),
  retry: { ...DEFAULT_RETRY },
  suppressionEnabled: true,
};

const schema = new mongoose.Schema(
  {
    singleton:          { type: String, default: 'config', unique: true, index: true },
    templates:          { type: mongoose.Schema.Types.Mixed, default: () => defaultTemplateConfig() },
    retry:              { type: mongoose.Schema.Types.Mixed, default: () => ({ ...DEFAULT_RETRY }) },
    suppressionEnabled: { type: Boolean, default: true },
  },
  { timestamps: true, minimize: false }
);

// Fetch the singleton, creating it on first access and backfilling any catalog
// key added after the doc was created (new templates appear enabled by default).
schema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ singleton: 'config' });
  if (!doc) doc = await this.create({ singleton: 'config' });

  let dirty = false;
  if (!doc.templates) { doc.templates = defaultTemplateConfig(); doc.markModified('templates'); dirty = true; }
  if (!doc.retry) { doc.retry = { ...DEFAULT_RETRY }; doc.markModified('retry'); dirty = true; }
  // Backfill templates for catalog keys added since the doc was written.
  for (const e of CATALOG) {
    if (!doc.templates[e.key]) {
      doc.templates[e.key] = { enabled: true, subjectOverride: '', note: '' };
      doc.markModified('templates');
      dirty = true;
    }
  }
  if (dirty) await doc.save();
  return doc;
};

const EmailLifecycleConfig = mongoose.model('EmailLifecycleConfig', schema);
EmailLifecycleConfig.DEFAULTS = DEFAULTS;

module.exports = EmailLifecycleConfig;
