const test = require('node:test');
const assert = require('node:assert');
const {
  parseMarkdown, parseCsv, parseCases, hashCase, diffCases, MAX_CASES,
} = require('./qaImport');

// A miniature of the real plan document (docs/PRE-RELEASE-TEST-PLAN.md), so the
// parser is tested against the shape the repo actually writes.
const DOC = `
# Calen — pre-release test plan

Intro prose that mentions [specs/](../specs/) and should not set a section spec.

## 2. Authentication & identity

Spec: [auth-identity.md](../specs/features/auth-identity.md)

- [ ] **AUTH-01** — Password registration creates the account → lands in the app.
- [ ] **AUTH-28** — After a reset, the vault is still locked. It must **never** offer "sign in again". **⛔ BLOCKER — this is the dead-end loop.**

### 2.5 Sessions, devices & device link

- [ ] **AUTH-29** — Sessions list shows physical devices
  not a history of sign-ins.
- [ ] **AUTH-33** — Device link hands the identity key over. **⚠️ RISK — no coverage.**

## 7. Calendar — events

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **CAL-13** — Create a timed event at 11:05pm, save five times → the date must not step forward.
- [ ] **Severity:** not a case, just bold prose.
- [ ] **CAL-C1** — New Calendar: the keyboard Done key dismisses.
`;

test('markdown: parses ids, sections, and sub-sections', () => {
  const { cases } = parseMarkdown(DOC, { sourceDoc: 'docs/plan.md' });
  const ids = cases.map((c) => c.caseId);
  assert.deepEqual(ids, ['AUTH-01', 'AUTH-28', 'AUTH-29', 'AUTH-33', 'CAL-13', 'CAL-C1']);

  const auth01 = cases.find((c) => c.caseId === 'AUTH-01');
  assert.equal(auth01.section, '2. Authentication & identity');
  const auth29 = cases.find((c) => c.caseId === 'AUTH-29');
  assert.equal(auth29.section, '2. Authentication & identity › 2.5 Sessions, devices & device link');
});

test('markdown: splits steps from expected on the first arrow', () => {
  const { cases } = parseMarkdown(DOC);
  const c = cases.find((x) => x.caseId === 'AUTH-01');
  assert.equal(c.steps, 'Password registration creates the account');
  assert.equal(c.expected, 'lands in the app.');
});

test('markdown: several arrows are narrative, so the line is not split', () => {
  const { cases } = parseMarkdown(
    '## 1. A\n\n- [ ] **A-01** — Open it → save → open → save. The date must not move.');
  assert.equal(cases[0].expected, '');
  assert.match(cases[0].steps, /Open it → save → open → save\. The date must not move\./);
});

test('markdown: a line with no arrow is all steps', () => {
  const { cases } = parseMarkdown(DOC);
  const c = cases.find((x) => x.caseId === 'CAL-C1');
  assert.equal(c.expected, '');
  assert.match(c.steps, /keyboard Done key dismisses/);
});

test('markdown: priority comes from the markers, not the section', () => {
  const { cases } = parseMarkdown(DOC);
  const byId = Object.fromEntries(cases.map((c) => [c.caseId, c]));
  assert.equal(byId['AUTH-28'].priority, 'blocker');
  assert.equal(byId['AUTH-33'].priority, 'critical');
  assert.equal(byId['AUTH-01'].priority, 'major');
});

test('markdown: cases inherit their section spec link', () => {
  const { cases } = parseMarkdown(DOC);
  const byId = Object.fromEntries(cases.map((c) => [c.caseId, c]));
  assert.equal(byId['AUTH-01'].specPath, '../specs/features/auth-identity.md');
  assert.equal(byId['AUTH-29'].specPath, '../specs/features/auth-identity.md');
  assert.equal(byId['CAL-13'].specPath, '../specs/features/calendar.md');
});

test('markdown: prose links before the first section never leak into cases', () => {
  const { cases } = parseMarkdown('Intro [x](../specs/features/x.md)\n\n## 1. A\n\n- [ ] **A-01** — do it');
  assert.equal(cases[0].specPath, '');
});

test('markdown: bold prose is skipped silently — it is formatting, not a case', () => {
  const { cases, warnings } = parseMarkdown(DOC);
  assert.equal(cases.some((c) => /Severity/.test(c.caseId)), false);
  assert.equal(warnings.length, 0);
});

