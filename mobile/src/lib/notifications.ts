// On-device reminder notifications (Phase 5).
//
// Replaces the server push cron for reminders with Expo local notifications
// computed on-device. The data comes from the calendar range endpoint (events,
// tasks, chores, birthdays — already expanded per occurrence with their reminder
// fields); post-plaintext-drop this same computation runs over the decrypted
// local replica instead. See docs/E2EE-SYNC-PLAN.md §7 / §1.5.
//
// iOS caps pending notifications at ~64, so we only schedule a rolling window
// (the soonest MAX_SCHEDULED within WINDOW_DAYS) and re-schedule on every app
// foreground — far-future reminders are guaranteed only once the window reaches
// them. The foreground-refresh is the reliability floor; a background task can
// tighten it later.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { notificationsApi, settingsApi, CalendarData } from '../api';
import { loadCalendarData } from './calendarData';
import { AlertAnchor, effectiveAlertAnchor, eventAlertAnchor, leaveAlertBuffer } from './calendar';
import { getPrivacyPrefs } from './privacyPrefs';
import {
  getAlertMutedCalendarIds, getOccasionAlertPrefs, OccasionAlertPrefs,
  getHolidayAlertPrefs, getHolidayCalendars, holidayEnabledIds, HolidayAlertPrefs,
} from './calendarPrefs';
import { getHolidays } from './holidays';
import { occasionTitle } from './occasions';

// Foreground notification behavior (applies to local reminders and any push).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const WINDOW_DAYS = 21;
const MAX_SCHEDULED = 60;  // headroom under the iOS ~64 pending cap
const ALERT_HOUR = 9;      // local 9am — the built-in day-based default (mirrors the server cron)
// The user's personal day-based alert default (Account screen → dayAlertTime),
// cached so an offline reschedule can still honor it.
const DAY_ALERT_CACHE_KEY = 'hc_day_alert_time';
// Outcome of the last reschedule pass, persisted so the Reminders screen can
// report a run that happened in a background-fetch slot (or before this launch).
const RUN_LOG_KEY = 'hc_reminder_run_log';

interface Reminder { at: Date; title: string; body: string; }

// ── Lead-time wording ───────────────────────────────────────────────────────
//
// A DAY-BASED reminder's body is the lead time alone — "Tomorrow", "2 weeks".
// The title already names the record, and a chore due tomorrow has no start
// instant or departure to count down to, so a verb would only spend the line.
//
// A TIMED EVENT's body names what the lead time is until, because that event
// can carry either of two framings and the number alone cannot tell them apart:
// "23 minutes" on an event with a 23-minute drive is the moment to walk out the
// door, not a heads-up before it starts. The body therefore reads "Starts in 23
// minutes" or "Leave in 23 minutes" ("Leave now" / "Starting now" at zero),
// chosen by the alert's own `alertAnchor` — the framing the user picked in the
// form, not one re-derived from the minutes (see lib/calendar).
//
// Every phrase is measured from the moment the notification fires to the moment
// it is about, so it stays true no matter when the window is rescheduled.

// Whole days ahead → "Today" / "Tomorrow" / "3 days" / "2 weeks".
// Day-based alerts (tasks, chores, occasions, holidays) are configured in whole
// days, so this takes the offset directly rather than re-deriving it from two
// timestamps (the fire time is a wall-clock hour, the due date is date-only —
// subtracting them would round badly across a DST boundary).
export function dayLeadPhrase(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days % 7 === 0) {
    const weeks = days / 7;
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}

// Minutes ahead → "23 minutes" / "1 hour" / "1 hour 30 minutes" / "2 days" /
// "1 week", spelled out for the middle of a sentence.
//
// Two things it deliberately does NOT do, both of which the old `leadPhrase`
// did: it never ROUNDS (the Custom sheet's minutes wheel reaches 180, so a
// 90-minute lead was reading back as "2 hours"), and it never uses the calendar
// words `dayLeadPhrase` produces — "Starts in Tomorrow" is not a sentence, and a
// timed event can carry a whole-day alert.
export function durationPhrase(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes % 10080 === 0) return unit(minutes / 10080, 'week');
  if (minutes % 1440 === 0) return unit(minutes / 1440, 'day');
  const parts: string[] = [];
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  if (mins) parts.push(unit(mins, 'minute'));
  return parts.join(' ');
}

