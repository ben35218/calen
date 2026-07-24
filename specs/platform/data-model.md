---
title: Data model
status: current
last-verified: 337a313 (2026-07-24)
code:
  - server/src/models/Record.js        # the live opaque content store
  - server/src/models/encFields.js
  - server/src/services/contentModels.js
  - server/src/models/
tests:
  - server/src/test/records.integration.test.js
  - server/src/test/authorHiding.integration.test.js
  - server/src/services/dropReadiness.test.js
---

# Data model

The single most important fact: **household content is stored content-blind.**
Every content record — an event, a person, a task, a recipe, a trip item — lives
as an opaque envelope in one physical collection, and the server never learns
even which *kind* of record it is. Everything else in `server/src/models/` is
identity, membership, sharing, or operational metadata that is plaintext by
necessity.

## The opaque record store (live content path)

[`Record`](../../server/src/models/Record.js) is the unified content collection
(Signal-parity "C3"). One Mongo collection holds every content record; the
collection type and all content fields ride **inside** the sealed `enc` blob (the
v2 envelope — the collection tag was moved out of the AAD and into the payload).

**The only plaintext (routing) fields on a Record:**

| Field | Why it's plaintext |
|---|---|
| `householdId` (indexed) | Attribution + primary read scope; the sync cursor is `householdId + updatedAt`. Household-granular, not member-granular (the member/author is sealed inside `enc`). |
| `userId` (conditional) | Author routing **only** for a solo user (no household yet), a resource-scoped record, or a not-yet-active household. On an active household it is omitted (author-hiding, C4). |
| `keyVersion` + `enc {alg, nonce, ct, ks}` | The ciphertext. `ks` picks the key: absent = household HDK, `cal`/`trip` = a resource key. |
| `scope {kind, resource, version}` | The shared-resource lane: a cross-household collaborator reads a shared calendar/trip's records by `scope.resource` (a CalendarKey / Trip id), never by `householdId`. No new identifier — it's the same routing the per-collection models exposed as `calendarType` / `tripId`. |
| `deleted` | Tombstone. Deletes flip this + bump `updatedAt` so the LWW sync propagates them; the row is reaped later. |
| `createdAt` / `updatedAt` | Existence + timing metadata (server-visible, acknowledged). |

The server **never reads `enc`** — it only stores and serves it, scoped by the
routing above. Reached only through `/api/records` (see
[api-reference.md](api-reference.md)).

## Decrypted record shapes (the per-collection models)

The per-collection schemas — `CalendarEvent`, `Person`, `MaintenanceTask`,
`Chore`, `Recipe`, `Trip`, `TripItem`, `Item`, `OdometerLog`, `RecipeSchedule`,
`Category` (the registry in
[`services/contentModels.js`](../../server/src/services/contentModels.js)) —
define the **decrypted shape** of what gets sealed into a Record's `enc`. The
client seals `{ collection, ...fields }`; those field definitions are the schema.

The exact **sealed field set per collection** is enumerated in
[`services/dropReadiness.js`](../../server/src/services/dropReadiness.js) as
`DROP_FIELDS` (the columns the drop nulls once ciphertext exists, and that
`e2eePolicy.stripSealedContent` strips on writes to an active household). It is
versioned (`DROP_FIELDS_VERSION`); notable additions over time: `nextDueDate`,
`nextDueKm`/`intervalKm`/`lastServiceKm` (D4), odometer reading/notes,
`RecipeSchedule.notes`, `Category.name` (D5), and `Household.name` (C2).

> **Caveat for these schemas:** they carry `...encFields` and mark content fields
> `requiredUntilSealed`, and some fields have comments calling them "plaintext
> scope field" (e.g. `calendarType`, `alertAudience`). Those comments describe
> the earlier **dual-write** era, when rows were written to their own collections
> with plaintext alongside ciphertext. In the live opaque store those fields are
> sealed inside `enc`; the physical per-collection rows are legacy/dual-write
> data plus the tooling surface (straggler re-encrypt, drop-readiness). Do not
> read the per-model plaintext fields as "server-visible" for new records.

## Identity, keys & sharing (plaintext by necessity)

- **Identity/keys:** `User` (email, name, timestamps, auth factors, public key,
  `aiEnabled` — the server-side mirror of the device's AI consent toggle;
  `sessions[]` device-session rows keyed by the install's random `deviceId` —
  an opaque label/dedup value, never an auth factor — see
  [features/auth-identity.md](../features/auth-identity.md)),
  `HouseholdKeyEnvelope` (HDK sealed per member × version), `ResourceKeyEnvelope`
  (calendar/trip keys for cross-household sharing), `DeviceLink`.
- **Household/membership:** `Household` — **name + `homeAddress`/`lat`/`lon` are
  sealed** into `Household.enc` (Signal-parity C2/P5), nulled at the drop; owner,
  key version, plan/billing, and grocery/timezone settings stay plaintext.
  `HouseholdInvitation`, `JoinRequest`.
- **Sharing & outside invitations:** `CustomCalendar`, `CalendarInvitation`,
  `EventInvitation`, `TripInvitation` — these carry the deliberate plaintext
  snapshots that make outside sharing work (see below).
- **Attachments:** `Manual`, `EventAttachment`, `Receipt` — file **bytes are
  encrypted per-file**; the row metadata (size, key wrap, references) is plaintext.

## Operational / metadata models

`AuditLog` (security lifecycle — who/when, never content), `EmailLog`
(template + delivery status, codes masked), `MonetizationConfig`, `PhoneCall`
(AI call outcome summary), `ContentReport` (moderation), `WeatherRecord`
(legacy cache, bypassed for E2EE households), plus legacy/aux rows
(`Property`, `TaskCompletion`, `TravelLeg`, `ShoppingSession`).

## Authoritative server-visible set

The honest list of what a server (or a legal request) can see: membership graph,
record existence/timing/(padded)size, key version, plan/billing counts, device
labels, and the deliberate plaintext exceptions — content **shared outside** the
household (trips/calendars), **event invitations** to non-account people, and
**AI phone-call** essentials. Household **name and home address are NOT** in this
list (sealed, C2). See [platform/crypto-e2ee.md](crypto-e2ee.md).

> `docs/CRYPTO-SPEC.md` §7 and `docs/TRANSPARENCY.md` still list household name
> (and `nextDueDate`) as server-visible — stale since C2/D4. Reconcile once the
> prod re-seal/re-drop backfill is confirmed complete.

## Verification

- The routing-only plaintext contract: an opaque write stores routing +
  ciphertext (no plaintext type), `householdId` is stamped authoritatively and
  unspoofable, ciphertext is required, LWW sync + tombstones propagate,
  cross-household isolation, household-lane and resource-lane reads, dual-accept
  of the v1 envelope, orphaned-attachment reaping —
  `records.integration.test.js`.
- Author-hiding (`userId` omitted on active households, kept pre-active) —
  `authorHiding.integration.test.js`.
- The `DROP_FIELDS` sealed-field enumeration — `services/dropReadiness.test.js`.

## Open questions

- Confirm whether any live client path still writes the legacy per-collection
  collections, or whether they are now purely historical + tooling.

*(Resolved 2026-07-20: `nextDueDate` and the km-scheduling fields are **sealed**
— they are in `DROP_FIELDS` (D4) and scheduling runs client-side via the
`shared/calendar` km engine. The earlier "is nextDueDate server-visible?"
question is closed.)*
