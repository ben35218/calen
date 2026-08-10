---
title: Data model
status: current
last-verified: ddaa21b+ (2026-08-09); `CalendarEvent` gains `alertAnchor`/`alert2Anchor` (`'event'`|`'leave'`, absent = `'event'`) — sealed with the alert minutes they describe; the minutes stay minutes-before-the-EVENT for both framings, so the scheduler is unchanged — behavior owned by features/calendar.md; ddaa21b+ (2026-08-06); added the client-only `EventRsvp` opaque-store collection (a member's sealed accept/decline of a household event invite; one single-writer record per responder per event, responder = the C4 `author` fold-in; no server schema — behavior owned by features/calendar.md) (2026-08-06); c2d18c0+ (2026-08-04); **`User.addons` added; `Household.addons` retired to LEGACY** — feature-calendar add-on ownership moved onto the user who actually bought it (RevenueCat keys purchases to `app_user_id` = user id), with the household-wide effect derived as the union across members at read time; storing it on the household detached the entitlement from the buyer, so leaving or being removed silently dropped add-ons they had paid for. The Household field is read by nothing and kept only for `scripts/backfillUserAddons.js` + rollback (2026-08-04); c2d18c0+ (2026-08-04); **a local write left its replica row decrypting to the PREVIOUS content** — `splitSealed` moves `enc`/`keyVersion` into the wire body, so `recordStore.update`'s `{ ...existing, ...plain }` merge kept the pre-write ciphertext, and since `openRecord` spreads decrypted fields over the plaintext every reader saw stale content until a background sync happened to replace the row; the fix carries the fresh ciphertext into the replica on create and update (reported as "I have to click Resume twice" and an ended chore staying in the chores list) (2026-08-04); all three repeating collections now carry their per-occurrence exceptions inside the record (`CalendarEvent.exceptionDates` + `recurrence.until`; `MaintenanceTask`/`Chore` `recurrence.skipDates` + `recurrence.until`, nested so the existing enc subsets seal them), since a server that can't read sealed content can't maintain a side table (2026-08-04); `User` gains `calendarPrefs` (the user's calendar arrangement: sparse `colors`/`order`/`hidden`/`deletedDefaults`/`alertsOff`; plaintext, like the `CustomCalendar` records its ids point at) so the arrangement survives the sign-out wipe of the client's device cache — behavior owned by [calendar](../features/calendar.md) (2026-08-04); `User` gains `usageWebSearches` (weekly {count, costMc} chat web-search counters) and `MonetizationConfig` gains `credits.actionCosts.webSearch` + `credits.webSearchRatePerSearch` (backfilled in getSingleton) — behavior owned by billing-plans.md / ai-assistant.md (2026-07-30); `User` gains `aiPlanActive`/`aiPlanExpiresAt` (monthly Calen AI plan) + provider-cost estimate counters, `CreditLedger` now records per-action usage debits (kinds + `action`), `MonetizationConfig` gains `credits.actionCosts` (flat per-action prices) + `aiPlan` (2026-07-30); added plaintext `Feedback` model (in-app questions/bugs/ideas + captured device diagnostics; support content, not sealed) and the `feedback_status_changed` audit event — see [feedback](../features/feedback.md) (2026-07-29); phone fields stored E.164 via shared PhoneField (2026-07-27); added plaintext `ECard` model (scheduled occasion e-cards) + occasion derivation from `Person.dates[]` (2026-07-28); ECard gains font + framing-line overrides + plaintext photo rows (2026-07-28); `Person` gains structured `firstName`/`lastName` (sealed content; `name` stays the composed source of truth) (2026-07-28); `EmailLog` upgraded to a delivery ledger + transient retry outbox, added `EmailLifecycleConfig` + `EmailSuppression` operational models (email-lifecycle.md) (2026-07-29); documented client record-sync cursor safety (never advance past an unreconciled row; reset the cursor whenever the replica is wiped) after a sign-out/sign-in content-loss bug (2026-07-29); activation straggler gate now counts author-hidden content from the `Record` store (not legacy tables) so an orphaned/un-migrated legacy plaintext row can't deadlock born-encrypted activation (2026-07-29); added personal `User.dayAlertTime` (`HH:mm`, null=9am) — the configurable day-based alert default (2026-07-29); record-sync now re-pulls + refetches the replica-backed views when the HDK first lands (`subscribeKeysReady` → auth-store subscriber), fixing first-login calendar/people showing only weather+holidays until a manual mutation (2026-07-29); added `PhoneCall.dncCaptured` (set when the recipient asked, on that call, not to be called again) so the call outcome view can surface an explicit do-not-call notice (2026-07-29); added plaintext `HouseholdNotice` model (per-user membership notice, `kind` removed|approved, `householdId` + actor first name) surfaced in the Invitations inbox (2026-07-29); `CustomCalendar` collaborator seats gained the re-key suppression pair (`keyChangedAt` / `reapprovalRequestedAt` — server state that withholds the owner's automatic CalendarKey re-wrap until they approve, preserved across normalization and the accept re-seat), and `AuditLog` gained `key_rekeyed` + `calendar_access_reapproved` (9282d82+, 2026-08-02); **the two calendar-level alert configs (Occasions + holidays) are now ACCOUNT settings** — `User.occasionAlerts` / `User.holidayAlerts`, carried on `GET`/`PUT /settings`, with the AsyncStorage keys demoted to a cache: that cache is account state wiped at sign-out, so holiday alerts a user set read back fine all session and were silently off again at the next sign-in; edits now write both, load adopts the account's config (rescheduling the window when it differs), an account with no config is seeded from a device holding a non-default one, and `offsets: []` stays a real "off" distinct from an unconfigured `null` (c2d18c0+, 2026-08-04)
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

**A local write's replica row must decrypt to what it displays.** `recordStore`
mirrors every create/update into the decrypted replica, and the ciphertext has to
travel with the plaintext: `splitSealed` moves `enc`/`keyVersion` into the wire
body, so a row merged as `{ ...existing, ...plain }` would keep the ciphertext it
held *before* the write. `openRecord` spreads decrypted fields **over** the
plaintext, so such a row renders its previous content — an edit that lands on the
server but silently doesn't take on device until a background sync replaces the
whole row. The user-visible symptom is having to perform the same action twice.

**Client cursor safety (`lib/records.syncRecords`).** `GET /records/sync?since=`
is exclusive (`updatedAt > since`), ascending. The client keeps its own cursor
(`hc_records_cursor`) and a decrypted per-collection replica, and two invariants
protect against silent content loss:
- **Never advance past an unreconciled row.** A live content row the session
  couldn't decrypt yet (household key not held — a sync racing ahead of unlock,
  or an account switch mid-boot) parks the cursor at the last reconciled row
  *before* it, so it is re-pulled once the key loads instead of being stranded
  out of the replica while it still lives on the server. Only an
  already-tombstoned row (ciphertext may be gone) is exempt — it can't block the
  cursor or the pull would loop forever.
