// Test-case import: parse a plan document into cases, and diff them against
// what the portal already holds (spec: features/release-qa.md).
//
// Pure and side-effect-free — no mongoose, no I/O — so the parsing rules and the
// four-bucket diff are unit-testable without a database (matching the repo's
// node:test style, cf. adminHelpers.js / dropReadiness.js). The route layer owns
// reading the request, applying the diff, and auditing.
//
// The REPO is the source of truth: cases are authored in docs/*.md and imported
// here. Both parsers are TOTAL — a malformed line lands in `warnings` and is
// skipped, never thrown — because the input is an operator-supplied document and
// one bad line must not cost the other 700 cases.

const crypto = require('crypto');

const PRIORITIES = ['blocker', 'critical', 'major', 'minor'];

// Bounds mirroring the TestCase schema, applied here so a hostile/garbled
// document can't push oversized fields at mongoose in the first place.
const LIMITS = { caseId: 60, section: 200, title: 500, steps: 4000, expected: 4000, specPath: 200 };
const MAX_CASES = 5000;

// A case id as the plan documents print them: an uppercase prefix plus at least
// one hyphenated part — CAL-13, AUTH-01, A11Y-04, CAL-C1, REG-50. Requiring the
// hyphen is what keeps ordinary bold text (**Severity:**, **Note**) from being
// mistaken for a case.
const CASE_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

// Something that was plainly MEANT to be an id but isn't one — wrong case, a
// space or underscore instead of the hyphen. Warned about, unlike ordinary bold
// prose, which is skipped in silence.
const NEAR_MISS_ID_RE = /^[A-Za-z][A-Za-z0-9]*[-_ ][A-Za-z0-9]+$/;

// `- [ ] **ID** — text`  (also tolerates `[x]`, an en/em dash or a plain hyphen,
// or no separator at all).
const CHECKBOX_RE = /^\s*[-*]\s*\[[ xX]?\]\s*\*\*(.+?)\*\*\s*(?:[—–-]\s*)?([\s\S]*)$/;
const H2_RE = /^##\s+(.*\S)\s*$/;
const H3_RE = /^###\s+(.*\S)\s*$/;
// A markdown link pointing into specs/ — the section's owning spec.
const SPEC_LINK_RE = /\[[^\]]*\]\(([^)]*specs\/[^)]+\.md)\)/;

function truncate(s, max) {
  const str = String(s ?? '').trim();
  return str.length > max ? str.slice(0, max) : str;
}

// Strip the inline markdown the plan uses for emphasis and linking, so a stored
// case reads as a sentence rather than as source. Deliberately minimal: code
// backticks are kept (they usually name a real identifier the tester needs).
function stripInline(s) {
  return String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // bold
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2') // italics
    .replace(/\s+/g, ' ')
    .trim();
}

// Priority is a property of the CASE, read from the markers the plan already
// writes — never inferred from which section it sits in.
function priorityFromText(text) {
  if (/⛔/.test(text) || /\bBLOCKER\b/.test(text)) return 'blocker';
  if (/⚠️?/.test(text) || /\bRISK\b/.test(text)) return 'critical';
  return 'major';
}

// `→` splits doing from expecting — but ONLY when the line uses it exactly once.
// The plan also writes arrows as narrative sequencing ("Open it → save → open →
// save, five times"), where splitting on the first one yields a step as the
// "expected" and reads as nonsense. One arrow is a divider; several are prose,
// so the whole line stays as steps. A line with no arrow is all steps too —
// plenty of checklist lines are self-describing assertions with nothing to split.
function splitSteps(text) {
  const first = text.indexOf('→');
  if (first === -1) return { steps: text.trim(), expected: '' };
  if (text.indexOf('→', first + 1) !== -1) return { steps: text.trim(), expected: '' };
  return { steps: text.slice(0, first).trim(), expected: text.slice(first + 1).trim() };
}

function normalizeCase(raw, sourceDoc) {
  const text = stripInline(raw.text);
  const { steps, expected } = splitSteps(text);
  return {
    caseId: truncate(raw.caseId, LIMITS.caseId),
    section: truncate(raw.section, LIMITS.section),
    title: truncate(text, LIMITS.title),
    steps: truncate(steps, LIMITS.steps),
    expected: truncate(expected, LIMITS.expected),
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'major',
    specPath: truncate(raw.specPath || '', LIMITS.specPath),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => truncate(t, 40)).filter(Boolean).slice(0, 20) : [],
    source: 'repo',
    sourceDoc: truncate(sourceDoc || '', LIMITS.specPath),
  };
}

