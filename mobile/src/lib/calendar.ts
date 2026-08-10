import { CalendarData, CalendarEvent, CalendarOccasion, Task, Chore } from '../api';
import { formatDuration } from './format';

// Default calendar category colors (mirrors CalendarView's `calendars`).
export const CALENDAR_COLORS: Record<string, string> = {
  maintenance: '#1976D2',
  activities: '#388E3C',
  appointments: '#1976D2',
  chores: '#F57C00',
  recipes: '#00897B',
  trips: '#5E35B1',
  birthdays: '#E91E63',
  'canadian-holidays': '#D32F2F',
};

// Glyphs (MaterialCommunityIcons) for the calendar concepts that appear on more
// than one surface. One constant per concept so a meal looks like a meal on the
// month grid, in the list and day views, in search, and on the meal planner —
// four screens that each used to spell the name out.
export const RECIPE_ICON = 'silverware-fork-knife';
export const GROCERY_ICON = 'cart';

// User colour overrides (loaded/persisted by calendarPrefs). `colorOf` resolves
// the effective colour for a calendar id so chips/bars/icons reflect overrides.
let colorOverrides: Record<string, string> = {};
export function applyCalendarColorOverrides(o: Record<string, string>) {
  colorOverrides = o || {};
}
export function colorOf(id: string): string {
  return colorOverrides[id] ?? CALENDAR_COLORS[id] ?? '#9E9E9E';
}

export const EVENT_CALENDAR_TYPES = [
  { label: 'Activities', value: 'activities' },
  { label: 'Appointments', value: 'appointments' },
];

export function eventColor(e: CalendarEvent): string {
  return colorOf(e.calendarType);
}

// Whether the event form opens with the cursor in its Title field. A blank
// New Event does — the title is the one thing every event needs, so the
// keyboard should already be up. An edit does not (the title is written), and
// neither does a create the assistant prefilled ("Edit in form"), where the
// user is reviewing filled fields rather than typing a title.
export function shouldAutoFocusTitle(p: { eventId?: string; prefill?: unknown }): boolean {
  return !p.eventId && !p.prefill;
}

// yyyy-MM-dd in the device's local timezone (uses local calendar components,
// so it never rolls over to the next UTC day the way toISOString() does).
export function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Date portion of a stored date-only / all-day record. These are stored at
// noon UTC (see EventFormScreen), so the calendar date is timezone-stable and
// reading it in UTC is correct — do NOT convert to local here or west-of-UTC
// users would see the date shift back a day.
function localDate(d: string): string {
  return new Date(d).toISOString().slice(0, 10);
}

// Date an event lands on. All-day events are timezone-stable (noon UTC), but
// timed events are real instants and must be read in the device's local zone.
function eventDate(e: CalendarEvent, iso: string): string {
  return e.allDay ? localDate(iso) : ymd(new Date(iso));
}

// ── Event form ⇄ stored instants ────────────────────────────────────────────
// The two directions below are exact inverses, and every event form goes
// through them so a load→save round-trip is a fixed point.
//
// The rule they encode: an **all-day** event stores its endpoints at noon UTC,
// so its calendar date is timezone-stable and MUST be read in UTC. A **timed**
// event stores real instants, so its date and its clock time must BOTH be read
// in the device's local zone. Mixing the two — reading a timed event's clock
// locally but slicing its date off the UTC string — is what walks a late-
// evening event forward one day per edit west of UTC, where 11:05pm on Aug 3
// is already Aug 4 in UTC.

export interface EventWhen {
  allDay: boolean;
  date: string; // yyyy-MM-dd, local for timed events
  startTime: string; // HH:MM, ignored when allDay
  endDate: string; // yyyy-MM-dd; '' means "same day as `date`"
  endTime: string; // HH:MM, ignored when allDay
}

type StoredWhen = { startDate: string; endDate?: string | null; allDay?: boolean };

