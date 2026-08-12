---
title: Release QA — test cases, runs & sign-off
status: current
last-verified: ddaa21b+ (2026-08-10); **the plan document is written for a non-technical tester and a case row opens** — `docs/PRE-RELEASE-TEST-PLAN.md` was rewritten as ~200 plain-language combined flows (the original 812-case technical plan is preserved as `docs/ENGINEERING-TEST-PLAN.md`, an engineer-run companion that is NOT imported), and the library's case rows became tappable: a detail dialog shows what-to-do / what-to-expect, records a result against any in-progress run (the same `(run, case)` upsert as the run screen, pre-filled with that run's existing answer), and lists the case's history across runs/releases via the new `GET /cases/:id/history` (2026-08-10); initial spec — the admin portal gains a Quality group (Releases / Test cases): a release record per public build, a test-case library imported from the repo's own markdown plan (or CSV) with the repo as source of truth, execution runs recorded one-per-device, and a sign-off gate that refuses while a blocker case is unexecuted or failing
code:
  - server/src/models/Release.js
  - server/src/models/TestCase.js
  - server/src/models/TestRun.js
  - server/src/models/TestResult.js
  - server/src/services/qaImport.js
  - server/src/services/qaSummary.js
  - server/src/routes/adminQa.js
  - server/src/scripts/importTestCases.js
  - admin/src/views/ReleasesView.vue
  - admin/src/views/ReleaseDetailView.vue
  - admin/src/views/TestRunView.vue
  - admin/src/views/TestCasesView.vue
tests:
  - server/src/services/qaImport.test.js
  - server/src/services/qaSummary.test.js
  - server/src/test/qa.integration.test.js
---

# Release QA — test cases, runs & sign-off

## Purpose

Every public release is preceded by a manual test pass
([operations/release.md](../operations/release.md)), and the pass itself lived in
a markdown checklist — which cannot record *who ran what on which device*, cannot
tell a fresh release from a stale one, and cannot refuse a sign-off. This spec
owns the admin-portal surface that fixes that: a **release** record per shipped
build, a **test-case library** imported from the repo's own plan documents, and
**runs** in which an admin records a result per case per device, gated by a
sign-off that will not accept an outstanding blocker.

The portal is the *execution and evidence* layer. It is deliberately **not** the
authoring layer — see the source-of-truth rule below.

## Behavior (normative)

### The repo is the source of truth for cases

Test cases are authored in the repository (`docs/PRE-RELEASE-TEST-PLAN.md` and
any sibling plan document), reviewed in pull requests like every other artifact,
and **imported** into the portal. The portal owns run results and sign-off; it
does not own the wording of a case.

**The imported plan is written for a non-technical tester.** Each case is a
plain-language "do this → you should see this" flow — no env vars, file paths,
or internals — because the person running it is a tester, not the engineer.
Engineering-only checks (server audits, App Store submission readiness, deploy
ops, migration steps) live in `docs/ENGINEERING-TEST-PLAN.md`, which is
deliberately **not** imported: the portal's library is the runnable tester
surface, and burying it under engineering checklists is what made the first
import unusable.

- A case is identified by its **`caseId`** — the stable, human-readable id the
  plan document already prints (`CAL-13`, `AUTH-28`, `REG-07`). The id is the
  join key everywhere: results reference it, imports upsert on it, and history
  survives a re-import because of it.
- An import is an **upsert by `caseId`**, never a replace. Its outcome is
  reported in four buckets: `added`, `updated` (the content hash moved),
  `unchanged`, and `missing`.
- **`missing` cases are flagged, never deleted.** A case present in the portal
  but absent from the imported document is marked `active: false` and kept, with
  every result it ever collected. Deleting it would silently destroy the record
  of a test that was really run — and the usual reason a case disappears from a
  document is an edit, not a decision to stop testing it.
- Re-importing an unchanged document MUST be a **no-op**: every case reports
  `unchanged` and nothing is written. Idempotence is what makes the import safe
  to run from a CI step or by habit.
- A case may also be **authored in the portal** (`source: 'manual'`) — a one-off
  check that doesn't belong in the plan. An import never touches a manual case,
  and never reports one as `missing`.
- **Renaming a `caseId` in the document creates a new case** and flags the old
  one missing. That is the honest reading: the portal cannot know whether an id
  change was a rename or a replacement, and guessing would rewrite history.

### Import formats

Two formats reach the same upsert, through the pure `services/qaImport.js`:

