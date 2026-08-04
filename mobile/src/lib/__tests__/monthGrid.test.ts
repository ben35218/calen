// Month-block geometry: each month is its own grid, a boundary week appears in
// both months showing only its own days, and spanning bars clip at the edge.

import { clipBars, inMonth, monthBlockWeeks, weekLayout } from '../monthGrid';
import type { MonthWindow } from '../calendarWindow';
import type { WeekCoreMetrics } from '../monthGrid';

const win = (sy: number, sm: number, ey: number, em: number): MonthWindow => ({
  start: { year: sy, month: sm },
  end: { year: ey, month: em },
});

// The in-month day numbers of a row, in column order (blanks dropped).
const shown = (w: ReturnType<typeof monthBlockWeeks>[number]) =>
  w.days.filter((_, col) => inMonth(w, col));

describe('monthBlockWeeks', () => {
  it('covers every day of every month in the window exactly once', () => {
    const weeks = monthBlockWeeks(win(2026, 6, 2026, 8)); // Jul–Sep 2026
    const seen = weeks.flatMap((w) => w.dates.filter((_, col) => inMonth(w, col)));
    expect(seen).toEqual([...new Set(seen)]); // no day rendered twice
    expect(seen[0]).toBe('2026-07-01');
    expect(seen[seen.length - 1]).toBe('2026-09-30');
    expect(seen.length).toBe(31 + 31 + 30);
  });

  it('renders a boundary week in both months, with complementary halves', () => {
    const weeks = monthBlockWeeks(win(2026, 6, 2026, 7)); // Jul–Aug 2026
    // Aug 1 2026 is a Saturday, so Jul 26–Aug 1 is the shared boundary week.
    const shared = weeks.filter((w) => w.dates[0] === '2026-07-26');
    expect(shared).toHaveLength(2);
    const [inJuly, inAugust] = shared;
    expect(inJuly.ym.month).toBe(6);
    expect(inAugust.ym.month).toBe(7);
    // July's copy shows 26–31 (Sun–Fri); August's shows only the 1st (Sat).
    expect(shown(inJuly)).toEqual([26, 27, 28, 29, 30, 31]);
    expect(inJuly.firstCol).toBe(0);
    expect(inJuly.lastCol).toBe(5);
    expect(shown(inAugust)).toEqual([1]);
    expect(inAugust.firstCol).toBe(6);
    expect(inAugust.lastCol).toBe(6);
    // …and the two rows are distinct rows, not one shared key.
    expect(inJuly.key).not.toBe(inAugust.key);
  });

  it('gives every row a unique key across the window', () => {
    const keys = monthBlockWeeks(win(2025, 10, 2027, 1)).map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks only the first row of each block, and puts the 1st at firstCol', () => {
    const weeks = monthBlockWeeks(win(2026, 6, 2026, 8));
    for (const ym of [6, 7, 8]) {
      const block = weeks.filter((w) => w.ym.month === ym);
      expect(block.filter((w) => w.isMonthStart)).toHaveLength(1);
      expect(block[0].isMonthStart).toBe(true);
      expect(block[0].days[block[0].firstCol]).toBe(1);
    }
  });

  it('emits no leading blanks for a month starting on a Sunday', () => {
    const weeks = monthBlockWeeks(win(2026, 10, 2026, 10)); // Nov 2026 starts Sunday
    expect(weeks[0].dates[0]).toBe('2026-11-01');
    expect(weeks[0].firstCol).toBe(0);
  });

  it('handles a 28-day February that starts mid-week', () => {
    const weeks = monthBlockWeeks(win(2027, 1, 2027, 1)); // Feb 2027 starts Monday
    expect(weeks).toHaveLength(5);
    expect(weeks[0].firstCol).toBe(1); // Monday
    expect(shown(weeks[0])).toEqual([1, 2, 3, 4, 5, 6]);
    const last = weeks[weeks.length - 1];
    expect(shown(last)).toEqual([28]);
    expect(last.abbrev).toBe('Feb');
  });

  it('labels a block with its own month, not the row majority', () => {
    const weeks = monthBlockWeeks(win(2026, 7, 2026, 7));
    // The first row is mostly July days, but the block is August's.
    expect(weeks[0].monthLabel).toBe('August 2026');
    expect(weeks[0].abbrev).toBe('Aug');
    expect(weeks.every((w) => w.monthLabel === 'August 2026')).toBe(true);
  });
});

