// Release QA server surfaces (specs/features/release-qa.md): the requireAdmin
// gate, release CRUD + the unique-build constraint, the import's dry-run /
// commit / idempotence / retire-not-delete contract, result upsert semantics,
// and the sign-off gate. Real app + in-memory MongoDB.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const TestCase = require('../models/TestCase');
const TestRun = require('../models/TestRun');
const TestResult = require('../models/TestResult');
const Release = require('../models/Release');

let admin;
let plain;

const DOC = `
## 1. Auth

Spec: [auth-identity.md](../specs/features/auth-identity.md)

- [ ] **AUTH-01** — Sign in works → the app opens.
- [ ] **AUTH-02** — Password change re-wraps the key. **⛔ BLOCKER**

## 2. Calendar

- [ ] **CAL-01** — An event saves.
`;

const importDoc = (content, extra = {}) => request()
  .post('/api/admin/qa/cases/import')
  .set('Authorization', admin.auth)
  .send({ format: 'markdown', content, sourceDoc: 'docs/plan.md', dryRun: false, ...extra });

async function makeRelease(over = {}) {
  const res = await request().post('/api/admin/qa/releases').set('Authorization', admin.auth).send({
    version: '1.0.0', buildNumber: String(Math.floor(Math.random() * 1e6)), channel: 'testflight', ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  await startDb();
  admin = await registerUser({ firstName: 'Ada' });
  plain = await registerUser({ firstName: 'Bob' });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'admin' } });
});
after(stopDb);

beforeEach(async () => {
  await Promise.all([
    TestCase.deleteMany({}), TestRun.deleteMany({}), TestResult.deleteMany({}),
    Release.deleteMany({}), AuditLog.deleteMany({}),
  ]);
});

test('every QA surface 403s for a non-admin and answers for an admin', async () => {
  for (const path of ['/api/admin/qa/releases', '/api/admin/qa/cases', '/api/admin/qa/runs']) {
    const denied = await request().get(path).set('Authorization', plain.auth);
    assert.equal(denied.status, 403, `${path} must 403 for role=user`);
    const ok = await request().get(path).set('Authorization', admin.auth);
    assert.equal(ok.status, 200, `${path} must 200 for role=admin`);
  }
  const unauth = await request().get('/api/admin/qa/releases');
  assert.equal(unauth.status, 401);
});

// --- Releases ---------------------------------------------------------------

test('a release requires a version and a build number', async () => {
  const res = await request().post('/api/admin/qa/releases').set('Authorization', admin.auth)
    .send({ version: '1.0.0' });
  assert.equal(res.status, 400);
});

test('the same build cannot be recorded twice on one channel', async () => {
  await makeRelease({ buildNumber: '42' });
  const dup = await request().post('/api/admin/qa/releases').set('Authorization', admin.auth)
    .send({ version: '1.0.0', buildNumber: '42', channel: 'testflight' });
  assert.equal(dup.status, 409);
  // ...but the same build on a different channel is a different artifact.
  const other = await request().post('/api/admin/qa/releases').set('Authorization', admin.auth)
    .send({ version: '1.0.0', buildNumber: '42', channel: 'app-store' });
  assert.equal(other.status, 201);
});