// The body of a TIMED event's alert: what the lead time is until, in the
// framing the user chose. `minutes` is always minutes before the event (that is
// what the record stores for both anchors); a departure-anchored alert counts
// its buffer back from the drive, so "23 min before leaving" on a 40-minute
// drive is stored as 63 and must read as 23.
//
// `effectiveAlertAnchor` re-checks the drive time rather than trusting the
// stored anchor: dropping the location off an event leaves `alertAnchor:
// 'leave'` behind on a record with nothing to leave for, and the alert falls
// back to what it literally is — a lead time before the start.
export function timedEventBody(
  minutes: number,
  anchor?: AlertAnchor | null,
  travelMinutes?: number | null,
): string {
  if (effectiveAlertAnchor(anchor, false, travelMinutes) === 'leave') {
    const buffer = leaveAlertBuffer(minutes, travelMinutes!);
    return buffer <= 0 ? 'Leave now' : `Leave in ${durationPhrase(buffer)}`;
  }
  return minutes <= 0 ? 'Starting now' : `Starts in ${durationPhrase(minutes)}`;
}

// One enabled holiday on one holiday calendar, inside the rolling window.
// Holidays are never server records — every device computes them from
// lib/holidays — so they reach computeReminders alongside the calendar data
// rather than inside it. `calendarId` is the holiday calendar's id, so its
// Alerts switch mutes them like any other calendar's.
export interface HolidayReminderItem { calendarId: string; date: string; name: string }

// yyyy-mm-dd at a local wall-clock time (minute defaults to 0).
function atLocalHour(dateStr: string, hour: number, minute = 0): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}
// Parse `HH:mm` → {hour, minute}, falling back to `fallback` when absent/invalid.
function parseHourMinute(time: string | null | undefined, fallback: { hour: number; minute: number }): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : fallback;
}
// A task/chore's `HH:mm` reminder time → {hour, minute}; falls back to the
// user's account-level day-based default (itself 9am unless changed).
function alertHourMinute(reminderTime: string | null | undefined, dayDefault: { hour: number; minute: number }): { hour: number; minute: number } {
  return parseHourMinute(reminderTime, dayDefault);
}
// Local yyyy-mm-dd (NOT toISOString, which is UTC and lands on the wrong day
// either side of midnight).
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateStrMinusDays(dateStr: string, days: number): string {
  const d = atLocalHour(dateStr, 0);
  d.setDate(d.getDate() - days);
  return localDateStr(d);
}

// A due date as yyyy-mm-dd, from either shape the calendar engine emits.
//
// This is a real trap, not defensiveness: expandRecurringTaskChore passes a
// one-time item's `nextDueDate` through untouched (the ISO string off the
// decrypted record) but sets a **Date object** on every instance it generates
// for the `calendar` and `interval` recurrence types. Calling .slice() on the
// latter throws "undefined is not a function", and because the whole window is
// computed in one pass, a single recurring chore then took down EVERY reminder
// — events included. Anything reading an expanded record's dates must handle
// both shapes.
function dueDateStr(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDateStr(value);
  if (typeof value === 'string') return value.slice(0, 10);
  return null;
}

// Day-based alert(s) for a task/chore: (dueDate − reminderDaysBefore) at the
// item's reminderTime (falling back to the account default), plus the optional
// second offset. Mirrors scheduler.js `alertsToday`. Each alert's body is its own
// lead time, so the two offsets on one item read "1 week" and "Today".
function pushDayAlerts(out: Reminder[], item: { nextDueDate?: string | Date; reminderDaysBefore?: number | null; alert2DaysBefore?: number | null; reminderTime?: string | null; title: string }, now: number, dayDefault: { hour: number; minute: number }) {
  const dueStr = dueDateStr(item.nextDueDate);
  if (!dueStr) return;
  const { hour, minute } = alertHourMinute(item.reminderTime, dayDefault);
  for (const off of [item.reminderDaysBefore, item.alert2DaysBefore]) {
    if (off == null) continue;
    const at = atLocalHour(dateStrMinusDays(dueStr, off), hour, minute);
    if (at.getTime() > now) out.push({ at, title: item.title, body: dayLeadPhrase(off) });
  }
}

