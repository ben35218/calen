/**
 * Import a test-plan document into the QA case library (spec:
 * features/release-qa.md) from the command line — the same parser and the same
 * upsert the admin portal's Import dialog runs, for seeding a fresh database or
 * scripting the import from CI.
 *
 *   node src/scripts/importTestCases.js docs/PRE-RELEASE-TEST-PLAN.md            # DRY RUN (default)
 *   node src/scripts/importTestCases.js docs/PRE-RELEASE-TEST-PLAN.md --commit   # write
 *   node src/scripts/importTestCases.js cases.csv --format csv --commit
 *   node src/scripts/importTestCases.js plan.md --source docs/other-plan.md --commit
 *
 * Dry run by default, like every other script here: an import can retire
 * hundreds of cases at once, and the four counts are what you check before
 * letting it.
 *
 * `--source` is the document identity cases are matched against. It defaults to
 * the path you passed, relative to the repo root — and it MATTERS: retiring is
 * scoped to one source document, so importing a second plan under the wrong
 * source name would retire the first one's cases.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const TestCase = require('../models/TestCase');
const { parseCases, diffCases } = require('../services/qaImport');

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const file = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

if (!file) {
  console.error('Usage: node src/scripts/importTestCases.js <file> [--format markdown|csv] [--source <doc>] [--commit]');
  process.exit(2);
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const abs = path.resolve(process.cwd(), file);
const defaultSource = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
const sourceDoc = flag('source', defaultSource);
const format = flag('format', /\.csv$/i.test(file) ? 'csv' : 'markdown');

(async () => {
  if (!fs.existsSync(abs)) {
    console.error(`No such file: ${abs}`);
    process.exit(2);
  }
  const content = fs.readFileSync(abs, 'utf8');
  const { cases, warnings } = parseCases(format, content, { sourceDoc });

  if (!cases.length) {
    console.error(`Parsed 0 cases from ${file} as ${format}. Refusing — this would retire the whole library.`);
    warnings.slice(0, 10).forEach((w) => console.error(`  ! ${w}`));
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exit(2);
  }
  await mongoose.connect(uri);

  const existing = await TestCase.find({}).select('caseId contentHash source sourceDoc active').lean();
  const diff = diffCases(cases, existing, { sourceDoc });

  console.log(`\n${commit ? 'IMPORT' : 'DRY RUN'} — ${file} (${format}) as "${sourceDoc}"`);
  console.log(`  parsed:    ${cases.length}`);
  console.log(`  added:     ${diff.added.length}`);
  console.log(`  updated:   ${diff.updated.length}`);
  console.log(`  unchanged: ${diff.unchanged.length}`);
  console.log(`  retired:   ${diff.missing.length}${diff.missing.length ? `  (${diff.missing.slice(0, 20).join(', ')}${diff.missing.length > 20 ? ', …' : ''})` : ''}`);
  for (const w of [...warnings, ...diff.warnings].slice(0, 20)) console.log(`  ! ${w}`);

  if (!commit) {
    console.log('\nDry run — nothing written. Re-run with --commit to apply.\n');
    await mongoose.disconnect();
    return;
  }

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
  // Flagged, never deleted — their results are evidence of a test that ran.
  if (diff.missing.length) {
    ops.push({
      updateMany: {
        filter: { caseId: { $in: diff.missing } },
        update: { $set: { active: false, retiredAt: now } },
      },
    });
  }
  if (ops.length) await TestCase.bulkWrite(ops, { ordered: false });

  const total = await TestCase.countDocuments({ active: true });
  console.log(`\nDone. ${total} active cases in the library.\n`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
