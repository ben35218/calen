# Calen — Specifications

This directory is the **source of truth for what Calen does today**. Each spec
describes current, intended behavior of one part of the system, mapped to the
code that implements it.

## Specs vs. plans

- **`specs/` (here) = present tense, normative.** "The calendar does X." If a
  spec and the code disagree, that's a bug in one of them — fix it.
- **`docs/` = supporting material** (cryptographic spec, user-facing
  transparency note, release runbook). Design/status *plan* docs are
  deliberately **not** kept here — plans encode "what we intend to do" with
  dated snapshots and rot by construction. When a plan's work ships, its truth
  moves into a spec and the plan is dropped (git history keeps the trail).

## Layout

```
specs/
  README.md            # this file
  _TEMPLATE.md         # copy this to start a new spec
  product-overview.md  # what Calen is, at a glance

  features/            # one spec per user-facing feature area
    calendar.md
    kitchen.md
    maintenance.md
    trips.md
    contacts.md
    households-sharing.md
    auth-identity.md
    guardian-recovery.md   # dual-control household-member recovery
    ai-assistant.md
    billing-plans.md
    notifications.md

  platform/            # cross-cutting technical foundations
    crypto-e2ee.md         # system view; points to docs/CRYPTO-SPEC.md for primitives
    api-reference.md
    data-model.md

  operations/          # ship & disclose
    transparency.md
    release.md
```

## How to keep a spec honest

1. **Frontmatter is a contract.** Every spec starts with `status` and
   `last-verified` (a commit SHA + date the author last checked the spec against
   the code). Stale `last-verified` is the signal to re-verify.
2. **Point at code, don't transcribe it.** Link the real files. Never hard-code
   counts (tests, routes, models) in prose — they drift silently. Say "see
   `server/src/routes/`," not "45 routes."
3. **Behavior is normative** (MUST/SHOULD); everything else is context.
4. **`tests:` is a contract too.** A `status: current` feature/platform spec
   MUST name the suite(s) proving its Behavior section (`tests:` frontmatter +
   a `## Verification` section mapping claims to suites — see `_TEMPLATE.md`).
   An empty `tests:` is a defect, like a spec with no `code:`; an untested
   normative claim is a defect — write the test or demote the claim. The gate
   lints this and fails any `tests:` path that no longer exists (rot).

## The change loop (required)

Spec-driven development here means the spec leads and the code follows. Every
change that alters behavior MUST follow this loop:

1. **Spec first.** Before/while implementing, update the relevant spec(s) —
   `features/<area>.md` for a feature change, `platform/*` for API/data-model/
   crypto changes. Write the intended behavior, not a changelog.
2. **Implement** to match the spec.
3. **Verify with a test.** A behavior change ships with the test that proves
   the spec — added or updated in the same change, and registered in the
   owning spec's `tests:` frontmatter + `## Verification` section. Run the
   suite: `npm test` at the repo root fans out to server + shared + mobile
   (`npm run test:server` / `test:shared` / `test:mobile` individually; the
   server also has a `test:coverage` floor that only ratchets up).
4. **Bump `last-verified`** on every spec you touched to the new commit + date.
5. **Ship them together.** A behavior change, its spec update, and its test
   land in the **same commit / PR**. Code that changes an area without touching
   that area's spec — or without a matching test change — is treated as drift:
   a defect, like a failing test.

**The gate.** [`scripts/check-spec-sync.mjs`](../scripts/check-spec-sync.mjs)
checks four things: (1) changed code whose owning spec wasn't touched (**spec
drift**); (2) changed feature code with no matching test change (**test
drift**); (3) a `status: current` feature/platform spec with an empty `tests:`
list (**lint**); (4) a `tests:` entry that matches no existing file (**rot**).
It runs:

- automatically at the end of each Claude Code session (a `Stop` hook, if
  configured in `.claude/settings*.json`);
- manually: `node scripts/check-spec-sync.mjs` (working tree) or
  `node scripts/check-spec-sync.mjs --base main` (branch vs `main`);
- in CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) on every
  PR, alongside the full test suite — warn-only today, to be ratcheted to
  blocking (`--strict`) now that the backfill is green;
- as the checklist in [`.github/pull_request_template.md`](../.github/pull_request_template.md).

A warning is a prompt to either update the spec / add the test or, if the
change genuinely doesn't alter documented behavior, note that in the PR.
Locally it is a nudge, not a hard block — the discipline is the point.
