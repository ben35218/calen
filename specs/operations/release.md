---
title: Release & build
status: current
last-verified: ddaa21b+ (2026-08-10); the manual pre-release pass moved out of a markdown checklist and into the admin portal — a Release record per build, per-device test runs, and a **sign-off gate that refuses while a blocker case is unexecuted or failing**; `docs/PRE-RELEASE-TEST-PLAN.md` stays the authoring source and is imported (mechanics in [features/release-qa.md](../features/release-qa.md)) (2026-08-10); d96d6b3 (2026-07-27); added a "remove development-only surfaces" pre-launch checklist and cleared its first entry — the Reminders → Delivery diagnostics card + test-notification button were removed, leaving the unrendered run log behind (46cd98a+, 2026-08-04)
code:
  - mobile/RELEASE.md
  - mobile/eas.json
  - mobile/app.json
  - render.yaml
---

# Release & build

How Calen ships: the API to Render, the mobile app to the App Store / Play via
EAS. `mobile/RELEASE.md` holds the detailed store-prep checklist and credential
blockers; this spec is the current-state overview.

## Server (API)

- Deployed via the Render Blueprint ([`render.yaml`](../../render.yaml),
  `rootDir: server`). Set the production env (see the README env table:
  `MONGODB_URI`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `SMTP_*`, `EXPO_ACCESS_TOKEN`,
  `VAPI_*`, `REVENUECAT_WEBHOOK_SECRET`, `PASSKEY_*`, `CORS_ORIGINS`, and point
  `UPLOAD_DIR` at a persistent volume).

## Mobile (EAS)

- Profiles in [`mobile/eas.json`](../../mobile/eas.json): `development`
  (dev client), `preview` (internal distribution), `production` (store).
  `appVersionSource: remote` + `autoIncrement` — EAS manages build numbers.
- Client code is config-driven and degrades gracefully when external values are
  missing (push, purchases, API URL all have safe fallbacks — see `RELEASE.md`).
- **Credential blockers** (external, one-time): Expo/EAS project (`eas init`
  writes `projectId`), Apple Developer + App Store Connect record, Google Play
  Console + service-account JSON, RevenueCat project with the `premium` /
  `unlimited` entitlements + webhook, and the production HTTPS API URL. Details
  in `RELEASE.md`.

```bash
cd mobile
eas build --profile production --platform all
eas submit --profile production --platform ios       # TestFlight / App Store
eas submit --profile production --platform android   # Play internal track
```

## The pre-release test pass (tracked, not remembered)

The full manual pass is authored in
[`docs/PRE-RELEASE-TEST-PLAN.md`](../../docs/PRE-RELEASE-TEST-PLAN.md) — the
source of truth for what gets tested — and **executed in the admin portal**
(Quality → Releases). The loop, per public build:

1. **Import** the plan into the case library (portal → Test cases → Import, or
   `node src/scripts/importTestCases.js docs/PRE-RELEASE-TEST-PLAN.md --commit`).
   The import is dry-run first and shows what it would add/update/retire.
