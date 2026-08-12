import { CalendarEvent, CalendarOccasion } from '../../../api';
import { DayItems, GROCERY_ICON, RECIPE_ICON, eventColor, ymd } from '../../../lib/calendar';
import { formatDuration } from '../../../lib/format';
import { occasionTitle, occasionIcon } from '../../../lib/occasions';
import type { EventStatus } from '../../../lib/callStatus';

// Pure layout logic for the Apple-style day view (no JSX, unit-testable):
// routing day items into the all-day row vs. timed hour-grid blocks, greedy
// lane-packing for overlaps (ported from TripTimeline), week-strip paging math,
// and the initial scroll target. All vertical math is 1px = 1min over a fixed
// 0–1440 day, so the grid is the same height every day.

export const PX_PER_MIN = 1;
export const HOUR_H = 60 * PX_PER_MIN;
export const GUTTER = 48; // left hour-label gutter
export const MIN_BLOCK = 30; // minimum rendered height (= 30 min) so titles fit
export const DAY_MIN = 24 * 60;

// The week strip pages over a fixed window of weeks centred on today, so its
// FlatList gets stable indices/offsets (getItemLayout) in both directions.
export const WEEK_WINDOW = 78; // weeks before/after today's week
export const WEEK_COUNT = WEEK_WINDOW * 2 + 1;

export type TimedBlock = {
  key: string;
  title: string;
  location?: string;
  color: string;
  startMin: number;
  endMin: number;
  eventId: string;
  // Set only when the event carries a drive time, so the block can mark that
  // its start already has travel factored in (see `blockDetail`).
  travelMinutes?: number;
  faded?: boolean;
  strike?: boolean;
};

export type LaidBlock = TimedBlock & {
  // `top`/`height` cover the block's whole occupied span — the travel lead-in
  // included, since the drive holds that time as surely as the event does.
  top: number;
  height: number;
  // Px of leading travel band inside that span (0 without a drive time). The
  // event's own body is `height - travelHeight`.
  travelHeight: number;
  leftFrac: number;
  widthFrac: number;
};

export type AllDayItem = {
  key: string;
  title: string;
  color: string;
  kind: 'event' | 'trip' | 'holiday' | 'occasion' | 'task' | 'chore' | 'recipe' | 'grocery';
  // Detail-navigation id for the kind (eventId / tripId / taskId / choreId /
  // recipeId; occasions carry the contactId); holidays and grocery have no
  // detail target.
  id?: string;
  // The full occasion for kind 'occasion', so a tap can focus it in the list.
  occasion?: CalendarOccasion;
  // Tasks are date-only reminders, not scheduled blocks — rendered muted with
  // an empty-circle glyph (Apple's reminder look).
  muted?: boolean;
  // Optional leading MaterialCommunityIcons glyph (an `mdi-…` string or a bare
  // glyph name), rendered tinted in the item's colour instead of a muted dot /
  // plain colour bar: chores carry their per-chore icon, occasions their kind
  // icon, and events a generic calendar glyph.
  icon?: string;
  faded?: boolean;
  strike?: boolean;
};

export type DayLayout = { allDay: AllDayItem[]; blocks: LaidBlock[] };

// Generic calendar glyph (MaterialCommunityIcons) for a plain event, so events
// read as calendar items alongside the icon-badged chores/occasions.
export const EVENT_ICON = 'calendar-blank-outline';


const pad = (n: number) => String(n).padStart(2, '0');

// Local-midnight Date for a yyyy-MM-dd string.
function localMidnight(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}

