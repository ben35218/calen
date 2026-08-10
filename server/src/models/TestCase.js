const mongoose = require('mongoose');

// One check in the pre-release test plan (spec: features/release-qa.md).
//
// The REPO is the source of truth: cases are authored in docs/*.md, reviewed in
// pull requests, and imported here by `services/qaImport.js`. `caseId` — the
// stable human id the plan already prints (CAL-13, AUTH-28) — is the join key
// for everything: imports upsert on it, and TestResult references it as a
// STRING rather than an ObjectId so execution history can never be orphaned by
// a re-import.
const PRIORITIES = ['blocker', 'critical', 'major', 'minor'];

const testCaseSchema = new mongoose.Schema({
  caseId:   { type: String, required: true, unique: true, trim: true, maxlength: 60 },
  section:  { type: String, default: '', trim: true, maxlength: 200, index: true },
  title:    { type: String, default: '', maxlength: 500 },
  steps:    { type: String, default: '', maxlength: 4000 },
  expected: { type: String, default: '', maxlength: 4000 },
  priority: { type: String, enum: PRIORITIES, default: 'major', index: true },
  // The spec that owns the behavior under test (specs/features/calendar.md).
  // Captured now; the coverage report that reads it is out of scope for v1.
  specPath: { type: String, default: '', maxlength: 200 },
  tags:     { type: [String], default: () => [] },
  // 'repo' cases are owned by an imported document and are overwritten by the
  // next import; 'manual' cases are authored in the portal and are invisible to
  // the importer's diff (never updated, never flagged missing).
  source:    { type: String, enum: ['repo', 'manual'], default: 'repo', index: true },
  sourceDoc: { type: String, default: '', maxlength: 200 },
  // Hash of the imported content, so a re-import of an unchanged document is a
  // no-op and `updated` means the wording really moved.
  contentHash: { type: String, default: '' },
  // False = the case was in the portal but absent from the latest import of its
  // source document. Flagged, never deleted: its results are real evidence.
  active:      { type: Boolean, default: true, index: true },
  retiredAt:   { type: Date },
}, { timestamps: true });

testCaseSchema.index({ section: 1, caseId: 1 });

const TestCase = mongoose.model('TestCase', testCaseSchema);
TestCase.PRIORITIES = PRIORITIES;

module.exports = TestCase;
