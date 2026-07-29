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
import { getPrivacyPrefs } from './privacyPrefs';
import { getAlertMutedCalendarIds, getOccasionAlertPrefs, OccasionAlertPrefs } from './calendarPrefs';
import { occasionTitle, occasionNoun } from './occasions';

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

interface Reminder { at: Date; title: string; body: string; }

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
function dateStrMinusDays(dateStr: string, days: number): string {
  const d = atLocalHour(dateStr, 0);
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Day-based alert(s) for a task/chore: (dueDate − reminderDaysBefore) at the
// item's reminderTime (falling back to the account default), plus the optional
// second offset. Mirrors scheduler.js `alertsToday`.
function pushDayAlerts(out: Reminder[], item: { nextDueDate?: string; reminderDaysBefore?: number | null; alert2DaysBefore?: number | null; reminderTime?: string | null; title: string }, body: string, now: number, dayDefault: { hour: number; minute: number }) {
  if (!item.nextDueDate) return;
  const dueStr = item.nextDueDate.slice(0, 10);
  const { hour, minute } = alertHourMinute(item.reminderTime, dayDefault);
  for (const off of [item.reminderDaysBefore, item.alert2DaysBefore]) {
    if (off == null) continue;
    const at = atLocalHour(dateStrMinusDays(dueStr, off), hour, minute);
    if (at.getTime() > now) out.push({ at, title: item.title, body });
  }
}

// Turn a calendar range into the soonest reminders to schedule.
// `mutedCalendarIds` = calendars whose Alerts switch is off (custom calendars);
// their events are skipped entirely. `occasionPrefs` = the calendar-level alert
// config for the Occasions calendar (offsets + time); defaults noon day-of + 2wk.
// `dayAlertTime` = the user's account-level day-based default (`HH:mm`); unset
// falls back to 9am (ALERT_HOUR).
export function computeReminders(data: CalendarData, mutedCalendarIds?: Set<string>, occasionPrefs?: OccasionAlertPrefs, dayAlertTime?: string | null): Reminder[] {
  const out: Reminder[] = [];
  const now = Date.now();
  const dayDefault = parseHourMinute(dayAlertTime, { hour: ALERT_HOUR, minute: 0 });

  for (const e of data.events) {
    if (!e.startDate) continue;
    if (mutedCalendarIds?.has(e.calendarType)) continue;
    const start = new Date(e.startDate).getTime();
    for (const mins of [e.reminderMinutes, e.alert2Minutes]) {
      if (mins == null) continue;
      const at = new Date(start - mins * 60000);
      if (at.getTime() > now) out.push({ at, title: e.title, body: 'Upcoming event' });
    }
  }
  // The Maintenance/Chores calendars' Alerts switch mutes their day alerts too.
  if (!mutedCalendarIds?.has('maintenance')) for (const t of data.tasks) pushDayAlerts(out, t, 'Maintenance due', now, dayDefault);
  if (!mutedCalendarIds?.has('chores')) for (const c of data.chores) pushDayAlerts(out, c, 'Chore due', now, dayDefault);

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
        // On the day → announce it; earlier → an upcoming heads-up.
        const title = off === 0 ? occasionTitle(o) : `Upcoming: ${occasionTitle(o)}`;
        const body = off === 0 ? occasionNoun(o) : `${occasionNoun(o)} on ${o.date}`;
        out.push({ at, title, body });
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

// Recompute the rolling window and (re)schedule it. Cancels the previous batch
// first so nothing double-fires. Returns the count scheduled (0 if not permitted
// or offline). Safe to call often (app foreground, after edits).
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

export async function rescheduleReminders(): Promise<number> {
  try {
    // Respect the user's on/off toggle even if called outside the scheduler hook.
    if (!getPrivacyPrefs().remindersEnabled) { await cancelAllReminders(); await syncServerFlag(false); return 0; }
    if (!(await ensureNotificationPermission())) { await syncServerFlag(false); return 0; }
    await syncServerFlag(true);
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('reminders', {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const from = new Date();
    const to = new Date(Date.now() + WINDOW_DAYS * 86400000);
    const data = await loadCalendarData({ from: from.toISOString(), to: to.toISOString() });
    const [muted, occasionPrefs, dayAlertTime] = await Promise.all([
      getAlertMutedCalendarIds(), getOccasionAlertPrefs(), resolveDayAlertTime(),
    ]);
    const reminders = computeReminders(data, muted, occasionPrefs, dayAlertTime);

    await Notifications.cancelAllScheduledNotificationsAsync();
    for (const r of reminders) {
      await Notifications.scheduleNotificationAsync({
        content: { title: r.title, body: r.body },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at },
      });
    }
    return reminders.length;
  } catch {
    return 0; // offline / transient — the next foreground pass retries
  }
}

export async function cancelAllReminders(): Promise<void> {
  serverFlag = null; // forget the synced state so the next signed-in user re-syncs
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
}