// Minutes from `dateStr`'s local midnight to the instant `iso` (may be
// negative / beyond 1440 when the instant falls on another day).
export function minutesInto(dateStr: string, iso: string): number {
  return Math.round((+new Date(iso) - +localMidnight(dateStr)) / 60000);
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// Whole days between two yyyy-MM-dd strings (b − a). Noon-anchored so a DST
// hour never rounds a boundary the wrong way.
export function diffDays(a: string, b: string): number {
  return Math.round((+new Date(b + 'T12:00:00') - +new Date(a + 'T12:00:00')) / 86400000);
}

// ── All-day vs. timed routing ───────────────────────────────────────────────

// Re-exported from callStatus so the layout + its consumers share one shape.
export type { EventStatus };

// Split one day's records into the all-day row and clipped timed blocks.
// `holidays` come pre-resolved (id/name/color) exactly as the old day screen
// assembled them; `calColors` is useCalendarColors()' effective map.
export function normalizeDay(
  day: DayItems,
  holidays: { id: string; name: string; color: string }[],
  dateStr: string,
  calColors: Record<string, string>,
  status: EventStatus
): { allDay: AllDayItem[]; timed: TimedBlock[] } {
  const allDay: AllDayItem[] = [];
  const timed: TimedBlock[] = [];

  for (const t of day.trips) {
    allDay.push({ key: `trip-${t.id}`, title: t.name, color: t.color, kind: 'trip', id: t.id });
  }
  for (const h of holidays) {
    allDay.push({ key: `hol-${h.id}`, title: h.name, color: h.color, kind: 'holiday' });
  }
  for (const o of day.occasions) {
    allDay.push({ key: `occ-${o.id}`, title: occasionTitle(o), color: calColors.birthdays, kind: 'occasion', id: o.contactId, occasion: o, icon: occasionIcon(o.kind) });
  }

  for (const e of day.events) {
    const faded = Boolean(e.cancelled) || status.isCancelled(e._id, dateStr) || status.isReschedulePending(e._id, dateStr);
    const strike = Boolean(e.cancelled) || status.isCancelled(e._id, dateStr);
    const rawStart = e.allDay ? 0 : minutesInto(dateStr, e.startDate);
    const rawEnd = e.allDay ? DAY_MIN : e.endDate ? minutesInto(dateStr, e.endDate) : rawStart + 60;
    // All-day events — and timed events covering this entire day (a multi-day
    // timed span's middle days) — live in the all-day row, like Apple.
    if (e.allDay || (rawStart <= 0 && rawEnd >= DAY_MIN)) {
      allDay.push({ key: e._id, title: e.title, color: eventColor(e), kind: 'event', id: e._id, icon: EVENT_ICON, faded, strike });
      continue;
    }
    // Clip to this column's day; events touching neighbouring days yield one
    // clipped segment per day column (itemsForDate returns every toucher).
    if (rawEnd <= 0 || rawStart >= DAY_MIN) continue;
    const startMin = Math.max(0, rawStart);
    const endMin = Math.max(Math.min(DAY_MIN, rawEnd), startMin + MIN_BLOCK);
    timed.push({
      key: e._id,
      title: e.title,
      location: e.location,
      color: eventColor(e),
      startMin,
      endMin: Math.min(endMin, DAY_MIN),
      eventId: e._id,
      ...(e.travelMinutes ? { travelMinutes: e.travelMinutes } : null),
      faded,
      strike,
    });
  }

  // Date-only reminders (no time of day) — muted all-day chips.
  for (const t of day.tasks) {
    allDay.push({ key: `task-${t._id}`, title: t.title, color: calColors.maintenance, kind: 'task', id: t._id, muted: true });
  }
  // Chores are Chores-calendar items: tinted in the calendar colour and badged
  // with their own icon (not a muted reminder dot).
  for (const c of day.chores) {
    allDay.push({ key: `chore-${c._id}`, title: c.title, color: calColors.chores, kind: 'chore', id: c._id, icon: c.icon });
  }
  // Meals and the shopping day carry the same glyphs the month grid and the list
  // view use for them, so a recipe reads as a recipe in every calendar surface.
  for (let i = 0; i < day.recipes.length; i++) {
    const r = day.recipes[i];
    allDay.push({ key: `recipe-${i}-${r.recipeId ?? r.title}`, title: r.title, color: calColors.recipes, kind: 'recipe', id: r.recipeId, icon: RECIPE_ICON });
  }
  if (day.grocery) {
    // The Meals calendar's own colour (user overrides included), like the month
    // grid's cart and the List view's row — the shopping day belongs to that
    // calendar, so a colour of its own would read as a separate one.
    allDay.push({ key: 'grocery', title: 'Grocery shopping', color: calColors.recipes, kind: 'grocery', icon: GROCERY_ICON });
  }

  return { allDay, timed };
}

// The minutes of travel that actually render above a block: the event's drive
// time, clipped at midnight (a drive starting on the previous day is shown
// from the top of this column, like any other clipped span).
export function travelLead(b: Pick<TimedBlock, 'startMin' | 'travelMinutes'>): number {
  return Math.min(Math.max(0, b.travelMinutes ?? 0), b.startMin);
}

// ── Lane packing (ported from TripTimeline's cluster-flush greedy) ──────────
// Overlapping blocks split a cluster's width evenly: first-fit lanes within
// each overlap cluster, every member sized 1/clusterLanes wide. A block's span
// starts at its DEPARTURE, not its start time — you can't be driving to one
// event and sitting in another, so a travel band collides like any other
// occupied time.
export function packLanes(timedBlocks: TimedBlock[]): LaidBlock[] {
  if (!timedBlocks.length) return [];
  const blocks = timedBlocks.map((b) => ({
    b, s: b.startMin - travelLead(b), e: b.endMin, lane: 0, lanes: 1, travel: travelLead(b),
  }));
  let cluster: typeof blocks = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    for (const x of cluster) {
      let placed = false;
      for (let l = 0; l < laneEnds.length; l++) {
        if (x.s >= laneEnds[l]) { x.lane = l; laneEnds[l] = x.e; placed = true; break; }
      }
      if (!placed) { x.lane = laneEnds.length; laneEnds.push(x.e); }
    }
    const total = laneEnds.length;
    cluster.forEach((x) => { x.lanes = total; });
    cluster = [];
  };
  for (const x of blocks.slice().sort((a, z) => a.s - z.s || a.e - z.e)) {
    if (cluster.length && x.s >= clusterEnd) flush();
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, x.e);
  }
  flush();
  return blocks.map((x) => ({
    ...x.b,
    top: x.s * PX_PER_MIN,
    height: (x.e - x.s) * PX_PER_MIN,
    travelHeight: x.travel * PX_PER_MIN,
    leftFrac: x.lane / x.lanes,
    widthFrac: 1 / x.lanes,
  }));
}

