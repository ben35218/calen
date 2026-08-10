---
title: Trips
status: current
last-verified: dbc5096+ (2026-08-10); **Starts/Ends redesign follows calendar.md**: a start edit now always carries the end with it (span preserved, either direction) via the shared `endKeepingDuration`; the end field is how the span changes; itinerary-item start-**time** edits shift the end only when both clocks are set (2026-08-06); nothing in trips repeats — neither `Trip` nor `TripItem` carries a recurrence field and itinerary items never reach the calendar, so the occurrence-scope prompts events/chores/tasks answer deliberately don't apply here; a repeating event on the Trips calendar is an ordinary calendar event and follows the event rules (recorded so the absence reads as a data-model property, not a gap) (2026-08-04); the trip assistant gained chat web search (server-side web_search tool + "Searching the web…" activity label) — behavior and pricing owned by ai-assistant.md / billing-plans.md (2026-07-30); trip-item phone uses shared PhoneField, stored E.164 (2026-07-27); editing an end (trip range / booking start-end / journey Departs-Arrives) before the start drags the start back to preserve the span via shared lib/datetime.startKeepingDuration (2026-07-29); the trip and trip-item add/edit forms guard against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (2026-07-29); trip-share email invites now compose via the shared mail-app chooser (`useEmailComposer`/EmailAppSheet — behavior specced in households-sharing.md) instead of a bare `mailto:` (2026-07-29); the Starts/Ends duration-keeping rule is now symmetric — editing the **start** (date/time) to at/after the end pushes the **end** forward via the shared `lib/datetime.endKeepingDuration`, mirroring the existing end→start drag, on the trip date range, the booking start/end, and the journey Departs/Arrives, so the end is never left before the start (2026-07-29); trip-share outreach is now composer-only-for-non-accounts — an account-holder recipient gets the server push + in-app inbox with no composer (lookup-gated via `GET /invitations/lookup`, fail-open, "they're on Calen" note), and not-yet-joined recipient rows gained a paper-plane Remind that composes on demand (households-sharing.md policy) (2026-07-29); the Trip Name field capitalizes each word (`autoCapitalize="words"`, proper-noun rule in mobile/CLAUDE.md); the Destination city keeps PlacesAutocomplete's own keyboard config (2026-08-10)
code:
  - mobile/src/screens/trips/
  - server/src/routes/trips.js
  - server/src/services/tripSharing.js
  - server/src/models/{Trip,TravelLeg,TripItem,TripInvitation}.js
  - mobile/src/lib/tripKeys.ts
tests:
  - server/src/test/tripKeys.integration.test.js
  - server/src/test/tripShare.integration.test.js
  - server/src/test/tripAttachments.integration.test.js
  - server/src/services/tripSharing.test.js
---

# Trips

## Purpose

Plan trips with itinerary/booking items, split and settle expenses across
participating households, and share a trip with people outside your household.

## Behavior (normative)

- **Unsaved-changes guard:** the trip and trip-item (booking) add/edit forms
  prompt an Apple-style "Discard Changes?" sheet before leaving with unsaved
  edits (header ✕ / back / swipe-back / Android back), via the shared
  `useUnsavedChangesGuard` hook — a successful save/delete/leave exits without
  prompting. On the trip form, changes to an existing trip's outside-sharing
  persist to the server immediately and so don't count as unsaved (a new trip's
  pending invites do). See [calendar.md](calendar.md) and
  [mobile/CLAUDE.md](../../mobile/CLAUDE.md).

### Add-on gating

