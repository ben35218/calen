// Release QA: the admin-portal surface for managing a public release's test
// pass (spec: features/release-qa.md). All routes are requireAuth + requireAdmin.
//
//   GET/POST   /api/admin/qa/releases              → list / create
//   GET/PUT    /api/admin/qa/releases/:id          → read / update
//   GET        /api/admin/qa/releases/:id/summary  → coverage + outstanding blockers
//   POST       /api/admin/qa/releases/:id/sign-off → gated (409 while a blocker is outstanding)
//   GET        /api/admin/qa/cases                 → paginated library
//   PUT        /api/admin/qa/cases/:id             → edit a portal-authored case
//   POST       /api/admin/qa/cases/import          → { format, content, dryRun, sourceDoc }
//   GET/POST   /api/admin/qa/runs                  → list by release / start
//   GET        /api/admin/qa/runs/:id              → run + its results
//   POST       /api/admin/qa/runs/:id/results      → bulk upsert
//   POST       /api/admin/qa/runs/:id/complete     → close
//
// Parsing/diffing (qaImport) and the coverage rollup (qaSummary) are pure and
// unit-tested; this file owns request handling, persistence, and auditing.

const express = require('express');
const mongoose = require('mongoose');
const Release = require('../models/Release');
const TestCase = require('../models/TestCase');
const TestRun = require('../models/TestRun');
const TestResult = require('../models/TestResult');
const AuditLog = require('../models/AuditLog');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { paginate } = require('./adminHelpers');
const { parseCases, hashCase, diffCases } = require('../services/qaImport');
const { summarizeRelease } = require('../services/qaSummary');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const RELEASE_STATUSES = ['planning', 'testing', 'submitted', 'released', 'rolled-back'];
const RESULT_STATUSES = ['pass', 'fail', 'blocked', 'skipped', 'na'];

const badId = (id) => !mongoose.isValidObjectId(id);

// --- Releases ---------------------------------------------------------------

