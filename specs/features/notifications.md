---
title: Notifications & reminders
status: current
last-verified: ddaa21b+ (2026-08-10); **a timed event's reminder body now names what its lead time counts down to** — the body was the bare lead time for every reminder kind, so an event with a drive time fired `23 minutes` at the moment the user had to walk out the door, indistinguishable from a 23-minute heads-up before it starts; a timed event's body now reads `Starts in 23 minutes` / `Starting now` or `Leave in 23 minutes` / `Leave now`, chosen by that slot's own `alertAnchor`/`alert2Anchor` (so one event's two alerts word themselves independently) with the drive subtracted back out of a departure-anchored value and a fallback to start wording when the drive time is gone; day-based reminders (all-day events, chores, tasks, occasions, holidays) keep the bare `Tomorrow`/`2 weeks`, having nothing to count down to; `leadPhrase` is replaced by an exact `durationPhrase`, which fixes a 90-minute lead reading back as `2 hours` now that the Custom sheet's minutes wheel reaches 180 (2026-08-10); ddaa21b+ (2026-08-08); **silent record-change pushes** — the push layer gained a data-only lane for the calendar's live household sync: `buildExpoMessage` (services/push.js) emits a title/body-less `_contentAvailable` message for `silent: true` payloads (web subs skipped), `services/recordChanges.js` debounces the `records_changed` fanout per household, and `lib/pushSync.ts` registers the on-device background task that syncs the replica when one arrives (behavior owned by calendar.md, Live household sync) (2026-08-08); ddaa21b+ (2026-08-06); **remote push registration wired + the household event notify relay** — `registerForPushNotifications()` was dead code (defined, never called: no device ever held a token, so every `pushToUser` reached nobody on mobile); a new `hooks/usePushNotifications` (mounted in RootNavigator) registers the Expo token on sign-in + foreground, sign-out best-effort unregisters the install's token, and notification taps route by `data.type` (invites → Invitations inbox, a household event reply → that event's detail; cold starts via `getLastNotificationResponseAsync`); two new stateless endpoints `POST /notifications/event-request|event-response` relay client-chosen invite/RSVP push strings to housemates after validating the event Record + every recipient's household membership (rate-limited, nothing stored — feature spec: calendar.md Household invitees); adjacent fix: cross-household `notifySender` crashed on sealed invites (`invitation.event.title` on an undefined snapshot — swallowed, so the sender silently got no reply push) and now falls back to a generic body (2026-08-06); **all-day event alerts are whole days off the day-alert hour, not minutes off noon UTC** — an all-day event has no start time, but its Alert pickers still offered 15/30/60-minute lead times and the scheduler counted them back from the stored noon-UTC instant, so every all-day alert landed at whatever local hour the reader's UTC offset produced (5am in Los Angeles, 8am in New York, 2pm in Berlin) and a previously configured minute offset survived the All-day switch untouched; an event alert now counts back from an ALERT ANCHOR (`eventAlertAnchor`, lib/calendar) — its start instant when timed, its own calendar date at `User.dayAlertTime` (9am default) when all-day — the all-day pickers/labels/Custom sheet/AI schemas offer whole days only ("On the day (9:00 AM)"), switching All day ON re-bases the alerts already set instead of dropping or keeping them, and the notification body is day-based (2026-08-04); day-based reminder default moved from 7am to **9am local** (`ALERT_HOUR`) across the server cron + on-device scheduler, and made **per-user configurable** via `User.dayAlertTime` (`PUT /settings`, Reminders screen TimeField) — cron honors the hour, on-device honors HH:mm (2026-07-29); moved the reminders controls (master toggle + day-based time) out of the Account screen into a dedicated Reminders screen off the profile hub (2026-07-29); e-card sends now flow through the mailer's lifecycle gates + delivery outbox (queue/retry) and the `ecard` template is admin-toggleable — see email-lifecycle.md (2026-07-29); calendar-level occasion alerts (noon day-of + 2wk default, on-device) + scheduled e-card server send (2026-07-28); e-card sends at-or-after the send hour on the occasion day (catch-up) (2026-07-28); e-card emails render via the style-gallery card renderer (ecardTemplates.js), template key passed through the scheduler (2026-07-28); scheduler also passes font/framing overrides + photos (embedded as inline CID attachments; missing files skipped, never fatal) (2026-07-28); paired alert slots (event/chore/task/occasion) must hold distinct values — second picker excludes the first's value via `excludeUsedAlert`, preventing duplicate notifications (2026-07-28); the Reminders screen accepts a **`promptEnable`** route param — a Calen assistant "Set up reminders" setup chip (`setup_reminders`, see ai-assistant.md) deep-links here and, while the master toggle is still off, shows a `SetupCallout` nudging the user to turn reminders on (df8c7f3+, 2026-07-31); e-cards are now **one-time** — `runECardCheck` sends a card on its next occurrence then clears `active` + stamps `sentAt` (replacing the annual `lastSentYear` guard), so a sent card never re-fires (df8c7f3+, 2026-07-31); **reminder-delivery repair** — the rolling window is now also recomputed on any `['calendar']` invalidation (an alert set on an event previously never reached the OS until the next background→foreground round trip), the pass is single-flight (overlapping passes double-scheduled the batch), the `localReminders` duplicate guard is claimed only after the OS accepts the batch and released when a pass fails, and the Reminders screen reports OS pending count / next reminder / last-run reason + a test notification (46cd98a+, 2026-08-03); **root cause found on-device** — `pushDayAlerts` called `.slice()` on `nextDueDate`, which the calendar engine emits as a **Date object** for recurring chores/tasks, so one recurring item threw and suppressed the entire reminder window (events included); fixed with a shape-tolerant `dueDateStr`, guarded per-reminder scheduling, stage+frame tagging in the run log, and engine-driven tests replacing the string-only fixtures that missed it (46cd98a+, 2026-08-04); **holiday alerts** — holiday calendars gained the same calendar-level alert config as Occasions (one config shared by ALL holiday calendars, device-local `hc_holiday_alert_prefs`, default OFF), reached from a notifications button on the holidays editor; holidays are computed on-device from `lib/holidays`, so they enter `computeReminders` as a `holidayAlerts` argument and are muted per-calendar by that calendar's Alerts switch (46cd98a+, 2026-08-04); **development-only surfaces removed for launch** — the Reminders screen's Delivery card (pending/next status rows + Send a test notification) and the `getReminderDiagnostics()` / `sendTestNotification()` helpers are gone; the run log survives but is **unrendered** (persisted + `console.warn` only), and its tests now assert the persisted record rather than an accessor (46cd98a+, 2026-08-04); **the two calendar-level alert configs (Occasions + holidays) are now ACCOUNT settings** — `User.occasionAlerts` / `User.holidayAlerts`, carried on `GET`/`PUT /settings`, with the AsyncStorage keys demoted to a cache: that cache is account state wiped at sign-out, so holiday alerts a user set read back fine all session and were silently off again at the next sign-in; edits now write both, load adopts the account's config (rescheduling the window when it differs), an account with no config is seeded from a device holding a non-default one, and `offsets: []` stays a real "off" distinct from an unconfigured `null` (c2d18c0+, 2026-08-04); **a reminder body is now the bare lead time** — the fixed `Upcoming event` / `Maintenance due` / `Chore due` labels (and the occasion/holiday `… on 2026-08-20` form) are replaced by `15 minutes` / `Tomorrow` / `2 weeks`, one wording across every reminder kind, via `leadPhrase` + `dayLeadPhrase` in `lib/notifications.ts` (c2d18c0+, 2026-08-04)
code:
  - mobile/src/lib/notifications.ts
  - mobile/src/lib/calendar.ts              # eventAlertAnchor + the all-day alert grid/labels
  - mobile/src/lib/calendarPrefs.ts         # occasion + holiday alert prefs (account-backed, device-cached)
  - mobile/src/screens/calendar/{OccasionAlerts,HolidayAlerts}Screen.tsx
  - mobile/src/hooks/useReminderScheduler.ts
  - mobile/src/screens/profile/RemindersScreen.tsx
  - mobile/src/lib/useSyncTimezone.ts
  - mobile/src/lib/push.ts
  - mobile/src/lib/pushSync.ts                 # silent records_changed push → background replica sync
  - mobile/src/hooks/usePushNotifications.ts   # session push wiring + tap routing
  - server/src/routes/notifications.js
  - server/src/services/{push,notify}.js
  - server/src/services/recordChanges.js       # silent-push debounce half (poke bus owned by calendar.md)
  - server/src/services/mailer.js          # sendECard (occasion e-cards)
  - server/src/services/ecardTemplates.js  # e-card style gallery + card HTML renderer
  - server/src/jobs/scheduler.js