test('creating a release and changing its status are audited', async () => {
  const rel = await makeRelease();
  const upd = await request().put(`/api/admin/qa/releases/${rel._id}`).set('Authorization', admin.auth)
    .send({ status: 'testing', tag: 'testflight/1.0.0-42' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.status, 'testing');
  assert.equal(upd.body.tag, 'testflight/1.0.0-42');

  const events = (await AuditLog.find({}).lean()).map((a) => a.event);
  assert.ok(events.includes('qa_release_created'));
  assert.ok(events.includes('qa_release_status_changed'));

  // An update that doesn't move the status writes no second audit row.
  await request().put(`/api/admin/qa/releases/${rel._id}`).set('Authorization', admin.auth)
    .send({ status: 'testing', notes: 'x' });
  assert.equal(await AuditLog.countDocuments({ event: 'qa_release_status_changed' }), 1);
});

test('an unknown release status is refused', async () => {
  const rel = await makeRelease();
  const res = await request().put(`/api/admin/qa/releases/${rel._id}`).set('Authorization', admin.auth)
    .send({ status: 'shipped-ish' });
  assert.equal(res.status, 400);
});

// --- Import -----------------------------------------------------------------

test('a dry run reports the diff and writes nothing', async () => {
  const res = await request().post('/api/admin/qa/cases/import').set('Authorization', admin.auth)
    .send({ format: 'markdown', content: DOC, sourceDoc: 'docs/plan.md', dryRun: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.counts.added, 3);
  assert.equal(await TestCase.countDocuments({}), 0);
});

test('committing an import creates the cases with their parsed metadata', async () => {
  const res = await importDoc(DOC);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.counts, { added: 3, updated: 0, unchanged: 0, missing: 0 });

  const rows = await TestCase.find({}).sort({ caseId: 1 }).lean();
  assert.deepEqual(rows.map((r) => r.caseId), ['AUTH-01', 'AUTH-02', 'CAL-01']);
  const auth02 = rows.find((r) => r.caseId === 'AUTH-02');
  assert.equal(auth02.priority, 'blocker');
  assert.equal(auth02.specPath, '../specs/features/auth-identity.md');
  assert.equal(auth02.source, 'repo');
  assert.equal(auth02.sourceDoc, 'docs/plan.md');
  assert.ok(auth02.contentHash);

  const audit = await AuditLog.findOne({ event: 'qa_cases_imported' }).lean();
  assert.equal(audit.meta.added, 3);
  assert.equal(audit.meta.sourceDoc, 'docs/plan.md');
});

test('re-importing the same document is a no-op', async () => {
  await importDoc(DOC);
  const again = await importDoc(DOC);
  assert.deepEqual(again.body.counts, { added: 0, updated: 0, unchanged: 3, missing: 0 });
  assert.equal(await TestCase.countDocuments({}), 3);
});

test('edited wording updates the case in place', async () => {
  await importDoc(DOC);
  const edited = DOC.replace('An event saves.', 'An event saves and syncs.');
  const res = await importDoc(edited);
  assert.equal(res.body.counts.updated, 1);
  assert.equal(res.body.counts.unchanged, 2);
  const cal = await TestCase.findOne({ caseId: 'CAL-01' }).lean();
  assert.match(cal.steps, /saves and syncs/);
});

test('a case dropped from the document is retired, never deleted, and keeps its results', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id, environment: { device: 'SE' } })).body;
  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'CAL-01', status: 'pass' }] });

  const trimmed = DOC.split('## 2. Calendar')[0];
  const res = await importDoc(trimmed);
  assert.deepEqual(res.body.missing, ['CAL-01']);

  const cal = await TestCase.findOne({ caseId: 'CAL-01' }).lean();
  assert.ok(cal, 'the case must still exist');
  assert.equal(cal.active, false);
  assert.ok(cal.retiredAt);
  assert.equal(await TestResult.countDocuments({ caseId: 'CAL-01' }), 1, 'its evidence must survive');
});

test('a document that parses to nothing is refused rather than retiring the library', async () => {
  await importDoc(DOC);
  const res = await importDoc('# Just a heading\n\nNo checklist here.\n');
  assert.equal(res.status, 400);
  assert.equal(await TestCase.countDocuments({ active: true }), 3, 'nothing may be retired');
});

test('importing a second document leaves the first one\'s cases alone', async () => {
  await importDoc(DOC);
  const other = '## 9. Other\n\n- [ ] **OTH-01** — something else\n';
  const res = await importDoc(other, { sourceDoc: 'docs/other.md' });
  assert.deepEqual(res.body.missing, []);
  assert.equal(await TestCase.countDocuments({ active: true }), 4);
});

test('an imported case cannot be edited in the portal', async () => {
  await importDoc(DOC);
  const row = await TestCase.findOne({ caseId: 'AUTH-01' }).lean();
  const res = await request().put(`/api/admin/qa/cases/${row._id}`).set('Authorization', admin.auth)
    .send({ title: 'rewritten' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /imported document/);
});

test('a portal-authored case is editable and survives an import', async () => {
  await importDoc(DOC);
  const created = await request().post('/api/admin/qa/cases').set('Authorization', admin.auth)
    .send({ caseId: 'MAN-01', title: 'One-off check', priority: 'minor' });
  assert.equal(created.status, 201);

  const edited = await request().put(`/api/admin/qa/cases/${created.body._id}`).set('Authorization', admin.auth)
    .send({ title: 'One-off check, revised' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, 'One-off check, revised');

  const res = await importDoc(DOC);
  assert.deepEqual(res.body.missing, [], 'a manual case is never reported missing');
  const man = await TestCase.findOne({ caseId: 'MAN-01' }).lean();
  assert.equal(man.active, true);
  assert.equal(man.title, 'One-off check, revised');
});

test('the case list filters by section, priority and search, and hides retired cases', async () => {
  await importDoc(DOC);
  await importDoc(DOC.split('## 2. Calendar')[0]); // retires CAL-01

  const all = await request().get('/api/admin/qa/cases').set('Authorization', admin.auth);
  assert.equal(all.body.total, 2);
  assert.equal(all.body.blockerCount, 1);
  assert.ok(all.body.sections.includes('1. Auth'));

  const retired = await request().get('/api/admin/qa/cases?active=false').set('Authorization', admin.auth);
  assert.deepEqual(retired.body.items.map((i) => i.caseId), ['CAL-01']);

  const blockers = await request().get('/api/admin/qa/cases?priority=blocker').set('Authorization', admin.auth);
  assert.deepEqual(blockers.body.items.map((i) => i.caseId), ['AUTH-02']);

  const search = await request().get('/api/admin/qa/cases?q=re-wraps').set('Authorization', admin.auth);
  assert.deepEqual(search.body.items.map((i) => i.caseId), ['AUTH-02']);
});

// --- Runs & results ---------------------------------------------------------

test('a run needs a real release', async () => {
  const bad = await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: 'nope' });
  assert.equal(bad.status, 400);
  const missing = await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: '64b7f9c2f1a2c3d4e5f60718' });
  assert.equal(missing.status, 404);
});