describe('clipBars', () => {
  const bar = (startCol: number, endCol: number) => ({ key: `${startCol}-${endCol}`, startCol, endCol });

  it('clamps a span that crosses the block edge', () => {
    expect(clipBars([bar(0, 6)], 6, 6)).toEqual([{ key: '0-6', startCol: 6, endCol: 6 }]);
    expect(clipBars([bar(0, 6)], 0, 5)).toEqual([{ key: '0-6', startCol: 0, endCol: 5 }]);
  });

  it('drops a span that falls entirely outside the block', () => {
    expect(clipBars([bar(0, 4)], 6, 6)).toEqual([]);
    expect(clipBars([bar(6, 6)], 0, 5)).toEqual([]);
  });

  it('passes a fully-inside span through by identity', () => {
    const b = bar(1, 3);
    expect(clipBars([b], 0, 6)[0]).toBe(b);
  });
});

// The three grid densities share ONE row core and differ only here, which is
// what lets the view switcher change density without re-expanding anything.
describe('weekLayout', () => {
  // The grid's real constants (CalendarScreen's WEEK_LAYOUT).
  const CFG = {
    dayNumH: 26, monthLabelH: 16, barH: 17, vpad: 8,
    compactWeek: 48, stackBarH: 9, minStackWeek: 60, minWeek: 96, maxWeek: 210,
  };
  const core = (over: Partial<WeekCoreMetrics> = {}): WeekCoreMetrics => ({
    isMonthStart: false,
    hasWeather: false,
    lanes: [0, 0, 0, 0, 0, 0, 0],
    itemsH: [0, 0, 0, 0, 0, 0, 0],
    stackN: [0, 0, 0, 0, 0, 0, 0],
    ...over,
  });

  it('reads all three densities off one unchanged core', () => {
    // A busy Wednesday: one bar lane over it, a tall chip stack, 4 stacked bars.
    const c = core({ lanes: [0, 0, 0, 1, 0, 0, 0], itemsH: [0, 0, 0, 140, 0, 0, 0], stackN: [0, 0, 0, 4, 0, 0, 0] });
    // Compact ignores the cell entirely — uniform short rows.
    expect(weekLayout('compact', c, CFG)).toEqual({ headerH: 26, height: 48, weather: false });
    // Stacked: header + 1 lane (17) + 4 bars (36) + vpad.
    expect(weekLayout('stacked', c, CFG)).toEqual({ headerH: 26, height: 26 + 17 + 36 + 8, weather: false });
    // Details: header + 1 lane + the 140pt stack + vpad, clamped to maxWeek.
    expect(weekLayout('details', c, CFG)).toEqual({ headerH: 26, height: 191, weather: false });
  });

  it('sizes a week by its single tallest cell, not per-column maxima summed', () => {
    // The deepest bar and the tallest stack are in DIFFERENT cells: taking the
    // week-wide max of each separately would over-allocate (17 + 40 + …).
    const c = core({ lanes: [2, 0, 0, 0, 0, 0, 0], itemsH: [0, 40, 0, 0, 0, 0, 0] });
    expect(weekLayout('details', c, CFG).height).toBe(96); // max cell is 40 → floor wins
    const tall = core({ lanes: [2, 0, 0, 0, 0, 0, 0], itemsH: [0, 120, 0, 0, 0, 0, 0] });
    expect(weekLayout('details', tall, CFG).height).toBe(26 + 120 + 8); // the 120 cell, not 34+120
  });

  it('reserves the month-label line on a month-start row, in every density', () => {
    const c = core({ isMonthStart: true });
    expect(weekLayout('compact', c, CFG)).toEqual({ headerH: 42, height: 64, weather: false });
    expect(weekLayout('stacked', c, CFG).headerH).toBe(42);
    expect(weekLayout('details', c, CFG).headerH).toBe(42);
  });

  it('applies each density its own minimum height', () => {
    const c = core();
    expect(weekLayout('stacked', c, CFG).height).toBe(60);
    expect(weekLayout('details', c, CFG).height).toBe(96);
  });

  it('clamps a very tall week to the maximum', () => {
    const c = core({ itemsH: [0, 0, 0, 500, 0, 0, 0] });
    expect(weekLayout('details', c, CFG).height).toBe(210);
  });

  it('shows the weather lane in Stacked and Details, never in Compact', () => {
    const c = core({ hasWeather: true });
    expect(weekLayout('compact', c, CFG).weather).toBe(false);
    expect(weekLayout('stacked', c, CFG).weather).toBe(true);
    expect(weekLayout('details', c, CFG).weather).toBe(true);
    // …and the lane costs one bar of height where it shows.
    expect(weekLayout('details', c, CFG).height - weekLayout('details', core(), CFG).height).toBe(0); // both at the floor
    const busy = (hasWeather: boolean) => core({ hasWeather, itemsH: [0, 0, 0, 120, 0, 0, 0] });
    expect(weekLayout('details', busy(true), CFG).height - weekLayout('details', busy(false), CFG).height).toBe(17);
  });
});
