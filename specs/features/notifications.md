---
title: Notifications & reminders
status: current
last-verified: 55bfc65+ (2026-07-29); day-based reminder default moved from 7am to **9am local** (`ALERT_HOUR`) across the server cron + on-device scheduler, and made **per-user configurable** via `User.dayAlertTime` (`PUT /settings`, Reminders screen TimeField) — cron honors the hour, on-device honors HH:mm (2026-07-29); moved the reminders controls (master toggle + day-based time) out of the Account screen into a dedicated Reminders screen off the profile hub (2026-07-29); e-card sends now flow through the mailer's lifecycle gates + delivery outbox (queue/retry) and the `ecard` template is admin-toggleable — see email-lifecycle.md (2026-07-29); calendar-level occasion alerts (noon day-of + 2wk default, on-device) + scheduled e-card server send (2026-07-28); e-card sends at-or-after the send hour on the occasion day (catch-up) (2026-07-28); e-card emails render via the style-gallery card renderer (ecardTemplates.js), template key passed through the scheduler (2026-07-28); scheduler also passes font/framing overrides + photos (embedded as inline CID attachments; missing files skipped, never fatal) (2026-07-28); paired alert slots (event/chore/task/occasion) must hold distinct values — second picker excludes the first's value via `excludeUsedAlert`, preventing duplicate notifications (2026-07-28); the Reminders screen accepts a **`promptEnable`** route param — a Calen assistant "Set up reminders" setup chip (`setup_reminders`, see ai-assistant.md) deep-links here and, while the master toggle is still off, shows a `SetupCallout` nudging the user to turn reminders on (df8c7f3+, 2026-07-31); e-cards are now **one-time** — `runECardCheck` sends a card on its next occurrence then clears `active` + stamps `sentAt` (replacing the annual `lastSentYear` guard), so a sent card never re-fires (df8c7f3+, 2026-07-31)
code:
  - mobile/src/lib/notifications.ts
  - mobile/src/lib/useSyncTimezone.ts
  - mobile/src/lib/push.ts
  - server/src/routes/notifications.js
  - server/src/services/{push,notify}.js
  - server/src/services/mailer.js          # sendECard (occasion e-cards)
  - server/src/services/ecardTemplates.js  # e-card style gallery + card HTML renderer
  - server/src/jobs/scheduler.js
tests:
  - server/src/test/notifications.integration.test.js
  - server/src/test/settings.integration.test.js
  - server/src/test/ecards.integration.test.js
  - server/src/jobs/scheduler.test.js
  - mobile/src/lib/__tests__/notifications.test.ts
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
  (`lib/notifications.ts`) from decrypted records, over a **rolling window**
  (respecting iOS' cap on pending notifications).
- Reminders honor a `remindersEnabled` pref (Privacy toggle); disabling
  cancels all scheduled ones.
- Events support up to two alerts; `alertAudience` (`everyone`/`owner`) chooses
  who is reminded in a shared household.
- **Two alerts must be distinct.** Anywhere two alert slots are offered (event
  Alert/Second alert, chore & maintenance Alert/Second alert, occasion
  Alert/Second alert), the second picker excludes the value already chosen in the
  first (and vice-versa) via `excludeUsedAlert` in `lib/recurrence.ts`. This
  prevents scheduling two identical notifications for the same record. The off
  ("None"/"No alert") and "Custom…" sentinels are always selectable.
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
  a set of day-before offsets + one time, stored device-local
  (`hc_occasion_alert_prefs`). Defaults: an alert at **noon the day of** the
  occasion AND one **two weeks before**. The two offset slots must be distinct
  (`excludeUsedAlert`), same as event/task alerts. Every occasion kind (birthday/
  anniversary/marriage/death/custom) uses this config, on-device. The Occasions
  calendar's Alerts switch (calendar id `birthdays`) suppresses them. The legacy
  **server** birthday push (`scheduler.js`, non-E2EE households only) stays
  birthday-only; new occasion kinds are on-device only.
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
- The server cron (`jobs/scheduler.js`) is a **duplicate guard**, not a sender:
  it uses `User.localReminders` to avoid also emitting a server-side reminder for
  something the device already schedules. The device registers its local-reminder
  state via `POST /notifications/local-reminders`.

### Push (security alerts)

- Real server→device push is used for security-lifecycle alerts (member/key/
  device/factor changes; see [households-sharing.md](households-sharing.md)),
  delivered through Expo (`services/push.js`, `services/notify.js`).
- Device registration: `POST /notifications/push/register-native` /
  `unregister-native` (Expo token on `User.pushSubscriptions`);
  `push/subscribe`/`unsubscribe` + `push/key` are the legacy Web-Push endpoints.

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
  label), `User.localReminders`.
- **Endpoints:** `notifications.js` (push register/unregister, local-reminders).
- **Client:** `lib/push.ts` (registration), `lib/notifications.ts` (scheduling).
- **Config:** `EXPO_ACCESS_TOKEN` (server → Expo Push API); push needs the EAS
  `projectId` to mint tokens.

## Encryption boundary

Reminder content never reaches the server (scheduled on-device from decrypted
records). Security-alert pushes carry no content — only that a lifecycle event
occurred.

## Verification

- Push-device registration: web subscribe/unsubscribe and native
  register/unregister validate input, replace per endpoint/token (no
  duplicates, fresh keys win), and coerce unknown platforms; `push/key` is
  always `configured` (native needs no server keys) with a null web key when
  VAPID is unset; the `local-reminders` duplicate-guard flag round-trips —
  `notifications.integration.test.js`.
- The daily reminder cron's behavior — per-member firing at each member's chosen
  local alert hour (`dayAlertTime`, 9am default), timezone
  spread, audience resolution (`alertAudience` + explicit `alertUserIds`), and
  the E2EE-active household skip — `jobs/scheduler.test.js`.
- The `householdTimezone` settings key (IANA validation, storage on the
  household, independence from the personal zone) —
  `settings.integration.test.js`.
- On-device scheduling (`lib/notifications.ts` rolling window) has no automated
  coverage yet; it is exercised on-device.

## Open questions

- Confirm whether the legacy Web-Push endpoints are still wired to any client or
  are dead code to remove.
- Document the rolling-window size and refresh trigger (background fetch).