- The Trips home is gated by the **`trips` add-on** — a one-time household-wide
  purchase specified in
  [billing-plans.md](billing-plans.md#feature-calendar-add-ons). When the
  household doesn't own it, `TripsScreen` renders the `AddonLockedView`
  purchase interstitial instead of its content (trip detail/sharing sub-screens
  are reached only through the gated home). Data is retained while locked and
  reappears on purchase.

### Trips & itinerary

- A `Trip` has name, destination (+ placeId/timezone), status, date range (or
  `candidateRanges` while planning), notes, color, `budget`, `baseCurrency`, and
  a `tripKeyVersion` (its own resource key, see Sharing).
- Every Starts/Ends pair (a trip's date range, a booking's start/end, or a
  journey's Departs/Arrives) follows the shared `lib/datetime.ts` rule described
  in calendar.md: editing the **start** always carries the **end** with it so
  the span is preserved (`endKeepingDuration`) — changing the span is the end
  field's job — and editing the **end** changes the span, unless it lands
  at/before the start, which drags the **start** back (`startKeepingDuration`)
  so the end never precedes the start. On an itinerary item, a start **time**
  edit only moves the end when the pair had both clocks set (a first-set start
  time, or a date-only end, leaves the end alone).
- `TripItem`s are itinerary/booking entries (title, start/end, location, address,
  confirmation, cost/currency, url/`phone` (entered via the shared `PhoneField`,
  stored E.164), notes, free-form `details`, and
  encrypted `attachments`). CRUD: `POST/PUT/DELETE /trips/:id/items[...]`;
  `POST /trips/:id/items/from-confirmation` parses a booking; per-item
  `attachments` upload/download/delete endpoints exist.
- `TravelLeg` caches computed travel between locations (mode/minutes/distance).
- **Nothing in trips repeats.** Neither `Trip` nor `TripItem` carries a recurrence
  field, and itinerary items never reach the calendar at all — a trip contributes
  only its date range (or its `candidateRanges` while planning) as a spanning
  overlay. So the Apple-style "This Occurrence Only / All Future" scoping that
  events, chores, and maintenance tasks answer on save and delete **does not apply
  here**, and its absence is a property of the data model rather than a gap in the
  UI. A repeating **event** whose `calendarType` is `trips` is an ordinary calendar
  event and is scoped by the event rules in [calendar.md](calendar.md);
  `calendarType` is just a field, so every calendar gets that behaviour uniformly.

### Expenses & settlement

- Costs are split across households: `householdBudgets`, per-item `shares` /
  `householdData` / `paidByHouseholdId`. Endpoints: `GET /:id/budget`,
  `/:id/families`, `PUT /:id/my-budget`, `GET /:id/settlement`,
  `POST /:id/settle-payments` (+ delete), rendered by `TripSettleScreen`.

### Sharing outside the household (normative)

- A trip may be shared with an outside collaborator who does **not** hold your
  HDK. Two mechanisms:
  - **Resource-key sharing** (in-app collaborators): `GET/POST /trips/:id/keys`,
    `/keys/members`, `/keys/pending` seal a per-trip key to the collaborator so
    trip records decrypt for them (`lib/tripKeys.ts`, `ResourceKeyEnvelope`).
  - **Decrypt-on-share** (`PUT /trips/:id/share`, `services/tripSharing.js`): the
    client sends the decrypted `{ trip, items }`; the server re-writes them as
    **plaintext** and mints a share code. Steady-state writes then **strip
    ciphertext while shared** so an edit can't reintroduce data the collaborator
    can't read. Un-sharing (`DELETE /:id/share`) re-encrypts on next edit.
- **Invite outreach is device-composed, and only for non-account recipients.**
  `PUT /trips/:id/share` only creates the `TripInvitation` discovery record and
  returns the sharing list — the server sends no invite email or text. An
  invited **existing account** gets a push (`notify.pushToUser`, best-effort)
  plus the in-app inbox entry, and NO composer opens on the owner's device
  (the trip form checks `GET /invitations/lookup` before composing, failing
  open, and shows a "they're on Calen" note instead). Only a recipient
  **without an account** gets the composed nudge — the owner's chosen mail app
  via the shared mail-app chooser, `sms:` for phones (mobile `lib/shareInvite`
  + `components/EmailAppSheet`). Not-yet-joined recipient rows carry a Remind
  action that re-opens the composer on demand regardless of account status.
  Policy + chooser behavior specced in
  [households-sharing](households-sharing.md); same pattern as
  [calendars](calendar.md).
- `TripInvitation` handles invite accept/decline (`GET /trips/invitations`,
  `.../accept`|`decline`). Collaborator management:
  `POST /:id/leave-share`, `DELETE /:id/collaborators/:userId`.

## Data & API surface

- **Models:** `Trip`, `TripItem` (+ encrypted `attachments`), `TravelLeg`,
  `TripInvitation`.
- **Endpoints:** `server/src/routes/trips.js` (the largest router — trips, items,
  budgets/settlement, sharing, keys).
- **Client:** `screens/trips/*` (Trips, TripDetail, TripForm, TripItemForm,
  TripSettle, TripPicker, TripAssistant). The trip assistant's prompt shows
  booking confirmation codes as "on file" only (never the code itself) — see
  [ai-assistant.md](ai-assistant.md).
  - The first-run empty state names the feature's purpose (plan bookings + split
    expenses with fellow travelers), not just "plan a getaway", so a new user
    understands what a trip is for before creating one.

## Encryption boundary

Trip content is sealed by default. **Outside sharing is a deliberate plaintext
exception** (the shared trip + items become server-readable so a non-household
collaborator can read them). Trip attachments across households remain a known
design gap (a collaborator outside your household doesn't hold the key). See
[platform/crypto-e2ee.md](../platform/crypto-e2ee.md).

## Verification

- TripKey lifecycle: owner-household-only mint/rotate (compare-and-set),
  wrap-on-approve, collaborator-only member wraps, revoke → rotation, envelope
  cleanup on delete — `tripKeys.integration.test.js`.
- Sharing paths: sealed trips share without a 409 (stay sealed, D2), sealed-name
  invitation snapshots, TripKey-sealed records strip plaintext, decrypt-on-share
  for non-E2EE households, invite → accept collaborator flow, share-by-phone —
  `tripShare.integration.test.js` (+ `services/tripSharing.test.js` units).
- Attachments: encrypted upload stores crypto metadata, shared-booking uploads
  wrap Kf under the TripKey (D2), unwrapped uploads rejected —
  `tripAttachments.integration.test.js`.
- Budget/settlement math has no automated coverage yet (see Open questions).

## Open questions

- Document the settlement algorithm (who-owes-whom minimization).
- Resolve cross-household trip-attachment encryption (currently plaintext on
  shared trips).
