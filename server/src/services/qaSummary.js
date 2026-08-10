// Release QA rollup (spec: features/release-qa.md).
//
// Pure and side-effect-free: the release screen and the sign-off gate BOTH read
// this, so the numbers a user sees can never disagree with the numbers the gate
// refuses on. That is the whole reason it is one function rather than a query in
// each route.

// A blocker is OUTSTANDING when, across every run on the release, it never
// passed and was not uniformly marked not-applicable.
//
//   - never executed        → outstanding (it was not tested)
//   - failed / blocked only → outstanding
//   - passed on any ONE run → satisfied. A blocker does not have to pass on
//     every device: the plan deliberately runs only a subset on secondary
//     devices, and judging which devices matter is the admin's call. The gate
//     only insists the case was genuinely exercised somewhere.
//   - 'na' on every run     → satisfied. A case that cannot apply cannot block.
function blockerOutstanding(statuses) {
  if (!statuses.length) return true;
  if (statuses.includes('pass')) return false;
  return !statuses.every((s) => s === 'na');
}

// summarizeRelease({ cases, results, runs }) → the release's coverage picture.
//
//   cases:   [{ caseId, priority }]        — ACTIVE cases only; the caller filters
//   results: [{ runId, caseId, status }]   — every result across the release
//   runs:    [{ _id, name, status, environment }]
function summarizeRelease({ cases = [], results = [], runs = [] } = {}) {
  const statusesByCase = new Map();
  const byStatus = { pass: 0, fail: 0, blocked: 0, skipped: 0, na: 0 };

  for (const r of results) {
    if (byStatus[r.status] !== undefined) byStatus[r.status] += 1;
    const key = String(r.caseId);
    if (!statusesByCase.has(key)) statusesByCase.set(key, []);
    statusesByCase.get(key).push(r.status);
  }

  let executed = 0;
  let passed = 0;
  let failed = 0;
  const outstandingBlockers = [];

  for (const c of cases) {
    const statuses = statusesByCase.get(String(c.caseId)) || [];
    if (statuses.length) executed += 1;
    if (statuses.includes('pass')) passed += 1;
    // A case counts as failing for the release when it failed somewhere and
    // never passed — a pass elsewhere means the failure was device-specific and
    // belongs to that run, not to the release.
    if (!statuses.includes('pass') && (statuses.includes('fail') || statuses.includes('blocked'))) failed += 1;
    if (c.priority === 'blocker' && blockerOutstanding(statuses)) outstandingBlockers.push(c.caseId);
  }

  const perRun = runs.map((run) => {
    const own = results.filter((r) => String(r.runId) === String(run._id));
    const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0, na: 0 };
    for (const r of own) if (counts[r.status] !== undefined) counts[r.status] += 1;
    return {
      _id: run._id,
      name: run.name,
      status: run.status,
      environment: run.environment,
      executed: own.length,
      counts,
    };
  });

  return {
    totalCases: cases.length,
    executed,
    unexecuted: cases.length - executed,
    passed,
    failed,
    // Share of EXECUTED cases that passed — an unexecuted case is unknown, not a
    // failure, and folding it into the denominator would make an early run look
    // like a catastrophe.
    passRate: executed ? Math.round((passed / executed) * 100) : 0,
    byStatus,
    outstandingBlockers,
    canSignOff: outstandingBlockers.length === 0,
    perRun,
  };
}

module.exports = { summarizeRelease, blockerOutstanding };
