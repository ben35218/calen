#!/usr/bin/env node
// Spec-sync gate for spec-driven development (see specs/README.md → "The change loop").
//
// Checks, in order:
//   1. Spec drift  — changed code whose owning spec wasn't touched in the same change set.
//   2. Test drift  — changed feature code with no matching test change (per-rule `tests` glob).
//   3. Tests lint  — a `status: current` feature/platform spec must declare a non-empty
//                    `tests:` frontmatter list (empty = defect, like a spec with no `code:`).
//   4. Tests rot   — every entry in a spec's `tests:` must resolve to at least one existing
//                    path (a renamed/deleted suite silently drops coverage).
//
// Drift checks (1–2) look at the change set; repo checks (3–4) always run. All are
// advisory nudges unless --strict, which exits 1 on any finding (for CI that blocks).
//
// Usage:
//   node scripts/check-spec-sync.mjs                 # working tree (staged + unstaged) vs HEAD
//   node scripts/check-spec-sync.mjs --base main     # current branch vs merge-base with <base>
//   node scripts/check-spec-sync.mjs --strict        # exit 1 on any finding
//
// Exit codes: 0 = clean (or findings without --strict), 1 = findings with --strict, 2 = usage/git error.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const baseIdx = args.indexOf('--base');
const base = baseIdx !== -1 ? args[baseIdx + 1] : null;