// Stored instants → the event form's date/time fields.
export function eventWhenFromStored(e: StoredWhen): EventWhen {
  const allDay = e.allDay ?? true;
  const start = new Date(e.startDate);
  const end = e.endDate ? new Date(e.endDate) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = allDay ? localDate(e.startDate) : ymd(start);
  const endDay = end ? (allDay ? localDate(String(e.endDate)) : ymd(end)) : '';
  return {
    allDay,
    date,
    // A same-day end stays unset — the invariant the End date row and the
    // start/end drag helpers assume.
    endDate: endDay && endDay !== date ? endDay : '',
    startTime: allDay ? '09:00' : `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    endTime: end && !allDay ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : '10:00',
  };
}

// The event form's date/time fields → the instants the API stores.
export function eventStoredFromWhen(w: EventWhen): { startDate: string; endDate?: string } {
  if (w.allDay) {
    return {
      startDate: `${w.date}T12:00:00.000Z`,
      endDate: w.endDate ? `${w.endDate}T12:00:00.000Z` : undefined,
    };
  }
  const endPart = w.endDate || w.date;
  return {
    startDate: new Date(`${w.date}T${w.startTime}:00`).toISOString(),
    endDate: w.endTime ? new Date(`${endPart}T${w.endTime}:00`).toISOString() : undefined,
  };
}

// ── Event alerts ────────────────────────────────────────────────────────────
// An event alert is stored as `reminderMinutes` — minutes before the event's
// ALERT ANCHOR, which is not always the instant the record stores.
//
// A timed event's anchor is its start. An **all-day** event has no start time:
// it stores both endpoints at noon UTC (above), so counting minutes back from
// the stored value put every alert at whatever local hour the reader's UTC
// offset happened to produce — "1 day before" fired at 5am in Los Angeles, 8am
// in New York and 2pm in Berlin — and a "15 min before" alert described a
// minute the event never had. So an all-day event's anchor is its own calendar
// day at the user's day-alert time (Profile → Reminders `dayAlertTime`, 9am
// unless changed): the same hour task, chore, occasion and holiday day-alerts
// fire at. Its offsets are consequently whole days — 0 = the day itself at that
// hour, 1440 = the day before at that hour — and the pickers offer only those.
// The stored field stays minutes-before for both kinds, so nothing about the
// record, the API or the seal changes with the event's all-day switch.

export const DEFAULT_DAY_ALERT_TIME = '09:00';
const MIN_PER_DAY = 1440;

// Whole-day offsets offered on an all-day event, as minutes-before.
export const ALL_DAY_ALERT_OFFSETS = [0, MIN_PER_DAY, 2 * MIN_PER_DAY, 7 * MIN_PER_DAY];

// `HH:mm` → local hour/minute, falling back to 9am when unset or malformed.
export function parseDayAlertTime(time?: string | null): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
  if (!m) return { hour: 9, minute: 0 };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : { hour: 9, minute: 0 };
}

// "09:00" → "9:00 AM", for the alert labels that name the hour they fire at.
export function dayAlertClock(time?: string | null): string {
  const { hour, minute } = parseDayAlertTime(time);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// The instant an event's alerts count back from (see the note above).
export function eventAlertAnchor(
  e: { startDate: string; allDay?: boolean },
  dayAlertTime?: string | null,
): Date {
  if (!e.allDay) return new Date(e.startDate);
  const { hour, minute } = parseDayAlertTime(dayAlertTime);
  const [y, m, d] = localDate(e.startDate).split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}

// An existing minutes-before value moved onto the all-day grid: a sub-day
// offset collapses onto the day itself (there is no hour left to count back
// from), a longer one keeps its whole-day count.
export function snapAlertToWholeDays(minutes?: number | null): number | null {
  if (minutes == null) return null;
  if (minutes < MIN_PER_DAY) return 0;
  return Math.round(minutes / MIN_PER_DAY) * MIN_PER_DAY;
}

// Both alert slots re-based for a change to the All-day switch. Switching it
// OFF changes nothing — every whole-day offset is a legal timed offset too.
// Switching it ON snaps both, so an already-configured alert is carried onto
// the day grid rather than silently left describing a time the event no longer
// has; the second alert drops when it collapses onto the first, since the two
// must stay distinct (a duplicate would fire the same notification twice).
//
// Both branches return a FRESH two-key object, never the argument itself:
// callers spread the result over a form patch, and a wider object handed in
// (the whole form) would otherwise spread its own `allDay` back on top of the
// switch's new value and pin the event to all-day.
export function alertsForAllDay(
  allDay: boolean,
  alerts: { reminderMinutes: number | null; alert2Minutes: number | null },
): { reminderMinutes: number | null; alert2Minutes: number | null } {
  if (!allDay) {
    return { reminderMinutes: alerts.reminderMinutes, alert2Minutes: alerts.alert2Minutes };
  }
  const reminderMinutes = snapAlertToWholeDays(alerts.reminderMinutes);
  const snapped2 = snapAlertToWholeDays(alerts.alert2Minutes);
  return {
    reminderMinutes,
    alert2Minutes: reminderMinutes == null || snapped2 === reminderMinutes ? null : snapped2,
  };
}

// The second alert is only ever the SECOND one: clearing the first promotes it
// into that slot rather than leaving it set behind a row the form no longer
// shows (the Second Alert field renders only while a first alert exists). Set
// two alerts, then clear the first, and the survivor is the one the user still
// wants — hiding it while keeping it set means an alert they can't see or edit,
// and dropping it silently discards a setting they never withdrew.
//
// Returns a FRESH four-key object every time, never the argument — same reason
// as `alertsForAllDay`: callers spread it over a form patch, and a wider object
// handed in would spread its own stale fields back on top.
export function promoteSecondAlert(alerts: {
  reminderMinutes: number | null;
  alert2Minutes: number | null;
  alertAnchor?: AlertAnchor | null;
  alert2Anchor?: AlertAnchor | null;
}): {
  reminderMinutes: number | null;
  alert2Minutes: number | null;
  alertAnchor: AlertAnchor;
  alert2Anchor: AlertAnchor;
} {
  const alertAnchor = alerts.alertAnchor ?? 'event';
  const alert2Anchor = alerts.alert2Anchor ?? 'event';
  if (alerts.reminderMinutes != null || alerts.alert2Minutes == null) {
    return {
      reminderMinutes: alerts.reminderMinutes,
      alert2Minutes: alerts.alert2Minutes,
      alertAnchor,
      alert2Anchor,
    };
  }
  // The survivor keeps its own framing as it moves up (see the anchor note).
  return {
    reminderMinutes: alerts.alert2Minutes,
    alert2Minutes: null,
    alertAnchor: alert2Anchor,
    alert2Anchor: 'event',
  };
}

// An all-day event's alert as the picker and the detail view word it, naming
// the hour it fires at: "On the day (9:00 AM)", "1 day before (9:00 AM)". A
// value off the day grid — set before all-day alerts were day-based, or by an
// older client — has no day wording, so it keeps the timed phrasing.
export function allDayAlertLabel(minutes: number, dayAlertTime?: string | null): string {
  if (minutes <= 0) return `On the day (${dayAlertClock(dayAlertTime)})`;
  if (minutes % MIN_PER_DAY !== 0) return `${formatDuration(minutes)} before`;
  const days = minutes / MIN_PER_DAY;
  const base =
    days % 7 === 0
      ? `${days / 7} week${days === 7 ? '' : 's'} before`
      : `${days} day${days === 1 ? '' : 's'} before`;
  return `${base} (${dayAlertClock(dayAlertTime)})`;
}

// ── Departure-anchored alerts ───────────────────────────────────────────────
// A timed event with a drive time can hang its alert off DEPARTURE instead of
// off the start: "30 min before leaving" fires half an hour before the user has
// to set off. The stored field is still `reminderMinutes` — minutes before the
// event — so scheduling, the record and the seal are untouched; `alertAnchor`
// records only which of the two framings the user actually chose.
//
// That flag is load-bearing because both framings can name the same instant:
// with a 23-minute drive, "2 hours before" and "1 hr 37 min before leaving" are
// the same alert. Inferring the framing from the number alone (what this used to
// do — any value at or past the drive time was re-worded as departure-relative)
// silently re-read a plain "2 hours before" as a departure countdown, so the
// picker showed back a setting the user never made.
export type AlertAnchor = 'event' | 'leave';

// Canned departure-relative rows, as minutes before leaving. 0 = "Time to leave".
export const LEAVE_ALERT_BUFFERS = [0, 5, 10, 15, 30];

// Departure anchoring exists only on a timed event whose drive time is known —
// an all-day event has no start to subtract the drive from, and with no drive
// time there is no departure to count back from.
export function canLeaveAnchor(allDay?: boolean, travelMinutes?: number | null): boolean {
  return !allDay && !!travelMinutes;
}

// The anchor an alert can honour as the event stands now. Turning the event
// all-day, or dropping its drive time, leaves the stored minutes-before-event
// exactly as they are but takes the departure wording away with them.
export function effectiveAlertAnchor(
  anchor: AlertAnchor | null | undefined,
  allDay?: boolean,
  travelMinutes?: number | null,
): AlertAnchor {
  return anchor === 'leave' && canLeaveAnchor(allDay, travelMinutes) ? 'leave' : 'event';
}

// Minutes before DEPARTURE for a leave-anchored alert — the buffer the user set.
export function leaveAlertBuffer(minutes: number, travelMinutes: number): number {
  return Math.max(0, minutes - travelMinutes);
}

// The stored minutes-before-event for "`buffer` minutes before leaving".
export function leaveAlertMinutes(buffer: number, travelMinutes: number): number {
  return travelMinutes + Math.max(0, buffer);
}

// The anchor for an event saved before the flag existed. Only the canned
// departure rows are recognised, so events set from those keep reading the way
// they always have, while every other value reads as what it literally is —
// minutes before the event.
export function inferAlertAnchor(
  minutes: number | null | undefined,
  allDay?: boolean,
  travelMinutes?: number | null,
): AlertAnchor {
  if (minutes == null || !canLeaveAnchor(allDay, travelMinutes)) return 'event';
  return LEAVE_ALERT_BUFFERS.some((b) => minutes === travelMinutes! + b) ? 'leave' : 'event';
}

// How a TIMED event's alert reads, in the picker and on the detail view.
// `leaveByTime` (e.g. "8:37 AM") names the departure clock time on the
// "Time to leave" row when it is known.
export function timedAlertLabel(
  minutes: number,
  anchor: AlertAnchor,
  travelMinutes?: number | null,
  leaveByTime?: string | null,
): string {
  if (anchor === 'leave' && travelMinutes) {
    const buffer = leaveAlertBuffer(minutes, travelMinutes);
    if (buffer === 0) return leaveByTime ? `Time to leave (${leaveByTime})` : 'Time to leave';
    return `${formatDuration(buffer)} before leaving`;
  }
  if (minutes <= 0) return 'At time of event';
  return `${formatDuration(minutes)} before`;
}

// A leave-anchored alert keeps its distance from DEPARTURE when the drive time
// changes: "30 min before leaving" means 30 minutes before the NEW departure, so
// the stored minutes-before-event move with the drive. An event-anchored alert
// never moves. Returns the (possibly unchanged) minutes-before-event.
export function rebaseLeaveAlert(
  minutes: number | null,
  anchor: AlertAnchor,
  prevTravelMinutes: number | null | undefined,
  nextTravelMinutes: number | null | undefined,
): number | null {
  if (minutes == null || anchor !== 'leave' || !prevTravelMinutes || !nextTravelMinutes) return minutes;
  return leaveAlertMinutes(leaveAlertBuffer(minutes, prevTravelMinutes), nextTravelMinutes);
}

// ── Occurrence anchoring ────────────────────────────────────────────────────
// A repeating event is ONE stored record whose `startDate` is the series' first
// day, but the user opens it from a calendar cell — the occurrence they tapped.
// The form must show that occurrence's date (Apple does), so the three helpers
// below move a when-block between the two frames:
//
//   seriesWhen --shift(+n)--> the occurrence the form displays
//   formWhen   --shift(-n)--> back to the series frame, for a whole-series save
//
// Getting this wrong is not cosmetic: without the shift the form shows the
// wrong day, and without the inverse a plain save drags the entire series onto
// the occurrence the user happened to open.

// Whole days from `a` to `b` (both yyyy-MM-dd). Both are read at local noon, so
// a DST boundary between them can't round the difference to 0 or 2.
export function daysBetween(a: string, b: string): number {
  const at = new Date(`${a}T12:00:00`).getTime();
  const bt = new Date(`${b}T12:00:00`).getTime();
  return Math.round((bt - at) / 86400000);
}

// yyyy-MM-dd `days` after `day` (negative goes back). Local noon again, and the
// result is read with local components so it never lands on the wrong UTC day.
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

// Move a form's when-block by whole days, preserving both clock times and the
// start→end span. An empty `endDate` means "same day as the start" — it stays
// empty, since the span is unchanged by a shift.
export function shiftEventWhen(w: EventWhen, days: number): EventWhen {
  if (!days) return w;
  return {
    ...w,
    date: addDays(w.date, days),
    endDate: w.endDate ? addDays(w.endDate, days) : '',
  };
}

// How far the tapped occurrence sits from the series' own start. 0 when the
// event doesn't repeat (the occurrence IS the series), when no occurrence day
// was passed (opened from search), or when they're the same day.
export function occurrenceShiftDays(
  seriesWhen: EventWhen,
  occurrenceDate: string | undefined,
  recurring: boolean,
): number {
  if (!recurring || !occurrenceDate || occurrenceDate === seriesWhen.date) return 0;
  return daysBetween(seriesWhen.date, occurrenceDate);
}

export interface DayItems {
  events: CalendarEvent[];
  tasks: Task[];
  chores: Chore[];
  recipes: { title: string; recipeId?: string }[];
  trips: { id: string; name: string; color: string; status?: string }[];
  occasions: CalendarOccasion[];
  grocery: boolean;
}

// All calendar records that touch a given yyyy-MM-dd date.
export function itemsForDate(data: CalendarData | undefined, dateStr: string): DayItems {
  if (!data) {
    return { events: [], tasks: [], chores: [], recipes: [], trips: [], occasions: [], grocery: false };
  }

  const events = (data.events ?? []).filter((e) => {
    const start = eventDate(e, e.startDate);
    const end = e.endDate ? eventDate(e, e.endDate) : start;
    return dateStr >= start && dateStr <= end;
  });

  const tasks = (data.tasks ?? []).filter((t) => t.nextDueDate && localDate(t.nextDueDate) === dateStr);
  const chores = (data.chores ?? []).filter((c) => c.nextDueDate && localDate(c.nextDueDate) === dateStr);

  const recipes = (data.recipes ?? [])
    .filter((r) => localDate(r.scheduledDate) === dateStr)
    .map((r) => ({
      title: typeof r.recipeId === 'object' ? r.recipeId?.title || 'Recipe' : 'Recipe',
      recipeId: typeof r.recipeId === 'object' ? r.recipeId?._id : (r.recipeId as string | undefined),
    }));

  const trips = (data.trips ?? [])
    .filter((t) => (t.ranges ?? []).some((r) => dateStr >= localDate(r.start) && dateStr <= localDate(r.end)))
    .map((t) => ({ id: t.id, name: t.name, color: t.color || colorOf('trips'), status: t.status }));

  const occasions = (data.occasions ?? []).filter((o) => localDate(o.date) === dateStr);

  const grocery = (data.groceryShopping ?? []).some((g) => g.date === dateStr);

  return { events, tasks, chores, recipes, trips, occasions, grocery };
}

// Up-to-`max` dot colors for a day cell.
export function dayDots(data: CalendarData | undefined, dateStr: string, max = 4): string[] {
  const d = itemsForDate(data, dateStr);
  const dots: string[] = [];
  d.trips.forEach((t) => dots.push(t.color));
  d.events.forEach((e) => dots.push(eventColor(e)));
  if (d.tasks.length) dots.push(CALENDAR_COLORS.maintenance);
  if (d.chores.length) dots.push(CALENDAR_COLORS.chores);
  if (d.recipes.length) dots.push(CALENDAR_COLORS.recipes);
  if (d.occasions.length) dots.push(CALENDAR_COLORS.birthdays);
  return dots.slice(0, max);
}

// One scheduled meal on a calendar cell — just enough to route the meal icon.
export type RecipeCell = { recipeId?: string };

// Where the month grid's meal icon leads: straight to the recipe when the day
// has a single scheduled meal (with a known recipe), otherwise the day view so
// the user can pick from several — mirroring the task icon's aggregate tap.
export type RecipeIconTarget =
  | { screen: 'RecipeDetail'; params: { id: string } }
  | { screen: 'CalendarDay'; params: { date: string } };
export function recipeIconTarget(recipes: RecipeCell[], date: string): RecipeIconTarget {
  const only = recipes.length === 1 ? recipes[0].recipeId : undefined;
  return only
    ? { screen: 'RecipeDetail', params: { id: only } }
    : { screen: 'CalendarDay', params: { date } };
}

// Multi-day spanning bars (trips + multi-day events) for one week row. Each bar
// is lane-packed so overlapping spans stack. Mirrors the web's trip/event bars.
export interface WeekBar {
  key: string;
  color: string;
  label: string;
  startCol: number;
  endCol: number;
  lane: number;
  tripId?: string; // set for trip bars so tapping one opens the trip
  eventId?: string; // set for multi-day event bars so tapping one opens the event
}

export function weekBars(data: CalendarData | undefined, weekDates: string[], maxLanes = 2): WeekBar[] {
  if (!data || weekDates.length !== 7) return [];
  const weekStart = weekDates[0];
  const weekEnd = weekDates[6];
  const colOf = (dateStr: string) => {
    if (dateStr < weekStart) return 0;
    if (dateStr > weekEnd) return 6;
    return weekDates.indexOf(dateStr);
  };

  const spans: { color: string; label: string; start: string; end: string; tripId?: string; eventId?: string }[] = [];
  for (const t of data.trips ?? []) {
    for (const r of t.ranges ?? []) {
      const s = localDate(r.start);
      const e = localDate(r.end);
      if (e >= weekStart && s <= weekEnd) spans.push({ color: t.color || colorOf('trips'), label: t.name, start: s, end: e, tripId: t.id });
    }
  }
  for (const ev of data.events ?? []) {
    const s = eventDate(ev, ev.startDate);
    const e = ev.endDate ? eventDate(ev, ev.endDate) : s;
    if (e > s && e >= weekStart && s <= weekEnd) spans.push({ color: eventColor(ev), label: ev.title, start: s, end: e, eventId: ev._id });
  }

  spans.sort((a, b) => (a.start < b.start ? -1 : 1));
  const laneEnds: number[] = [];
  const bars: WeekBar[] = [];
  for (const sp of spans) {
    const startCol = colOf(sp.start);
    const endCol = colOf(sp.end);
    let lane = laneEnds.findIndex((end) => startCol > end);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(endCol); }
    else laneEnds[lane] = endCol;
    if (lane < maxLanes) bars.push({ key: `${sp.label}-${sp.start}-${lane}`, color: sp.color, label: sp.label, startCol, endCol, lane, tripId: sp.tripId, eventId: sp.eventId });
  }
  return bars;
}

// Build a calendar month grid (6 weeks, Sunday-first) of yyyy-MM-dd cells.
export interface MonthGrid {
  key: string;
  label: string;
  weeks: { date: string; day: number; currentMonth: boolean; isToday: boolean }[][];
}

export function buildMonth(year: number, month: number): MonthGrid {
  const first = new Date(year, month, 1);
  const todayStr = ymd(new Date());
  const startOffset = first.getDay(); // 0=Sun
  const gridStart = new Date(year, month, 1 - startOffset);

  const cells: MonthGrid['weeks'][number] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const dateStr = ymd(d);
    cells.push({
      date: dateStr,
      day: d.getDate(),
      currentMonth: d.getMonth() === month,
      isToday: dateStr === todayStr,
    });
  }

  const weeks: MonthGrid['weeks'] = [];
  for (let w = 0; w < 6; w++) weeks.push(cells.slice(w * 7, w * 7 + 7));

  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    label: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    weeks,
  };
}
