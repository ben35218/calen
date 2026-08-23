// A trip has no color of its own — every trip surface is painted by the Trips
// calendar's color (specs/features/trips.md), so recoloring that calendar
// recolors the month bars, the day dots and the day view's all-day chip. This
// pins that: nothing may read a stored per-trip hue back in.

import {
  applyCalendarColorOverrides,
  colorOf,
  dayDots,
  itemsForDate,
  weekBars,
  CALENDAR_COLORS,
} from '../calendar';
import { normalizeDay } from '../../screens/calendar/dayview/dayViewLayout';

const DATE = '2026-08-12';
const WEEK = ['2026-08-09', '2026-08-10', '2026-08-11', DATE, '2026-08-13', '2026-08-14', '2026-08-15'];
const TEAL = '#00897B';

// A trip carrying the OLD default hue — what every trip saved before the
// per-trip color was retired, and the value the bug rendered.
const data = {
  events: [],
  tasks: [],
  chores: [],
  recipes: [],
  occasions: [],
  groceryShopping: [],
  trips: [{ id: 'tr1', name: 'Banff', color: '#5E35B1', ranges: [{ start: DATE, end: DATE }] }],
} as any;

afterEach(() => applyCalendarColorOverrides({}));

describe('a trip wears the Trips calendar’s color', () => {
  it('falls back to the built-in Trips color with no override set', () => {
    expect(itemsForDate(data, DATE).trips[0].color).toBe(CALENDAR_COLORS.trips);
  });

  it('follows a recolored Trips calendar on every month-grid surface', () => {
    applyCalendarColorOverrides({ trips: TEAL });
    expect(colorOf('trips')).toBe(TEAL);
    expect(itemsForDate(data, DATE).trips[0].color).toBe(TEAL);
    expect(dayDots(data, DATE)).toEqual([TEAL]);
    expect(weekBars(data, WEEK).map((b) => b.color)).toEqual([TEAL]);
  });

  it('follows it on the day view’s all-day row', () => {
    applyCalendarColorOverrides({ trips: TEAL });
    const day = itemsForDate(data, DATE);
    const { allDay } = normalizeDay(day, [], DATE, { trips: TEAL }, {
      isCancelled: () => false,
      isReschedulePending: () => false,
    } as any);
    expect(allDay.map((a) => [a.kind, a.color])).toEqual([['trip', TEAL]]);
  });
});