- **Wiping the replica resets the cursor.** The cursor lives in its own storage
  key, so any path that clears the replica (sign-out/account-switch,
  `clearAll`) MUST also `resetRecordCursor()` — otherwise the next sign-in
  resumes incremental sync from the old high-water mark and never re-pulls the
  cleared records, silently emptying the household's content.
- **Re-pull + refetch when the key lands.** Parking the cursor (invariant 1) only
  guarantees the stranded rows are *re-pullable*, not that anything re-pulls them:
  on sign-in the first `syncRecords` runs before the household key is held, blocks
  every row, and leaves the replica empty, so the replica-backed views (calendar,
  people, …) render only their plaintext overlays (weather, holidays) until
  something invalidates them. The E2EE session therefore signals `subscribeKeysReady`
  the moment the current-version HDK first becomes available inside
  `ensureHouseholdKey` — the single chokepoint every unlock path (login, relaunch
  restore, app-lock foreground, manual unlock) reaches — and the auth store's
  subscriber re-pulls (`syncRecords`) and refetches the record-backed queries. This
  fires once per genuine absent→held transition (not on every ready re-check), so
  content appears on its own without a manual mutation and the signal can't loop.

**Activation gate reads the same store as the sealer (`scripts/dropPlaintext`).**
Born-encrypted activation flips `Household.e2eeActive` only once every content
row carries ciphertext. For the author-hidden collections the source of truth is
the **`Record` store** — and `/e2ee/seal` writes ciphertext *there*, never back
to the legacy per-collection tables. So the straggler gate MUST count from
`Record` (scoped by `householdId`), not from the legacy tables: a legacy row with
no `Record` twin (an un-migrated / orphaned pre-mandate seed) can never be sealed
in place, so counting it would deadlock activation forever ("ready, not live").
Legacy tables are migrated + dropped out-of-band (`dropContentCollections`); only
Trip/TripItem (the C4 routing deviation) are still gated in their own collection.
The commit's **author-hiding (C4) also reaches `Record`**: it nulls the plaintext
`userId` on the household's HDK-sealed Records (`enc.ks` absent) — the same null
it applies to the (now-dropped) legacy tables — so an active household's records
carry no member-granular author. A resource-sealed Record keeps `userId` (the
shared-lane routing deviation). Records written *after* activation never store
`userId` (the write path strips it); the drop covers any written pre-activation.