// Turn a calendar range into the soonest reminders to schedule.
// `mutedCalendarIds` = calendars whose Alerts switch is off (custom calendars);
// their events are skipped entirely. `occasionPrefs` = the calendar-level alert
// config for the Occasions calendar (offsets + time); defaults noon day-of + 2wk.
// `dayAlertTime` = the user's account-level day-based default (`HH:mm`); unset
// falls back to 9am (ALERT_HOUR). It is also the hour an ALL-DAY event's alerts
// count back from, since such an event has no start time of its own. `holidayAlerts` = the alert config shared by
// every holiday calendar plus the window's holidays (see HolidayReminderItem);
// omitted or empty-offset means no holiday reminders, which is the default.
export function computeReminders(
  data: CalendarData,
  mutedCalendarIds?: Set<string>,
  occasionPrefs?: OccasionAlertPrefs,
  dayAlertTime?: string | null,
  holidayAlerts?: { prefs: HolidayAlertPrefs; items: HolidayReminderItem[] },
): Reminder[] {
  const out: Reminder[] = [];
  const now = Date.now();
  const dayDefault = parseHourMinute(dayAlertTime, { hour: ALERT_HOUR, minute: 0 });

  for (const e of data.events) {
    if (!e.startDate) continue;
    if (mutedCalendarIds?.has(e.calendarType)) continue;
    // A timed event's alerts count back from its start; an all-day event has no
    // start time, so they count back from the day-alert hour on its own date
    // (lib/calendar `eventAlertAnchor`). Counting back from the stored noon-UTC
    // instant instead made every all-day alert land at an arbitrary local hour
    // set by the reader's UTC offset. All-day offsets are whole days, so their
    // lead phrase is day-based ("Today"/"Tomorrow"), never "15 minutes".
    const anchor = eventAlertAnchor(e, dayAlertTime).getTime();
    // Each slot carries its OWN framing (`alertAnchor`/`alert2Anchor`), so the
    // two alerts on one event can word themselves differently — "Starts in 1
    // hour" and then "Leave now" is the normal pairing on an event with a drive.
    for (const [mins, slotAnchor] of [
      [e.reminderMinutes, e.alertAnchor],
      [e.alert2Minutes, e.alert2Anchor],
    ] as const) {
      if (mins == null) continue;
      const at = new Date(anchor - mins * 60000);
      if (at.getTime() > now) {
        const body = e.allDay
          ? dayLeadPhrase(Math.round(mins / 1440))
          : timedEventBody(mins, slotAnchor, e.travelMinutes);
        out.push({ at, title: e.title, body });
      }
    }
  }
  // The Maintenance/Chores calendars' Alerts switch mutes their day alerts too.
  if (!mutedCalendarIds?.has('maintenance')) for (const t of data.tasks) pushDayAlerts(out, t, now, dayDefault);
  if (!mutedCalendarIds?.has('chores')) for (const c of data.chores) pushDayAlerts(out, c, now, dayDefault);

  // Occasions (birthdays + labeled contact dates) share ONE calendar-level alert
  // config: each configured offset fires at the shared time (default: noon on the
  // day + two weeks before). Muted with the Occasions calendar's Alerts switch
  // (calendar id 'birthdays').
  if (!mutedCalendarIds?.has('birthdays')) {
    const prefs = occasionPrefs ?? { offsets: [0, 14], time: '12:00' };
    const { hour, minute } = parseHourMinute(prefs.time, { hour: 12, minute: 0 });
    for (const o of data.occasions) {
      for (const off of prefs.offsets) {
        const at = atLocalHour(dateStrMinusDays(o.date, off), hour, minute);
        if (at.getTime() <= now) continue;
        // On the day → announce it; earlier → an upcoming heads-up. The title
        // already names the occasion, so the body is just its lead time.
        const title = off === 0 ? occasionTitle(o) : `Upcoming: ${occasionTitle(o)}`;
        out.push({ at, title, body: dayLeadPhrase(off) });
      }
    }
  }

  // Holidays share ONE alert config across every holiday calendar (no
  // per-holiday override), mirroring the occasion config. Off by default, so an
  // absent/empty offsets list schedules nothing. Each holiday calendar's own
  // Alerts switch mutes its holidays.
  if (holidayAlerts && holidayAlerts.prefs.offsets.length > 0) {
    const { hour, minute } = parseHourMinute(holidayAlerts.prefs.time, { hour: ALERT_HOUR, minute: 0 });
    for (const h of holidayAlerts.items) {
      if (mutedCalendarIds?.has(h.calendarId)) continue;
      for (const off of holidayAlerts.prefs.offsets) {
        const at = atLocalHour(dateStrMinusDays(h.date, off), hour, minute);
        if (at.getTime() <= now) continue;
        out.push({
          at,
          title: off === 0 ? h.name : `Upcoming: ${h.name}`,
          body: dayLeadPhrase(off),
        });
      }
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, MAX_SCHEDULED);
}

// Ensure notification permission, prompting once if undetermined.
export async function ensureNotificationPermission(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.status === 'granted';
}

// Tell the server we handle reminders on-device so its push cron skips us —
// only when the value actually changes (not on every foreground refresh).
let serverFlag: boolean | null = null;
async function syncServerFlag(enabled: boolean) {
  if (serverFlag === enabled) return;
  serverFlag = enabled;
  try { await notificationsApi.setLocalReminders(enabled); } catch { serverFlag = null; }
}

// The user's account-level day-based alert default (`HH:mm`), or null for the
// 9am default. Fetched fresh from settings and cached so an offline reschedule
// still honors the last-known value.
async function resolveDayAlertTime(): Promise<string | null> {
  try {
    const { data } = await settingsApi.get();
    const t = typeof data.dayAlertTime === 'string' ? data.dayAlertTime : null;
    await AsyncStorage.setItem(DAY_ALERT_CACHE_KEY, t ?? '').catch(() => {});
    return t;
  } catch {
    try { return (await AsyncStorage.getItem(DAY_ALERT_CACHE_KEY)) || null; } catch { return null; }
  }
}

// The holidays every holiday calendar contributes to the reminder window, with
// the config they all share. Nothing is fetched — each calendar's country +
// enabled ids resolve locally (lib/holidays), same as the grid's holiday chips.
//
// The lookahead runs PAST the reminder window by the largest offset: an alert
// "2 weeks before" a holiday 25 days out fires inside the 21-day window even
// though the holiday itself lands outside it, and pure date math is free.
async function collectHolidayAlerts(from: Date, to: Date): Promise<{ prefs: HolidayAlertPrefs; items: HolidayReminderItem[] }> {
  const prefs = await getHolidayAlertPrefs();
  if (prefs.offsets.length === 0) return { prefs, items: [] };
  const lookahead = new Date(to.getTime() + Math.max(...prefs.offsets) * 86400000);
  const items: HolidayReminderItem[] = [];
  for (const cal of await getHolidayCalendars()) {
    for (const h of getHolidays(cal.country, from, lookahead, holidayEnabledIds(cal))) {
      items.push({ calendarId: cal.id, date: h.date, name: h.name });
    }
  }
  return { prefs, items };
}

// ── Run log (observability) ─────────────────────────────────────────────────
//
// Every failure path below is a silent `return 0`, which made "no notifications
// arrived" indistinguishable from "permission denied", "offline", and "the keys
// were locked" — a whole-feature outage that went unnoticed for weeks. Nothing
// renders this: it is a `console.warn` plus a record under RUN_LOG_KEY that
// survives to the next launch, so the next person debugging silent reminders
// starts with the answer instead of the symptom.

// The pass runs five stages against data the server can't see, so "it threw" is
// not actionable on its own — the log names the stage that failed.
export type ReminderStage = 'load' | 'prefs' | 'compute' | 'cancel' | 'schedule';

export interface ReminderRunLog {
  at: string;              // ISO timestamp of the pass
  scheduled: number;       // reminders handed to the OS
  reason: 'ok' | 'disabled' | 'no-permission' | 'error';
  stage?: ReminderStage;   // present when reason === 'error'
  error?: string;          // present when reason === 'error'
}

// Thrown stage boundary: lets the outer catch report WHERE without every stage
// needing its own try/catch/record.
class StageError extends Error {
  constructor(readonly stage: ReminderStage, readonly cause: unknown) {
    super(String((cause as Error)?.message ?? cause));
  }
}

async function stage<T>(name: ReminderStage, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new StageError(name, e);
  }
}

