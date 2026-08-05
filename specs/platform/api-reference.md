---
title: API reference
status: current
last-verified: c2d18c0+ (2026-08-04); `PUT/GET /settings` accepts/echoes `calendarPrefs` — the user's calendar arrangement (colours / order / hidden / deleted built-ins / muted alerts), merged field-by-field so a partial payload can't blank the rest, validated (hex colours, string ids, 500-entry cap) with 400 on malformed input, `null` = never configured (2026-08-04); `GET /billing/status` gained the free-viewer-mode `viewer` counts, and `/records` now authorizes calendar-lane writes from the plaintext `scope` (403 for `view` collaborators / foreign-scope claims; trips exempt) (2026-07-31); added `/api/ecards` (plaintext occasion e-cards) (2026-07-28); added e-card photo endpoints (upload/serve/delete) (2026-07-28); `PUT/GET /settings` accepts/echoes personal `dayAlertTime` (HH:mm, empty=reset to 9am default; validated) (2026-07-29); `PUT/GET /settings` accepts/echoes `homeCity` — a coarse plaintext household home-area label (city + region/country) derived client-side from the home address (or hand-set) that grounds the calendar assistant's local suggestions without ever exposing the street address (2026-07-30); **the two calendar-level alert configs (Occasions + holidays) are now ACCOUNT settings** — `User.occasionAlerts` / `User.holidayAlerts`, carried on `GET`/`PUT /settings`, with the AsyncStorage keys demoted to a cache: that cache is account state wiped at sign-out, so holiday alerts a user set read back fine all session and were silently off again at the next sign-in; edits now write both, load adopts the account's config (rescheduling the window when it differs), an account with no config is seeded from a device holding a non-default one, and `offsets: []` stays a real "off" distinct from an unconfigured `null` (c2d18c0+, 2026-08-04)
code:
  - server/src/app.js        # the mount table — source of truth for what exists
  - server/src/routes/
  - server/src/routes/records.js
tests:
  - server/src/test/         # every integration suite boots the real app over in-memory MongoDB
---

# API reference

All routes are prefixed with `/api`. The route mount table in
[`server/src/app.js`](../../server/src/app.js) is the authoritative index; this
spec explains the shape and the parts that aren't obvious from the mounts.

## Conventions

- **Auth:** `Authorization: Bearer <JWT>` on everything except the public
  endpoints listed below. The token is issued by `/api/auth/login` (and the
  passkey/OTP flows) and stored on-device in `expo-secure-store`.
- **Sliding session:** responses may carry an `X-Refreshed-Token` header; the
  admin (browser) client can only read it because it's in CORS `exposedHeaders`.
  The mobile client swaps its stored token when present.
- **CORS:** the native app sends no `Origin` and is allowed through; the admin
  app's origin must be in `CORS_ORIGINS` (or `CLIENT_URL`). In non-production
  any `http://localhost:<port>` / `http://127.0.0.1:<port>` origin is allowed,
  so the admin dev server works on whatever port Vite picks.
- **Rate limits:** auth, key, and join endpoints carry per-IP limiters
  (`trust proxy` is set so limits key off the real client IP behind Render).
- **Large bodies:** the AI chat paths get a 15 MB JSON limit (inline base64
  image/PDF attachments); every other route keeps the default small limit.

## The content path: one opaque record store

