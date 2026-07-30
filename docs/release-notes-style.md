# TestFlight "What to Test" — release-notes style guide

Source of truth for the tester-facing release notes Claude writes for each new
App Store Connect / TestFlight build. When Ben asks for a new build (or for the
notes for one), Claude reads this file and produces notes in exactly this style
from the output of `npm run release:notes` (see [scripts/release-notes.mjs](../scripts/release-notes.mjs)).

## How to generate

1. Run `npm run release:notes` to get the commit range since the last build tag
   (`testflight/<version>-<build>`), with changes pre-grouped by tester-facing area.
2. Turn that into notes following the rules below.
3. After shipping, anchor the build: `npm run release:notes -- --tag <version>-<build>`.

## Rules

- **Audience: beta testers, not developers.** Describe what they can *see and try*,
  never internal mechanics (models, schemas, refactors, spec/test/CI changes).
- **Drop internal churn.** Anything under `specs/`, `scripts/`, `.github/`, tests,
  or pure refactors does not appear. The script separates these out for you.
- **Group by user-facing area** with an emoji + bold header (Calendar, Plans &
  billing, Add-ons, People, Assistant, etc.). Only include areas that changed.
- **Imperative, invite-to-try voice:** "Try the new…", "Check that…", "Poke at…".
- **Lead with the biggest user-visible change.** New features before fixes.
- **A short "🐛 Fixed" section** at the end for notable bug fixes testers had hit.
- **Warm bookends:** a one-line thanks at the top, a "report via Help & feedback"
  nudge at the bottom.
- **≤ 4000 characters** (App Store Connect `whatsNew` hard limit). Tighten if over.
- Keep bullets short; one idea each.

## Canonical example (2026-07-29 build)

> **What to Test — this build**
>
> Thanks for testing Calen! This build is a big one. Please poke at:
>
> **💳 Plans & billing (new model)**
> - Billing changed from subscription tiers to a **one-time app unlock** plus
>   **prepaid AI credits**. Try the unlock paywall, buying a credit pack, and watch
>   the credits banner update as you use the assistant.
>
> **🧩 Add-ons store**
> - New store with paid add-ons (**Meals, Maintenance, Trips**) and free opt-in
>   ones (**Birthdays, Chores**). Try enabling/disabling and confirm they
>   appear/disappear correctly.
>
> **📅 Calendar**
> - Calendar now **loads instantly from cache** then refreshes — check it feels
>   fast and stays correct after edits.
> - **New Apple-style Day view** (single day / multi-day / list). Try switching modes.
> - **Recurring events:** "Delete This Event Only" vs "Delete All Future," and
>   cancel/reschedule on a single occurrence.
> - Event detail: recurrence summary, travel-time row, mini timeline.
>
> **🎉 Occasions & onboarding**
> - New occasions + e-cards flow, and a first-run onboarding flow for new accounts.
>
> **📝 Editing & feedback**
> - Editing any form and backing out now shows a **"Discard Changes?"** prompt —
>   confirm it appears only when you actually changed something.
> - New **Help & feedback** screen under Profile (question / bug / idea).
>
> **🐛 Fixed**
> - Fixed the misleading **"update to the latest app version"** error some invitees
>   hit when toggling guest-list visibility or cancelling an event on shared calendars.
>
> Please report issues via the in-app Help & feedback screen. 🙏