## Decrypted record shapes (the per-collection models)

The per-collection schemas — `CalendarEvent`, `Person`, `MaintenanceTask`,
`Chore`, `Recipe`, `Trip`, `TripItem`, `Item`, `OdometerLog`, `RecipeSchedule`,
`Category` (the registry in
[`services/contentModels.js`](../../server/src/services/contentModels.js)) —
define the **decrypted shape** of what gets sealed into a Record's `enc`. The
client seals `{ collection, ...fields }`; those field definitions are the schema.

One collection is **client-only** (no server schema at all, which the opaque
store permits by construction): `EventRsvp` — a household member's
accept/decline of an event whose sealed `householdInvitees` list names them,
shaped `{ eventId, status: 'accepted'|'declined', respondedAt }` with the
responder identified by the C4 `author` fold-in. One record per responder per
event (single writer each — RSVPs never contend on the event record under LWW);
defined in `mobile/src/lib/encSubsets.ts` (`EVENT_RSVP_ENC`) and read/written by
`mobile/src/lib/householdRsvp.ts`. Behavior owned by
[calendar](../features/calendar.md).

**An event alert stores its lead time AND what that lead time was measured
against.** `CalendarEvent.reminderMinutes` / `alert2Minutes` are always minutes
before the EVENT — the single form the scheduler and the on-device notifier read
— and `alertAnchor` / `alert2Anchor` (`'event'` | `'leave'`, absent = `'event'`)
say whether the user set that lead time against the event's start or against
departure (`travelMinutes` before the start). The two can name the same instant,
so the anchor cannot be recovered from the number: it is stored, sealed with the
minutes it describes (`EVENT_ENC`), and never inferred except when reading a
record written before the field existed. Behavior — including how a changed
drive time moves a departure-anchored alert — is owned by
[calendar.md](../features/calendar.md).

