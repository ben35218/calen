// Month-window math for the calendar grid's unbounded scroll, plus the merge
// that folds per-month expansion chunks back into one CalendarData. The grid
// (CalendarScreen) owns the window state; this owns the rules, so they stay
// pure and unit-testable. The window is a contiguous, inclusive month span —
// it only ever grows (scroll extensions, jump coverage); the FlatList's
// virtualization is what keeps rendering bounded, not the window.

import { CalendarData } from '../api';

export interface YearMonth {
  year: number;
  month: number; // 0-11, JS Date convention
}

// Inclusive on both ends.
export interface MonthWindow {
  start: YearMonth;
  end: YearMonth;
}

// First paint expands only what a launch actually looks at: last month,
// this month, and a season ahead. Scrolling grows it from there.
export const INITIAL_PAST_MONTHS = 1;
export const INITIAL_FUTURE_MONTHS = 3;
// Nearing either edge of the built grid grows the window by this much.
export const EXTEND_MONTHS = 6;

export function addMonths(m: YearMonth, n: number): YearMonth {
  const d = new Date(m.year, m.month + n, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

// Total-month ordinal, for comparisons and iteration.
export const ymIndex = (m: YearMonth) => m.year * 12 + m.month;

// Stable chunk/query key, e.g. "2026-08".
export const ymKey = (m: YearMonth) => `${m.year}-${String(m.month + 1).padStart(2, '0')}`;

export function initialWindow(now: Date): MonthWindow {
  const cur = { year: now.getFullYear(), month: now.getMonth() };
  return { start: addMonths(cur, -INITIAL_PAST_MONTHS), end: addMonths(cur, INITIAL_FUTURE_MONTHS) };
}

export const extendPast = (w: MonthWindow, n = EXTEND_MONTHS): MonthWindow => ({
  start: addMonths(w.start, -n),
  end: w.end,
});

export const extendFuture = (w: MonthWindow, n = EXTEND_MONTHS): MonthWindow => ({
  start: w.start,
  end: addMonths(w.end, n),
});

// Grow the window (never shrink) to cover a jump target, with a margin of
// neighbouring months so the landing spot has somewhere to scroll into before
// the edge-extension kicks in. Returns the same object when already covered,
// so setState callers can no-op.
export function ensureCovers(w: MonthWindow, target: YearMonth, margin = 1): MonthWindow {
  let { start, end } = w;
  if (ymIndex(target) - margin < ymIndex(start)) start = addMonths(target, -margin);
  if (ymIndex(target) + margin > ymIndex(end)) end = addMonths(target, margin);
  return start === w.start && end === w.end ? w : { start, end };
}

export function monthsIn(w: MonthWindow): YearMonth[] {
  const out: YearMonth[] = [];
  for (let i = ymIndex(w.start); i <= ymIndex(w.end); i++) {
    out.push({ year: Math.floor(i / 12), month: ((i % 12) + 12) % 12 });
  }
  return out;
}

// One month's expansion range: first day → last day, at local midnight
// (mirrors the whole-window range the grid used before chunking).
export function monthRange(m: YearMonth): { from: string; to: string } {
  return {
    from: new Date(m.year, m.month, 1).toISOString(),
    to: new Date(m.year, m.month + 1, 0).toISOString(),
  };
}

const dedupBy = <T>(rows: T[], key: (r: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
};

// Fold per-month expansion chunks into one CalendarData. A record can surface
// in two chunks — a span crossing the month boundary, or a whole collection
// the engine returns un-clipped — so everything dedups on its identity; a
// recurring event's occurrences share an _id and differ by startDate, hence
// the compound event key. Events re-sort by start so the merged list matches
// what a single whole-range expansion would have returned.
export function mergeCalendarChunks(chunks: CalendarData[]): CalendarData {
  return {
    events: dedupBy(chunks.flatMap((c) => c.events ?? []), (e) => `${e._id}:${e.startDate}`).sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    ),
    tasks: dedupBy(chunks.flatMap((c) => c.tasks ?? []), (t) => t._id),
    chores: dedupBy(chunks.flatMap((c) => c.chores ?? []), (c) => c._id),
    occasions: dedupBy(chunks.flatMap((c) => c.occasions ?? []), (o) => `${o.id}:${o.date}`),
    recipes: dedupBy(chunks.flatMap((c) => c.recipes ?? []), (r) => {
      const rid = typeof r.recipeId === 'object' ? r.recipeId?._id : r.recipeId;
      return `${r._id ?? rid ?? ''}:${r.scheduledDate}`;
    }),
    groceryShopping: dedupBy(chunks.flatMap((c) => c.groceryShopping ?? []), (g) => g.date),
    trips: dedupBy(chunks.flatMap((c) => c.trips ?? []), (t) => t.id),
  };
}