test('markdown: a near-miss id is skipped WITH a warning, so it cannot vanish', () => {
  for (const label of ['cal-13', 'CAL 13', 'CAL_13']) {
    const { cases, warnings } = parseMarkdown(`## 1. A\n\n- [ ] **${label}** — do it`);
    assert.deepEqual(cases, [], `${label} should not parse as a case`);
    assert.match(warnings.join(' '), /looks like a case id/, `${label} should warn`);
  }
});

test('markdown: an indented continuation line folds into its case', () => {
  const { cases } = parseMarkdown(DOC);
  const c = cases.find((x) => x.caseId === 'AUTH-29');
  assert.match(c.steps, /physical devices not a history of sign-ins/);
});

test('markdown: inline markdown is stripped from the stored text', () => {
  const { cases } = parseMarkdown(DOC);
  const c = cases.find((x) => x.caseId === 'AUTH-28');
  assert.equal(/\*\*/.test(c.title), false);
  assert.match(c.title, /never offer/);
});

test('markdown: a duplicate id keeps the first and warns', () => {
  const { cases, warnings } = parseMarkdown('## 1. A\n\n- [ ] **A-01** — first\n- [ ] **A-01** — second');
  assert.equal(cases.length, 1);
  assert.equal(cases[0].steps, 'first');
  assert.match(warnings.join(' '), /Duplicate case id "A-01"/);
});

test('markdown: an empty or prose-only document yields no cases and does not throw', () => {
  assert.deepEqual(parseMarkdown('').cases, []);
  assert.deepEqual(parseMarkdown('# Title\n\nJust prose.\n').cases, []);
  assert.deepEqual(parseMarkdown(null).cases, []);
});

test('markdown: parsing is idempotent — the same text hashes identically', () => {
  const a = parseMarkdown(DOC, { sourceDoc: 'docs/plan.md' }).cases.map(hashCase);
  const b = parseMarkdown(DOC, { sourceDoc: 'docs/plan.md' }).cases.map(hashCase);
  assert.deepEqual(a, b);
});

// --- CSV --------------------------------------------------------------------

test('csv: header order is free and unknown columns are ignored', () => {
  const csv = 'Owner,Priority,ID,Section,Title\nben,blocker,CAL-13,Calendar,Timed event date drift\n';
  const { cases } = parseCsv(csv);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].caseId, 'CAL-13');
  assert.equal(cases[0].priority, 'blocker');
  assert.equal(cases[0].section, 'Calendar');
  assert.equal(cases[0].title, 'Timed event date drift');
});

test('csv: quoted fields carry commas, newlines and escaped quotes', () => {
  const csv = 'caseId,title,steps\nA-01,"One, two","Say ""hi""\nthen leave"\n';
  const { cases } = parseCsv(csv);
  assert.equal(cases[0].title, 'One, two');
  assert.match(cases[0].steps, /Say "hi"/);
  assert.match(cases[0].steps, /then leave/);
});

test('csv: steps and expected columns win over splitting the title', () => {
  const csv = 'caseId,title,steps,expected\nA-01,T,Do the thing,It works\n';
  const { cases } = parseCsv(csv);
  assert.equal(cases[0].steps, 'Do the thing');
  assert.equal(cases[0].expected, 'It works');
});

test('csv: a row with a bad id is skipped with a warning, not thrown', () => {
  const csv = 'caseId,title\nnot an id,T\nA-01,Fine\n';
  const { cases, warnings } = parseCsv(csv);
  assert.deepEqual(cases.map((c) => c.caseId), ['A-01']);
  assert.match(warnings.join(' '), /is not a valid case id/);
});

test('csv: a header with no caseId column yields nothing and says why', () => {
  const { cases, warnings } = parseCsv('title,steps\nA,B\n');
  assert.deepEqual(cases, []);
  assert.match(warnings.join(' '), /No "caseId" column/);
});

test('parseCases routes by format and refuses an unknown one', () => {
  assert.equal(parseCases('markdown', DOC).cases.length, 6);
  assert.equal(parseCases('csv', 'caseId\nA-01\n').cases.length, 1);
  const bad = parseCases('yaml', 'x');
  assert.deepEqual(bad.cases, []);
  assert.match(bad.warnings.join(' '), /Unknown import format/);
});

// --- Diff -------------------------------------------------------------------