**Recurrence carries its own exceptions.** All three repeating collections keep
per-occurrence scoping *inside* the record rather than in a side table, because the
server can't read sealed content and so can't maintain one. `CalendarEvent` uses a
top-level `exceptionDates: [String]` (YYYY-MM-DD) plus `recurrence.until`;
`MaintenanceTask` and `Chore` use `recurrence.skipDates: [String]` plus
`recurrence.until`, nested so the existing `TASK_ENC`/`CHORE_ENC` subsets seal them
with the rule they belong to. A task/chore copy created by "Save for This … Only"
additionally carries `detachedFrom` (the series' id) + `detachedDate` (the day it
stands in for), sealed like the rest — the link is what lets "Resume schedule"
leave an already-covered day skipped instead of double-booking it. All three are honoured by the shared expansion engine
and are what "delete/save this occurrence only" and "…all future" write. See
[calendar.md](../features/calendar.md) and
[maintenance.md](../features/maintenance.md).

Phone-number fields (`Person.phone`, `TripItem.phone`, `CalendarEvent.phone`, and
the account phone on settings) are captured by the mobile `PhoneField` control and
persisted as canonical **E.164** (`+15551234567`) so stored values are dial-ready
for `tel:` links and AI phone calls. Legacy values (bare digits) remain valid and
are re-formatted on read/edit.

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
  `dayAlertTime` — the personal `HH:mm` local default that DAY-BASED alerts
  (tasks/chores/birthdays with no per-item time) fire at, `null` = the 9am
  default; the hourly reminder cron honors its hour, the on-device scheduler its
  full time — see [features/notifications.md](../features/notifications.md);
  `occasionAlerts` / `holidayAlerts` — the calendar-level alert configs
  (`{ offsets: [days before], time: "HH:mm" }`) for the Occasions calendar and
  for all holiday calendars, `null` = never configured; they live on the account
  because the client's copy is a device cache wiped at sign-out;
  `calendarPrefs` — how the user arranged their calendars
  (`colors` id→hex, `order`, `hidden`, `deletedDefaults`, `alertsOff`), on the
  account for the same reason; every field is sparse (deviations from the
  defaults only) and independently optional, `null` = never configured. Stored
  in plaintext like the `CustomCalendar` records its ids point at — it is
  arrangement, not content;
  `sessions[]` device-session rows keyed by the install's random `deviceId` —
  an opaque label/dedup value, never an auth factor — see
  [features/auth-identity.md](../features/auth-identity.md); monetization
  state — `revenueCatId` (RC app_user_id = user id), `appUnlocked(+At)` /
  `unlockProductId` (the per-user $4.99 unlock), `addons: [String]` (the
  feature-calendar add-ons this user OWNS — the effect is household-wide, read as
  the union across members, so a purchase survives joining/leaving/removal),
  `creditBalanceMc` (prepaid
  AI-credit balance in millicredits), `aiPlanActive` / `aiPlanExpiresAt` (the
  optional monthly Calen AI plan) and per-user usage analytics counters (incl.
  the margin-free `costMc` provider-cost estimates reconciliation reads) —
  see [features/billing-plans.md](../features/billing-plans.md)),
  `HouseholdKeyEnvelope` (HDK sealed per member × version), `ResourceKeyEnvelope`
  (calendar/trip keys for cross-household sharing), `DeviceLink`.
- **Household/membership:** `Household` — **name + `homeAddress`/`lat`/`lon` are
  sealed** into `Household.enc` (Signal-parity C2/P5), nulled at the drop; owner,
  key version, feature-`activity`
  counters, and grocery/timezone settings stay plaintext (the subscription-era
  `plan*` fields are gone). The household `usage*` AI counters are **frozen
  legacy** — AI usage/tokens/call-seconds are written per-USER only
  (`User.usage*`) since the per-user billing restructure — and `Household.addons`
  joined them: add-on ownership moved to `User.addons` so it stays with the person
  who paid rather than a container they can leave (see
  [features/billing-plans.md](../features/billing-plans.md)); the field is read by
  nothing and kept only for `scripts/backfillUserAddons.js` and rollback. `HouseholdInvitation`,
  `JoinRequest`, `HouseholdNotice` (a plaintext per-user membership notice —
  `kind: 'removed'` or `'approved'` with the actor's first name, `householdId`,
  and `acknowledgedAt`; never the sealed household name — surfaced in the
  Invitations inbox, see
  [features/households-sharing.md](../features/households-sharing.md)).