tests:
  - server/src/test/notifications.integration.test.js
  - server/src/test/recordPoke.integration.test.js   # poke socket + silent push message shape
  - server/src/test/settings.integration.test.js
  - server/src/test/ecards.integration.test.js
  - server/src/jobs/scheduler.test.js
  - mobile/src/lib/__tests__/notifications.test.ts
  - mobile/src/lib/__tests__/rescheduleReminders.test.ts
  - mobile/src/lib/__tests__/eventAlerts.test.ts   # the alert anchor (timed start vs all-day day-alert hour)
---

# Notifications & reminders

## Purpose

Two distinct channels: **event/task reminders** (whose content is encrypted, so
they're scheduled on-device) and **household security alerts** (server-driven
push). The root README's old "Web Push / daily Gmail digest" description is
obsolete.

## Behavior (normative)

### On-device reminders

- Reminder content (event titles, task names) is E2EE, so the server cannot
  build a reminder. The client schedules **local notifications**
  (`lib/notifications.ts`) from decrypted records, over a **rolling window**: the
  soonest **60** reminders (`MAX_SCHEDULED`, headroom under iOS' ~64 pending cap)
  falling within the next **21 days** (`WINDOW_DAYS`). A reminder further out is
  guaranteed only once the window reaches it — hence the refresh triggers below.
- Reminders honor a `remindersEnabled` pref (Privacy toggle); disabling
  cancels all scheduled ones.
- Events support up to two alerts; `alertAudience` (`everyone`/`owner`) chooses
  who is reminded in a shared household.
- **An event alert counts back from the event's ALERT ANCHOR, which is not always
  the instant the record stores.** Both alerts are stored as `reminderMinutes` /
  `alert2Minutes` — minutes *before the anchor* — for every event, so the field,
  the API and the seal are the same for both kinds:
  - A **timed** event's anchor is its **start instant**.
  - An **all-day** event has no start time. It stores both endpoints at **noon
    UTC** (see [calendar.md](calendar.md)), so counting minutes back from the
    stored value put the alert at whatever local hour the reader's UTC offset
    produced — "1 day before" fired at 5am in Los Angeles, 8am in New York and
    2pm in Berlin — and a "15 min before" alert described a minute the event
    never had. Its anchor is therefore **its own calendar date at the user's
    day-alert time** (`User.dayAlertTime`, 9am unless changed — the same hour
    task, chore, occasion and holiday day-alerts fire at).
  - Both anchors come from `eventAlertAnchor` in `mobile/src/lib/calendar.ts`;
    nothing may re-derive them.
  - Because an all-day event's anchor is a wall-clock hour on a date, its offsets
    are **whole days**: `0` = the day itself at that hour, `1440` = the day
    before, `2880` = two days, `10080` = a week. The event form offers exactly
    those (plus None and Custom…, whose sheet is **fixed to the Days unit**), the
    detail view labels them with the hour they fire at ("1 day before (9:00
    AM)"), and the AI form-assist / `open_event_form` schemas advertise only
    whole-day values while the event is all-day.
  - **Switching All day ON re-bases the alerts already configured** rather than
    leaving them describing a time the event no longer has: sub-day offsets
    collapse onto the day itself, longer ones round to whole days, and a second
    alert that lands on the same offset as the first is dropped (two alerts must
    stay distinct). Switching All day **off** changes nothing — every whole-day
    offset is a legal timed offset too. Turning all-day on must never silently
    clear a configured alert.
  - An all-day event carrying an off-grid value (saved before this rule, or by
    an older client) still fires — at the anchor minus that value — and still
    renders, in timed wording, so the picker never falls back to its placeholder.
  - An all-day alert's body is **day-based** (`Today`/`Tomorrow`/`N days`), never
    the minute wording.
- **A reminder's body is the lead time, and a timed event's body says what that
  lead time is until.** The notification title already names the record and the
  banner already reads as a reminder, so no body carries a record-kind label
  (`Upcoming event`, `Maintenance due`, `Chore due` and the occasion/holiday
  `… on 2026-08-20` form — which leaked a raw yyyy-mm-dd into a user-facing
  string — are all gone). Every body is measured from the fire time, so it stays
  true however often the window is rescheduled. There are two wordings:
  - **Day-based reminders** (all-day events, maintenance tasks, chores,
    occasions, holidays) are the bare interval, `dayLeadPhrase`: `Today` /
    `Tomorrow` / `N days`, with exact multiples of seven days collapsing to
    `N weeks`. These have no start instant or departure to count down to, so a
    verb would spend the line on nothing. They phrase from the configured offset
    rather than a timestamp difference, so a DST boundary can't round the day
    count off by one.
  - **A timed event's alert** names its anchor, `timedEventBody`:
    `Starts in 23 minutes` / `Starting now` for an event-anchored alert,
    `Leave in 23 minutes` / `Leave now` for a departure-anchored one. The
    distinction is load-bearing, not decorative: a bare `23 minutes` on an event
    with a 23-minute drive is the moment to walk out the door, not a heads-up
    before it starts, and the number alone cannot say which. The wording is
    chosen by that slot's own `alertAnchor` / `alert2Anchor` — the framing the
    user picked in the form — so one event's two alerts routinely word
    themselves differently.
    - The stored minutes are minutes before the EVENT for both anchors, so a
      departure-anchored body subtracts the drive back out
      (`leaveAlertBuffer`): 63 minutes on a 40-minute drive reads
      `Leave in 23 minutes`, and a buffer of zero or less reads `Leave now`.
    - The anchor is re-checked against the live drive time
      (`effectiveAlertAnchor`), so an event whose location was removed keeps a
      stale `'leave'` flag but falls back to `Starts in …` — what the stored
      number literally is.
  - Durations in the timed bodies are spelled out **exactly** by
    `durationPhrase`: `23 minutes` / `1 hour` / `1 hour 30 minutes` / `2 days` /
    `1 week`. It must not round (the Custom sheet's minutes wheel reaches 180, so
    a 90-minute lead read back as `2 hours` under the old `leadPhrase`) and must
    not use the calendar words — `Starts in Tomorrow` is not a sentence, and a
    timed event can carry a whole-day alert.
  - All three helpers live in `lib/notifications.ts`.
- **Two alerts must be distinct.** Anywhere two alert slots are offered (event
  Alert/Second alert, chore & maintenance Alert/Second alert, occasion
  Alert/Second alert), the second picker excludes the value already chosen in the
  first (and vice-versa) via `excludeUsedAlert` in `lib/recurrence.ts`. This
  prevents scheduling two identical notifications for the same record. The off
  ("None"/"No alert") and "Custom…" sentinels are always selectable.
- **Expanded records carry two date shapes.** `expandRecurringTaskChore` passes a
  one-time item's `nextDueDate` through as the record's ISO **string**, but sets
  a **`Date` object** on every instance it generates for `calendar`/`interval`
  recurrences. The scheduler reads it through a shape-tolerant helper
  (`dueDateStr`) and derives the **local** y-m-d, not `toISOString()` (which is
  UTC and lands a day off either side of midnight). Assuming the string form is
  what broke on-device reminders entirely: `.slice()` on the Date form threw, and
  since the whole window is computed in one pass, a single recurring chore
  suppressed every reminder including event alerts. The server cron's
  `alertsToday` was never affected — it normalizes via `new Date(...)`.
- **Day-based reminders** (chores, maintenance tasks, occasions) fire at a
  wall-clock time of day rather than at an event start. The default is **9am
  local** (`ALERT_HOUR`), but each user may change it on the Reminders screen — the
  chosen time is a personal setting, `User.dayAlertTime` (`"HH:mm"`, `null` = 9am),
  written via `PUT /settings { dayAlertTime }` (empty string resets to the
  default; a non-empty value must be a valid 24h `HH:mm`). A chore or maintenance
  task may still override this per-item with its own `reminderTime` (`"HH:mm"`,
  sealed content) — both of its alerts (`reminderDaysBefore` and the optional
  `alert2DaysBefore`) fire at that time; unset falls back to the account default.
  The **server cron runs hourly**, so it honors only the HOUR of `dayAlertTime`
  (fires the daily batch at the top of that hour); the **on-device scheduler**
  honors the full `HH:mm`. Changing the time reschedules on-device reminders.
- **Occasion reminders** (the Occasions calendar — birthdays + labeled contact
  dates) use a single **calendar-level** alert config (no per-occasion override):
  a set of day-before offsets + one time, held on the **account**
  (`User.occasionAlerts`, read/written on `/settings`) and cached on the device
  (`hc_occasion_alert_prefs` — see *Where the two calendar-level configs live*
  below). Defaults: an alert at **noon the day of** the
  occasion AND one **two weeks before**. The two offset slots must be distinct
  (`excludeUsedAlert`), same as event/task alerts. Every occasion kind (birthday/
  anniversary/marriage/death/custom) uses this config, on-device. The Occasions
  calendar's Alerts switch (calendar id `birthdays`) suppresses them. The legacy
  **server** birthday push (`scheduler.js`, non-E2EE households only) stays
  birthday-only; new occasion kinds are on-device only.
- **Holiday reminders** use the same calendar-level shape as occasions, with one
  config shared by **every** holiday calendar: offsets + one time, on the account
  (`User.holidayAlerts`) and cached device-side (`hc_holiday_alert_prefs`),
  edited on the **Holiday Alerts** screen reached
  from the notifications button on any holidays editor (see
  [calendar.md](calendar.md)). They **default to off** (`offsets: []`, time
  `09:00`) — holidays are numerous, and scheduling them by default would crowd
  the 60-reminder window out of the user's own events. Holidays are never server
  records: each device resolves them from `lib/holidays` for each calendar's
  country + enabled ids, so they reach `computeReminders` as a separate
  `holidayAlerts` argument rather than inside `CalendarData`. Each item carries
  its **holiday calendar's id**, so that calendar's Alerts switch mutes it like
  any other calendar's events. The holiday lookahead deliberately runs **past**
  the 21-day window by the largest offset, so a "2 weeks before" alert for a
  holiday 25 days out still fires inside the window (pure date math, no fetch).
- **Where the two calendar-level configs live.** The Occasions and holiday alert
  configs are **account settings, not device settings**: `User.occasionAlerts` /
  `User.holidayAlerts`, carried on `GET`/`PUT /settings`. `lib/calendarPrefs`
  keeps the two AsyncStorage keys as a **cache** so a read never waits on the
  network — but the cache is account state, wiped at sign-out with the rest of
  `ACCOUNT_KEYS`, so it can never be the only copy. It was, and the settings
  therefore did not survive a sign-out: alerts set on the Holiday Alerts screen
  read back correctly for the whole session and were gone at the next sign-in.
  Rules:
  - Every edit writes the cache **and** `PUT /settings` (the server normalizes:
    offsets deduped, sorted, whole days ≥ 0; `time` a valid 24h `HH:mm`).
  - On load, `hydrateAlertPrefsFromServer` adopts the account's config over the
    cache and reschedules the reminder window if it differs.
  - `null` on the wire means **never configured** — the client's own defaults
    apply. An **empty `offsets` list is a real value** meaning the user turned
    that calendar's alerts off, and must not be collapsed into `null`: doing so
    would put an opted-out user back on the occasions default and re-notify them.
  - When the account has no config but the device holds a **non-default** one,
    the device's is uploaded rather than dropped — that is the upgrade path for
    settings made before these were server-backed.
- **Timezone stickiness.** Day-based timing is only right if the stored zones
  track reality, so both zones self-heal:
  - The personal `User.timezone` follows the **device clock**: synced at app
    launch *and on every return to the foreground*
    (`lib/useSyncTimezone.ts` — landing in a new zone rarely coincides with a
    relaunch). The sync is the zone's **single writer** — there is no
    user-facing picker (removed 2026-07: on-device reminder scheduling uses the
    phone's own clock, the server cron skips E2EE households and
    local-reminders devices, and a manual choice would be silently reverted by
    the sync anyway). A write is only issued when the zone actually changed.
  - The household default `Household.timezone` (the scheduler's fallback for
    members with no personal zone yet) is **derived from the home location**
    whenever the home address is saved: the client geocodes and reads the IANA
    zone from open-meteo's `timezone=auto` echo (keyless + client-side, so it
    also works for E2EE households whose address the server can't read), then
    writes it via the `householdTimezone` key on `PUT /settings` (validated
    server-side as a real IANA id).
- **When the window is recomputed.** `rescheduleReminders()` runs on three
  triggers, wired in `useReminderScheduler`:
  1. **App foreground** (and once on sign-in) — the reliability floor.
  2. **Any calendar data change.** The hook subscribes to the React Query cache
     and reschedules ~1.5s after a `['calendar']` invalidation (debounced, so one
     save's burst of invalidations is one pass). Every calendar mutation in the
     app already invalidates that key, so forms, detail screens, the assistant,
     templates, invitations, and the calendar prefs are all covered without each
     call site remembering to schedule. **This trigger is normative**: without
     it, an alert set on an event never reached the OS until the next
     background→foreground round trip, so an alert due in the same session
     simply never fired.
  3. **A background-fetch slot** (`lib/backgroundRefresh.ts`), best-effort.
- **The pass is single-flight.** Those triggers overlap routinely, and a pass is
  a cancel-all followed by a schedule loop — so two concurrent passes interleave
  into a double-scheduled batch (every reminder in the overlap fires twice). A
  caller arriving mid-pass joins the running promise instead of starting a
  second.
- The server cron (`jobs/scheduler.js`) is a **duplicate guard**, not a sender:
  it uses `User.localReminders` to avoid also emitting a server-side reminder for
  something the device already schedules. The device registers its local-reminder
  state via `POST /notifications/local-reminders`. The flag is claimed
  (`true`) **only after** the OS has accepted the batch, and released (`false`)
  when a pass fails — claiming it up front left the server standing down for a
  device that had scheduled nothing, so neither side sent.

### The run log (developer-facing only)

Every failure inside the scheduling pass is a silent no-op, so a broken layer is
indistinguishable from "no alerts were set" — which is exactly how a total
reminder outage went unnoticed until it was reported by hand. Each pass
therefore leaves a record. **Nothing renders it**: there is no delivery-status
UI, by decision (a raw failure reason belongs in a diagnostics channel, not a
settings screen).

- Each pass writes a `ReminderRunLog` to `hc_reminder_run_log` — `at`,
  `scheduled`, and a `reason` of `ok` (a clean pass, possibly with nothing to
  schedule), `disabled`, `no-permission`, or `error`. It is persisted, so a
  failure in a background-fetch slot is still readable after a relaunch.
- An `error` also records **which stage** threw — `load` (decrypt/assemble the
  calendar), `prefs` (device-local alert prefs), `compute`, `cancel`, or
  `schedule` — plus the message, and emits a `console.warn` carrying the stack.
  The stages are deliberately separate awaits rather than one `Promise.all`:
  they fail for unrelated reasons (a locked vault vs. a corrupt prefs blob) and a
  log that can't tell them apart can't be acted on.
- **A malformed reminder costs only itself.** Each `scheduleNotificationAsync`
  is guarded individually, so one bad row (an invalid date, an over-long title)
  cannot abort every later reminder in the batch. A pass that places some
  reminders reports `ok`; only a non-empty batch that placed *none* is an
  `error`.
- The Reminders screen's only failure surface is the `denied` banner + **Open
  Settings** row — a permission fix the user can act on, not diagnostics.
- **Open:** a user hitting this in production has no way to report the cause,
  and no server log exists (the content is E2EE). Attaching the last run log to
  the Help & Feedback diagnostics payload (`lib/diagnostics.ts`) would close that
  without rendering anything.

### Push (server-originated alerts)

- Real server→device push carries what can't be computed on-device: security-
  lifecycle alerts (member/key/device/factor changes; see
  [households-sharing.md](households-sharing.md)), cross-household invitation
  alerts, and household event invite/response alerts — delivered through Expo
  (`services/push.js`, `services/notify.js`).
- Device registration: `POST /notifications/push/register-native` /
  `unregister-native` (Expo token on `User.pushSubscriptions`);
  `push/subscribe`/`unsubscribe` + `push/key` are the legacy Web-Push endpoints.
- **Registration is wired** (`hooks/usePushNotifications`, mounted in
  RootNavigator): the device registers its Expo token after sign-in and again
  on each foreground (replace-per-token, so re-running is idempotent, and a
  permission granted later in iOS Settings is picked up). The permission prompt
  therefore fires post-sign-in, never on the auth screens; denial degrades to
  the in-app Invitations inbox. Sign-out best-effort unregisters the install's
  token (`unregisterCurrentPushToken`) before the session token clears, so a
  signed-out device stops receiving the account's pushes.
- **Tap routing:** a notification tap navigates by the payload's `data.type` —
  invite requests (`household_event_request`, `event_invitation`,
  `household_invite`, `calendar_invitation`, `trip_invitation`) land on the
  Invitations inbox; a household event reply (`household_event_response`) opens
  that event's detail. Cold-start taps ride
  `getLastNotificationResponseAsync()` (briefly waiting for the nav container);
  unknown types just open the app. No banner action buttons (accept/decline
  from the notification) in v1.
- **Household event notify relay** (`POST /notifications/event-request`,
  `POST /notifications/event-response`): the stateless push channel behind the
  calendar's in-household invitees (feature spec:
  [calendar.md](calendar.md#invitees--sharing)). The sending device chooses
  `title`/`body` (the server can't read the sealed event — same exposure class
  as the existing invite pushes, which already carry client-supplied titles).
  The server validates: caller has a household; 1–19 recipients
  (`event-response` takes exactly one `toUserId`); title ≤120 / body ≤200
  chars; the `eventId` names a live Record in the caller's household (404
  otherwise — a foreign event is indistinguishable from absent); **every**
  recipient is a housemate (one cross-household recipient fails the whole
  request, never a partial send); the sender is skipped, not an error. Then it
  fans out via `pushToUser` with `data: {type, eventId}` and stores nothing.
  Rate-limited (30/min per IP). Delivery is best-effort by design — the
  durable channel is the replica-derived inbox row.
- **Silent record-change pushes** (`type: 'records_changed'`): the background
  half of the calendar's live household sync (feature spec:
  [calendar.md](calendar.md), Live household sync). When a household record
  changes, `services/recordChanges.js` debounces (~3s per household) a
  **data-only** push to every member's native devices — `buildExpoMessage`
  emits **no `title`/`body`** and sets `_contentAvailable: true`, so nothing is
  ever user-visible; web subscriptions are skipped (a browser can't act on a
  notification it never shows). The payload names no record, collection, or
  author — only "your household's records changed". On-device,
  `lib/pushSync.ts`'s `Notifications.registerTaskAsync` background task
  (registered by `hooks/useRecordSync` while signed in, unregistered on
  sign-out) runs the normal `/records/sync` cursor pull into the replica and
  sets a dirty flag the next foreground consumes. The writer's own devices are
  **included** on purpose (their other devices want the refresh; the push is
  invisible). Best-effort by design — the OS throttles silent pushes; the
  foreground socket + revalidate lanes are the reliability floor. Requires
  `remote-notification` in `UIBackgroundModes` (EAS rebuild; no-ops in Expo
  Go).

### Scheduled e-cards (server-sent email)

- Occasion e-cards are the one scheduler pass that **runs for E2EE households**:
  the `ECard` row is a deliberate plaintext exception (recipient emails + message
  are server-readable by design), so `scheduler.js` `runECardCheck` sends them by
  **email** (`mailer.sendECard`) on the occasion's month/day at the **first
  hourly tick at or after** the author's local send-time — so a card scheduled
  same-day past its hour, or one whose exact tick was missed (deploy/downtime),
  still goes out that day. Each card sends **once**, on its next occurrence:
  after a successful send `runECardCheck` clears `active` and stamps `sentAt`, so
  a sent card is never queried again and does **not** recur annually.
  **Delivery needs SMTP** (`SMTP_URL`/`SMTP_HOST`);
  unconfigured, every email is a logged dry-run (EmailLog `status:'dry'`), not
  delivered. Like every send, an e-card flows through the mailer's lifecycle
  gates + delivery outbox: a provider-blocked send is queued and auto-retried,
  and the `ecard` template can be toggled/subject-overridden from the admin Email
  lifecycle page — see [email-lifecycle.md](email-lifecycle.md). Feature spec:
  [calendar.md](calendar.md#occasions-calendar-free-opt-in-add-on-id-birthdays);
  exception: [crypto-e2ee.md](../platform/crypto-e2ee.md).

## Data & API surface

- **State:** `User.pushSubscriptions` (platform, endpoint/keys, `expoToken`,
  label), `User.localReminders`. The event notify relay stores **nothing**.
- **Endpoints:** `notifications.js` (push register/unregister, local-reminders,
  and the stateless `event-request`/`event-response` relay).
- **Client:** `lib/push.ts` (registration + sign-out unregister),
  `hooks/usePushNotifications.ts` (session wiring + tap routing),
  `lib/notifications.ts` (scheduling).
- **Config:** `EXPO_ACCESS_TOKEN` (server → Expo Push API); push needs the EAS
  `projectId` to mint tokens.

## Encryption boundary

Reminder content never reaches the server (scheduled on-device from decrypted
records). Security-alert pushes carry no content — only that a lifecycle event
occurred. Household event invite/response pushes carry **client-chosen**
strings (the sender's device decides what the event is called in the banner);
the server relays them transiently after membership validation and persists
nothing.

## Verification

- Push-device registration: web subscribe/unsubscribe and native
  register/unregister validate input, replace per endpoint/token (no
  duplicates, fresh keys win), and coerce unknown platforms; `push/key` is
  always `configured` (native needs no server keys) with a null web key when
  VAPID is unset; the `local-reminders` duplicate-guard flag round-trips —
  `notifications.integration.test.js`.
- The event notify relay: recipient/title/body/eventId validation 400s, 404 on
  an event outside the caller's household, hard 400 when any recipient is
  cross-household (no partial sends), success skips the sender, and
  `event-response` enforces the same rules for its single recipient —
  `notifications.integration.test.js` (delivery no-ops there: no push
  subscriptions exist, so `sent` is 0 — the contract under test is validation
  and membership, not the Expo transport).
- The daily reminder cron's behavior — per-member firing at each member's chosen
  local alert hour (`dayAlertTime`, 9am default), timezone
  spread, audience resolution (`alertAudience` + explicit `alertUserIds`), and
  the E2EE-active household skip — `jobs/scheduler.test.js`.
- The `householdTimezone` settings key (IANA validation, storage on the
  household, independence from the personal zone) —
  `settings.integration.test.js`.
- The scheduling pass itself — the batch reaches the OS before the
  `localReminders` guard is claimed, a failed pass releases the guard instead of
  claiming it, no permission means neither schedule nor claim, concurrent
  callers join one pass (a single cancel + a single schedule), and the run log
  distinguishes a successful empty pass from a failed one; the run log names the
  failing stage (`load` vs. `prefs` for the same visible symptom) and survives a
  relaunch; and one rejected `scheduleNotificationAsync` still lets the rest of
  the batch through (only an all-failed batch reads as an error) —
  `mobile/src/lib/__tests__/rescheduleReminders.test.ts`. Those assertions read
  the **persisted log** rather than any accessor, because the log *is* the
  contract now that nothing renders it.
- `computeReminders` (window contents: offsets, times, mute switches) and the
  body wording — `durationPhrase` never rounding (90 → `1 hour 30 minutes`) or
  reaching for a calendar word, `timedEventBody` picking `Starts in …` vs.
  `Leave in …` / `Leave now` off the anchor, the drive subtracted back out of a
  departure-anchored value, the fallback to start wording when the drive time is
  gone, and one event's two slots wording themselves independently —
  `mobile/src/lib/__tests__/notifications.test.ts`. That suite drives part of its
  coverage from **real `assembleCalendarData` output**, not hand-built fixtures:
  the hand-built tasks all carried string `nextDueDate`s, so they passed while
  every real recurring chore crashed the pass. Any new reminder-shape test must
  go through the engine.
- End-to-end delivery is still only exercisable on-device: the Reminders
  screen's **Send a test notification** is the intended check.

## Open questions

- Confirm whether the legacy Web-Push endpoints are still wired to any client or
  are dead code to remove.
