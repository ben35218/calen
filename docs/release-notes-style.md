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

- **PLAIN TEXT ONLY — no emoji, no markdown.** App Store Connect's "What to Test"
  field rejected the old emoji/markdown format with a page-level validation error
  (2026-07-30, build 24). Never use emoji, `**bold**`, `>` blockquotes, or any
  other markup. Area headers are ALL-CAPS lines; bullets are plain hyphens.
  Straight quotes, em dashes, and $ signs are fine (accepted in build 24).
- **Audience: beta testers, not developers.** Describe what they can *see and try*,
  never internal mechanics (models, schemas, refactors, spec/test/CI changes).
- **Drop internal churn.** Anything under `specs/`, `scripts/`, `.github/`, tests,
  or pure refactors does not appear. The script separates these out for you.
- **Group by user-facing area** with an ALL-CAPS header (CREDITS, CALENDAR,
  ADD-ONS, CONTACTS, ASSISTANT, etc.). Only include areas that changed.
- **Imperative, invite-to-try voice:** "Try the new…", "Check that…", "Poke at…".
- **Lead with the biggest user-visible change.** New features before fixes.
- **A short "FIXED" section** at the end for notable bug fixes testers had hit.
- **Warm bookends:** a one-line thanks at the top, a "report via Help & feedback"
  nudge at the bottom (plain text — no emoji).

### Keep it short

Testers skim these on a phone, in TestFlight, before opening the app. A wall of
text gets skipped entirely, so brevity is a rule, not a preference:

- **Target ~1200 characters** for the whole thing (the App Store Connect
  `whatsNew` hard limit is 4000 — that's the ceiling, not the goal).
- **At most 6 area sections**, and **at most 3 bullets per area.** If a release
  touched more, cut to what a tester can actually go and try.
- **One line per bullet** — one idea, no sub-clauses, no parenthetical asides,
  no naming the setting path unless the tester needs it to find the feature.
- **Cut anything a tester can't act on.** Pricing mechanics, internal reasons,
  and "we also refactored X" never earn a line.
- When two bullets describe the same feature from different angles, keep one.

## Format reference (2026-07-30, build 24 — accepted by App Store Connect)

This is the proof of the PLAIN-TEXT format App Store Connect accepts — copy its
shape, not its length. At ~1650 characters, with 5 bullets in one section and
several running to two clauses, it sits well past the target above; today it
would be cut to the three things a tester should actually go and try per area.

```
What to Test — this build

Thanks for testing Calen! This build is all about AI credits and the new Calen AI plan.

CREDITS & THE NEW CALEN AI PLAN
- New optional Calen AI monthly plan: 600 credits every month for $4.99. Try subscribing from the Credits screen.
- Manage or cancel right from the app: tap Manage subscription, cancel in the Apple sheet, and check the card changes to "Cancelled — plan benefits until your renewal date. Your credits are yours forever." Then try re-subscribing.
- Credit prices are now flat per action. Check the "What things cost" card: cheapest first, phone calls (per-minute) pinned last.
- History now shows every credit movement, usage as well as purchases.
- Placing an assistant phone call now shows an estimated credits-per-minute price above the call button. Confirm it appears before you dial.

OWNER'S MANUALS
- Uploading a manual (file or from a URL) is now free. Credits are only spent when the AI looks one up or extracts maintenance tasks from it. Parsing also got smarter on long documents.

ADD-ONS
- The Add-ons row on the Calendars screen now stays put once you own everything (it reads "All add-ons added"). It is the permanent store entry point.

RECOVERY CODE
- If you close the app before saving your recovery code, a fresh code now appears on your next unlock. Try force-quitting the recovery modal and reopening.

FIXED
- Manual uploads no longer charge credits for plain file storage.
- Cost labels now say exactly what's metered: "Photo scan", "Recipe generation", "Owner's manual parsing" (receipts are never AI-scanned).

Please report issues via the in-app Help & feedback screen. Thank you!
```