const parsed = (...ids) => ids.map((id) => ({
  caseId: id, section: 'S', title: id, steps: id, expected: '', priority: 'major', specPath: '', tags: [],
}));

test('diff: everything is added against an empty portal', () => {
  const d = diffCases(parsed('A-01', 'A-02'), []);
  assert.deepEqual(d.added.map((c) => c.caseId), ['A-01', 'A-02']);
  assert.deepEqual(d.updated, []);
  assert.deepEqual(d.missing, []);
  assert.ok(d.added.every((c) => c.contentHash));
});

test('diff: re-importing an unchanged document is a no-op', () => {
  const cases = parsed('A-01', 'A-02');
  const existing = cases.map((c) => ({
    caseId: c.caseId, contentHash: hashCase(c), source: 'repo', sourceDoc: 'd.md', active: true,
  }));
  const d = diffCases(cases, existing, { sourceDoc: 'd.md' });
  assert.deepEqual(d.unchanged.map((c) => c.caseId), ['A-01', 'A-02']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.updated, []);
  assert.deepEqual(d.missing, []);
});

test('diff: changed wording is an update', () => {
  const before = parsed('A-01')[0];
  const after = { ...before, steps: 'now different' };
  const d = diffCases([after], [{
    caseId: 'A-01', contentHash: hashCase(before), source: 'repo', sourceDoc: 'd.md', active: true,
  }], { sourceDoc: 'd.md' });
  assert.deepEqual(d.updated.map((c) => c.caseId), ['A-01']);
});

test('diff: a retired case reappearing counts as an update even when identical', () => {
  const c = parsed('A-01')[0];
  const d = diffCases([c], [{
    caseId: 'A-01', contentHash: hashCase(c), source: 'repo', sourceDoc: 'd.md', active: false,
  }], { sourceDoc: 'd.md' });
  assert.deepEqual(d.updated.map((x) => x.caseId), ['A-01']);
  assert.deepEqual(d.unchanged, []);
});

test('diff: a case absent from the document is reported missing, never deleted', () => {
  const d = diffCases(parsed('A-01'), [
    { caseId: 'A-01', contentHash: 'x', source: 'repo', sourceDoc: 'd.md', active: true },
    { caseId: 'A-99', contentHash: 'y', source: 'repo', sourceDoc: 'd.md', active: true },
  ], { sourceDoc: 'd.md' });
  assert.deepEqual(d.missing, ['A-99']);
});

test('diff: missing is scoped to the source document being imported', () => {
  const d = diffCases(parsed('A-01'), [
    { caseId: 'B-01', contentHash: 'y', source: 'repo', sourceDoc: 'other.md', active: true },
  ], { sourceDoc: 'd.md' });
  assert.deepEqual(d.missing, []);
});

test('diff: an already-retired case is not reported missing again', () => {
  const d = diffCases(parsed('A-01'), [
    { caseId: 'A-99', contentHash: 'y', source: 'repo', sourceDoc: 'd.md', active: false },
  ], { sourceDoc: 'd.md' });
  assert.deepEqual(d.missing, []);
});

test('diff: portal-authored cases are never touched in either direction', () => {
  const d = diffCases(parsed('A-01'), [
    { caseId: 'A-01', contentHash: 'zzz', source: 'manual', sourceDoc: '', active: true },
    { caseId: 'M-02', contentHash: 'q', source: 'manual', sourceDoc: 'd.md', active: true },
  ], { sourceDoc: 'd.md' });
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.updated, []);
  assert.deepEqual(d.missing, []);
  assert.match(d.warnings.join(' '), /portal-authored case/);
});

test('hashCase is stable across parses and moves when a field moves', () => {
  const [a] = parsed('A-01');
  assert.equal(hashCase(a), hashCase({ ...a }));
  assert.notEqual(hashCase(a), hashCase({ ...a, priority: 'blocker' }));
  assert.notEqual(hashCase(a), hashCase({ ...a, specPath: 'specs/x.md' }));
});

test('markdown: the case cap bounds a runaway document', () => {
  const lines = ['## 1. Big'];
  for (let i = 0; i < MAX_CASES + 10; i += 1) lines.push(`- [ ] **A-${i}** — case ${i}`);
  const { cases, warnings } = parseMarkdown(lines.join('\n'));
  assert.equal(cases.length, MAX_CASES);
  assert.match(warnings.join(' '), /case limit/);
});