// --- Markdown ---------------------------------------------------------------

// Parses the format the repo already writes:
//   ## 7. Calendar — events          → section
//   ### 7.2 Starts / Ends            → refines it ("7. Calendar — events › 7.2 …")
//   Spec: [calendar.md](../specs/…)  → the section's spec, inherited by its cases
//   - [ ] **CAL-13** — do X → expect Y
// Indented lines following a case are continuation and fold into its text, so a
// multi-line checklist item (sub-bullets under ECD-14) survives the import.
function parseMarkdown(text, { sourceDoc = '' } = {}) {
  const warnings = [];
  const cases = [];
  const lines = String(text ?? '').split(/\r?\n/);

  let h2 = '';
  let h3 = '';
  let sectionSpec = '';
  let current = null; // the case still accepting continuation lines

  const flush = () => {
    if (!current) return;
    if (cases.length >= MAX_CASES) {
      current = null;
      return;
    }
    const own = current.text.match(SPEC_LINK_RE);
    cases.push(normalizeCase({
      caseId: current.caseId,
      section: [h2, h3].filter(Boolean).join(' › '),
      text: current.text,
      priority: priorityFromText(current.text),
      specPath: own ? own[1] : current.sectionSpec,
    }, sourceDoc));
    current = null;
  };

  for (const line of lines) {
    const h2m = line.match(H2_RE);
    if (h2m) {
      flush();
      h2 = stripInline(h2m[1]);
      h3 = '';
      sectionSpec = '';
      continue;
    }
    const h3m = line.match(H3_RE);
    if (h3m) {
      flush();
      h3 = stripInline(h3m[1]);
      continue;
    }

    const box = line.match(CHECKBOX_RE);
    if (box) {
      flush();
      const id = box[1].trim();
      if (!CASE_ID_RE.test(id)) {
        // Bold text that isn't an id is ordinary formatting (**Severity:**,
        // **Note**) and is skipped silently — warning on every bold bullet would
        // bury the warnings that matter. A NEAR MISS is different: a label that
        // was clearly meant to be an id (`cal-13`, `CAL 13`, `CAL_13`) would
        // otherwise vanish from the import with no trace, so it gets one.
        if (NEAR_MISS_ID_RE.test(id)) {
          warnings.push(`Skipped "${truncate(id, 40)}" — looks like a case id but isn't one (expected e.g. CAL-13).`);
        }
        continue;
      }
      current = { caseId: id, text: box[2] || '', sectionSpec };
      continue;
    }

    // A spec link in a section's preamble sets that section's spec — but only
    // before its first case, so a link inside prose further down can't re-point
    // the ones already read.
    if (!current && !sectionSpec) {
      const link = line.match(SPEC_LINK_RE);
      if (link) sectionSpec = link[1];
    }

    if (current) {
      if (/^\s+\S/.test(line)) current.text += ' ' + line.trim(); // continuation
      else if (!line.trim()) flush();                             // blank line ends it
      else flush();                                               // any other prose too
    }
  }
  flush();

  if (cases.length >= MAX_CASES) {
    warnings.push(`Stopped at the ${MAX_CASES}-case limit — the rest of the document was ignored.`);
  }
  return dedupe(cases, warnings);
}

// --- CSV --------------------------------------------------------------------

// Minimal RFC 4180 reader: quoted fields may hold commas, newlines, and ""
// escapes. Returns rows of raw string cells.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Header names are matched case-insensitively in any order, and unknown columns
// are IGNORED rather than rejected — a working spreadsheet usually carries extra
// columns, and refusing it would be pedantry the operator can't act on.
const CSV_ALIASES = {
  caseid: 'caseId', id: 'caseId',
  section: 'section', area: 'section',
  title: 'title', name: 'title',
  steps: 'steps', action: 'steps',
  expected: 'expected', result: 'expected',
  priority: 'priority', severity: 'priority',
  spec: 'specPath', specpath: 'specPath',
  tags: 'tags',
};

