const mongoose = require('mongoose');

// A shipped (or shipping) build of the mobile app, and the anchor every test run
// and sign-off hangs off (spec: features/release-qa.md). Plaintext by design —
// this is metadata about our own product, never household content.
//
// `tag` matches the anchor the release-notes tooling creates
// (`testflight/<version>-<buildNumber>`, see scripts/release-notes.mjs), so a
// release row and its git history name the same thing.
const releaseSchema = new mongoose.Schema({
  version:     { type: String, required: true, trim: true, maxlength: 40 },
  buildNumber: { type: String, required: true, trim: true, maxlength: 40 },
  channel:     { type: String, enum: ['testflight', 'app-store', 'play'], default: 'testflight', index: true },
  tag:         { type: String, default: '', trim: true, maxlength: 120 },
  commitSha:   { type: String, default: '', trim: true, maxlength: 60 },
  // Advisory lifecycle: planning → testing → submitted → released, with
  // rolled-back reachable from any of them. Not enforced — a release record
  // must stay correctable after the fact.
  status:      { type: String, enum: ['planning', 'testing', 'submitted', 'released', 'rolled-back'], default: 'planning', index: true },
  notes:       { type: String, default: '', maxlength: 4000 },
  // Set by POST /releases/:id/sign-off, which refuses while a blocker case is
  // outstanding. Re-signing overwrites (see the spec).
  signOff: {
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at:       { type: Date },
    note:     { type: String, default: '', maxlength: 2000 },
  },
}, { timestamps: true });

// One record per build per channel: two rows for the same build would split its
// evidence in half.
releaseSchema.index({ version: 1, buildNumber: 1, channel: 1 }, { unique: true });
releaseSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Release', releaseSchema);
