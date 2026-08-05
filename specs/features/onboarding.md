---
title: First-run onboarding
status: current
last-verified: c2d18c0+ (2026-08-04); the splash gate now also holds for the calendar arrangement (`useCalendarPrefsReady`), so the calendar's first frame carries the user's colours instead of the app defaults (2026-08-04); the assistant feature bullet now says "scans photos" (was "scans receipts" — receipts are never AI-scanned; copy-only, matches billing-plans.md action-label truthfulness) (2026-07-30); first-run orientation screen added between sign-in and the app (before the unlock paywall), gated by a per-install AsyncStorage flag; names the feature calendars + Calen assistant, points at the Calendars entry point, and states the E2EE guarantee
code:
  - mobile/src/screens/onboarding/OnboardingScreen.tsx
  - mobile/src/lib/onboarding.ts
  - mobile/src/navigation/RootNavigator.tsx
tests:
  - mobile/src/lib/__tests__/onboarding.test.ts
---

# First-run onboarding

## Purpose

A new user finishes sign-up and would otherwise land on an empty calendar grid
with nothing explaining that Calen is more than a calendar. First-run onboarding
is a single orientation screen, shown once, that names what Calen does and points
at where the extra calendars live — the app's first impression instead of a blank
month view.

## Behavior (normative)

- After a user signs in, the app MUST show the onboarding screen once, before the
  main app, until they dismiss it with **Get started**. It sits **before** the
  unlock paywall ([billing-plans.md](billing-plans.md)) so a new user learns what
  Calen is before being asked to pay.
- Dismissal is one-way and persisted **per install** (an AsyncStorage flag,
  `hc_onboarding_complete`). Once set, subsequent launches MUST skip onboarding
  and route straight to the paywall/app. The flag is device-local, not synced —
  a fresh install or a new device sees it again.
- The gate MUST hold the splash while the flag reads from disk, so a returning
  user never flashes onboarding before it resolves. It holds the same way for
  the other device caches whose absence would paint something WRONG rather than
  merely empty: the unlock/viewer caches (billing-plans.md) and the calendar
  arrangement (`useCalendarPrefsReady` — calendar.md; without it the calendar's
  first frame is the default colours, recoloured a beat later). Each of those
  waits is capped or cache-satisfied on its own terms, and every one of them is
  scoped to `isLoggedIn`, so nothing can hold the splash on a signed-out or
  switched account.
- The screen MUST name the feature areas beyond the calendar (Meals, Home &
  chores, Trips, Contacts, and the Calen assistant), tell the user those live
  under **Calendars** at the top of the calendar, and state that content is
  end-to-end encrypted.
- Onboarding does not gate logged-out users and never blocks the auth stack.

## Data & API surface

- **Model(s):** none — no server state. Purely client-local.
- **Endpoints / sync:** none.
- **Client:** `mobile/src/lib/onboarding.ts` (the persisted flag + `useOnboardingStatus`
  subscriber hook, mirroring `privacyPrefs.ts`), `OnboardingScreen`, and the
  `RootNavigator` gate ordering (`!isLoggedIn` → onboarding → paywall → app).

## Encryption boundary

Nothing sensitive — the flag is a single boolean and carries no household data.
It is intentionally device-local and unencrypted.

## Verification

- `onboarding.test.ts` proves the persistence contract: a fresh install has no
  `hc_onboarding_complete` flag, and `markOnboardingComplete()` writes `'1'` so
  the next launch skips onboarding. The gate ordering and copy are presentation
  and are verified by read-back, not a unit test.

## Out of scope

- Multi-step/tour walkthroughs, per-feature coach marks, and a tab bar for the
  feature calendars (the app is intentionally calendar-centric — see the
  navigation shape in `RootNavigator`/`AppNavigator`). Onboarding only orients;
  it does not restructure navigation.
- The mandatory recovery-code gate shown right after registration is owned by
  [auth-identity.md](auth-identity.md); onboarding renders beneath it.

## Open questions

- Whether to reset the flag (re-show a "what's new" variant) after a major
  feature launch, and whether returning pre-onboarding users should be suppressed
  rather than shown the screen once.
