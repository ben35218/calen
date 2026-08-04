// Month-block geometry for the calendar grids — the layout rule that makes the
// scrolling month surface read like Apple Calendar: every month is its OWN
// block of Sunday-first weeks, and the days of the neighbouring month inside a
// boundary week are left blank. A boundary week therefore appears TWICE (once
// per month, each showing only its own days), which is what puts real
// whitespace between one month and the next instead of running them together.
//
// Pure and unit-tested; CalendarScreen's grid (Compact/Stacked/Details) and
// the viewer shell's ViewerMonthGrid both build their rows from this.

import { MonthWindow, YearMonth, monthsIn, ymKey } from './calendarWindow';
import { ymd } from './calendar';

// One rendered row: seven Sunday-first day slots, of which only the columns in
// [firstCol, lastCol] belong to `ym` — the rest render as blank spacers.
export interface MonthBlockWeek {
  ym: YearMonth;
  // Month-qualified, because the same week start belongs to two blocks at a
  // month boundary and the two rows must not collide (FlatList keys, row cache).
  key: string;
  dates: string[];   // 7 × yyyy-MM-dd
  days: number[];    // 7 × day-of-month
  firstCol: number;  // first column that belongs to `ym`
  lastCol: number;   // last column that belongs to `ym`
  // The block's first row — the one holding the 1st (always at firstCol). It
  // carries the month marker: the abbreviation above the day number.
  isMonthStart: boolean;
  monthLabel: string; // "August 2026" — the sticky header / jump-sheet label
  abbrev: string;     // "Aug" — the 1st-of-month marker
}

export const inMonth = (w: MonthBlockWeek, col: number) => col >= w.firstCol && col <= w.lastCol;

// Every week of every month in the window, in order. Consecutive blocks share
// their boundary week's dates — deliberately, see the header note.
export function monthBlockWeeks(win: MonthWindow): MonthBlockWeek[] {
  const out: MonthBlockWeek[] = [];
  for (const ym of monthsIn(win)) {
    const first = new Date(ym.year, ym.month, 1);
    const lastDay = new Date(ym.year, ym.month + 1, 0).getDate();
    const monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const abbrev = first.toLocaleDateString(undefined, { month: 'short' });
    // Start on the Sunday on/before the 1st; walk whole weeks until past the last.
    for (let offset = -first.getDay(); offset < lastDay; offset += 7) {
      const dates: string[] = [];
      const days: number[] = [];
      let firstCol = -1;
      let lastCol = -1;
      for (let i = 0; i < 7; i++) {
        // Day-of-month arithmetic through the Date constructor, so it rolls
        // into the neighbouring month (and across DST) on its own.
        const d = new Date(ym.year, ym.month, 1 + offset + i);
        dates.push(ymd(d));
        days.push(d.getDate());
        if (d.getMonth() === ym.month && d.getFullYear() === ym.year) {
          if (firstCol < 0) firstCol = i;
          lastCol = i;
        }
      }
      out.push({
        ym,
        key: `${ymKey(ym)}:${dates[0]}`,
        dates,
        days,
        firstCol,
        lastCol,
        isMonthStart: offset === -first.getDay(),
        monthLabel,
        abbrev,
      });
    }
  }
  return out;
}

// ── Week layout by density ──
// The three grid densities share ONE row core: the cells' content and the
// week's spanning bars are identical in all three, and computing them is the
// expensive part (it scans every event and trip). Only the row's height, its
// header height, and whether the weather lane shows actually vary. Keeping the
// layout pass pure and separate is what lets the grid switch density without
// re-expanding or re-scanning anything — see calendar.md → "Views".

export type GridDensityName = 'compact' | 'stacked' | 'details';

// The density-independent measurements of one week, per column.
export interface WeekCoreMetrics {
  isMonthStart: boolean;
  hasWeather: boolean;  // the forecast covers at least one of this week's own days
  lanes: number[];      // bar lanes covering each column
  itemsH: number[];     // Details: the column's chip/icon stack height
  stackN: number[];     // Stacked: the column's thin-bar count
}

// The caller's layout constants (they live with the grid that draws them).
export interface WeekLayoutConfig {
  dayNumH: number;
  monthLabelH: number;
  barH: number;
  vpad: number;
  compactWeek: number;
  stackBarH: number;
  minStackWeek: number;
  minWeek: number;
  maxWeek: number;
}

export function weekLayout(
  density: GridDensityName,
  core: WeekCoreMetrics,
  cfg: WeekLayoutConfig,
): { headerH: number; height: number; weather: boolean } {
  // A month's first row reserves a line above the day numbers for the month
  // abbreviation, across the whole row so the numbers stay aligned.
  const labelH = core.isMonthStart ? cfg.monthLabelH : 0;
  const headerH = cfg.dayNumH + labelH;
  // Compact hides every span, the weather lane included.
  const weather = density !== 'compact' && core.hasWeather;
  if (density === 'compact') {
    // Uniform short rows — no spans, just the dots strip.
    return { headerH, height: cfg.compactWeek + labelH, weather };
  }
  // Size the week by its single tallest cell: that cell's own bar lanes plus
  // its own items. Taking the week-wide max of each separately would
  // over-allocate when the deepest bar and the tallest item stack live in
  // different cells, leaving a spurious gap above the next week.
  const perCol = core.lanes.map((lanes, col) =>
    lanes * cfg.barH + (density === 'stacked' ? core.stackN[col] * cfg.stackBarH : core.itemsH[col]),
  );
  const maxCell = Math.max(0, ...perCol);
  const floor = density === 'stacked' ? cfg.minStackWeek : cfg.minWeek;
  const height = Math.min(cfg.maxWeek, Math.max(floor, headerH + (weather ? cfg.barH : 0) + maxCell + cfg.vpad));
  return { headerH, height, weather };
}

// Clip spanning bars (multi-day events, trips) and the weather lane to the
// block's own columns: a span crossing a month boundary draws as two clipped
// bars, one per block, never over the blank neighbouring-month cells.
export function clipBars<T extends { startCol: number; endCol: number }>(
  bars: T[],
  firstCol: number,
  lastCol: number,
): T[] {
  const out: T[] = [];
  for (const b of bars) {
    if (b.endCol < firstCol || b.startCol > lastCol) continue;
    out.push(
      b.startCol >= firstCol && b.endCol <= lastCol
        ? b
        : { ...b, startCol: Math.max(b.startCol, firstCol), endCol: Math.min(b.endCol, lastCol) },
    );
  }
  return out;
}
