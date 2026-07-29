---
title: Release & build
status: current
last-verified: d96d6b3 (2026-07-27)
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

## Deliberately NOT in scope

- The old **steady-state "per-household plaintext drop"** go-live is obsolete
  for new households: E2EE is mandatory and born-encrypted. (The former
  `docs/RELEASE-SMOKE-CHECKLIST.md`, written around that flow, was retired
  2026-07-20 — this spec supersedes it.) The one-time pre-launch residue
  cleanup above is what remains of it.
- Cross-household trip-attachment encryption (design gap — see [trips.md](../features/trips.md)).

## Open questions

- Document the Android release track status (currently iOS-first).