2. **Open a Release** for the build (version + build number + the
   `testflight/<version>-<buildNumber>` tag this doc's tooling anchors) and move
   it to `testing`.
3. **Run it** — one run per device in the plan's matrix, recording
   pass/fail/blocked/skipped/NA per case. Partial runs are expected: the plan
   deliberately puts the full pass on the primary device and the smoke subset on
   the rest.
4. **Sign off.** The gate **refuses while any blocker case is unexecuted or
   failing**, naming them. It is the machine-checked half of the plan's own exit
   criteria ("every ⛔ BLOCKER case passes; zero open S1/S2"); the rest stays the
   release owner's judgement.
5. Ship, then anchor the build: `npm run release:notes -- --tag <version>-<buildNumber>`.

Mechanics — import semantics, the retire-never-delete rule, run/result shapes,
and the exact gate — are owned by
[features/release-qa.md](../features/release-qa.md).

## Pre-submit smoke pass

A native **dev/store build** is required whenever native modules change
(`expo-file-system`, `expo-sqlite`, `expo-notifications`, `react-native-passkeys`,
`react-native-purchases`) — they don't run in Expo Go. Minimum on-device pass:

- Sign in (token in SecureStore) → lists load from the live API; the sqlite
  replica is in use (no AsyncStorage fallback warning).
- Create + edit a record; confirm it syncs (`/records/sync`) and reads back.
- Encrypted attachment roundtrip: upload a manual/booking PDF → reopen (decrypts).
- Passkey (if configured): add a passkey → relaunch → Face ID unlocks without a
  password.
- Reminder: create an event with a near reminder, background the app, it arrives.
- Complete a sandbox IAP → plan flips via the webhook.
- Stream one assistant response (SSE).

## Pre-launch checklist — E2EE completion (prod residue, audited 2026-07-27)

New households are born encrypted, but a prod audit (2026-07-27, read-only)
found **residual plaintext from the pre-mandate era** that must be cleared
before launch. The steps are ordered and interlocked — each script refuses to
run before its prerequisite (see the headers of
`server/src/scripts/{reDropPlaintext,dropContentCollections}.js`):

1. **Re-seal the two grandfathered households** (bendpolk@ and laithpolk@ —
   both stamped `dropFieldsVersion` 0 of 4, household **name still plaintext**).
   Requires an app session on each **owner's unlocked device**; the re-seal pass
   (`dropMigration.reencryptForReDrop`) runs automatically on unlock and stamps
   v4. No server-side substitute exists by design.
2. **Re-drop each**: `node src/scripts/reDropPlaintext.js <hh> --commit`
   (dry-run first) — nulls `Household.name` + the newer plaintext columns.
3. **Drop the legacy content tables**:
   `node src/scripts/dropContentCollections.js --commit` — removes the
   pre-cutover rows the app no longer reads (~364 rows incl. deleted users'
   plaintext categories/people and 6 legacy calendar events). Do NOT migrate
   these rows into `Record` first — they lack `householdId` and are stale;
   they are meant to die here.
4. **Delete the 4 zero-member orphan households** (test/deleted-account
   leftovers holding plaintext names + home addresses).
5. **Re-run the residue audit** (all-clean = no plaintext content columns, all
   e2eeActive households at `DROP_FIELDS_VERSION`), then **reconcile the
   user-facing docs**: `docs/CRYPTO-SPEC.md` §7 + `docs/TRANSPARENCY.md` still
   conservatively list the household name and `nextDueDate` as server-visible;
   update once the residue is confirmed gone (tracked in
   [crypto-e2ee.md](../platform/crypto-e2ee.md) open questions).
6. **E2 — publish `shared/crypto` + `docs/CRYPTO-SPEC.md`** (repo/venue
   decision pending).
7. **E3 — third-party crypto audit** (ops/comms engagement; schedule near
   launch against the final surface — see `docs/SIGNAL-PARITY-PLAN.md`).

## Pre-launch checklist — remove development-only surfaces

Affordances kept deliberately through TestFlight to diagnose problems on real
devices, which are **not** meant to ship to the store. Add an entry the moment
such a surface goes in, naming what to cut *and what must survive the cut* — the
list is only useful if it is written while the context is fresh rather than
reconstructed at launch.

**Nothing outstanding.** Cleared 2026-08-04:

- **Reminders → "Delivery" card** (pending/next-reminder status rows + *Send a
  test notification*), added 2026-08-03 to diagnose the silent on-device reminder
  outage — **removed**, along with the now-orphaned `getReminderDiagnostics()`
  and `sendTestNotification()`. The Reminders screen keeps only its `denied`
  banner + Open Settings row, which is a permission fix the user can act on
  rather than diagnostics. The **run log stays** (`recordRun`,
  `hc_reminder_run_log`, the stage tagging, the `console.warn`): nothing renders
  it, it costs nothing, and it is the only record of an on-device E2EE failure.
  Removing the card does re-open one gap — a user hitting this in production has
  no way to report the cause — tracked in
  [notifications.md](../features/notifications.md).

## Deliberately NOT in scope

- The old **steady-state "per-household plaintext drop"** go-live is obsolete
  for new households: E2EE is mandatory and born-encrypted. (The former
  `docs/RELEASE-SMOKE-CHECKLIST.md`, written around that flow, was retired
  2026-07-20 — this spec supersedes it.) The one-time pre-launch residue
  cleanup above is what remains of it.
- Cross-household trip-attachment encryption (design gap — see [trips.md](../features/trips.md)).

## Open questions

- Document the Android release track status (currently iOS-first).
