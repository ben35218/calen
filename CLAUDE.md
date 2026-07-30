# Household Copilot / Calen

## Spec-driven development (required — read before editing feature code)

The spec leads, the code follows. Specs live in [specs/](specs/); the full loop
is in [specs/README.md](specs/README.md). **Any change that alters behavior MUST
update the owning spec in the same commit/PR** — code that changes an area
without touching that area's spec is drift, treated as a defect.

The loop, every behavior change:

1. **Spec first.** Before/while implementing, update the relevant spec(s) —
   `specs/features/<area>.md` for a feature, `specs/platform/*` for API /
   data-model / crypto. Write the intended behavior, not a changelog.
2. **Implement** to match the spec.
3. **Verify** (tests + read-back) that the code does what the spec says.
4. **Bump `last-verified`** on every spec you touched (new commit short-sha + date).
5. **Ship them together** in the same commit/PR.

Before finishing, run the gate: `node scripts/check-spec-sync.mjs` (working tree)
or `node scripts/check-spec-sync.mjs --base main` (branch vs `main`). It maps
changed code paths to their owning spec and flags any area changed without a spec
update. Resolve drift on the files you touched, or note in the PR why the change
doesn't alter documented behavior.

Mobile UI conventions live in [mobile/CLAUDE.md](mobile/CLAUDE.md).

## Release notes (TestFlight / App Store Connect)

When asked to prepare a new App Store Connect build — or for the "What to Test"
notes for one — run `npm run release:notes` and write tester-facing notes that
follow [docs/release-notes-style.md](docs/release-notes-style.md) exactly (group
by user-facing area, drop internal/spec/test/CI churn, ≤4000 chars). After the
build ships, anchor it: `npm run release:notes -- --tag <version>-<buildNumber>`.