- **Sharing & outside invitations:** `CustomCalendar`, `CalendarInvitation`,
  `EventInvitation`, `TripInvitation` — these carry the deliberate plaintext
  snapshots that make outside sharing work (see below). A `CustomCalendar`
  collaborator seat also carries the **re-key suppression** pair —
  `keyChangedAt` (this collaborator minted a new identity key, so the owner's
  automatic CalendarKey re-wrap is withheld) and `reapprovalRequestedAt` (they
  asked for access back). Server state, not client payload: both are preserved
  across collaborator normalization and the accept-invitation re-seat, because
  clearing them would silently re-grant. See
  [features/households-sharing.md](../features/households-sharing.md).
- **Scheduled occasion e-cards:** `ECard` — a **plaintext** content model (no
  `enc`): author/household ids, occasion kind + month/day + send-time, template
  + font keys, the card **message** and optional **framing-line overrides**
  (`greeting`/`signoff`/`signature`; blank = defaults), **photos**
  (`{storageKey, contentType}` rows pointing at plaintext files in the shared
  disk upload store, embedded inline in the email, max 3), and the **recipient
  emails**. Stored readable so the
  scheduler can send them by email on the date while the app is closed — a
  deliberate E2EE exception like the invitation snapshots (see
  [features/calendar.md](../features/calendar.md) + crypto-e2ee.md). Occasions
  themselves are **not** a stored collection: they're derived client-side from
  each `Person`'s `birthday` + labeled `dates[]` by the shared calendar engine.
- **Attachments:** `Manual`, `EventAttachment`, `Receipt` — file **bytes are
  encrypted per-file**; the row metadata (size, key wrap, references) is plaintext.

## Operational / metadata models

`AuditLog` (security lifecycle + admin-console actions — role/billing/config
changes, moderation triage, feedback triage, support-mailbox access; who/when,
never content; the key lifecycle includes `key_rekeyed` and
`calendar_access_reapproved`, the two halves of lost-every-factor recovery),
`EmailLog`
(outbound delivery ledger + transient retry outbox: `to`/`subject`/`kind` +
`status` `sent|dry|canceled|suppressed|queued|failed`, `attempts`/`responseCode`/
`failureKind`/`nextAttemptAt`, and a `payload` sub-doc that holds the renderable
message ONLY while `queued` and is cleared on any terminal state — codes masked,
bodies otherwise never stored; see [email-lifecycle](../features/email-lifecycle.md)),
`EmailLifecycleConfig` (singleton overlay on the code-owned email catalog:
per-template enable/subject/note + retry policy + suppression toggle),
`EmailSuppression` (address-level do-not-mail list — plaintext so the send path
can query it; hard-bounce auto-adds, admins add/release), `MonetizationConfig`,
`CreditLedger` (append-only record of every AI-credit movement — grants,
plan periods, refunds, adjustments AND per-action usage debits; unique sparse
`transactionId` = webhook idempotency gate),
`PhoneCall`
(AI call outcome summary; `dncCaptured` flags a call on which the recipient
asked not to be called again, so the outcome view can say so explicitly),
`DncEntry` (do-not-call suppression for outbound AI
calls — HMAC-SHA256 of the E.164 number as the match key + last4 for admin
display, never the raw number; queried before every call so it must be
plaintext/unsealed), `ContentReport` (moderation), `WeatherRecord`
(legacy cache, bypassed for E2EE households), plus legacy/aux rows
(`Property`, `TaskCompletion`, `TravelLeg`, `ShoppingSession`).

## Authoritative server-visible set

The honest list of what a server (or a legal request) can see: membership graph,
record existence/timing/(padded)size, key version, billing state (unlock,
credit balances, usage counts), device
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