test('recording a result twice overwrites rather than appending', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id, environment: { device: 'SE', osVersion: '18.1' } })).body;

  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'fail', note: 'mis-tap' }] });
  const second = await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'pass', note: '' }] });

  assert.equal(second.status, 200);
  assert.equal(await TestResult.countDocuments({ runId: run._id, caseId: 'AUTH-01' }), 1);
  const row = await TestResult.findOne({ runId: run._id, caseId: 'AUTH-01' }).lean();
  assert.equal(row.status, 'pass');
  assert.equal(row.note, '');
  assert.equal(String(row.releaseId), String(rel._id), 'the result carries the release for the rollup');
});

test('an unknown result status is refused for the whole batch', async () => {
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id })).body;
  const res = await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'pass' }, { caseId: 'AUTH-02', status: 'maybe' }] });
  assert.equal(res.status, 400);
  assert.equal(await TestResult.countDocuments({}), 0, 'no partial write');
});

test('completing a run is audited and records how much was executed', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id })).body;
  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'pass' }] });

  const done = await request().post(`/api/admin/qa/runs/${run._id}/complete`).set('Authorization', admin.auth).send({});
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'complete');
  assert.ok(done.body.completedAt);

  const audit = await AuditLog.findOne({ event: 'qa_run_completed' }).lean();
  assert.equal(audit.meta.results, 1);
});

test('a case\'s history reports its results across runs and releases, newest first', async () => {
  await importDoc(DOC);
  const row = await TestCase.findOne({ caseId: 'AUTH-01' }).lean();

  // Nothing recorded yet → an empty history, not an error.
  const empty = await request().get(`/api/admin/qa/cases/${row._id}/history`).set('Authorization', admin.auth);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.results, []);

  const rel = await makeRelease({ version: '2.0.0' });
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id, environment: { device: 'iPhone SE' } })).body;
  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'fail', note: 'saw it break' }] });

  const res = await request().get(`/api/admin/qa/cases/${row._id}/history`).set('Authorization', admin.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.caseId, 'AUTH-01');
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].status, 'fail');
  assert.equal(res.body.results[0].note, 'saw it break');
  assert.equal(res.body.results[0].run.device, 'iPhone SE');
  assert.equal(res.body.results[0].release.version, '2.0.0');

  const bogus = await request().get('/api/admin/qa/cases/64b7f9c2f1a2c3d4e5f60718/history')
    .set('Authorization', admin.auth);
  assert.equal(bogus.status, 404);
});

// --- Summary & the sign-off gate --------------------------------------------

test('the summary reports coverage across every run on the release', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const runA = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id, environment: { device: 'SE' } })).body;
  const runB = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id, environment: { device: 'iPad' } })).body;

  await request().post(`/api/admin/qa/runs/${runA._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'pass' }, { caseId: 'AUTH-02', status: 'fail' }] });
  await request().post(`/api/admin/qa/runs/${runB._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-02', status: 'pass' }] });

  const res = await request().get(`/api/admin/qa/releases/${rel._id}/summary`).set('Authorization', admin.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCases, 3);
  assert.equal(res.body.executed, 2);
  assert.equal(res.body.passed, 2);
  assert.equal(res.body.failed, 0, 'a pass on the other run clears the release-level failure');
  assert.equal(res.body.perRun.length, 2);
});

