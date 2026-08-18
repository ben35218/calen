// Home-screen widget snapshot (iOS). The WidgetKit extension can't decrypt
// records or reach the server — it renders ONLY what the app hands it. After
// any calendar change (and on foreground / background sync), the app expands
// the next WINDOW_DAYS of the calendar through the SAME pipeline the day view
// renders with (itemsForDate → visibility filter → normalizeDay, holidays
// included) and writes the result — titles, times, colours, nothing else — to
// the App Group container via modules/calen-widget.
//
// WINDOW_DAYS is the widget's freshness contract: the widget walks the
// snapshot forward day by day on its own (WidgetKit timeline entries at each
// local midnight), so the display stays correct for WINDOW_DAYS without the
// app ever running. Fourteen days means a user who opens the app once a week
// keeps a full week of margin; the silent-push and background-fetch sync lanes
// rewrite it opportunistically in between. A day beyond the snapshot's
// endDate is rendered by the widget as "Open Calen to update", never as a
// silently empty day.

import { itemsForDate, visibleDayItems, ymd } from './calendar';
import { addDays, normalizeDay } from '../screens/calendar/dayview/dayViewLayout';
import type { EventStatus } from './callStatus';
import { loadCalendarData } from './calendarData';
import {
  getCalendarColorMap,
  getCalendarVisibility,
  getHolidayCalendars,
  holidayEnabledIds,
} from './calendarPrefs';
import { getHolidays } from './holidays';
import { isUnlocked } from './e2ee';
// TEMP DEBUG (remove after device verification): breadcrumb file readable via
// devicectl from the app's Documents container.
import * as FileSystem from 'expo-file-system/legacy';
import {
  clearWidgetSnapshotFile,
  reloadWidgetTimelines,
  setWidgetSnapshotJson,
  widgetBridgeAvailable,
  widgetSnapshotDebug,
} from '../../modules/calen-widget';

export const WINDOW_DAYS = 14;
export const SNAPSHOT_VERSION = 1;

// One rendered row. `startMin`/`endMin` are minutes from that day's local
// midnight — the same clipped values the day view positions blocks with — so
// the widget formats times with zero date math of its own.
// Data minimization: the snapshot carries ONLY what the widget draws — titles,
// clipped times, colours, a struck flag. No ids, descriptions, locations, or
// invitees ever reach the App Group file.
export interface WidgetTimedRow {
  title: string;
  color: string;
  startMin: number;
  endMin: number;
  struck?: boolean;
}

export interface WidgetAllDayRow {
  title: string;
  color: string;
  kind: string;
  struck?: boolean;
}

export interface WidgetDay {
  date: string; // yyyy-MM-dd, device-local
  allDay: WidgetAllDayRow[];
  timed: WidgetTimedRow[];
}

export interface WidgetSnapshot {
  version: number;
  generatedAt: string;
  startDate: string;
  endDate: string;
  days: WidgetDay[];
}

// The widget shows post-call cancellations only via the record's own
// `cancelled` flag; the live AI-call overlay (['calls'] query) is a
// foreground-session concern the snapshot doesn't reach for.
const NO_CALL_STATUS: EventStatus = {
  isCancelled: () => false,
  isReschedulePending: () => false,
};

// Pure assembly over already-loaded inputs — exported for tests.
export function buildWidgetSnapshot(input: {
  data: Parameters<typeof itemsForDate>[0];
  visibility: Record<string, boolean>;
  calColors: Record<string, string>;
  holidaysByDate: Record<string, { id: string; name: string; color: string }[]>;
  startDate: string;
  now: Date;
}): WidgetSnapshot {
  const { data, visibility, calColors, holidaysByDate, startDate, now } = input;
  const visible = (id: string) => visibility[id] !== false;
  const days: WidgetDay[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = addDays(startDate, i);
    const items = visibleDayItems(itemsForDate(data, d), visible);
    const { allDay, timed } = normalizeDay(items, holidaysByDate[d] ?? [], d, calColors, NO_CALL_STATUS);
    days.push({
      date: d,
      allDay: allDay.map((a) => ({
        title: a.title,
        color: a.color,
        kind: a.kind,
        ...(a.strike ? { struck: true } : null),
      })),
      timed: timed
        .slice()
        .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
        .map((t) => ({
          title: t.title,
          color: t.color,
          startMin: t.startMin,
          endMin: t.endMin,
          ...(t.strike ? { struck: true } : null),
        })),
    });
  }
  return {
    version: SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    startDate,
    endDate: days[days.length - 1].date,
    days,
  };
}