function parseCsv(text, { sourceDoc = '' } = {}) {
  const warnings = [];
  const rows = parseCsvRows(text);
  if (!rows.length) return { cases: [], warnings };

  const header = rows[0].map((h) => CSV_ALIASES[h.trim().toLowerCase()] || null);
  if (!header.includes('caseId')) {
    warnings.push('No "caseId" column found in the CSV header.');
    return { cases: [], warnings };
  }

  const cases = [];
  for (let r = 1; r < rows.length && cases.length < MAX_CASES; r += 1) {
    const cells = rows[r];
    const rec = {};
    header.forEach((key, i) => { if (key) rec[key] = (cells[i] ?? '').trim(); });

    const id = (rec.caseId || '').trim();
    if (!CASE_ID_RE.test(id)) {
      warnings.push(`Row ${r + 1}: skipped, "${truncate(id || '(blank)', 40)}" is not a valid case id.`);
      continue;
    }
    const priority = (rec.priority || '').trim().toLowerCase();
    const text2 = [rec.title, rec.steps].filter(Boolean).join(' — ') || rec.title || '';
    cases.push(normalizeCase({
      caseId: id,
      section: rec.section || '',
      // Title stays the author's own; steps/expected come from their columns
      // when present, else from splitting the title on `→`.
      text: rec.steps || rec.expected ? text2 : rec.title || '',
      priority: PRIORITIES.includes(priority) ? priority : priorityFromText(`${rec.title} ${rec.steps}`),
      specPath: rec.specPath || '',
      tags: (rec.tags || '').split(/[;|]/).map((t) => t.trim()).filter(Boolean),
    }, sourceDoc));

    const last = cases[cases.length - 1];
    if (rec.steps) last.steps = truncate(rec.steps, LIMITS.steps);
    if (rec.expected) last.expected = truncate(rec.expected, LIMITS.expected);
    if (rec.title) last.title = truncate(stripInline(rec.title), LIMITS.title);
  }
  return dedupe(cases, warnings);
}

// A duplicate id inside ONE document is an authoring mistake, not a merge: keep
// the first and say so, rather than letting the later one silently win.
function dedupe(cases, warnings) {
  const seen = new Map();
  const out = [];
  for (const c of cases) {
    if (seen.has(c.caseId)) {
      warnings.push(`Duplicate case id "${c.caseId}" in the document — kept the first.`);
      continue;
    }
    seen.set(c.caseId, true);
    out.push(c);
  }
  return { cases: out, warnings };
}

// --- Parse + diff -----------------------------------------------------------

function parseCases(format, text, opts = {}) {
  if (format === 'csv') return parseCsv(text, opts);
  if (format === 'markdown') return parseMarkdown(text, opts);
  return { cases: [], warnings: [`Unknown import format "${format}".`] };
}

// Stable hash of the fields an import owns, so a re-import of an unchanged
// document is a no-op and `updated` means the wording really moved. Field order
// is fixed here rather than taken from Object.keys.
function hashCase(c) {
  const payload = JSON.stringify([
    c.caseId, c.section, c.title, c.steps, c.expected, c.priority, c.specPath, (c.tags || []).join(','),
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Diff parsed cases against what the portal holds.
//
//   existing: [{ caseId, contentHash, source, sourceDoc, active }]
//
// Buckets: added / updated / unchanged, plus `missing` — cases from THIS source
// document that the import no longer contains. Missing cases are reported so the
// route can flag them inactive; they are never deleted, because their results
// are real evidence of a test that really ran.
//
// A parsed case colliding with a MANUAL case is skipped with a warning: the
// importer never touches portal-authored cases in either direction.
function diffCases(parsed, existing, { sourceDoc = '' } = {}) {
  const byId = new Map((existing || []).map((e) => [e.caseId, e]));
  const added = [];
  const updated = [];
  const unchanged = [];
  const warnings = [];
  const seen = new Set();

  for (const c of parsed) {
    seen.add(c.caseId);
    const prev = byId.get(c.caseId);
    const hash = hashCase(c);
    if (!prev) {
      added.push({ ...c, contentHash: hash });
      continue;
    }
    if (prev.source === 'manual') {
      warnings.push(`"${c.caseId}" already exists as a portal-authored case — left untouched.`);
      continue;
    }
    // A case that was retired and has reappeared counts as updated even when its
    // wording is identical: reactivating it is a real write.
    if (prev.contentHash === hash && prev.active !== false) unchanged.push({ ...c, contentHash: hash });
    else updated.push({ ...c, contentHash: hash });
  }

  // Scoped to this source document — importing a second plan must not retire the
  // first one's cases.
  const missing = (existing || [])
    .filter((e) => e.source !== 'manual' && e.active !== false
      && (e.sourceDoc || '') === sourceDoc && !seen.has(e.caseId))
    .map((e) => e.caseId);

  return { added, updated, unchanged, missing, warnings };
}

module.exports = {
  PRIORITIES,
  MAX_CASES,
  CASE_ID_RE,
  parseMarkdown,
  parseCsv,
  parseCases,
  hashCase,
  diffCases,
  // exported for tests
  _internals: { stripInline, splitSteps, priorityFromText, parseCsvRows },
};