This is the most important and least obvious part of the API. **Household content
is not stored through per-entity CRUD routes.** Every content record (calendar
events, people, tasks, chores, recipes, trips, items, trip items, …) is a
client-**sealed** blob in a single server collection, reached through
[`server/src/routes/records.js`](../../server/src/routes/records.js):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/records/sync` | Incremental **last-writer-wins** pull: every record in the caller's scope changed after `?since=<cursor>`, including tombstones for deletes. |
| POST | `/api/records` | Create a sealed record. |
| PUT | `/api/records/:id` | Replace a sealed record (LWW). |
| DELETE | `/api/records/:id` | Delete → tombstone. |

- The server stores ciphertext plus a small set of **plaintext scope fields** it
  must act on (household/owner, collection tag, sharing/scheduling metadata). It
  cannot read record content. See
  [platform/crypto-e2ee.md](crypto-e2ee.md) and [data-model.md](data-model.md).
- Records may be scoped to a shared **calendar** or **trip** resource (with a key
  version), which is how sharing and key rotation ride along.
- **Calendar-lane writes are authorized** from that plaintext scope: creating,
  replacing, or tombstoning a record whose stored or incoming
  `scope.kind === 'calendar'` requires `full` effective access on the calendar
  (`403` for `view` collaborators and for foreign-scope claims). Trips are
  exempt (trip collaborators are full-access by design). See
  [features/calendar.md](../features/calendar.md).
- The mobile client mirrors this into a local replica and drives the UI
  offline-first (`mobile/src/lib/recordStore.ts`, `records.ts`).

Legacy per-entity routers (`/api/items`, `/api/tasks`, `/api/chores`,
`/api/recipes`, …) remain mounted but the live content path folds into the record
store; treat them as compatibility/aux surfaces, not the primary CRUD API.

## Route groups (by mount)

See `app.js` for exact paths. Grouped for orientation:

- **Auth & identity:** `/api/auth` (register, login, forgot/reset + reset-cancel,
  sessions, me, email/password change, delete account), `/api/keys` (E2EE factor
  enrollment, recovery, factor add/remove, device-link, public keys, and
  `rekey` — the guarded lost-every-factor identity replacement, see
  [crypto-e2ee.md](crypto-e2ee.md) "Re-key"). Passkeys
  are under `/api/auth` too (`register-options`, `register`, `challenge`,
  `login`). See [features/auth-identity.md](../features/auth-identity.md).
- **Household, membership & E2EE:** `/api/household` (get/update, invitations,
  join-requests + approve-on-device, member remove, leave, key get/rotate/retire,
  `e2ee/activate`, `e2ee/readiness`, `e2ee/stragglers`+`seal`, reseal,
  `client-version`). See [features/households-sharing.md](../features/households-sharing.md).
- **Calendar:** `/api/calendars` (custom calendars + per-calendar key envelopes +
  calendar invitations + the re-key `access-request` / `keys/approve` pair —
  see [features/households-sharing.md](../features/households-sharing.md)),
  `/api/calendar` (event attachments), `/api/invitations`
  (event invitations incl. public `ics` + `lookup`). See
  [features/calendar.md](../features/calendar.md).
- **Maintenance & home:** `/api/items`, `/api/tasks`, `/api/task-templates`,
  `/api/chores`, `/api/chore-templates`, `/api/manuals`, `/api/receipts`,
  `/api/categories`, `/api/properties`, `/api/vehicles/:itemId/odometer`,
  `/api/history`.
- **Kitchen:** `/api/recipes` (incl. `suggest-recipes`), `/api/recipe-schedule`.
- **Trips:** `/api/trips`.
- **People:** `/api/people`.
- **Occasion e-cards:** `/api/ecards` (CRUD) + card photos:
  `POST /api/ecards/:id/photos` (multipart `photo`; JPEG/PNG/GIF/WebP, ≤10MB,
  max 3, author-only), `GET /api/ecards/:id/photos/:photoId` (bytes,
  household-scoped), `DELETE /api/ecards/:id/photos/:photoId` (author-only;
  photo files also unlink when their card is deleted). **Plaintext** by design
  (recipient emails, message/framing lines, and photo files stored readable so
  the scheduler can send on the occasion date — a deliberate E2EE exception, so
  these are NOT routed through the sealed record store or the plaintext-create
  guard). See [features/calendar.md](../features/calendar.md).
- **AI:** `/api/calendar/chat`, `/api/maintenance/chat`,
  `/api/maintenance/plan-chat`, `/api/chores/chat`, `/api/trips/chat`,
  `/api/form-assist`, `/api/calls` (Vapi phone calls), `/api/places` (biasing).
  See [features/ai-assistant.md](../features/ai-assistant.md). All AI routes
  sit behind `middleware/aiConsent.js` (`requireAiEnabled` → 403 when
  `User.aiEnabled` is false; the flag syncs from the device via `PUT /settings`
  and is returned by `GET /settings`).
- **Billing:** `/api/billing` (`webhook` — public, secret-verified, RC
  `app_user_id` = USER id; `status` — the per-user app unlock (`unlocked`),
  the free-viewer-mode signal (`viewer: { calendarCollaborations,
  pendingCalendarInvitations }` — a locked user with either > 0 gets the
  read-only viewer shell instead of the paywall, see
  [features/billing-plans.md](../features/billing-plans.md)),
  prepaid credit balance (`creditBalance`/`creditBalanceMc`, `lowBalance`,
  `unlimited`, `packs`), per-user usage analytics, and the household's owned
  feature-calendar `addons` + `addonCatalog`; `credits/ledger` — the caller's
  credit grant history; `addons/claim` — any member claims a FREE add-on
  (catalog price 0: Birthdays/Chores) for the household; `addons` — admin
  override of the household's owned add-on set). AI routes return
  `402 CREDITS_EXHAUSTED` when the balance is spent. See
  [features/billing-plans.md](../features/billing-plans.md).
- **Misc:** `/api/weather`, `/api/notifications`, `/api/settings`,
  `/api/moderation`, `/api/health` (public).
  - `/api/weather` geocodes the home address via the Google Geocoding API when
    `GOOGLE_PLACES_API_KEY` is set, falling back to Nominatim (and remains
    Nominatim-only without a key). E2EE households bypass this route entirely
    (client-direct open-meteo).
  - `PUT /settings` additionally accepts `householdTimezone` — the household's
    default IANA zone (the reminder scheduler's fallback for members with no
    personal zone). Validated as a real IANA id (400 otherwise) and stored as
    `Household.timezone`; echoed by `GET /settings`. The client derives it from
    the home location keyless + client-side, so an E2EE household's address is
    never sent to resolve it. Distinct from the personal `timezone` key.
  - `PUT /settings` also accepts `homeCity` — a coarse household home-area label
    (city + region/country, e.g. "Ottawa, Ontario, Canada") stored **plaintext**
    on `Household.homeCity` and echoed by `GET /settings`. Derived client-side
    from the home address (same keyless geocoders as `householdTimezone`, so an
    E2EE household's address is never sent to resolve it) or set by hand; it
    grounds the calendar assistant's local suggestions — the street address
    itself is never put in an AI prompt. See
    [features/ai-assistant.md](../features/ai-assistant.md).
  - `PUT /settings` also accepts `dayAlertTime` — the personal wall-clock time
    (`"HH:mm"`) that DAY-BASED alerts fire at, stored on `User.dayAlertTime` and
    echoed by `GET /settings`. An empty string clears it back to the 9am default
    (`null`); a non-empty value must be a valid 24h `HH:mm` (400 otherwise). See
    [features/notifications.md](../features/notifications.md).
  - `PUT/GET /settings` also carry `occasionAlerts` and `holidayAlerts` — the
    calendar-level alert configs for the two calendars whose items are computed
    on-device (Occasions; all holiday calendars share one config), stored on
    `User.occasionAlerts` / `User.holidayAlerts`. Shape:
    `{ offsets: number[], time: "HH:mm" }`, where `offsets` are whole days
    before the date (`0` = the day of). The server dedupes and sorts `offsets`
    and rejects a malformed config with 400 rather than storing it. `null`
    means **never configured** (the client applies its own defaults) and may be
    written to clear one; an **empty `offsets` list is a stored value** meaning
    that calendar's alerts are off. These are account settings precisely so they
    survive a sign-out, which wipes the client's device cache of them — see
    [features/notifications.md](../features/notifications.md).
  - `PUT/GET /settings` also carry `calendarPrefs` — how the user arranged their
    calendars, stored on `User.calendarPrefs`. Shape:
    `{ colors: { [calendarId]: "#RRGGBB" }, order: string[], hidden: string[],
    deletedDefaults: string[], alertsOff: string[] }`, every field optional and
    sparse (only deviations from the app defaults). A PUT **merges field by
    field** over what's stored, so a payload carrying one field can't blank the
    rest. The server rejects a malformed arrangement with 400 rather than
    storing it (non-hex colours, non-string ids, over 500 entries). `null` means
    **never configured** — the client's own arrangement stands and seeds the
    account — and may be written to clear one; a field that is **present but
    empty is a stored value** meaning the user cleared it, which the client must
    adopt rather than re-seed. Account state precisely so it survives a
    sign-out — see [features/calendar.md](../features/calendar.md).
- **Admin app surfaces:** `/api/monetization-config` (config CRUD;
  `households` — usage analytics; `users` — per-user unlock + credit balance;
  `unlock` — grant/revoke a user's app unlock; `credits` — ledgered balance
  adjustment), `/api/admin/analytics`, `/api/admin/email`, `/api/admin` — all
  `requireAdmin`-gated.

## Public (unauthenticated) endpoints

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/forgot`,
  `POST /api/auth/reset`
- `POST /api/auth/passkey/challenge`, `POST /api/auth/passkey/login`
- `GET /api/invitations/public/:id/ics`, `GET /api/invitations/lookup`
- `POST /api/billing/webhook` (verified via `REVENUECAT_WEBHOOK_SECRET`)
- `GET /api/keys/link/:linkId`, `GET /api/keys/public/:userId`
- `GET /api/health`

## Verification

- The API surface is exercised end-to-end by the integration suites in
  `server/src/test/` — each boots the real Express app (real routes, middleware,
  models) over in-memory MongoDB via `server/src/test/harness.js`. Per-area
  coverage is mapped in each feature spec's own Verification section; this spec
  claims only the cross-cutting conventions (auth requirement, public endpoint
  list, rate limiting), which every suite hits implicitly.

## Open questions

- Enumerate the exact plaintext scope fields the record store persists and index
  them against `server/src/models/encFields.js` (tracked in
  [data-model.md](data-model.md)).
- Confirm whether the legacy per-entity routers still serve any live client path
  or are fully superseded by `/records`.
