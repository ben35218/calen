import { CalendarData, CalendarEvent, CalendarOccasion, Task, Chore } from '../api';

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
