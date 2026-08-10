const test = require('node:test');
const assert = require('node:assert');
const { summarizeRelease, blockerOutstanding } = require('./qaSummary');

const c = (caseId, priority = 'major') => ({ caseId, priority });
const r = (runId, caseId, status) => ({ runId, caseId, status });

test('blockerOutstanding: never executed is outstanding', () => {
  assert.equal(blockerOutstanding([]), true);
});

test('blockerOutstanding: a single pass on any run satisfies it', () => {
  assert.equal(blockerOutstanding(['fail', 'pass']), false);
  assert.equal(blockerOutstanding(['pass']), false);
});

test('blockerOutstanding: failed or blocked without a pass stays outstanding', () => {
  assert.equal(blockerOutstanding(['fail']), true);
  assert.equal(blockerOutstanding(['blocked', 'skipped']), true);
});

test('blockerOutstanding: uniformly not-applicable is satisfied', () => {
  assert.equal(blockerOutstanding(['na', 'na']), false);
  // ...but a single non-na answer means it really did apply somewhere.
  assert.equal(blockerOutstanding(['na', 'fail']), true);
});

test('counts coverage over cases, not over raw results', () => {
  const s = summarizeRelease({
    cases: [c('A-01'), c('A-02'), c('A-03')],
    results: [r('r1', 'A-01', 'pass'), r('r2', 'A-01', 'pass'), r('r1', 'A-02', 'fail')],
    runs: [],
  });
  assert.equal(s.totalCases, 3);
  assert.equal(s.executed, 2);   // A-01 and A-02
  assert.equal(s.unexecuted, 1);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.byStatus, { pass: 2, fail: 1, blocked: 0, skipped: 0, na: 0 });
});

test('a pass anywhere clears a failure elsewhere from the release-level count', () => {
  const s = summarizeRelease({
    cases: [c('A-01')],
    results: [r('r1', 'A-01', 'fail'), r('r2', 'A-01', 'pass')],
    runs: [],
  });
  assert.equal(s.failed, 0);
  assert.equal(s.passed, 1);
});

test('passRate is over executed cases — unexecuted is unknown, not failure', () => {
  const s = summarizeRelease({
    cases: [c('A-01'), c('A-02'), c('A-03'), c('A-04')],
    results: [r('r1', 'A-01', 'pass')],
    runs: [],
  });
  assert.equal(s.passRate, 100);
  assert.equal(s.executed, 1);
});

test('passRate is 0 rather than NaN when nothing has been executed', () => {
  const s = summarizeRelease({ cases: [c('A-01')], results: [], runs: [] });
  assert.equal(s.passRate, 0);
  assert.equal(s.executed, 0);
});

// The gate is a BLOCKER gate, not a coverage gate: it refuses on a blocker that
// was never exercised, and says nothing about the rest. Coverage is reported for
// the admin to judge — deliberately, since a partial run (the smoke subset on a
// secondary device) is a legitimate artifact, not an incomplete one.
test('a release whose library holds no blockers can sign off unexecuted', () => {
  const s = summarizeRelease({ cases: [c('A-01'), c('A-02', 'critical')], results: [], runs: [] });
  assert.equal(s.executed, 0);
  assert.deepEqual(s.outstandingBlockers, []);
  assert.equal(s.canSignOff, true);
});

test('an unexecuted blocker blocks sign-off and is named', () => {
  const s = summarizeRelease({
    cases: [c('A-01', 'blocker'), c('A-02')],
    results: [r('r1', 'A-02', 'pass')],
    runs: [],
  });
  assert.deepEqual(s.outstandingBlockers, ['A-01']);
  assert.equal(s.canSignOff, false);
});

test('a non-blocker failure never gates sign-off', () => {
  const s = summarizeRelease({
    cases: [c('A-01', 'critical'), c('A-02', 'major')],
    results: [r('r1', 'A-01', 'fail'), r('r1', 'A-02', 'fail')],
    runs: [],
  });
  assert.deepEqual(s.outstandingBlockers, []);
  assert.equal(s.canSignOff, true);
  assert.equal(s.failed, 2);
});

test('a blocker passing on one run of several clears the gate', () => {
  const s = summarizeRelease({
    cases: [c('A-01', 'blocker')],
    results: [r('r1', 'A-01', 'fail'), r('r2', 'A-01', 'pass')],
    runs: [],
  });
  assert.deepEqual(s.outstandingBlockers, []);
  assert.equal(s.canSignOff, true);
});

test('per-run progress is reported independently of the release rollup', () => {
  const s = summarizeRelease({
    cases: [c('A-01'), c('A-02')],
    results: [r('r1', 'A-01', 'pass'), r('r1', 'A-02', 'fail'), r('r2', 'A-01', 'na')],
    runs: [
      { _id: 'r1', name: 'iPhone SE', status: 'complete', environment: { device: 'SE' } },
      { _id: 'r2', name: 'iPad', status: 'in_progress', environment: { device: 'iPad' } },
    ],
  });
  assert.equal(s.perRun.length, 2);
  assert.equal(s.perRun[0].executed, 2);
  assert.equal(s.perRun[0].counts.pass, 1);
  assert.equal(s.perRun[0].counts.fail, 1);
  assert.equal(s.perRun[1].executed, 1);
  assert.equal(s.perRun[1].counts.na, 1);
});

test('an empty release summarizes without throwing', () => {
  const s = summarizeRelease({});
  assert.equal(s.totalCases, 0);
  assert.equal(s.canSignOff, true); // nothing to block on
  assert.deepEqual(s.perRun, []);
});

test('a result for a case not in the library is ignored by the case rollup', () => {
  const s = summarizeRelease({
    cases: [c('A-01')],
    results: [r('r1', 'GHOST-01', 'pass')],
    runs: [],
  });
  assert.equal(s.executed, 0);
  assert.equal(s.byStatus.pass, 1); // still counted as raw activity
});
