#!/usr/bin/env node
// TestFlight "What to Test" helper — gathers every change since the last shipped
// build so tester-facing release notes can be written from it. No tokens, no API:
// the AI summarization is done by whoever reads the output (you, or Claude Code).
//
// How builds are anchored: each shipped build is marked with a git tag
//   testflight/<version>-<buildNumber>       e.g. testflight/1.0.0-42
// "Since the last build" is then just `git log <lastTag>..HEAD`.
//
// Usage:
//   node scripts/release-notes.mjs                 # range = last testflight/* tag .. HEAD
//   node scripts/release-notes.mjs --base <ref>    # override the "last build" anchor
//   node scripts/release-notes.mjs --tag 1.0.0-43  # after shipping: create+push the anchor tag
//   node scripts/release-notes.mjs --json          # machine-readable output
//
// Typical flow:
//   1. Commit everything that goes into the build.
//   2. `npm run release:notes`  → hand the output to Claude → get "What to Test" notes.
//   3. Paste notes into App Store Connect / TestFlight for the build.
//   4. `npm run release:notes -- --tag <version>-<buildNumber>`  to anchor this build.

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const baseIdx = args.indexOf('--base');
const baseOverride = baseIdx !== -1 ? args[baseIdx + 1] : null;
const tagIdx = args.indexOf('--tag');
const tagArg = tagIdx !== -1 ? args[tagIdx + 1] : null;

const TAG_PREFIX = 'testflight/';

function git(cmd, { quiet = false } = {}) {
  return execSync(`git ${cmd}`, {
    encoding: 'utf8',
    stdio: quiet ? ['pipe', 'pipe', 'ignore'] : undefined,
  }).trim();
}

// --- --tag mode: anchor the build we just shipped, then exit. ------------------
if (tagArg) {
  const name = tagArg.startsWith(TAG_PREFIX) ? tagArg : TAG_PREFIX + tagArg;
  git(`tag ${name}`);
  console.log(`Tagged ${git('rev-parse --short HEAD')} as ${name}`);
  try {
    git(`push origin ${name}`);
    console.log(`Pushed ${name} to origin.`);
  } catch {
    console.log(`(Could not push — run: git push origin ${name})`);
  }
  process.exit(0);
}

// --- Resolve the "last build" anchor. -----------------------------------------
let anchor = baseOverride;
if (!anchor) {
  try {
    anchor = git(`describe --tags --match "${TAG_PREFIX}*" --abbrev=0`, { quiet: true });
  } catch {
    anchor = null; // no build ever tagged
  }
}

const range = anchor ? `${anchor}..HEAD` : 'HEAD';
const head = git('rev-parse --short HEAD');

// Commits in range, newest first, with body. Use a rare delimiter for safe parsing.
const SEP = '\x1e';
const raw = anchor
  ? git(`log ${range} --pretty=format:%h%x1f%ad%x1f%s%x1f%b${SEP} --date=short`)
  : git(`log -30 --pretty=format:%h%x1f%ad%x1f%s%x1f%b${SEP} --date=short`);

const commits = raw
  .split(SEP)
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, date, subject, body = ''] = c.split('\x1f');
    return { hash, date, subject, body: body.trim() };
  });

// Files touched across the range, so notes can be grouped by user-facing area.
const files = anchor
  ? git(`diff --name-only ${anchor} HEAD`).split('\n').filter(Boolean)
  : [];

// Map changed paths → the area a tester would recognize (repo is spec-organized).
const AREA_RULES = [
  [/specs\/features\/calendar|screens\/calendar|lib\/calendar/, 'Calendar'],
  [/screens\/trips|features\/trips/, 'Trips'],
  [/plan|billing|AddOns|unlock|credits/i, 'Plans & billing'],
  [/household|invit|sharing/i, 'Households & sharing'],
  [/auth|login|passkey|identity|session|device/i, 'Sign-in & devices'],
  [/e2ee|crypto|encrypt/i, 'Encryption'],
  [/contact|people|person/i, 'People & contacts'],
  [/assistant|vapi|call|\bai\b/i, 'Assistant'],
  [/feedback|bug-report/i, 'Feedback'],
];
// Paths that never matter to a tester — surfaced separately so they can be dropped.
const INTERNAL = /^(specs\/|scripts\/|\.github\/|.*\.test\.|.*__tests__\/|.*\/CLAUDE\.md)/;

const areas = {};
const internalFiles = [];
for (const f of files) {
  if (INTERNAL.test(f)) { internalFiles.push(f); continue; }
  const hit = AREA_RULES.find(([re]) => re.test(f));
  const area = hit ? hit[1] : 'Other';
  (areas[area] ??= new Set()).add(f);
}

if (asJson) {
  console.log(JSON.stringify({
    anchor: anchor ?? null,
    head,
    commitCount: commits.length,
    commits,
    areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, [...v]])),
    internalFiles,
  }, null, 2));
  process.exit(0);
}

// --- Human-readable draft. ----------------------------------------------------
const L = [];
L.push('# Release notes source — since last TestFlight build');
L.push('');
L.push(anchor ? `Range: ${anchor} .. ${head}` : `No build tagged yet — showing last ${commits.length} commits (HEAD = ${head}).`);
L.push(`Commits: ${commits.length}`);
L.push('');
L.push('## Commits (newest first)');
for (const c of commits) {
  L.push(`- ${c.subject}  (${c.hash}, ${c.date})`);
  if (c.body) for (const line of c.body.split('\n').filter(Boolean)) L.push(`    ${line}`);
}
L.push('');
if (Object.keys(areas).length) {
  L.push('## Changed areas (tester-facing)');
  for (const [area, set] of Object.entries(areas)) {
    L.push(`- ${area}: ${set.size} file(s)`);
  }
  L.push('');
}
if (internalFiles.length) {
  L.push(`## Internal (drop from tester notes): ${internalFiles.length} file(s)`);
  L.push('');
}
L.push('---');
L.push('Next: ask Claude for TestFlight "What to Test" notes from this output.');
L.push('Notes MUST follow docs/release-notes-style.md (audience = testers, drop internal churn).');
L.push('After shipping, anchor the build:  npm run release:notes -- --tag <version>-<buildNumber>');
console.log(L.join('\n'));