- **Markdown** — the format the repo already writes. `## <n>. <Section>` opens a
  section; `- [ ] **<ID>** — <text>` is a case. Within a case's text:
  - `⛔ BLOCKER` anywhere in the line sets `priority: 'blocker'`;
    `⚠️ RISK` sets `priority: 'critical'`; otherwise the priority is `major`,
    and a case inside a section whose heading marks it optional stays `major`
    (priority is a property of the case, never inferred from position).
  - The first `→` splits the line into **steps** (before) and **expected**
    (after). A line with no arrow is all steps, and `expected` is empty — many
    checklist lines are self-describing assertions.
  - A markdown link to a spec (`[calendar.md](../specs/features/calendar.md)`)
    appearing in the section's preamble sets that section's `specPath`, which
    every case in the section inherits. A case may override it with its own
    inline spec link.
  - Sub-headings (`### 7.2 …`) refine the section label; the numeric prefix is
    kept because it is how the plan is navigated.
- **CSV** — `caseId,section,title,steps,expected,priority,spec,tags`. Header
  names are matched case-insensitively and may appear in any order; unknown
  columns are ignored rather than rejected, so a spreadsheet with extra working
  columns imports cleanly.

Both parsers are **total**: a malformed line is skipped and reported in
`warnings`, never thrown. An import that parses zero cases is refused (400) —
that is nearly always the wrong file, and committing it would flag the entire
library missing.

### Every import is reviewed before it commits

`POST /cases/import` with `dryRun: true` parses and diffs but writes nothing,
returning the four buckets plus the per-case detail. The same call with
`dryRun: false` commits. The portal MUST show the dry-run diff and require an
explicit confirm before committing — the same review-diff convention the
monetization config and email lifecycle already follow, and for the same reason:
an import can silently retire hundreds of cases.

### Releases

- A `Release` names a shipped or shipping build: `version` + `buildNumber`, the
  git `tag` the release-notes tooling anchors (`testflight/1.0.0-42`, see
  [operations/release.md](../operations/release.md)), a `channel`
  (`testflight` | `app-store` | `play`), and a `status`.
- Status moves `planning → testing → submitted → released`, with `rolled-back`
  reachable from any of them. Transitions are recorded in the audit log; the
  order is advisory, not enforced — a release can be corrected.
- `version` + `buildNumber` + `channel` are **unique together**: two records for
  the same build would split its evidence in half.

### Runs

- A **run is one tester on one device.** It carries an `environment`
  (`device`, `osVersion`, `build`, `tester`) and belongs to one release. The
  device matrix in the plan document therefore maps to several runs under one
  release, which is what makes "the full pass on the primary device, the smoke
  subset on the rest" expressible.
- A **result** is one row per `(runId, caseId)`, upserted — re-recording a case
  overwrites the previous answer rather than appending, so a tester can correct
  a mis-tap without leaving a contradictory trail inside the same run. The
  history that matters lives across runs, not within one.
- **Results can be recorded from the library too.** Tapping a case in the
  Test-cases view opens a detail dialog — the full what-to-do / what-to-expect,
  where the case came from, and its history across runs and releases
  (`GET /cases/:id/history`) — with a record-result control offered whenever at
  least one run is `in_progress`. It writes through the **same
  `POST /runs/:id/results` upsert** as the run screen (never a parallel path),
  and selecting a run pre-fills the answer already recorded on it, so the
  dialog corrects rather than blanks. With no run in progress it points at
  Releases instead — a result always belongs to a run.
- Result statuses: `pass`, `fail`, `blocked` (couldn't run — a dependency was
  broken), `skipped` (chose not to run), `na` (does not apply to this device).
  A `fail` or `blocked` SHOULD carry a note; nothing enforces it, because
  forcing prose is how testers learn to type ".".
- A run is `complete` when the admin says so — not when every case has a result.
  A partial run is a real, honest artifact (the smoke subset *is* a partial
  run); the release summary is what reports coverage.

### The sign-off gate

`POST /releases/:id/sign-off` **refuses (409)** while the release has any
**outstanding blocker**: a case with `priority: 'blocker'` that, across every
run on that release, has no `pass` and is not uniformly `na`. The response names
the offending `caseId`s so the reason is actionable rather than a bare refusal.

- The gate counts a blocker as satisfied by a **single pass on any run** — a
  blocker case does not have to pass on every device to sign off, because the
  device matrix deliberately runs only a subset on secondary devices. Judging
  which devices matter is the admin's call; the gate only insists the case was
  genuinely exercised somewhere.
- A blocker marked `na` on every run it appears in is **not** outstanding — a
  case that cannot apply cannot block.
- Non-blocker failures never gate. They are surfaced in the summary and left to
  the admin, matching the plan document's own severity rules (S1/S2 zero-open,
  S3 triaged).
- Sign-off records who and when plus an optional note, and is audited. It is
  **not** irreversible: re-signing overwrites, because a release corrected after
  the fact is more useful than an accurate-but-stale record.

### Summary

`GET /releases/:id/summary` reports, over all runs on the release: total active
cases, how many were executed at least once, the per-status counts, the pass
rate, the outstanding blockers (with ids), and per-run progress. It is the one
read the release detail screen paints from, so the numbers on that screen cannot
disagree with the numbers the gate uses — the same helper computes both.