router.get('/releases', async (req, res) => {
  try {
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 25, maxSize: 100 });
    const filter = {};
    if (RELEASE_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (['testflight', 'app-store', 'play'].includes(req.query.channel)) filter.channel = req.query.channel;

    const [total, rows] = await Promise.all([
      Release.countDocuments(filter),
      Release.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);

    // Each row carries its own rollup so the list can show a pass rate and a
    // blocker count without the client fanning out one summary call per row.
    const ids = rows.map((r) => r._id);
    const [cases, results, runs] = await Promise.all([
      TestCase.find({ active: true }).select('caseId priority').lean(),
      TestResult.find({ releaseId: { $in: ids } }).select('releaseId runId caseId status').lean(),
      TestRun.find({ releaseId: { $in: ids } }).select('releaseId status').lean(),
    ]);

    res.json({
      items: rows.map((r) => {
        const own = results.filter((x) => String(x.releaseId) === String(r._id));
        const s = summarizeRelease({ cases, results: own, runs: [] });
        return {
          ...r,
          runCount: runs.filter((x) => String(x.releaseId) === String(r._id)).length,
          summary: {
            totalCases: s.totalCases,
            executed: s.executed,
            passed: s.passed,
            failed: s.failed,
            passRate: s.passRate,
            outstandingBlockers: s.outstandingBlockers.length,
            canSignOff: s.canSignOff,
          },
        };
      }),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/releases', async (req, res) => {
  try {
    const { version, buildNumber, channel, tag, commitSha, notes, status } = req.body || {};
    if (!String(version || '').trim() || !String(buildNumber || '').trim()) {
      return res.status(400).json({ error: 'version and buildNumber are required' });
    }
    // The unique (version, buildNumber, channel) index IS the guard against a
    // build's evidence being split across two records, so it has to exist before
    // the insert — index builds are async at startup, and without this a create
    // racing a cold process silently succeeds twice. Same pattern (and same
    // reason) as CreditLedger.grant's idempotency gate; init() caches, so it is
    // a one-time cost.
    await Release.init();
    const doc = await Release.create({
      version: String(version).trim(),
      buildNumber: String(buildNumber).trim(),
      channel: ['testflight', 'app-store', 'play'].includes(channel) ? channel : 'testflight',
      tag: String(tag || '').trim(),
      commitSha: String(commitSha || '').trim(),
      notes: String(notes || ''),
      status: RELEASE_STATUSES.includes(status) ? status : 'planning',
    });
    await AuditLog.create({
      userId: req.user._id,
      event: 'qa_release_created',
      meta: { releaseId: doc._id, version: doc.version, buildNumber: doc.buildNumber, channel: doc.channel },
    });
    res.status(201).json(doc.toObject());
  } catch (err) {
    // The unique (version, buildNumber, channel) index is the real guard against
    // a build's evidence being split across two records.
    if (err.code === 11000) {
      return res.status(409).json({ error: 'That build already exists for this channel.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/releases/:id', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const doc = await Release.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/releases/:id', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const before = await Release.findById(req.params.id).select('status').lean();
    if (!before) return res.status(404).json({ error: 'Not found' });

    const set = {};
    for (const k of ['tag', 'commitSha', 'notes']) {
      if (req.body?.[k] !== undefined) set[k] = String(req.body[k]);
    }
    if (req.body?.status !== undefined) {
      if (!RELEASE_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: `status must be one of ${RELEASE_STATUSES.join(', ')}` });
      }
      set.status = req.body.status;
    }
    const doc = await Release.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();

    if (set.status && set.status !== before.status) {
      await AuditLog.create({
        userId: req.user._id,
        event: 'qa_release_status_changed',
        meta: { releaseId: doc._id, from: before.status, to: set.status },
      });
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The one place coverage is computed. The sign-off gate below reads the SAME
// helper, so the screen and the gate can never disagree.
async function buildSummary(releaseId) {
  const [cases, results, runs] = await Promise.all([
    TestCase.find({ active: true }).select('caseId priority section').lean(),
    TestResult.find({ releaseId }).select('runId caseId status').lean(),
    TestRun.find({ releaseId }).sort({ startedAt: 1 }).lean(),
  ]);
  return summarizeRelease({ cases, results, runs });
}

router.get('/releases/:id/summary', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const release = await Release.findById(req.params.id).lean();
    if (!release) return res.status(404).json({ error: 'Not found' });
    res.json({ release, ...(await buildSummary(release._id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sign-off refuses (409) while a blocker case is unexecuted or failing, and
// NAMES the offenders — a bare refusal the admin can't act on would just get
// worked around. Re-signing overwrites: a corrected release beats an accurate
// but stale record.
router.post('/releases/:id/sign-off', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const release = await Release.findById(req.params.id).lean();
    if (!release) return res.status(404).json({ error: 'Not found' });

    const summary = await buildSummary(release._id);
    if (!summary.canSignOff) {
      return res.status(409).json({
        error: `${summary.outstandingBlockers.length} blocker case(s) are unexecuted or failing.`,
        blockers: summary.outstandingBlockers,
      });
    }

    const doc = await Release.findByIdAndUpdate(
      release._id,
      { $set: { signOff: { byUserId: req.user._id, at: new Date(), note: String(req.body?.note || '') } } },
      { new: true },
    ).lean();
    await AuditLog.create({
      userId: req.user._id,
      event: 'qa_release_signed_off',
      meta: {
        releaseId: doc._id,
        version: doc.version,
        buildNumber: doc.buildNumber,
        executed: summary.executed,
        totalCases: summary.totalCases,
        passRate: summary.passRate,
      },
    });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Test cases -------------------------------------------------------------

router.get('/cases', async (req, res) => {
  try {
    const { page, pageSize, skip } = paginate(req.query, { defaultSize: 50, maxSize: 500 });
    const filter = {};
    if (req.query.section) filter.section = req.query.section;
    if (TestCase.PRIORITIES.includes(req.query.priority)) filter.priority = req.query.priority;
    if (['repo', 'manual'].includes(req.query.source)) filter.source = req.query.source;
    // Retired cases are hidden unless asked for — they are history, not work.
    if (req.query.active === 'false') filter.active = false;
    else if (req.query.active !== 'all') filter.active = true;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ caseId: rx }, { title: rx }, { steps: rx }, { expected: rx }, { section: rx }];
    }

    const [total, items, sections, blockerCount] = await Promise.all([
      TestCase.countDocuments(filter),
      TestCase.find(filter).sort({ section: 1, caseId: 1 }).skip(skip).limit(pageSize).lean(),
      TestCase.distinct('section', { active: true }),
      TestCase.countDocuments({ active: true, priority: 'blocker' }),
    ]);
    res.json({ items, total, page, pageSize, sections: sections.filter(Boolean).sort(), blockerCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A case's results across every run and release, newest first — what the
// library's detail view shows so "has this ever passed, and where?" is
// answerable without opening each run.
router.get('/cases/:id/history', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const tc = await TestCase.findById(req.params.id).select('caseId').lean();
    if (!tc) return res.status(404).json({ error: 'Not found' });

    const rows = await TestResult.find({ caseId: tc.caseId })
      .sort({ at: -1 }).limit(100).lean();
    const runIds = [...new Set(rows.map((r) => String(r.runId)))];
    const releaseIds = [...new Set(rows.map((r) => String(r.releaseId)))];
    const [runs, releases] = await Promise.all([
      TestRun.find({ _id: { $in: runIds } }).select('name environment status').lean(),
      Release.find({ _id: { $in: releaseIds } }).select('version buildNumber channel').lean(),
    ]);
    const runById = Object.fromEntries(runs.map((r) => [String(r._id), r]));
    const relById = Object.fromEntries(releases.map((r) => [String(r._id), r]));

    res.json({
      caseId: tc.caseId,
      results: rows.map((r) => ({
        _id: r._id,
        runId: r.runId,
        status: r.status,
        note: r.note,
        at: r.at,
        run: runById[String(r.runId)]
          ? { name: runById[String(r.runId)].name, device: runById[String(r.runId)].environment?.device || '' }
          : null,
        release: relById[String(r.releaseId)]
          ? {
            _id: r.releaseId,
            version: relById[String(r.releaseId)].version,
            buildNumber: relById[String(r.releaseId)].buildNumber,
          }
          : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Only portal-authored cases are editable here: a repo case's wording belongs to
// the document it came from, and editing it would be silently reverted by the
// next import — which is worse than refusing.
router.put('/cases/:id', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const existing = await TestCase.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.source !== 'manual') {
      return res.status(409).json({
        error: 'This case is owned by an imported document. Edit it there and re-import.',
      });
    }
    const set = {};
    for (const k of ['section', 'title', 'steps', 'expected', 'specPath']) {
      if (req.body?.[k] !== undefined) set[k] = String(req.body[k]);
    }
    if (req.body?.priority !== undefined) {
      if (!TestCase.PRIORITIES.includes(req.body.priority)) {
        return res.status(400).json({ error: `priority must be one of ${TestCase.PRIORITIES.join(', ')}` });
      }
      set.priority = req.body.priority;
    }
    if (req.body?.active !== undefined) set.active = !!req.body.active;
    if (Array.isArray(req.body?.tags)) set.tags = req.body.tags.map(String).slice(0, 20);

    const doc = await TestCase.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a portal-authored case (a one-off check that doesn't belong in the plan).
router.post('/cases', async (req, res) => {
  try {
    const caseId = String(req.body?.caseId || '').trim();
    if (!caseId) return res.status(400).json({ error: 'caseId is required' });
    const doc = await TestCase.create({
      caseId,
      section: String(req.body?.section || ''),
      title: String(req.body?.title || ''),
      steps: String(req.body?.steps || ''),
      expected: String(req.body?.expected || ''),
      priority: TestCase.PRIORITIES.includes(req.body?.priority) ? req.body.priority : 'major',
      specPath: String(req.body?.specPath || ''),
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String).slice(0, 20) : [],
      source: 'manual',
    });
    res.status(201).json(doc.toObject());
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A case with that id already exists.' });
    res.status(500).json({ error: err.message });
  }
});

// Import a plan document. `dryRun: true` parses and diffs but writes NOTHING —
// the portal shows that diff and requires a confirm before committing, because
// an import can retire hundreds of cases at once.
// The body limit for this path is raised in app.js (a plan document is ~150 KB,
// over the global default) — it must be mounted there, ahead of the global JSON
// parser, or that one rejects the request before this router is reached.
router.post('/cases/import', async (req, res) => {
  try {
    const { format = 'markdown', content = '', sourceDoc = '', dryRun = true } = req.body || {};
    if (!String(content).trim()) return res.status(400).json({ error: 'content is required' });

    const doc = String(sourceDoc || '').trim();
    const { cases: parsed, warnings } = parseCases(format, content, { sourceDoc: doc });
    // Nearly always the wrong file — and committing it would flag the whole
    // library missing, so it is refused rather than confirmed away.
    if (!parsed.length) {
      return res.status(400).json({
        error: 'No test cases were found in that document.',
        warnings,
      });
    }

    const existing = await TestCase.find({}).select('caseId contentHash source sourceDoc active').lean();
    const diff = diffCases(parsed, existing, { sourceDoc: doc });
    const report = {
      dryRun: !!dryRun,
      sourceDoc: doc,
      format,
      counts: {
        added: diff.added.length,
        updated: diff.updated.length,
        unchanged: diff.unchanged.length,
        missing: diff.missing.length,
      },
      added: diff.added.map((c) => ({ caseId: c.caseId, section: c.section, title: c.title, priority: c.priority })),
      updated: diff.updated.map((c) => ({ caseId: c.caseId, section: c.section, title: c.title, priority: c.priority })),
      missing: diff.missing,
      warnings: [...warnings, ...diff.warnings],
    };

    if (dryRun) return res.json(report);

    const now = new Date();
    const ops = [...diff.added, ...diff.updated].map((c) => ({
      updateOne: {
        filter: { caseId: c.caseId },
        update: {
          $set: {
            section: c.section,
            title: c.title,
            steps: c.steps,
            expected: c.expected,
            priority: c.priority,
            specPath: c.specPath,
            tags: c.tags,
            source: 'repo',
            sourceDoc: c.sourceDoc,
            contentHash: c.contentHash,
            active: true,
            retiredAt: null,
          },
        },
        upsert: true,
      },
    }));
    // Missing cases are FLAGGED, never deleted: their results are real evidence
    // of a test that really ran.
    if (diff.missing.length) {
      ops.push({
        updateMany: {
          filter: { caseId: { $in: diff.missing } },
          update: { $set: { active: false, retiredAt: now } },
        },
      });
    }
    if (ops.length) await TestCase.bulkWrite(ops, { ordered: false });

    await AuditLog.create({
      userId: req.user._id,
      event: 'qa_cases_imported',
      meta: { sourceDoc: doc, format, ...report.counts },
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Runs & results ---------------------------------------------------------

router.get('/runs', async (req, res) => {
  try {
    const filter = {};
    if (req.query.releaseId) {
      if (badId(req.query.releaseId)) return res.status(400).json({ error: 'invalid releaseId' });
      filter.releaseId = req.query.releaseId;
    }
    const runs = await TestRun.find(filter).sort({ startedAt: -1 }).limit(200).lean();
    res.json({ items: runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/runs', async (req, res) => {
  try {
    const { releaseId, name, environment } = req.body || {};
    if (badId(releaseId)) return res.status(400).json({ error: 'a valid releaseId is required' });
    const release = await Release.findById(releaseId).select('_id').lean();
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const env = environment || {};
    const doc = await TestRun.create({
      releaseId,
      name: String(name || env.device || 'Run').trim(),
      environment: {
        device: String(env.device || ''),
        osVersion: String(env.osVersion || ''),
        build: String(env.build || ''),
        tester: String(env.tester || req.user.email || ''),
      },
      startedByUserId: req.user._id,
    });
    res.status(201).json(doc.toObject());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const run = await TestRun.findById(req.params.id).lean();
    if (!run) return res.status(404).json({ error: 'Not found' });
    const [release, results] = await Promise.all([
      Release.findById(run.releaseId).lean(),
      TestResult.find({ runId: run._id }).select('caseId status note at').lean(),
    ]);
    res.json({ run, release, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk upsert: re-answering a case OVERWRITES its row rather than appending, so
// a mis-tap is correctable without leaving a contradictory trail inside one run.
router.post('/runs/:id/results', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const run = await TestRun.findById(req.params.id).lean();
    if (!run) return res.status(404).json({ error: 'Not found' });

    const rows = Array.isArray(req.body?.results) ? req.body.results : [];
    if (!rows.length) return res.status(400).json({ error: 'results[] is required' });
    if (rows.length > 1000) return res.status(400).json({ error: 'too many results in one request (max 1000)' });

    const bad = rows.find((r) => !r?.caseId || !RESULT_STATUSES.includes(r.status));
    if (bad) {
      return res.status(400).json({
        error: `each result needs a caseId and a status of ${RESULT_STATUSES.join(', ')}`,
      });
    }

    const now = new Date();
    await TestResult.bulkWrite(rows.map((r) => ({
      updateOne: {
        filter: { runId: run._id, caseId: String(r.caseId) },
        update: {
          $set: {
            releaseId: run.releaseId,
            status: r.status,
            note: String(r.note || ''),
            byUserId: req.user._id,
            at: now,
          },
        },
        upsert: true,
      },
    })), { ordered: false });

    const results = await TestResult.find({ runId: run._id }).select('caseId status note at').lean();
    res.json({ saved: rows.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A run closes when the admin says so, not when every case has an answer — a
// partial run (the smoke subset on a secondary device) is a real artifact.
router.post('/runs/:id/complete', async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const status = req.body?.status === 'abandoned' ? 'abandoned' : 'complete';
    const run = await TestRun.findByIdAndUpdate(
      req.params.id,
      { $set: { status, completedAt: new Date() } },
      { new: true },
    ).lean();
    if (!run) return res.status(404).json({ error: 'Not found' });

    const count = await TestResult.countDocuments({ runId: run._id });
    await AuditLog.create({
      userId: req.user._id,
      event: 'qa_run_completed',
      meta: { runId: run._id, releaseId: run.releaseId, status, results: count },
    });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
