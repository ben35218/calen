---
title: Trips
status: current
last-verified: 55bfc65+ (2026-07-27); trip-item phone uses shared PhoneField, stored E.164 (2026-07-27); editing an end (trip range / booking start-end / journey Departs-Arrives) before the start drags the start back to preserve the span via shared lib/datetime.startKeepingDuration (2026-07-29)
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
- Editing the **end** of any Starts/Ends pair (a trip's date range, a booking's
  start/end, or a journey's Departs/Arrives) to at/before the start drags the
  **start** back so the span is preserved — the shared `lib/datetime.ts`
  (`startKeepingDuration`) rule described in calendar.md.
- `TripItem`s are itinerary/booking entries (title, start/end, location, address,
  confirmation, cost/currency, url/`phone` (entered via the shared `PhoneField`,
  stored E.164), notes, free-form `details`, and
  encrypted `attachments`). CRUD: `POST/PUT/DELETE /trips/:id/items[...]`;
  `POST /trips/:id/items/from-confirmation` parses a booking; per-item
  `attachments` upload/download/delete endpoints exist.
- `TravelLeg` caches computed travel between locations (mode/minutes/distance).

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
- **Invite outreach is device-composed.** `PUT /trips/:id/share` only creates the
  `TripInvitation` discovery record and returns the sharing list; the owner's own
  Mail/Messages app sends the nudge (`mailto:`/`sms:` via mobile `lib/shareInvite`)
  — the server sends no invite email or text. An invited **existing account** also
  gets a push (`notify.pushToUser`, best-effort) plus the in-app inbox entry. Same
  pattern as [households-sharing](households-sharing.md) and [calendars](calendar.md).
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