## Data & API surface

- **Models:** `Release`, `TestCase`, `TestRun`, `TestResult`
  (`server/src/models/`). All plaintext by design — see the encryption boundary.
- **Endpoints** (`server/src/routes/adminQa.js`, mounted at `/api/admin/qa`,
  every route `requireAuth` + `requireAdmin`):

  | Method | Path | Purpose |
  |---|---|---|
  | GET / POST | `/releases` | List (paginated, newest first) / create |
  | GET / PUT | `/releases/:id` | Read / update (status, tag, notes) |
  | GET | `/releases/:id/summary` | Coverage + outstanding blockers |
  | POST | `/releases/:id/sign-off` | Gated sign-off (409 with `blockers[]`) |
  | GET | `/cases` | Paginated, filter by section/priority/spec/source/active, search |
  | GET | `/cases/:id/history` | The case's results across every run/release, newest first, joined to run device + release version |
  | PUT | `/cases/:id` | Edit a `manual` case (409 on a repo-managed one) |
  | POST | `/cases/import` | `{ format, content, dryRun, sourceDoc }` |
  | GET / POST | `/runs` | List by release / start a run |
  | GET | `/runs/:id` | Run + its results, joined to their cases |
  | POST | `/runs/:id/results` | Bulk upsert `[{ caseId, status, note }]` |
  | POST | `/runs/:id/complete` | Close a run |

- **Audit events** (`AuditLog`): `qa_cases_imported` (meta: counts +
  `sourceDoc`), `qa_release_created`, `qa_release_status_changed`,
  `qa_run_completed`, `qa_release_signed_off`.
- **Client:** `admin/src/views/{Releases,ReleaseDetail,TestRun,TestCases}View.vue`
  behind a **Quality** nav group, using the shared `usePagedList`, `useSnackbar`,
  `ConfirmDialog`, `Timestamp`, and `downloadCsv` plumbing
  ([admin-portal.md](admin-portal.md)).

## Encryption boundary

Nothing here touches household content, so nothing here is sealed. A test case
is a sentence the team wrote about the product; a result is a status and a note
an admin typed. The models are plaintext and server-readable by design, in the
same class as `Feedback` and `AuditLog` — with one rule that keeps it that way:
**a result note MUST NOT be used to record user data.** Reproduction steps
belong in the case; a real user's record does not belong in either.

Imports carry a document the operator supplies, so the parser is treated as
handling untrusted text: it is total (never throws), bounds every field it
stores, and caps the number of cases a single import may create.

## Verification

- The rollup, as a pure unit — coverage counted over cases rather than raw
  results, a pass on one run clearing a failure on another, `passRate` over
  *executed* cases (an unexecuted case is unknown, not a failure), and every
  branch of the blocker rule: never executed / failing / passed-somewhere /
  uniformly-`na` — `server/src/services/qaSummary.test.js`.
- The parsers and the diff, as pure units — markdown sections/ids/priority
  markers/`→` splitting/spec-link inheritance, CSV header tolerance, malformed
  lines landing in `warnings` rather than throwing, the four-bucket diff,
  idempotence on a re-parse, and `manual` cases being invisible to the diff —
  `server/src/services/qaImport.test.js`.
- The routes end-to-end — admin gating (403 for a non-admin), release CRUD +
  the unique-build constraint, import dry-run writing nothing vs. commit
  writing, a re-import reporting all-unchanged, a removed case flagged
  `active: false` with its results intact, result upsert replacing rather than
  appending, the case **history** endpoint (empty before any run, joined to run
  device + release version after, 404 on an unknown id), and the **sign-off
  gate refusing (409) with an outstanding blocker and accepting once it passes
  on any one run** — plus the audit rows each action writes — and the repo's
  real plan document importing end to end with zero warnings —
  `server/src/test/qa.integration.test.js`.

## Out of scope

- **Defect tracking.** A failing result carries a note, not a defect record;
  promoting a failure (or an in-app [feedback](feedback.md) row) into a tracked
  defect with severity and lifecycle is the natural next feature and hangs off
  `TestResult` without changing it.
- **Spec coverage.** `TestCase.specPath` is captured but nothing yet reports
  which specs have no cases.
- Evidence attachments (screenshots/video), ingesting automated `npm test`
  results as runs, cross-release trend reporting, and non-admin tester accounts
  (every tester signs in as an admin today).
- Authoring cases in the portal as the primary workflow — see the source-of-truth
  rule.

## Open questions

- Whether a run should be able to **inherit** the previous release's results for
  cases whose `contentHash` didn't move (a "same as last build" affordance), or
  whether that would quietly launder stale evidence into a new release.
- Whether `missing` (deactivated) cases should auto-reactivate when a later
  import reintroduces the same `caseId`. Today they do — the upsert clears
  `active: false` — which is right for an accidental deletion and wrong for a
  case deliberately retired and later re-used.