// ── Week-strip math ─────────────────────────────────────────────────────────

// The Sunday on/before the date.
export function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return addDays(dateStr, -d.getDay());
}

// First week (page 0) of the strip's fixed window, for a given today.
export function weekEpoch(todayStr: string): string {
  return addDays(weekStartOf(todayStr), -7 * WEEK_WINDOW);
}

export function weekIndexFor(dateStr: string, epochStr: string): number {
  const i = Math.floor(diffDays(epochStr, weekStartOf(dateStr)) / 7);
  return Math.min(Math.max(0, i), WEEK_COUNT - 1);
}

// The 7 dates (Sun..Sat) of the strip page at `index`.
export function weekForIndex(index: number, epochStr: string): string[] {
  const start = addDays(epochStr, index * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// Which weekday columns the selection pill covers on the anchor's week page.
// Multi-day: the pair [anchor, anchor+1]; when the anchor is Saturday the pair
// straddles a week boundary, so this page shows Saturday only (the next page
// independently shows its Sunday selected via the same rule on its own anchor).
export function selectionCols(anchorStr: string, dayCount: 1 | 2): number[] {
  const c0 = new Date(anchorStr + 'T12:00:00').getDay();
  if (dayCount === 1 || c0 === 6) return [c0];
  return [c0, c0 + 1];
}

// ── Scroll targets ──────────────────────────────────────────────────────────

// Where the grid should sit when it first appears: today → the now-line ~30%
// down the viewport (Apple); other days → just above the first event; empty
// days → 8 AM. Clamped to the scrollable range.
export function initialScrollY(
  nowMin: number | null,
  blocks: { startMin: number; travelMinutes?: number }[],
  viewportH: number
): number {
  const max = Math.max(0, DAY_MIN * PX_PER_MIN - viewportH);
  const clamp = (y: number) => Math.min(Math.max(0, y), max);
  if (nowMin != null) return clamp(nowMin * PX_PER_MIN - viewportH * 0.3);
  // "The first event" means the top of its block — a travel band is part of it,
  // so a long drive can't open the day with its own lead-in above the fold.
  if (blocks.length) {
    const first = Math.min(...blocks.map((b) => b.startMin - travelLead(b)));
    return clamp((first - 30) * PX_PER_MIN);
  }
  return clamp(8 * 60 * PX_PER_MIN);
}

// ── Hourly weather rail ─────────────────────────────────────────────────────

// One mark on a timeline column's weather rail: the hour's condition icon +
// temperature, vertically centred within its hour band.
export type RailMark = { minutes: number; temp: number; code: number };

// Map a forecast day's hourly entries onto the 24h canvas. Input is the
// WeatherHour shape (`hour` is 0–23 local); out-of-range/duplicate hours are
// dropped so a malformed feed can't stack marks.
export function railMarks(
  hours: { hour: number; temperature: number; weatherCode: number }[] | undefined
): RailMark[] {
  if (!hours?.length) return [];
  const seen = new Set<number>();
  const out: RailMark[] = [];
  for (const h of hours) {
    if (h.hour < 0 || h.hour > 23 || seen.has(h.hour)) continue;
    seen.add(h.hour);
    out.push({ minutes: h.hour * 60, temp: Math.round(h.temperature), code: h.weatherCode });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

// ── Labels ──────────────────────────────────────────────────────────────────

// Gutter hour labels, Apple style: 12 AM, 1 AM … 11 AM, Noon, 1 PM … 11 PM.
export function hourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return 'Noon';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// The now-badge time ("2:08" — no meridiem, matching Apple's compact badge).
export function nowBadgeLabel(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad(min % 60)}`;
}

// "Monday – Jul 27" (list section headers, multi-day adds nothing).
export function dayHeaderLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} – ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// "Tuesday – Jul 28, 2026" (single-day title line).
export function singleDayTitle(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} – ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// "Tue – Jul 28" (multi-day column headers).
export function colHeaderLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} – ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// "5:00 PM" event times (blocks + agenda rows).
export function timeLabel(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad(min % 60)} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// A block's start–end line, Apple-compact: on-the-hour drops the minutes and
// the two sides share one meridiem when they fall in the same half of the day
// ("9 – 11AM", "11:30AM – 1PM"). Space is the scarcest thing in a day column,
// so the label spends none of it repeating what the reader can infer.
export function timeRangeLabel(startMin: number, endMin: number): string {
  const clock = (min: number) => {
    const h24 = Math.floor(min / 60) % 24;
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return min % 60 === 0 ? `${h}` : `${h}:${pad(min % 60)}`;
  };
  const meridiem = (min: number) => (Math.floor(min / 60) % 24 < 12 ? 'AM' : 'PM');
  const same = meridiem(startMin) === meridiem(endMin);
  const start = same ? clock(startMin) : `${clock(startMin)}${meridiem(startMin)}`;
  return `${start} – ${clock(endMin)}${meridiem(endMin)}`;
}

// How much a block says, chosen by how tall it is rendered — the same
// progressive disclosure Apple's day view uses, so a 30-minute event never
// tries to stack three lines into 30px.
//   full   → title + location + time range
//   medium → title + time range
//   compact→ title only
// The thresholds are rendered pixel heights (1px = 1min) derived from
// DayColumn's line heights: 6px of vertical padding, a 15px title line and a
// 14px meta row (13 + 1 margin). `full` starts at the point all three fit
// (6 + 15 + 14 + 14 = 49, with headroom so a one-hour block qualifies), and a
// title only takes a second line where one still fits above the meta rows.
export type BlockDetail = 'compact' | 'medium' | 'full';

export function blockDetail(height: number): BlockDetail {
  if (height >= 56) return 'full';
  if (height >= 38) return 'medium';
  return 'compact';
}

export const blockTitleLines = (height: number) => (height >= 78 ? 2 : 1);

// The shortest travel band that can carry its label without clipping it
// (11px line + the band's 2px of padding).
export const TRAVEL_LABEL_MIN = 14;

// What the travel band says. It names travel outright — the band's position
// above the block says *when*, but only the word says *what* — and falls
// silent when the drive is too short to print a line, leaving the band itself
// as the marker.
export function travelBandLabel(travelMinutes: number, bandHeight: number): string | null {
  if (bandHeight < TRAVEL_LABEL_MIN || travelMinutes <= 0) return null;
  return `${formatDuration(travelMinutes)} travel`;
}

// The spoken version, which always has room to be explicit.
export function travelAccessibilityLabel(travelMinutes: number, startMin: number): string {
  return `${formatDuration(travelMinutes)} travel time before this event — leave by ${timeLabel(startMin - travelMinutes)}`;
}

// Minutes since local midnight for an instant, on today's date.
export function nowMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}
