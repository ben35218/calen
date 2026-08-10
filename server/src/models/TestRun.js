const mongoose = require('mongoose');

// One tester on one device, working a release's test plan (spec:
// features/release-qa.md). The device matrix in the plan maps to several runs
// under one release — which is what makes "the full pass on the primary device,
// the smoke subset on the rest" expressible instead of collapsing into a single
// ambiguous pass/fail per case.
//
// A run is `complete` when the admin says so, NOT when every case has a result:
// a partial run is a real artifact (the smoke subset IS partial), and the
// release summary is what reports coverage.
const testRunSchema = new mongoose.Schema({
  releaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Release', required: true, index: true },
  name:      { type: String, default: '', trim: true, maxlength: 200 },
  environment: {
    device:    { type: String, default: '', trim: true, maxlength: 120 },
    osVersion: { type: String, default: '', trim: true, maxlength: 60 },
    build:     { type: String, default: '', trim: true, maxlength: 60 },
    tester:    { type: String, default: '', trim: true, maxlength: 120 },
  },
  status:      { type: String, enum: ['in_progress', 'complete', 'abandoned'], default: 'in_progress', index: true },
  startedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  startedAt:   { type: Date, default: Date.now },
  completedAt: { type: Date },
}, { timestamps: true });

testRunSchema.index({ releaseId: 1, startedAt: -1 });

module.exports = mongoose.model('TestRun', testRunSchema);