let lastRun: ReminderRunLog | null = null;

async function recordRun(reason: ReminderRunLog['reason'], scheduled: number, error?: unknown): Promise<number> {
  const staged = error instanceof StageError ? error : null;
  lastRun = {
    at: new Date().toISOString(),
    scheduled,
    reason,
    ...(staged ? { stage: staged.stage } : {}),
    ...(error ? { error: String((error as Error)?.message ?? error).slice(0, 300) } : {}),
  };
  if (error) {
    // Also to the Metro/device console with the stack, which the persisted log
    // deliberately truncates away.
    console.warn(`[reminders] ${staged?.stage ?? 'pass'} failed:`, (staged?.cause ?? error));
  }
  await AsyncStorage.setItem(RUN_LOG_KEY, JSON.stringify(lastRun)).catch(() => {});
  return scheduled;
}

// Recompute the rolling window and (re)schedule it. Cancels the previous batch
// first so nothing double-fires. Returns the count scheduled (0 if not permitted
// or offline). Safe to call often — it runs on app foreground, on a background
// -fetch slot, and after any calendar mutation (see useReminderScheduler).
//
// Single-flight: those three triggers overlap routinely (a save right before a
// foreground), and two concurrent passes interleave their cancel-then-schedule
// halves — B's cancel lands between A's cancel and A's writes, so A's batch is
// scheduled on top of B's and every reminder in the overlap fires twice. A
// caller arriving mid-pass joins the one already running instead.
let inFlight: Promise<number> | null = null;

