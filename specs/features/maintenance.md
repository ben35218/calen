---
title: Maintenance (items, tasks, chores)
status: current
last-verified: 55bfc65 (2026-07-28); chore/task Alert + Second alert must be distinct — second picker excludes the first's value (`excludeUsedAlert`) (2026-07-28)
code:
  - mobile/src/screens/maintenance/
  - server/src/routes/{items,tasks,chores,taskTemplates,choreTemplates,odometer,manuals}.js
  - server/src/models/{Item,MaintenanceTask,Chore,TaskCompletion,OdometerLog,Manual}.js
  - server/src/services/recurrence.js
  - shared/seed/taskTemplates.json
tests:
  - server/src/test/maintenance.integration.test.js
  - server/src/services/recurrence.test.js
  - mobile/src/lib/__tests__/recurrence.test.ts
---

# Maintenance (items, tasks, chores)

## Purpose

Home **items** (appliances, vehicles, systems) with attached manuals; recurring
**maintenance tasks** and household **chores**; a rural-home template library; and
odometer tracking for mileage-based service.

## Behavior (normative)

### Add-on gating

- The Maintenance home is gated by the **`maintenance` add-on** — a one-time
  household-wide purchase specified in
  [billing-plans.md](billing-plans.md#feature-calendar-add-ons). When the
  household doesn't own it, `MaintenanceScreen` renders the `AddonLockedView`
  purchase interstitial instead of its content (items/tasks sub-screens are
  reached only through the gated home).
- The Chores home is gated by the **`chores` add-on** — **included free with
  the app but opt-in**: not default-added; a household adds it from the
  Add-ons screen at no charge (`POST /billing/addons/claim`). Until claimed,
  `ChoresScreen` renders the `AddonLockedView` free-variant interstitial
  ("Add for free").
- Data is retained while locked and reappears on purchase/claim.

### Items & manuals

- An `Item` has name, category, property, optional service-pro link,
  manufacturer/model/serial, location, notes, custom fields, and a photo. It can
  auto-look-up a manual (`autoLookupManual`).
- Manuals are files attached to an item (`Manual` model, `manuals` router):
  uploaded PDFs or fetched-from-URL, **encrypted per-file** (`Manual.encrypted`,
  `wrappedFileKey`, `keyVersion`). `items` router is AI-only (`POST /items/from-photo`).

### Tasks & chores

- A `MaintenanceTask` binds to an item/category and recurs by interval
  (`intervalValue`/`intervalUnit`), calendar/seasonal pattern (`recurrence`), or
  mileage (`intervalKm`/`lastServiceKm`/`nextDueKm`). It tracks
  `lastCompletedAt`, `nextDueDate`, cost/duration estimates, priority, and alert
  config (`reminderDaysBefore`, `alert2DaysBefore`, `alertAudience`,
  `alertUserIds`). The two alert slots must be **distinct** — the Second alert
  picker excludes the value already chosen in the first (`excludeUsedAlert`), so
  the same lead time can't fire twice. See [notifications.md](notifications.md).
- A `Chore` is the lighter household variant (recurrence, `assignedTo`,
  `nextDueDate`, alerts) without item binding. Tapping "+" on the chores list
  opens an **Add Chore chooser** (`AddChoreScreen`) — mirroring the item form's
  "what would you like to add?" scope step — offering *add a chore by hand*
  (→ `ChoreForm`) or *use a template* (→ `ChoreTemplates`). The chooser
  `replace`s itself so Back returns to the list, not the chooser.
- **"Ask Calen" form-assist** on the task and chore forms fills fields from a
  plain-language description (via the generic `formAssist` route — AI endpoints
  here, incl. item photo scan and manual extract/auto-lookup, are refused
  server-side when the account's AI toggle is off; see
  [ai-assistant.md](ai-assistant.md)). A field the form doesn't advertise can
  never be set by the assistant, so the schema advertises the whole editable
  form: title/instructions(description)/assignee/due-date, the **icon** (a
  `select` over the form's suggested glyph set), the **alert** timings
  (`reminderDaysBefore`, `alert2DaysBefore`; chores also expose `alertAudience`),
  and the **recurrence**. Because the generic route only accepts flat fields, the
  `RepeatRule` is exposed as primitives (`repeatFrequency`, `repeatInterval`,
  `repeatWeekday`, `repeatDayOfMonth`, `repeatMonths`) and reassembled client-side
  (`lib/recurrence.ts` `applyRecurrenceAssistPatch`) — covering daily / every-N /
  weekly-on-a-day / monthly-on-a-date / yearly-in-months; the niche "on the 2nd
  Tuesday" ordinal form stays editable only on the Repeat screen. So a request
  like "make laundry day Saturdays" now updates the repeat rule, not just the
  next due date.
- **Completion is content-blind** (D4 + C3b): the CLIENT computes the next due
  date / mileage rollover and sends the facts plus the task's **re-sealed
  ciphertext**; `POST /tasks/:id/complete` verifies the task is in scope,
  validates the envelope **before** recording anything (a malformed envelope
  MUST NOT leave an orphaned ledger row behind the 400), logs a
  `TaskCompletion`, and applies the re-sealed `enc` to the task's Record row.
  `GET /tasks/completions` is the history log (date-range filterable,
  household-scoped). Chore/task CRUD otherwise flows through the opaque
  `/records` store.
- **Maintenance home "due soon" window:** the home lists overdue + due-soon
  tasks, bucketed **client-side** over the decrypted `nextDueDate` (the server
  can't filter sealed dates). A task counts as *due soon* when it falls within
  the household-shared **`reminderLeadDays`** setting (default 7). That setting
  is edited from the Maintenance home (a "Flag tasks due within" picker →
  `PUT /settings { reminderLeadDays }`) and applies to every member — it is the
  only in-app editor for it. It is a display/threshold window, **not** a
  notification schedule (per-item alert timing is `reminderDaysBefore`; on-device
  scheduling is the personal "Allow reminders" toggle — see
  [notifications.md](notifications.md)).
- **Templates:** browse read-only catalogs — `GET /task-templates` (+ `/:id`,
  from `shared/seed/taskTemplates.json`) and `GET /chore-templates` — and add
  them via the review screens. The task catalog is the rural-home library and
  includes seasonal winter-prep coverage (garage door lubrication, hose bib +
  garden-hose draining, storm windows, de-icing cables, patio furniture and
  water-feature close-down, snow-gear stocking), fall-anchored via calendar
  recurrences. Templates are **reusable**: a household may add
  the same template more than once (nothing blocks re-adding). A template that
  already backs a record shows a non-blocking "In Use" hint but stays tappable;
  the stored `templateId` drives only that hint, not any single-use limit.

### Odometer

- `OdometerLog` (itemId, reading, recordedAt, notes) feeds mileage-based tasks:
  `GET/POST /vehicles/:itemId/odometer`, `DELETE /:logId`.

## Data & API surface

- **Models:** `Item`, `MaintenanceTask`, `Chore`, `OdometerLog` (content records,
  sealed in the opaque store), `TaskCompletion` (history), `Manual` (encrypted
  file + metadata).
- **Endpoints:** `tasks.js` (completions + complete), `odometer.js`, `manuals.js`,
  `items.js` (from-photo), template routers; CRUD via `/records`.
- **Client:** `screens/maintenance/*` (Maintenance, Items, Tasks, Chores, their
  detail/form screens, template + AI-plan screens).

## Encryption boundary

Items, tasks, chores, and odometer logs are sealed content records; manual file
bytes are encrypted per-file. **Scheduling is sealed too** — `nextDueDate`,
`nextDueKm`, `intervalKm`, `lastServiceKm`, and odometer reading/notes are in
`DROP_FIELDS` (Signal-parity D4/D5), and due-date/mileage computation runs
client-side via the `shared/calendar` engine. Reminder timing is on-device — see
[notifications.md](notifications.md) and
[platform/data-model.md](../platform/data-model.md).

## Verification

- Content-blind completion: facts recorded + re-sealed ciphertext applied to the
  Record row; envelope validated before the ledger write (the orphaned-row bug
  this suite caught); scope 404s; history date-range filter + household scoping
  — `maintenance.integration.test.js`.
- Odometer: readings log against an in-scope vehicle only, raw rows +
  km-interval mileage tasks return, deletes are scope-checked —
  `maintenance.integration.test.js`.
- Template catalogs: non-empty seed with id/title/recurrence, category filter,
  by-id + 404, chore catalog — `maintenance.integration.test.js`.
- Recurrence math — `services/recurrence.test.js` (server) and
  `mobile/src/lib/__tests__/recurrence.test.ts` (client assist-patch
  reassembly).
- Task/chore/item content storage rides the opaque record store — verified
  under [platform/data-model.md](../platform/data-model.md); the AI surfaces
  (form-assist, from-photo, manual parse) are consent-gate-verified in
  [ai-assistant.md](ai-assistant.md).

## Open questions

- Confirm mileage-based due recomputation path end-to-end (odometer → nextDueKm),
  now that the km engine lives in `shared/calendar`.
