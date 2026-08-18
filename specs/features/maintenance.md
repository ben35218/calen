---
title: Maintenance (items, tasks, chores)
status: current
last-verified: 3cfa750+ (2026-08-14); **the date-mismatch check now accepts the engine's own short-month clamping** — a "monthly on the 31st" chore was unsaveable: the expansion engine clamps a day past a month's end to that month's last day (`clampDay`, shared/calendar), the form's repeat-change reseed (`dueDateFor`) wrote exactly that clamped date (Sep 30 for rule 31), and `ruleDateMismatch` then rejected it as "not the 31st" — the form blocked its own auto-seeded value, and a series edit opened on a clamped occurrence (Feb 28 of a monthly-31 chore) could never save; the monthly/yearly day-of-month check (`clampedDayMatch` in lib/recurrence, unit-tested against 29/30/31 rules × short/long/leap months) now accepts a date exactly when it lands where `clampDay` would put it — the configured day itself, or the month's LAST day when the configured day exceeds that month's length (rule 31 accepts Sep 30 and Feb 28/29; rule 30 accepts Feb 28/29; rule 29 accepts Feb 28 in non-leap years only) — and still rejects everything else (rule 31 on Sep 29) (3cfa750+, 2026-08-14); **a calendar-type recurrence's `dayOfMonth` now survives the Repeat-screen bridge** — `recurrenceToRule` dropped it and `ruleToRecurrence` rebuilt without it, so any edit-save of a multi-month yearly chore ("Mar & Sep on the 15th", written by web/legacy or the yearly month-multiselect) silently moved every occurrence to the 1st (the engine defaults `day = r.dayOfMonth || 1`); the day now rides the rule's `daysOfMonth` slot both directions (interval-`years` single-month recurrences carry theirs the same way), the yearly branch of `ruleDateMismatch` validates the anchor against it (clamp-aware, per the rule above), `ruleLossyForItem` refuses a yearly multi-day set like a monthly one while passing the lossless single-day round-trip, and a legacy record without `dayOfMonth` still defaults to the 1st exactly as before (round-trip + expansion unit-tested in lib/__tests__/recurrence.test.ts) (3cfa750+, 2026-08-14); **the chore/task Repeat picker is restricted to what the sealed model can store, with a save-time backstop** — the shared Repeat screen let a chore pick "weekly on Tue & Thu" or "each 5th & 20th" while `ruleToRecurrence` silently kept only the first day (Thursdays vanished, the 20th vanished) and dropped the day/weekday/weekend ordinal kinds and the yearly within-year ordinal entirely; the chore and task forms now push the screen with **`singleDay: true`** (weekly weekday list + monthly date grid become single-select radios, the aggregate day/weekday/weekend kinds and the yearly "Days of week" switch are hidden, the summary reads "Will repeat …" instead of "Event will repeat …"; the calendar event form passes nothing and keeps the full multi-select picker), and `ruleDateMismatch` now runs **`ruleLossyForItem`** first (lib/recurrence, unit-tested) so any unstorable rule that still reaches save — a legacy draft, an assistant draft, a future entry point — is **refused with the same inline FormError** instead of degrading silently; the check runs even with the date field empty, and the "Save for This Chore/Task Only" exemption is correct for it too (a detached copy discards the rule); `repeatsLine` still renders multi-day rules so nothing already sealed displays wrong (3cfa750+, 2026-08-13); **the chore engine's week ordinals -2 and 5 now behave** — `nthWeekdayOfMonth` (shared/calendar) computed "next to last" as first-match − 3 weeks (landing in the PREVIOUS month, which tripped the expander's non-advancing-cursor guard: a next-to-last-Tuesday chore emitted its anchor then nothing forever) and "fifth" as first-match + 4 weeks (overflowing into the NEXT month's first Tuesday — reproduced Nov 3 / Feb 2 where the correct behavior is skipping months without a fifth); it now indexes the month's actual weekday matches like the events path's `ordinalDayOfMonth` (1..5 from the start, null when absent; -1..-4 from the end, always present), and `computeNextDueDate` advances past a month with no nth occurrence — **skipped months consume interval steps**, matching the events expander's unconditional `month += interval`; the Repeat picker's fifth/next-to-last ordinals are therefore offered to chores/tasks and correct end-to-end (`ruleDateMismatch` already validated them; `recurrenceLabel` now labels them), regression-tested in shared/calendar/index.test.js + `nextOccurrenceFrom` (3cfa750+, 2026-08-13); **"Delete All Future Chores" is now a one-step delete** — the ended husk had lingered in the Chores list's collapsed "Ended chores" footer demanding a second, permanent delete (reported); the footer group is removed and an ended chore leaves the Chores list entirely (all-ended = the plain empty state), while the record still truncates rather than deletes so past calendar days keep their occurrences (Ben's explicit choice over a full delete) — those past days remain the route to the detail page, whose Resume-schedule row renders on any entry path and whose *Delete All Future* from the series' first day deletes the record outright; ended TASKS keep their "Ended tasks" group (item-less tasks have no other home; the record anchors completion history) (1d42ed2+, 2026-08-13); **the Chores list now shows one card per chore** — editing one occurrence of a repeating chore ("Save for This Chore Only") had made it appear a second time as a "one-time" card, and a "Save for Future Chores" edit listed the chore twice (the truncated old series beside its fork); `collapseScopedRecords` (repeatingItemScope, unit-tested) hides a detached copy whose series is present and a truncated predecessor whose fork is present (fork chains collapse to the latest; a survivor whose counterpart was deleted lists normally; genuinely one-time chores always list), backed by a new sealed **`splitFrom`** link stamped on every chore AND task fork (CHORE_ENC/TASK_ENC, both server models, fork-side counterpart of `detachedFrom`) — task lists deliberately don't collapse yet (completion history is keyed on the old record's id) and pre-existing forks carry no link (1d42ed2+, 2026-08-13); the assistant-draft prefill gained **`firstDueDate`** (overrides the recurrence's interval-from-today reseed so "starting this Sunday" anchors the series on that Sunday — the anchor day is the weekday pattern for an interval series) and **self-reference assignee matching** (`matchAssigneeByName` resolves "me"/"you"/"myself" to the "(You)"-suffixed member option; the model never knows the user's name) — both found by device-testing the 08-12 full-draft prefill, where the drafted "every 2 weeks on Sundays starting Aug 16, assigned to me" landed due Aug 27 and Unassigned (1d42ed2+, 2026-08-13); **the chore/task form's Repeat row is one self-labeled line** — "Repeats every 1 week on Tue & Thu" (`repeatsLine` in lib/eventRepeat, unit-tested: interval always spelled, weekday/month names abbreviated, "&" join, "Does not repeat" when off) replacing the label-left/value-right split, whose long summaries crushed the "Repeat" label; Ben's requirement: the set values must read at a glance without opening the field (1d42ed2+, 2026-08-12); **a chore/task date off its repeat's pattern days no longer saves** — the anchor is the pattern, so "every week on Tuesday" due on a Wednesday broke every future occurrence; both forms now refuse with an inline error naming both sides (`ruleDateMismatch`, unit-tested), while "Save for This Chore/Task Only" stays exempt (a detached copy is one-time and may land anywhere) (1d42ed2+, 2026-08-12); **an assistant-drafted chore now prefills the whole form** — `ChoreForm`'s `prefill` (from the chores assistant's "Review & add chore") previously seeded only title/instructions/recurrence; it now also applies the draft's icon (validated against CHORE_ICONS), alert settings (day offsets validated against ALERT_DAY_OPTIONS, distinct-second-alert guard, HH:MM time zero-padded, everyone/owner audience), and assignee — the draft carries the NAME the user said, matched to a household-member option on-device once contacts+household load (one shot: exact label else first-name match, "(You)" ignored; no match leaves Unassigned); tool/field ownership on the assistant side is [ai-assistant.md](ai-assistant.md)'s (1d42ed2+, 2026-08-12); **the chore due row now dates its frame truthfully** — ChoreDetail opened from a past calendar day read "Due today" (the shared `dueInLabel` clamped every past date to today); `dueInLabel` now reports the past plainly (**"Due yesterday" / "Due N days ago"**), and the series frame (opened from a list) labels the **next occurrence computed from today** (`nextOccurrenceFrom` in repeatingItemScope, skips/`until`-aware, unit-tested) instead of the stored anchor — which nothing advances, so it had read "Due today" forever once its first occurrence passed (or when the chore was created with a past start date, which is supported); a one-time chore whose day passed falls back to that day's past label; tasks were already correct via their own overdue-aware label (2026-08-12); loading states follow the app-wide shimmer-skeleton rule (mobile/CLAUDE.md's loading table): the chore/task template catalogs load as `SkeletonList` rows, TaskTemplateReview as grouped selectable-row skeletons, ItemDetail as the shared `SkeletonDetail` with the AI manual lookup shimmering candidate rows inside the Manuals card, and the item wizard's property picker as row skeletons; the odometer log control sits disabled/dimmed until its query resolves, so the premature-tap "still loading" alert path is no longer the loading indicator; the template catalogs' per-row create spinners are tinted the area accent (was `colors.primary` drift) (2026-08-11); **moving a repeating chore/task occurrence's date now asks the save-scope question** — the date field held the occurrence yet a date-only change fell through the sheet silently as a whole-series re-anchor (the payload diff exempts `nextDueDate` because the repeat rule reseeds it, so the edit was invisible); the chore and task forms now pass an explicit `occurrenceDateMoved` signal into `itemSaveScopeDecision` when the shown occurrence's date no longer holds the tapped day, offering **Save for This Chore/Task Only** (detached copy on the new day + skip the old) and **Save for Future** (fork anchored on the new day), while a rule-derived reseed alone still never counts as a date edit (2026-08-06); device testing then found the sheet **collapsing to "Save for Future" on a date-only move** — the decision compared the whole recurrence object, but `skipDates`/`until` live inside it and the form rebuilds the rule without them, so one previously skipped day (or `months: []` vs. an absent key) read as a rule change; the compare now looks at the rule only, the chore/task save payloads carry the prior `skipDates`/`until` over (a plain series save had been silently wiping them — skipped days resurrected on any rename), and the "Editing the … chore in this repeating series" hint is pinned to the tapped day instead of tracking the date field as it is edited (2026-08-06); an ended chore/task now reads **"Ended <date>"** instead of reporting its stale anchor as long overdue, the Maintenance screen gained the same collapsed **"Ended tasks"** group the Chores list has (without it an ended task with no linked item had no home on that screen), and an all-ended chores list shows an inline empty state rather than blank space (2026-08-04); **"Resume schedule"** on the chore/task detail card puts a skipped-down or ended series back to work **from today**, leaving the past exactly as it looks — future skips are dropped while past ones stay, and lifting a past `until` enumerates the now-past tail into `skipDates` so no cleared history is repopulated (a literal undo was considered and rejected); upcoming days already covered by a detached copy stay skipped, via a new sealed `detachedFrom`/`detachedDate` link stamped on the copy; ended chores stay reachable in a collapsed "Ended chores" footer group and ended tasks leave the overdue dashboard (they had read as permanently overdue) (2026-08-04); **"Delete All Future" left the chore sitting in the Chores list** — truncating ends the series but keeps the record (so past days keep their occurrences), and neither the Chores list nor the Maintenance due/overdue lists filtered on whether anything remained ahead, so an ended chore went on advertising its stale anchor as a live next due date; both now drop items with no occurrence from today onward (`hasUpcomingOccurrence`). The occurrence date field is also renamed "Date" (from "Next Due Date", which named the wrong thing once the form showed the tapped occurrence) with a hint naming which occurrence is being edited (2026-08-04); **a repeat-rule-only change saved silently** — the save-scope decision suppressed its sheet when the edit was made from the series' first occurrence (reasoning that "future" and "the whole series" are the same write there), which collapsed two separate concerns: the occurrence governs how a chosen scope is CARRIED OUT, never whether the user is asked; the sheet now always appears for a series-defining change and future-from-the-first is performed as an in-place series update (events, chores and tasks alike) (2026-08-04); a scoped save now lands the user on the record it created — an override/fork writes a NEW record, so the detail screen under the form stayed bound to the original id and showed the unedited event (reported: "saved this event only, the event view was unchanged, but the month grid had the change"); the form rebinds that entry to the new id + day on exit (`navigation/rebindDetailBelow.ts`), chore and task forms included (2026-08-04); **repeating chores and maintenance tasks answer the same occurrence-scope questions as calendar events** — `recurrence.skipDates` + `recurrence.until` (sealed inside the rule, honoured by the shared expander), the tapped day threaded through ChoreDetail/ChoreForm/TaskDetail/TaskForm, and Apple-style delete + save sheets; a task's mileage interval scopes as series-defining alongside the repeat rule, skipping an interval series' anchor advances it, and completion history stays with the truncated original on a fork (the warning now rides only the outcomes that actually destroy the record) (2026-08-04); the chore form's **"Assigned to" is limited to household members** (self-Contacts whose `accountId` is a current `GET /household` member, you first then alphabetical) instead of every `type: 'family'` contact — a solo household lists only you, and an existing non-member assignee stays visible-but-unofferable (2026-08-04); the maintenance/chores/task-plan assistants gained chat web search (server-side web_search tool + "Searching the web…" activity label) — behavior and pricing owned by ai-assistant.md / billing-plans.md (2026-07-30); manual upload + save-from-URL are no longer credit-metered — meter('manualParse') removed from both (they spend no model tokens; only auto-lookup + extract-tasks are billed), regression-tested at zero balance (2026-07-30); chore/task Alert + Second alert must be distinct — second picker excludes the first's value (`excludeUsedAlert`) (2026-07-28); the item/task/chore add/edit forms guard against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (the Item form guards its final details step, not the add wizard) (2026-07-29); the chores assistant's **"Review & add chore" chip now persists** by default instead of being consumed on tap (`ChoresAssistantScreen` no longer calls `resolvePending()` when opening `ChoreForm`) — it's retired only once the chore is actually created, which `ChoreForm` signals via `markAssistantDraftSaved('chores')` (shared `lib/assistantDraft` store) so re-tapping and re-saving can't duplicate the chore; the persist-until-created rule is owned by [ai-assistant.md](ai-assistant.md) (2026-07-31); superseded same day by the **inline per-message chip** model — `ChoresAssistantScreen`'s "Review & add chore" chip now renders under its own turn's bubble, reads its draft from `msg.pendingChore` (moved into `useChat`), and stays permanently tappable; the `assistantDraft` signal + `ChoreForm`'s `markAssistantDraftSaved('chores')` were removed (a form-opening chip has no direct-create to guard). Chip behavior is owned by [ai-assistant.md](ai-assistant.md) (2026-07-31); changing a chore's **Repeat** on the add/edit form now resets its **Next Due Date** from the new rule (shared `dueDateForRule`, unit-tested; "Does not repeat" leaves the picked date alone) (c2d18c0+, 2026-08-04); the **item, task and chore edit forms now end in a Delete button** like the event form does — reported missing from the edit view; each runs the same prompt its detail screen runs (occurrence-scoped sheet for a repeating chore/task, cascade confirm for an item) and exits past the detail underneath, which is bound to the record just destroyed (`navigation/popPastDetail`, unit-tested) (c2d18c0+, 2026-08-04); the chore-template and task-template search fields set `autoCapitalize="none"` + `autoCorrect={false}` per the app-wide input-hint convention (mobile/CLAUDE.md) (2026-08-10); the chore/task/item "Ask Calen" form-assist action button is tinted with the section accent per the section-accent rule (card chrome stays app-primary; shared FormAssist accent prop) (3cd3b36+, 2026-08-11)
code:
  - mobile/src/screens/maintenance/
  - mobile/src/lib/choreAssignees.ts
  - server/src/routes/{items,tasks,chores,taskTemplates,choreTemplates,odometer,manuals}.js
  - server/src/models/{Item,MaintenanceTask,Chore,TaskCompletion,OdometerLog,Manual}.js
  - server/src/services/recurrence.js
  - shared/seed/taskTemplates.json
tests:
  - server/src/test/maintenance.integration.test.js
  - server/src/services/recurrence.test.js
  - mobile/src/lib/__tests__/recurrence.test.ts
  - mobile/src/lib/__tests__/choreAssignees.test.ts
  - mobile/src/lib/__tests__/repeatingItemScope.test.ts
  - mobile/src/navigation/__tests__/rebindDetailBelow.test.ts
---

# Maintenance (items, tasks, chores)

## Purpose

Home **items** (appliances, vehicles, systems) with attached manuals; recurring
**maintenance tasks** and household **chores**; a rural-home template library; and
odometer tracking for mileage-based service.

## Behavior (normative)

- **Unsaved-changes guard:** the item, task, and chore add/edit forms prompt an
  Apple-style "Discard Changes?" sheet before leaving with unsaved edits (header
  ✕ / back / swipe-back / Android back), via the shared `useUnsavedChangesGuard`
  hook — a successful save/delete exits without prompting. On the Item form the
  guard covers only the final details step, not the add wizard. See
  [calendar.md](calendar.md) and [mobile/CLAUDE.md](../../mobile/CLAUDE.md).
- **Every edit form ends in Delete.** The item, task, and chore forms carry a
  danger-styled **Delete Item / Delete Task / Delete Chore** button at the bottom
  when editing (never on an add), matching the event form. It runs the *same*
  prompt the matching detail screen's Delete runs — the occurrence-scoped sheet
  for a repeating chore/task, the plain cascade confirm for an item — so the user
  who opened the form to change something and decided to bin it instead doesn't
  have to back out first. Deleting from a form exits **past** the detail screen
  underneath it (`navigation/popPastDetail`), because that page is bound to the
  record (or occurrence) just destroyed; the user lands where the detail was
  opened from, exactly as the detail screen's own Delete leaves them.

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
  Only the manuals routes that spend model tokens are credit-metered
  (`meter('manualParse')`): **auto-lookup** and **extract-tasks**. A plain
  manual **upload** or **save-from-URL** is free — storing a user-provided
  file is not an AI action and MUST NOT be metered or debited (pricing rule
  in [billing-plans.md](billing-plans.md)).

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
  `nextDueDate`, alerts) without item binding. **"Assigned to" offers household
  members only** — never the wider contacts roster. `Chore.assignedTo` refs a
  `Contact`, so the options are the self-Contacts of the current household's member
  accounts: the decrypted contacts list filtered to `accountId ∈ GET /household →
  members` (plus your own id, so a solo household — or an offline/404 household
  fetch — still lists just you), sorted **you first**, then the rest
  alphabetically. A chore already assigned to a non-member (assigned before this
  rule, or to someone since removed from the household) keeps that person as a
  visible option so the field never silently reads "Unassigned"; they just can't
  be picked fresh. The same option list is what the form advertises to
  "Ask Calen" form-assist, so the assistant can't assign a chore to a contact
  either — and it is what a chores-assistant draft's `assignedToName` is matched
  against on-device (see the draft-prefill rule below). Tapping "+" on the chores list
  opens an **Add Chore chooser** (`AddChoreScreen`) — mirroring the item form's
  "what would you like to add?" scope step — offering *add a chore by hand*
  (→ `ChoreForm`) or *use a template* (→ `ChoreTemplates`). The chooser
  `replace`s itself so Back returns to the list, not the chooser.
- **An assistant draft prefills the whole chore form.** Opening `ChoreForm`
  from the chores assistant's "Review & add chore" chip seeds every field the
  draft carries: title, instructions, **icon** (applied only if it names one of
  the form's `CHORE_ICONS`), recurrence, **the first due date** (a draft
  `firstDueDate` in YYYY-MM-DD overrides the interval-from-today reseed the
  recurrence produces — "every 2 weeks starting this Sunday" must anchor on
  that Sunday, and for an interval series the anchor day IS the weekday
  pattern), **alert settings**
  (`reminderDaysBefore`/`alert2DaysBefore` applied only when they match
  `ALERT_DAY_OPTIONS` values and differ from each other; `reminderTime`
  zero-padded to HH:MM; `alertAudience` everyone/owner), and the **assignee** —
  the draft names a person (`assignedToName`), and the form resolves that name
  to a household-member option once contacts + household have loaded
  (`matchAssigneeByName`: a self-reference — "me"/"you"/"myself", since the
  model never knows the user's name — resolves to the signed-in user's
  "(You)"-suffixed option; otherwise exact label match first, else first-name
  match, the "(You)" suffix ignored; one shot, so no match — or the user
  clearing the field — leaves it Unassigned).
  Draft values the form's own pickers don't offer are dropped, not saved.
- **Changing a chore's repeat resets its next due date.** On the add and edit
  chore forms (`ChoreForm`), any change to the Repeat rule — live from the pushed
  Repeat screen, from "Ask Calen", or from an assistant draft's prefilled
  recurrence — reseeds **Next Due Date** from the new rule
  (`dueDateForRule` in `lib/recurrence.ts`, over the shared `seedDueDate`), since
  a date the old cadence produced means nothing under the new one. The reseeded
  date is shown in the field, not applied silently at save. A rule with **no**
  frequency ("Does not repeat") implies no date, so turning the repeat off leaves
  the date the user picked alone — as does editing any non-repeat field. The same
  helper seeds the create-time fallback for a chore saved with the field still
  empty (client-owned due-date lifecycle, D4).
- **The Repeat picker only offers what the sealed model can store.** The chore
  and task forms reuse the calendar's pushed Repeat screen, but the sealed
  chore/task `Recurrence` keeps a **single** `dayOfWeek` / `dayOfMonth` and
  only concrete Sun..Sat ordinal kinds — it cannot represent "Tue & Thu",
  "each 5th & 20th", the day/weekday/weekend ordinal kinds, or a within-year
  ordinal rule. Both forms therefore push the screen with **`singleDay: true`**
  (`EventRepeat` route param): the weekly weekday list and the monthly date
  grid become **single-select** (the tapped day replaces the selection), the
  ordinal "Day" select lists **Sunday through Saturday only**, and the yearly
  "Days of week" ordinal switch is hidden. Ordinals offered are the full
  first/second/third/fourth/**fifth**/next-to-last/last set — all handled by
  the engine (see the ordinal-semantics rule below). The calendar event form
  never passes the param and keeps the unrestricted multi-select picker.
- **A rule the model can't store losslessly is refused at save, never
  degraded.** `ruleToRecurrence` used to keep just the first selected day
  ("weekly on Tue & Thu" anchored Thursday saved as Tuesday-only; "each 5th &
  20th" saved as 5th-only) and dropped unsupported ordinal kinds silently.
  `ruleLossyForItem` (`lib/recurrence.ts`, unit-tested) now flags a
  multi-weekday weekly rule, a multi-date monthly **or yearly** rule, the
  day/weekday/weekend ordinal kinds, and a yearly rule carrying a within-year
  ordinal — while passing a yearly rule with a **single** anchor day, which is
  the lossless calendar-type round-trip (next bullet), not a degradation;
  `ruleDateMismatch` runs it **first** — before the date check, and
  even when no date is picked — so both forms refuse with the same inline
  `FormError` whatever produced the rule (the restricted picker can't, but a
  legacy draft, an assistant draft, or a future entry point could). The
  assistant paths only ever write single-day rules
  (`applyRecurrenceAssistPatch` / the draft prefill's `Recurrence`), so the
  backstop is exactly that — a backstop. Display stays tolerant: `repeatsLine`
  still renders a multi-day rule, so anything already sealed reads correctly.
- **A yearly recurrence's anchor day round-trips the Repeat-screen bridge
  intact.** A calendar-type recurrence ("Mar & Sep **on the 15th**" —
  `{ type: 'calendar', months, dayOfMonth }`, written by web/legacy records or
  reached via the yearly month-multiselect) carries its `dayOfMonth` into the
  rule's `daysOfMonth` slot in `recurrenceToRule`, and `ruleToRecurrence`
  writes it back — for the multi-month calendar output and the single-month
  interval-`years` output alike. Without the carry, any edit-save silently
  moved every occurrence to the **1st** (the engine defaults
  `day = r.dayOfMonth || 1`). The Repeat screen's yearly mode preserves the
  populated `daysOfMonth` through month toggles (changing frequency reseeds,
  as for every frequency); a legacy record with **no** `dayOfMonth` stays on
  the 1st exactly as before. Round-trip and expansion are unit-tested in
  `lib/__tests__/recurrence.test.ts`.
- **A date the repeat rule never generates can't be saved as the series'
  anchor.** The saved date IS the pattern anchor, so "every week on Tuesday"
  due on a Wednesday would put every future occurrence on the wrong day. On
  both the chore and task forms, saving with a date that conflicts with the
  rule's pinned days is refused with an inline `FormError` naming both sides
  ("The repeat is on Tuesday, but this date falls on a Wednesday. Pick a
  matching date or change the repeat."). The check (`ruleDateMismatch` in
  `lib/recurrence.ts`, unit-tested) covers weekly weekdays, monthly numbered
  dates, monthly ordinal weekdays (including *which* one of the month —
  second/**fifth**/last/next-to-last), yearly months, and a yearly rule's
  anchor day (the `dayOfMonth` a calendar-type recurrence round-trips through
  the rule's `daysOfMonth`); daily and
  plain-interval rules pin no days and never conflict.
  **A date the engine's short-month clamping generates is a match, not a
  mismatch.** The expansion engine clamps a configured day past a month's end
  to that month's last day (`clampDay`, `shared/calendar/index.js`), so those
  clamped dates are dates the rule genuinely produces — the repeat-change
  reseed writes them, and a series edit opened on a clamped occurrence carries
  one. The monthly/yearly day check (`clampedDayMatch`) therefore accepts a
  date exactly when it lands where `clampDay` would put it: the configured day
  itself, or the month's **last day when the configured day exceeds that
  month's length** — rule 31 accepts Aug 31, Sep 30, and Feb 28/29; rule 30
  accepts Feb 28/29; rule 29 accepts Feb 28 **only in a non-leap year**.
  Anything short of the clamp target is still refused (rule 31 on Sep 29).
  (Multi-day sets and
  aggregate weekday/weekend/day kinds no longer reach the date check — the
  lossy-rule rule above refuses them outright.) **The "Save for This
  Chore/Task Only" scope is exempt** from both checks: it detaches the
  occurrence as a one-time copy, which repeats nothing (the rule is discarded)
  and may land on any day — that flow ("do this one on Friday instead") must
  keep working. The whole-series and Save-for-Future scopes keep the rule, so
  picking either with a mismatched or unstorable rule shows the error instead
  of saving.
- **Week-ordinal semantics (the `weekOfMonth` + `dayOfWeek` interval rule).**
  `nthWeekdayOfMonth` in the shared engine (`shared/calendar/index.js`)
  indexes the month's actual matching weekdays, exactly like the events
  path's `ordinalDayOfMonth`: positive ordinals 1..5 count from the start and
  yield **nothing in a month without an nth occurrence**; negative ordinals
  count from the end (-1 last, -2 next to last — every month has at least
  four of each weekday, so -1..-4 always exist). `computeNextDueDate`
  advances past a month that yields nothing, and **a skipped month still
  consumes an interval step** — "every 2 months on the fifth Tuesday" checks
  every second month and fires only in those having one, matching the events
  expander's unconditional month stepping. So a fifth-Tuesday chore runs Sep
  29 2026 → Dec 29 → Mar 30 2027 (no first-Tuesday bleed into Nov/Feb), and a
  next-to-last-Tuesday chore continues month after month (previously the
  ordinal landed in the *prior* month and the expander's non-advancing-cursor
  guard ended the series right after its anchor). Regression-tested in
  `shared/calendar/index.test.js` and via `nextOccurrenceFrom`.
- **A repeating chore or task is scoped per occurrence, exactly like a calendar
  event.** Chores and maintenance tasks are the other two things on the calendar
  that repeat, and they now answer the same Apple questions
  (`lib/repeatingItemScope.ts` serves both domains; only the noun and the api group
  differ). A `one-time` item — or one with no recurrence — keeps the plain single
  confirm and never prompts.
  - **The occurrence is what's opened.** Tapping a chore or task from a calendar
    cell passes that day as the `date` route param (`ChoreDetail` / `ChoreForm` /
    `TaskDetail` / `TaskForm`), and the detail screen and form show **that day**
    rather than the record's `nextDueDate` anchor. A whole-series save shifts the
    due date back onto the anchor by the same delta, so saving from the third
    occurrence doesn't drag the series onto it. Opened from a list (Chores,
    Maintenance, an item, calendar search) there is no occurrence and the series
    itself is the subject.
    The chore detail screen's due row dates the frame it's in: an occurrence
    reads relative to **its own day** — including the past ("Due yesterday",
    "Due 2 days ago") when the tapped day is behind today. The series frame
    reads relative to the **next occurrence computed from today**
    (`nextOccurrenceFrom`, honouring skips and `until`), never the stored
    `nextDueDate` anchor — nothing advances the anchor as time passes (chores
    don't track completion), so it goes stale the moment its first occurrence
    is behind us, and a chore may legitimately be created with a past start.
    With no occurrence ahead the row falls back to the anchor's own (past) day
    — a one-time chore whose day passed — or to "Ended <date>" (below). A
    task's label is overdue-aware on its own.
  - **Delete** — from the detail screen or the edit form, identically — offers
    **Delete This Chore/Task Only** and **Delete All Future
    Chores/Tasks** in a native action sheet. *This … Only* adds the day to
    `recurrence.skipDates`; *All Future* sets `recurrence.until` to the end of the
    previous day, or **deletes the record** when the occurrence is the series'
    first (nothing precedes it).
  - **Save** offers **Save for This … Only** and **Save for Future …** under
    "How should this change be applied?", with the same series/occurrence split
    events use: the **repeat rule** — and, for a task, the **mileage interval**
    (`intervalKm`), which is a second recurrence schedule in disguise — are
    series-defining and offer *Save for Future* alone. **Moving the occurrence's
    date is an occurrence-level change** — "do the Aug 20 chore on Aug 22
    instead" offers both choices, exactly as an event's date/time does. The
    save-payload diff cannot see that edit on its own (`nextDueDate` is exempt
    from it, because the due-date lifecycle reseeds the field whenever the
    repeat rule changes), so the form passes an explicit
    `occurrenceDateMoved` signal when it is showing an occurrence and the date
    field no longer holds the tapped day; a rule-derived reseed alone never
    raises it. The decision's recurrence compare looks at the **rule only**:
    `skipDates`/`until` live inside the sealed recurrence object and the form
    rebuilds the rule without them, so a previously skipped day (or an end date)
    must not make an unrelated edit read as a rule change and collapse the sheet
    to *Save for Future* alone — and an absent list vs. an empty one
    (`months: []`) is shape noise, not an edit. A mixed edit takes the most
    restrictive answer; an unchanged form and a one-time item don't prompt at all.
    Being on the series' **first** occurrence does NOT suppress the sheet — it only
    changes how the choice is performed (*Save for Future* there is a plain
    in-place series update, since there is nothing behind it to truncate to), the
    same rule events follow. *This … Only* writes a
    detached **one-time** copy on that day and skips the day in the series; *Save
    for Future* truncates the original and starts a new series carrying the edits,
    with skips from the fork day on inherited and shifted by however far the
    occurrence moved. Both are create-then-mutate with a rollback on failure.
    The fork is stamped with a sealed **`splitFrom`** link naming the series it
    truncated — the fork-side counterpart of the detached copy's
    `detachedFrom`/`detachedDate` — on chores and tasks alike, so a list can
    tell the two records are one chore (below).
  - **"Resume schedule" undoes accumulated scoping, forward only.** A chore or
    task that has been skipped down (or ended) carries a **Resume schedule** row
    at the bottom of its detail card, shown only when something is actually
    holding the series back, with a subtitle naming what
    (`"Ended Aug 4 · 3 skipped ahead"`). That subtitle is the feature's
    discoverability: it explains why the item looks the way it does before
    offering the fix. Confirming resumes the series **from today**:
    - Skips from today onward are dropped — those occurrences come back.
    - **The past is left exactly as it looks.** Days already skipped stay
      skipped, and because clearing a past `until` would also expose the stretch
      between the end day and today, those occurrences are **enumerated into
      `skipDates` as the end date is lifted**. Resuming can never repopulate
      history the user deliberately cleared. This is a deliberate choice over a
      literal undo.
    - An upcoming day that already has a **detached copy** (from *Save for This …
      Only*) stays skipped, or the day would show the copy *and* the series
      occurrence. The link is `detachedFrom` + `detachedDate`, stamped on the copy
      when it is created and sealed with the rest of the record.
    - Resuming is **idempotent**, and never deletes anything the user created.

    Forward-only semantics are also what make the anchor's one-way drift
    irrelevant: `skipOccurrence` advances `nextDueDate` past a skipped anchor day
    and an interval series can never expand earlier than its anchor, but
    everything lost that way is in the past, which resume doesn't touch.
  - **A finished series leaves the to-do lists.** "Delete All Future" ends the
    series with `recurrence.until` instead of destroying the record, precisely so
    the days already behind it keep their occurrences. But the Chores list and the
    Maintenance due/overdue lists exist to show **outstanding work**, so an item
    with no occurrence remaining from today onward is filtered out of both
    (`hasUpcomingOccurrence` — an unbounded series always qualifies; a bounded one
    is expanded over the window its own `until` closes, so the check is exact
    rather than a guess from `nextDueDate`). It still renders on the past calendar
    days it legitimately occupies. Without this a chore the user had just ended
    stayed listed, advertising its stale anchor as a live next due date — and a
    maintenance task read as permanently **overdue**, since its anchor sits in the
    past while the schedule has stopped.

    **An ended chore leaves the Chores list entirely — deleting is a one-step
    action.** The truncation-not-deletion above is bookkeeping in service of the
    calendar's past days; to the user, "Delete All Future Chores" is a delete,
    and the earlier collapsed "Ended chores (N)" footer group made it a
    two-step one (the ended husk sat in the list until deleted a second time —
    reported). The Chores list therefore shows no ended group at all; an
    all-ended list is simply the plain "No chores yet" empty state. The ended
    record stays reachable through the past calendar days it kept: tapping one
    opens its detail page, which still offers **Resume schedule** (the row
    renders whenever something holds the series back, whatever the entry path)
    and — from the series' first day — the full record delete, since *Delete
    All Future* from the first occurrence deletes the record outright.

    Ended **tasks** keep their collapsed **"Ended tasks (N)"** group, dimmed and
    expandable, and that is not optional politeness: the Maintenance screen
    groups tasks under their linked item and skips any without one, so an ended
    **item-less** task would otherwise have no home on the screen at all — and a
    task's record also anchors its completion history.
  - **The Chores list shows one card per chore.** Occurrence scoping works by
    writing new records, but to the user those records are still one chore, and
    a list that shows every record shows the plumbing: editing one occurrence
    made the chore appear a second time as a "one-time" card, and a *Save for
    Future* edit listed the chore twice — the truncated old version beside the
    new. `collapseScopedRecords` (lib/repeatingItemScope, unit-tested) therefore
    hides from the list:
    - a **detached copy** whose series is present (`detachedFrom`) — the
      override still renders on its calendar day, which is where a single day's
      edit lives; the series card is the chore's one entry here;
    - a **truncated predecessor** whose fork is present (the successor's
      `splitFrom` names it) — the fork carries the chore forward and is its one
      card; a chain of forks collapses to the latest.

    Either rule needs the *other* record to actually exist: when the series (or
    the fork) has since been deleted, the survivor is all that's left of the
    chore and lists normally. A genuinely one-time chore (created that way, no
    `detachedFrom`) always lists. Forks made before the `splitFrom` stamp
    existed carry no link and still list both halves. **Task lists deliberately
    do not collapse forks yet**: a task's completion history is keyed on the
    old record's id, so hiding the predecessor would orphan its history — the
    link is stamped on task forks from day one, but the Maintenance screens
    keep showing both halves until history has an answer.
  - **An ended item's date row says so.** Its anchor still sits in the past, so
    reading `nextDueDate` would report a stopped series as long overdue ("7 months
    overdue"). The row shows `Ended <date>` instead — keyed on having **no
    occurrence left**, not merely on `until` being set, since a series ending next
    month hasn't ended yet.
  - **The date field is named for the frame it's in.** Opened on an occurrence, it
    holds THAT day, not the series anchor — so calling it "Next Due Date" would
    name the wrong thing (the real next due date may be months behind what's
    shown). It reads **"Date"** in that frame and keeps **"Next Due Date"** when
    the series itself is the subject (opened from a list, or a one-time item). A
    single `Hint` under the date/repeat group names the occurrence being edited
    ("Editing the Aug 20 chore in this repeating series."), so the form doesn't
    read as the whole chore and the save sheet's "This … Only" choice has a
    visible referent.
  - **Skipping the anchor moves it.** An `interval` series walks forward from
    `nextDueDate`, so skipping the day the record is currently anchored on also
    advances the anchor (`computeNextDueDate`) — otherwise the detail screen and
    the due-in label would keep reporting a due date the calendar no longer shows.
  - **Completion history stays with the original record.** `TaskCompletion` is
    keyed on the task id, and a *Save for Future* fork is a **new** record, so the
    ledger remains with the truncated original — history describes the schedule
    that produced it. Only destroying the record destroys its history, which is why
    the "This also removes all completion history" warning appears on the one-time
    confirm and on a first-occurrence sheet (where *All Future* deletes the record)
    and **not** on a later occurrence's sheet, where every choice leaves the record
    standing. Chores keep no completion ledger, so they never carry the warning.
  - `skipDates` and `until` live **inside** the recurrence object, which
    `CHORE_ENC` / `TASK_ENC` already seal whole — no encryption-subset change, and
    the shared engine honours both on expansion (see
    [calendar.md](calendar.md)). Because the edit forms rebuild the recurrence
    from the Repeat rule, their save payloads **carry the prior record's
    `skipDates`/`until` over** (unless the repeat was turned off) — otherwise a
    plain series save (a rename) would resurrect every skipped day and un-end an
    ended series. The *Save for Future* fork still replaces `skipDates` with the
    shifted from-here-on subset it computes.
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