export function rescheduleReminders(): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = runReschedule().finally(() => { inFlight = null; });
  return inFlight;
}

async function runReschedule(): Promise<number> {
  try {
    // Respect the user's on/off toggle even if called outside the scheduler hook.
    if (!getPrivacyPrefs().remindersEnabled) { await cancelAllReminders(); await syncServerFlag(false); return recordRun('disabled', 0); }
    if (!(await ensureNotificationPermission())) { await syncServerFlag(false); return recordRun('no-permission', 0); }
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('reminders', {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const from = new Date();
    const to = new Date(Date.now() + WINDOW_DAYS * 86400000);

    // Separate stages, not one Promise.all: decrypting the calendar and reading
    // device-local prefs fail for completely different reasons (a locked vault
    // vs. corrupt AsyncStorage), and the log is only useful if it says which.
    // Sequential, not Promise.all: a parallel pair whose second member also
    // rejects leaves an unhandled rejection behind, and the prefs read is a
    // handful of AsyncStorage hits — there is no latency worth that.
    const data = await stage('load', () => loadCalendarData({ from: from.toISOString(), to: to.toISOString() }));
    const { muted, occasionPrefs, dayAlertTime, holidayAlerts } = await stage('prefs', async () => {
      const [m, o, t, h] = await Promise.all([
        getAlertMutedCalendarIds(), getOccasionAlertPrefs(), resolveDayAlertTime(),
        collectHolidayAlerts(from, to),
      ]);
      return { muted: m, occasionPrefs: o, dayAlertTime: t, holidayAlerts: h };
    });

    const reminders = await stage('compute', () => computeReminders(data, muted, occasionPrefs, dayAlertTime, holidayAlerts));

    await stage('cancel', () => Notifications.cancelAllScheduledNotificationsAsync());

    // Per-reminder, not per-batch: one malformed record (a bad date, an
    // over-long title) must cost its own notification, not every later one in
    // the batch — a single bad row used to take the whole schedule down.
    let scheduled = 0;
    let firstFailure: unknown = null;
    for (const r of reminders) {
      try {
        await Notifications.scheduleNotificationAsync({
          content: { title: r.title, body: r.body },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at },
        });
        scheduled++;
      } catch (e) {
        firstFailure ??= e;
      }
    }
    // Claim the duplicate guard only now that the batch is actually on the OS.
    // Claiming it up front (before the load + schedule) meant a pass that threw
    // left the server skipping its cron for a device holding nothing.
    await syncServerFlag(true);
    // Some scheduled = a working pass with a bad row; NONE scheduled out of a
    // non-empty batch is a failed pass, and must read as one.
    if (firstFailure && scheduled === 0) return recordRun('error', 0, new StageError('schedule', firstFailure));
    return recordRun('ok', scheduled);
  } catch (e) {
    // offline / locked keys / transient — the next foreground pass retries. Do
    // NOT leave the server standing down for a batch that never got scheduled.
    await syncServerFlag(false);
    return recordRun('error', 0, e);
  }
}

export async function cancelAllReminders(): Promise<void> {
  serverFlag = null; // forget the synced state so the next signed-in user re-syncs
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
}
