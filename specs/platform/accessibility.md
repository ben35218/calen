---
title: Accessibility — Dynamic Type
status: current
last-verified: 1d42ed2+ (2026-08-12); initial spec — every `Text`/`TextInput` in the app now renders through a capped wrapper (`mobile/src/components/Text.tsx`) instead of the react-native primitive, so iOS Dynamic Type scales the UI to a ceiling the layouts survive (1.5x body, 1.1x fixed-geometry chrome) rather than to AX5's ~3.1x
code:
  - mobile/src/components/Text.tsx
tests:
  - mobile/src/components/__tests__/textScaling.test.tsx
---

# Accessibility — Dynamic Type

## Purpose

iOS lets the user scale every app's text from 0.8x up to ~3.1x (AX5, the largest
of the "Larger Accessibility Sizes"). React Native honours that scale on every
`Text` by default. Nothing in this app is laid out to survive 3.1x — the month
grid is a fixed 7-column geometry, avatars and badges are fixed discs, and ~90
styles pin an explicit `lineHeight` that does not scale with `fontSize` — so
unbounded scaling produces overlapping lines and text spilling out of its shape.

This spec owns the ceiling: how far text is allowed to grow, and where the app
holds a tighter line because the container cannot give.

Dark/light appearance is **not** covered here — the app is dark-only
(`mobile/src/theme.ts` is a single palette).

## Behavior (normative)

### Text scales, but to a cap

- Every user-visible string MUST render through `Text` from
  `mobile/src/components/Text.tsx`, never `Text` from `react-native`. The same
  holds for `TextInput`.
- Body text — lists, forms, detail screens, anything that reflows — MUST cap at
  `TEXT_MAX_SCALE` (**1.5x**). At that size the app stays usable: rows grow,
  labels wrap, nothing is clipped.
- Text baked into **fixed geometry** MUST cap at `FIXED_MAX_SCALE` (**1.1x**).
  Fixed geometry means a container whose size comes from something other than
  its text: a calendar cell (sized by the grid), an event block (sized by
  duration), a 44pt avatar or back pill, a count badge. These grow just enough
  to track the rest of the UI without bursting their shape. Use `FixedText`.
- A caller MAY override either cap by passing its own `maxFontSizeMultiplier`,
  or opt out entirely with `allowFontScaling={false}`. Props spread after the
  default, so the override always wins. Opting out is reserved for strings whose
  *layout is the content* — the Contacts A–Z index rail, a safety-number block.

### Where the tight cap applies

`FixedText` is used throughout the three grid surfaces and nowhere else:

- `CalendarScreen` — weekday headers, day numbers, month abbreviations, event
  chips and their times, "+N more", span bars, the avatar initial, the lock /
  invitation count badge, the icon-chip count, the back pill. Its Today and
  Calendars pills are padding-sized, so they take the ordinary body cap.
- `ViewerMonthGrid` — the read-only viewer's copy of the same grid.
- `DayColumn` — event-block titles and meta in the day timeline.

### The wrapper is the only door

A screen that imports `Text` or `TextInput` straight from `react-native` silently
scales to AX5 and breaks its layout, and the failure is invisible until someone
runs the app at an accessibility size. The suite therefore scans every file under
`mobile/src` and fails on any such import.

## Data & API surface

- **Client:** `mobile/src/components/Text.tsx` exports `Text`, `FixedText`,
  `TextInput`, and the two scale constants. `TextInput` is re-exported as a type
  as well as a value, so `useRef<TextInput>(null)` keeps resolving to the native
  instance.
- No model, endpoint, or persisted state — this is presentation only.

## Encryption boundary

Not applicable; no data crosses a boundary here.

## Verification

`mobile/src/components/__tests__/textScaling.test.tsx`:

- the two caps are ordered and both well under AX5 → "caps body text below iOS'
  largest accessibility size"
- `Text` / `TextInput` carry `TEXT_MAX_SCALE`, `FixedText` carries
  `FIXED_MAX_SCALE` → the two "applies the … cap" cases
- a caller's own `maxFontSizeMultiplier` / `allowFontScaling` beats the default
  → "lets a caller override the cap"
- no file under `mobile/src` imports `Text`/`TextInput` from `react-native`
  → "imports Text/TextInput from components/Text, never react-native"

**Not yet verified on device.** The caps are enforced in code and under test, but
nobody has run the app at AX5 to confirm 1.5x is actually the right ceiling, or
that navigation headers and tab-bar labels (native chrome, outside this wrapper)
hold up. See Open questions.

## Out of scope

- **Light mode.** The app is dark-only; there is no second palette.
- **VoiceOver, focus order, and contrast ratios.** Real accessibility work that
  this spec does not attempt. `accessibilityLabel` is applied ad hoc per screen
  today with no documented rule.
- **Navigation chrome.** Native-stack header titles and bottom-tab labels are
  rendered by the OS / React Navigation, not by this wrapper, and follow iOS'
  own Dynamic Type behavior.
- **The ~90 explicit `lineHeight` declarations.** Capping keeps them from
  overlapping in practice; it does not make them correct. A style with
  `fontSize: 12, lineHeight: 13` still has a line box that does not scale.

## Open questions

- Is 1.5x the right body ceiling? It needs a pass at AX5 on a small device
  (Ben's iPhone SE 3) to confirm forms and list rows still read.
- Should the tight `lineHeight` ratios in the grid styles be converted to
  multiples of `fontSize` so the cap can eventually be raised? Currently the
  1.1x cap is what hides them.
- Nothing enforces `FixedText` on *new* fixed-geometry surfaces — the import scan
  catches raw react-native imports, not a `Text` used where `FixedText` belongs.