test('sign-off is refused while a blocker is unexecuted, and names it', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const res = await request().post(`/api/admin/qa/releases/${rel._id}/sign-off`)
    .set('Authorization', admin.auth).send({});
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.blockers, ['AUTH-02']);
  assert.equal(await AuditLog.countDocuments({ event: 'qa_release_signed_off' }), 0);
});

test('sign-off is refused while a blocker is failing', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id })).body;
  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-02', status: 'fail', note: 'reproduces' }] });

  const res = await request().post(`/api/admin/qa/releases/${rel._id}/sign-off`)
    .set('Authorization', admin.auth).send({});
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.blockers, ['AUTH-02']);
});

test('sign-off is accepted once the blocker passes on any one run, and is audited', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id })).body;
  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-02', status: 'pass' }, { caseId: 'CAL-01', status: 'fail' }] });

  const res = await request().post(`/api/admin/qa/releases/${rel._id}/sign-off`)
    .set('Authorization', admin.auth).send({ note: 'Shipping it.' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.signOff.note, 'Shipping it.');
  assert.ok(res.body.signOff.at);
  assert.equal(String(res.body.signOff.byUserId), String(admin.user._id));

  const audit = await AuditLog.findOne({ event: 'qa_release_signed_off' }).lean();
  assert.equal(audit.meta.totalCases, 3);
});

test('a retired blocker no longer gates sign-off', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  // Drop the blocker from the document: it retires, and a retired case is not
  // work the release still owes.
  await importDoc(DOC.replace('- [ ] **AUTH-02** — Password change re-wraps the key. **⛔ BLOCKER**\n', ''));

  const res = await request().post(`/api/admin/qa/releases/${rel._id}/sign-off`)
    .set('Authorization', admin.auth).send({});
  assert.equal(res.status, 200);
});

// The parser's unit tests use a miniature document; this proves the REAL plan
// imports through the real route — the one thing a fixture can't tell us, and
// the file this whole surface exists to run.
test('the repo\'s own pre-release plan imports end to end', async () => {
  const fs = require('fs');
  const path = require('path');
  const planPath = path.resolve(__dirname, '../../../docs/PRE-RELEASE-TEST-PLAN.md');
  if (!fs.existsSync(planPath)) return; // the suite must not depend on a doc's location

  const content = fs.readFileSync(planPath, 'utf8');
  const res = await request().post('/api/admin/qa/cases/import').set('Authorization', admin.auth)
    .send({ format: 'markdown', content, sourceDoc: 'docs/PRE-RELEASE-TEST-PLAN.md', dryRun: false });

  assert.equal(res.status, 200);
  assert.ok(res.body.counts.added > 150, `expected the full plan, got ${res.body.counts.added} cases`);
  assert.deepEqual(res.body.warnings, [], 'the real plan must parse without warnings');

  // The ⛔ markers are load-bearing: they are what the sign-off gate refuses on.
  const blockers = await TestCase.countDocuments({ priority: 'blocker' });
  assert.ok(blockers > 30, `expected the plan's blocker cases, got ${blockers}`);
  // Spec links in a section preamble reach the cases under it.
  const spot = await TestCase.findOne({ caseId: 'REPEAT-03' }).lean();
  assert.ok(spot, 'REPEAT-03 must survive the round trip');
  assert.equal(spot.priority, 'blocker');
  assert.match(spot.specPath, /calendar\.md$/);

  const again = await request().post('/api/admin/qa/cases/import').set('Authorization', admin.auth)
    .send({ format: 'markdown', content, sourceDoc: 'docs/PRE-RELEASE-TEST-PLAN.md', dryRun: false });
  assert.equal(again.body.counts.added, 0, 're-importing the plan must be a no-op');
  assert.equal(again.body.counts.updated, 0);
  assert.equal(again.body.counts.missing, 0);
});

test('the releases list carries each release\'s own rollup', async () => {
  await importDoc(DOC);
  const rel = await makeRelease();
  const run = (await request().post('/api/admin/qa/runs').set('Authorization', admin.auth)
    .send({ releaseId: rel._id })).body;
  await request().post(`/api/admin/qa/runs/${run._id}/results`).set('Authorization', admin.auth)
    .send({ results: [{ caseId: 'AUTH-01', status: 'pass' }] });

  const res = await request().get('/api/admin/qa/releases').set('Authorization', admin.auth);
  const row = res.body.items.find((r) => String(r._id) === String(rel._id));
  assert.equal(row.runCount, 1);
  assert.equal(row.summary.executed, 1);
  assert.equal(row.summary.passRate, 100);
  assert.equal(row.summary.outstandingBlockers, 1);
  assert.equal(row.summary.canSignOff, false);
});