// Ordered rules: first matching pattern wins per file. `specs` lists the spec
// files that must be touched when a matching code file changes. `tests` (optional)
// is the area's test-file pattern: when code matching `re` changes and no changed
// file matches `tests`, that is test drift. Test files matching `tests` are never
// themselves treated as code needing tests.
const RULES = [
  // Cross-cutting foundations — check these before the per-feature rules.
  { re: /^shared\/crypto\//, specs: ['specs/platform/crypto-e2ee.md'],
    tests: /^shared\/crypto\/src\/.*\.test\.(ts|js)$/ },
  { re: /^server\/src\/models\/(Record|encFields)\.js/, specs: ['specs/platform/data-model.md'],
    tests: /^server\/src\/test\/records\./ },
  { re: /^server\/src\/services\/(householdKey|keyEnvelope|e2eePolicy|securityAlerts)\.js/, specs: ['specs/platform/crypto-e2ee.md'],
    tests: /^(server\/src\/services\/(householdKey|keyEnvelope|e2eePolicy)\.test\.js|server\/src\/test\/(householdKey|keyHygiene|e2eeMandate|securityAlerts)\.)/ },
  { re: /^mobile\/src\/lib\/e2ee\.ts/, specs: ['specs/platform/crypto-e2ee.md'],
    tests: /^mobile\/src\/lib\/__tests__\/e2ee\./ },

  // Features.
  { re: /^(server\/src\/routes\/(auth|authPasskey)\.js|server\/src\/services\/sessions\.js|mobile\/src\/screens\/auth\/|mobile\/src\/store\/auth\.tsx|mobile\/src\/api\/client\.ts|mobile\/src\/lib\/(passkeys|secureToken|deviceId|deviceLink|deviceKey)\.ts)/, specs: ['specs/features/auth-identity.md'],
    tests: /^(server\/src\/test\/(authFlows|passwordlessRegister|sessions|deviceLink|recoveryMandate)\.|mobile\/src\/lib\/__tests__\/(passkeys|deviceKey|deviceLink)\.)/ },
  { re: /^(server\/src\/routes\/(household|keys)\.js|mobile\/src\/screens\/profile\/HouseholdScreen\.tsx|mobile\/src\/lib\/safetyNumbers\.ts)/, specs: ['specs/features/households-sharing.md'],
    tests: /^(server\/src\/test\/(householdInvitations|householdKey|keyHygiene|recoveryMandate)\.|mobile\/src\/lib\/__tests__\/(safetyNumbers|guardianRecovery)\.)/ },
  { re: /^(server\/src\/routes\/(calendars|calendarChat|eventAttachments|invitations)\.js|mobile\/src\/screens\/calendar\/|mobile\/src\/lib\/(calendar|calendarData|eventRepeat|calendarKeys|holidays)\.ts|shared\/calendar\/)/, specs: ['specs/features/calendar.md'],
    tests: /^(server\/src\/test\/(calendarKeys|customCalendars|authorHiding|drop|reDrop|invitations)\.|shared\/calendar\/index\.test\.js$|mobile\/src\/lib\/__tests__\/(calendarFeeds|calendarPrefs|calendarKeys|holidays|recurrence|tz|eventRepeat)\.)/ },
  { re: /^(server\/src\/routes\/(recipes|recipeSchedule)\.js|mobile\/src\/screens\/kitchen\/|mobile\/src\/lib\/grocery)/, specs: ['specs/features/kitchen.md'],
    tests: /^(server\/src\/test\/kitchen\.|mobile\/src\/(lib\/__tests__\/(groceryList|groceryAggregate|recipeIconTarget)\.|screens\/kitchen\/__tests__\/))/ },
  { re: /^(server\/src\/routes\/(items|tasks|chores|odometer|manuals|taskTemplates|choreTemplates)\.js|mobile\/src\/screens\/maintenance\/|server\/src\/services\/recurrence\.js|shared\/seed\/)/, specs: ['specs/features/maintenance.md'],
    tests: /^(server\/src\/test\/maintenance\.|server\/src\/services\/recurrence\.test\.js$|mobile\/src\/lib\/__tests__\/(odometer|diy)\.)/ },
  { re: /^(server\/src\/routes\/(trips|tripsChat)\.js|mobile\/src\/screens\/trips\/|mobile\/src\/lib\/tripKeys\.ts|server\/src\/services\/tripSharing\.js)/, specs: ['specs/features/trips.md'],
    tests: /^(server\/src\/test\/(tripKeys|tripShare|tripAttachments)\.|server\/src\/services\/tripSharing\.test\.js$|mobile\/src\/lib\/__tests__\/tripKeys\.)/ },
  { re: /^(server\/src\/routes\/people\.js|mobile\/src\/screens\/profile\/(People|Person|ContactImport))/, specs: ['specs/features/people-contacts.md'],
    tests: /^server\/src\/test\/people\./ },
  { re: /^(server\/src\/routes\/(calendarChat|choresChat|maintenanceChat|maintenancePlanChat|tripsChat|calls|formAssist)\.js|server\/src\/services\/(chatStream|chatSuggestions|aiUsage|phoneCalls)\.js|mobile\/src\/screens\/chat\/|mobile\/src\/lib\/aiPayload\.ts)/, specs: ['specs/features/ai-assistant.md'],
    tests: /^(server\/src\/test\/aiPrivacy\.|server\/src\/services\/phoneCalls\.test\.js$|server\/src\/middleware\/usageMeter\.tokens\.test\.js$|mobile\/src\/lib\/__tests__\/(aiPayload|aiWindow)\.)/ },
  { re: /^(server\/src\/routes\/(billing|monetizationConfig)\.js|mobile\/src\/screens\/plan\/|mobile\/src\/lib\/purchases\.ts|admin\/)/, specs: ['specs/features/billing-plans.md'],
    tests: /^(server\/src\/test\/billingWebhook\.|server\/src\/routes\/billing\.test\.js$)/ },
  { re: /^(server\/src\/routes\/notifications\.js|server\/src\/jobs\/scheduler\.js|server\/src\/services\/(push|notify)\.js|mobile\/src\/lib\/(notifications|push)\.ts)/, specs: ['specs/features/notifications.md'],
    tests: /^(server\/src\/test\/notifications\.|server\/src\/jobs\/scheduler\.test\.js$|mobile\/src\/lib\/__tests__\/notifications\.)/ },

  // Broad fallbacks — a route or model with no more-specific owner still owns the platform specs.
  { re: /^server\/src\/routes\//, specs: ['specs/platform/api-reference.md'] },
  { re: /^server\/src\/models\//, specs: ['specs/platform/data-model.md'] },
];

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`git ${cmd} failed: ${err.message}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Change set
// ---------------------------------------------------------------------------

let changed;
if (base) {
  const mb = git(`merge-base HEAD ${base}`);
  changed = git(`diff --name-only ${mb} HEAD`);
} else {
  // Working tree: staged + unstaged vs HEAD, plus untracked.
  const tracked = git('diff --name-only HEAD');
  const untracked = git('ls-files --others --exclude-standard');
  changed = [tracked, untracked].filter(Boolean).join('\n');
}

const files = changed.split('\n').map((f) => f.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// 1 + 2. Spec drift and test drift over the change set
// ---------------------------------------------------------------------------

const touchedSpecs = new Set(files.filter((f) => f.startsWith('specs/')));
const requiredByArea = new Map(); // spec path -> Set of code files that triggered it
const codeByRule = new Map(); // rule index -> Set of non-test code files changed
const testChangeByRule = new Map(); // rule index -> true when a matching test changed

for (const file of files) {
  if (file.startsWith('specs/')) continue;
  const idx = RULES.findIndex((r) => r.re.test(file) || (r.tests && r.tests.test(file)));
  if (idx === -1) continue;
  const rule = RULES[idx];
  if (rule.tests && rule.tests.test(file)) {
    testChangeByRule.set(idx, true);
    continue; // a test file is never itself code needing a spec/test update
  }
  if (!rule.re.test(file)) continue;
  if (rule.tests) {
    if (!codeByRule.has(idx)) codeByRule.set(idx, new Set());
    codeByRule.get(idx).add(file);
  }
  for (const spec of rule.specs) {
    if (!requiredByArea.has(spec)) requiredByArea.set(spec, new Set());
    requiredByArea.get(spec).add(file);
  }
}

const specDrift = [...requiredByArea.entries()].filter(([spec]) => !touchedSpecs.has(spec));
const testDrift = [...codeByRule.entries()]
  .filter(([idx]) => !testChangeByRule.has(idx))
  .map(([idx, codeFiles]) => [RULES[idx], codeFiles]);

// ---------------------------------------------------------------------------
// 3 + 4. Spec frontmatter lint (non-empty tests:) and tests-path rot
// ---------------------------------------------------------------------------

// Frontmatter: the YAML-ish block between the leading `---` fences. We only
// need `status:` and the `tests:` list, so a targeted parse beats a YAML dep.
function parseFrontmatter(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[0] !== '---') return { status: null, tests: null };
  const fm = { status: null, tests: null };
  let inTests = false;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const line = lines[i];
    const key = line.match(/^([a-z-]+):\s*(.*)$/);
    if (key) {
      inTests = key[1] === 'tests';
      if (inTests) fm.tests = [];
      if (key[1] === 'status') fm.status = key[2].split('#')[0].trim();
      continue;
    }
    if (inTests) {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item) fm.tests.push(item[1].replace(/\s+#.*$/, '').trim());
    }
  }
  return fm;
}

// Expand `{a,b}` alternatives, then match globs (`*` within a segment, `**`
// across segments) against the git-known file list; non-glob entries hit the
// filesystem directly so directories also count.
function braceExpand(pattern) {
  const m = pattern.match(/^(.*?)\{([^}]+)\}(.*)$/);
  if (!m) return [pattern];
  return m[2].split(',').flatMap((alt) => braceExpand(m[1] + alt + m[3]));
}

let allFiles = null; // lazy: only listed when a glob entry needs it
function globExists(pattern) {
  if (allFiles === null) {
    allFiles = git('ls-files --cached --others --exclude-standard').split('\n');
  }
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^$()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') +
      '$'
  );
  return allFiles.some((f) => re.test(f));
}

function testsEntryExists(entry) {
  return braceExpand(entry).some((p) =>
    /[*]/.test(p) ? globExists(p) : existsSync(p)
  );
}

const specFiles = ['specs/features', 'specs/platform'].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => `${dir}/${f}`)
);

const lintFailures = []; // current specs with a missing/empty tests: list
const rotFailures = []; // [spec, entry] pairs where the entry matches nothing

for (const spec of specFiles) {
  const { status, tests } = parseFrontmatter(spec);
  if (status === 'current' && (!tests || tests.length === 0)) lintFailures.push(spec);
  for (const entry of tests || []) {
    if (!testsEntryExists(entry)) rotFailures.push([spec, entry]);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let findings = 0;

if (files.length === 0) {
  console.log('spec-sync: no changes to check (running repo lint only).');
} else if (specDrift.length === 0 && testDrift.length === 0) {
  console.log('spec-sync: OK — every changed code area has a matching spec and test update.');
}

if (specDrift.length > 0) {
  findings += specDrift.length;
  console.log('\nspec-sync: possible drift — code changed without its spec:\n');
  for (const [spec, codeFiles] of specDrift) {
    console.log(`  ${spec}`);
    for (const f of codeFiles) console.log(`    ← ${f}`);
  }
  console.log('\nUpdate the spec(s) above (and bump last-verified), or note in the PR');
  console.log('that this change does not alter documented behavior. See specs/README.md.');
}

if (testDrift.length > 0) {
  findings += testDrift.length;
  console.log('\nspec-sync: possible test drift — feature code changed without a matching test change:\n');
  for (const [rule, codeFiles] of testDrift) {
    console.log(`  ${rule.specs.join(', ')} (tests: ${rule.tests})`);
    for (const f of codeFiles) console.log(`    ← ${f}`);
  }
  console.log('\nAdd or update a test proving the behavior change, or note in the PR why');
  console.log('the change is not observable (pure refactor, copy, comments).');
}

if (lintFailures.length > 0) {
  findings += lintFailures.length;
  console.log('\nspec-sync: defect — `status: current` specs with a missing/empty `tests:` list:\n');
  for (const spec of lintFailures) console.log(`  ${spec}`);
  console.log('\nA current spec must name the suite(s) proving its Behavior section');
  console.log('(specs/_TEMPLATE.md → `tests:` + `## Verification`).');
}

if (rotFailures.length > 0) {
  findings += rotFailures.length;
  console.log('\nspec-sync: rot — `tests:` entries that match no existing file:\n');
  for (const [spec, entry] of rotFailures) console.log(`  ${spec}: ${entry}`);
  console.log('\nA renamed or deleted suite silently drops coverage — fix the path or the spec.');
}

if (findings === 0) {
  console.log('spec-sync: repo lint OK — all current specs declare tests and every tests: path exists.');
  process.exit(0);
}

process.exit(strict ? 1 : 0);