// TEMP DEBUG (remove after device verification)
async function debugLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const path = (FileSystem.documentDirectory ?? '') + 'widget-debug.json';
    let prev: unknown[] = [];
    try {
      prev = JSON.parse(await FileSystem.readAsStringAsync(path));
    } catch {}
    prev.push({ at: new Date().toISOString(), ...entry });
    await FileSystem.writeAsStringAsync(path, JSON.stringify(prev.slice(-40)));
  } catch {}
}

// Load + expand the next WINDOW_DAYS through the day-view pipeline and return
// the snapshot object. Shared by the App Group writer below and the widget
// promo screen's in-app preview (which renders the same data the widget would
// show, without needing the native bridge). Null while the vault is locked —
// nothing can be decrypted.
export async function computeWidgetSnapshot(): Promise<WidgetSnapshot | null> {
  if (!isUnlocked()) return null;

  // The window opens at today's local date, not "now" — the widget shows the
  // whole current day (finished events struck by time, not dropped by us).
  const now = new Date();
  const startDate = ymd(now);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + WINDOW_DAYS * 86400000);

  const data = await loadCalendarData({ from: from.toISOString(), to: to.toISOString() });
  const [visibility, calColors, holidayCals] = await Promise.all([
    getCalendarVisibility(),
    getCalendarColorMap(),
    getHolidayCalendars(),
  ]);

  // Holidays per date, mirroring the agenda view: visible holiday calendars
  // only, user colour overrides winning over the calendar's own colour.
  const holidaysByDate: Record<string, { id: string; name: string; color: string }[]> = {};
  for (const cal of holidayCals) {
    if (visibility[cal.id] === false) continue;
    const color = calColors[cal.id] ?? cal.color;
    for (const h of getHolidays(cal.country, new Date(startDate + 'T12:00:00'), new Date(addDays(startDate, WINDOW_DAYS - 1) + 'T12:00:00'), holidayEnabledIds(cal))) {
      (holidaysByDate[h.date] ??= []).push({ id: `${cal.id}-${h.id}`, name: h.name, color });
    }
  }

  return buildWidgetSnapshot({ data, visibility, calColors, holidaysByDate, startDate, now });
}

async function runRefresh(): Promise<void> {
  await debugLog({ stage: 'start', bridge: widgetBridgeAvailable(), unlocked: isUnlocked() });
  // No bridge (Expo Go / Android / tests) — skip the whole expand pass.
  if (!widgetBridgeAvailable()) return;
  // Locked vault: computeWidgetSnapshot returns null. Leave the LAST snapshot
  // standing — it is the same signed-in user's data, and a
  // relaunch-before-unlock must not blank their widget. Sign-out clears
  // explicitly via clearWidgetData.
  const snapshot = await computeWidgetSnapshot();
  if (!snapshot) return;
  await debugLog({ stage: 'built', days: snapshot.days.length, today: snapshot.days[0] });
  await setWidgetSnapshotJson(JSON.stringify(snapshot));
  await reloadWidgetTimelines();
  await debugLog({ stage: 'written', native: await widgetSnapshotDebug().catch((e) => String(e)) });
}

// Single-flight, like rescheduleReminders: the mount / foreground / data-change
// triggers overlap routinely, and a caller arriving mid-pass joins the one
// already running. Errors are swallowed — offline or a mid-teardown read just
// leaves the previous snapshot in place, and the next trigger retries.
let inFlight: Promise<void> | null = null;

export function refreshWidgetSnapshot(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runRefresh()
    // TEMP DEBUG: record instead of a bare swallow (remove after verification).
    .catch((e) => debugLog({ stage: 'error', error: String((e as Error)?.message ?? e) }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Sign-out / household-change teardown: the snapshot is the OLD account's (or
// old household's) decrypted data and must not outlive it on the home screen.
export async function clearWidgetData(): Promise<void> {
  if (!widgetBridgeAvailable()) return;
  try {
    await clearWidgetSnapshotFile();
    await reloadWidgetTimelines();
  } catch {
    // Best-effort — a failed clear is retried implicitly by the next refresh.
  }
}
