const mongoose = require('mongoose');

// One case's outcome inside one run (spec: features/release-qa.md).
//
// `caseId` is the STRING id, not a ref: a re-import can retire and re-add a
// TestCase document, and results must survive that untouched. The unique
// (runId, caseId) index makes recording a result an UPSERT — re-answering a case
// overwrites rather than appending, so a mis-tap can be corrected without
// leaving a contradictory trail inside the same run. Disagreement across
// DIFFERENT runs is meaningful and is preserved.
const STATUSES = ['pass', 'fail', 'blocked', 'skipped', 'na'];

const testResultSchema = new mongoose.Schema({
  runId:     { type: mongoose.Schema.Types.ObjectId, ref: 'TestRun', required: true, index: true },
  releaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Release', required: true, index: true },
  caseId:    { type: String, required: true, trim: true, maxlength: 60 },
  status:    { type: String, enum: STATUSES, required: true },
  // Free text from the tester. MUST NOT be used to record user data — see the
  // spec's encryption boundary: nothing in this collection is sealed.
  note:      { type: String, default: '', maxlength: 4000 },
  byUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  at:        { type: Date, default: Date.now },
}, { timestamps: true });

testResultSchema.index({ runId: 1, caseId: 1 }, { unique: true });
// The sign-off gate and the summary both scan a release's results by case.
testResultSchema.index({ releaseId: 1, caseId: 1 });

const TestResult = mongoose.model('TestResult', testResultSchema);
TestResult.STATUSES = STATUSES;

module.exports = TestResult;
