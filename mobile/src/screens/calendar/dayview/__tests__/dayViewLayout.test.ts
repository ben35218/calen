import {
  normalizeDay,
  packLanes,
  railMarks,
  weekStartOf,
  weekEpoch,
  weekIndexFor,
  weekForIndex,
  selectionCols,
  initialScrollY,
  minutesInto,
  addDays,
  diffDays,
  hourLabel,
  nowBadgeLabel,
  TimedBlock,
  WEEK_WINDOW,
  MIN_BLOCK,
  DAY_MIN,
} from '../dayViewLayout';
import { DayItems } from '../../../../lib/calendar';

const CAL_COLORS = {
  maintenance: '#1976D2',
  chores: '#F57C00',
  recipes: '#00897B',
  birthdays: '#E91E63',
};

const NO_STATUS = { cancelledIds: new Set<string>(), reschedulePendingIds: new Set<string>() };

function emptyDay(): DayItems {
  return { events: [], tasks: [], chores: [], recipes: [], trips: [], occasions: [], grocery: false };
}

// Local-zone ISO instant for a date + hh:mm, so tests pass in any timezone.
function iso(dateStr: string, hm: string): string {
  return new Date(`${dateStr}T${hm}:00`).toISOString();
}

function block(key: string, startMin: number, endMin: number): TimedBlock {
  return { key, title: key, color: '#123456', startMin, endMin, eventId: key };
}

describe('minutesInto / date math', () => {
  it('measures minutes from local midnight', () => {
    expect(minutesInto('2026-07-28', iso('2026-07-28', '00:00'))).toBe(0);
    expect(minutesInto('2026-07-28', iso('2026-07-28', '17:30'))).toBe(1050);
    expect(minutesInto('2026-07-28', iso('2026-07-29', '01:00'))).toBe(1500);
    expect(minutesInto('2026-07-28', iso('2026-07-27', '23:00'))).toBe(-60);
  });

  it('addDays / diffDays cross month boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
    expect(diffDays('2026-07-27', '2026-08-03')).toBe(7);
  });
});

describe('normalizeDay routing', () => {
  it('routes a timed event to a clipped block and all-day items to the all-day row', () => {
    const day = emptyDay();
    day.events = [
      { _id: 'e1', title: 'Therapy', calendarType: 'appointments', startDate: iso('2026-07-27', '17:00'), endDate: iso('2026-07-27', '18:00') },
      { _id: 'e2', title: 'Conference', calendarType: 'activities', allDay: true, startDate: '2026-07-27T12:00:00.000Z' },
    ] as any;
    const { allDay, timed } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS);
    expect(timed).toHaveLength(1);
    expect(timed[0]).toMatchObject({ eventId: 'e1', startMin: 1020, endMin: 1080 });
    expect(allDay.map((a) => a.key)).toEqual(['e2']);
  });

  it('clips a midnight-spanning event to each column day', () => {
    const day = emptyDay();
    const ev = { _id: 'e1', title: 'Party', calendarType: 'activities', startDate: iso('2026-07-27', '23:00'), endDate: iso('2026-07-28', '01:00') };
    day.events = [ev] as any;
    const d1 = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS).timed[0];
    const d2 = normalizeDay(day, [], '2026-07-28', CAL_COLORS, NO_STATUS).timed[0];
    expect(d1).toMatchObject({ startMin: 1380, endMin: 1440 });
    expect(d2).toMatchObject({ startMin: 0, endMin: 60 });
  });

  it('demotes a timed event covering the whole day to the all-day row', () => {
    const day = emptyDay();
    day.events = [{ _id: 'e1', title: 'Offsite', calendarType: 'activities', startDate: iso('2026-07-26', '09:00'), endDate: iso('2026-07-29', '17:00') }] as any;
    const { allDay, timed } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS);
    expect(timed).toHaveLength(0);
    expect(allDay).toHaveLength(1);
    expect(allDay[0].kind).toBe('event');
  });

  it('enforces the minimum block height', () => {
    const day = emptyDay();
    day.events = [{ _id: 'e1', title: 'Ping', calendarType: 'appointments', startDate: iso('2026-07-27', '09:00'), endDate: iso('2026-07-27', '09:10') }] as any;
    const { timed } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS);
    expect(timed[0].endMin - timed[0].startMin).toBe(MIN_BLOCK);
  });

  it('renders date-only tasks and chores as muted all-day chips', () => {
    const day = emptyDay();
    day.tasks = [{ _id: 't1', title: 'Furnace filter' }] as any;
    day.chores = [{ _id: 'c1', title: 'Garbage + Blue Bin' }] as any;
    const { allDay, timed } = normalizeDay(day, [], '2026-07-28', CAL_COLORS, NO_STATUS);
    expect(timed).toHaveLength(0);
    const kinds = allDay.map((a) => [a.kind, a.muted]);
    expect(kinds).toContainEqual(['task', true]);
    expect(kinds).toContainEqual(['chore', true]);
  });

  it('marks cancelled / reschedule-pending events faded and struck', () => {
    const day = emptyDay();
    day.events = [
      { _id: 'e1', title: 'A', calendarType: 'appointments', startDate: iso('2026-07-27', '10:00'), endDate: iso('2026-07-27', '11:00') },
      { _id: 'e2', title: 'B', calendarType: 'appointments', startDate: iso('2026-07-27', '12:00'), endDate: iso('2026-07-27', '13:00') },
    ] as any;
    const status = { cancelledIds: new Set(['e1']), reschedulePendingIds: new Set(['e2']) };
    const { timed } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, status);
    const a = timed.find((b) => b.eventId === 'e1')!;
    const b = timed.find((b) => b.eventId === 'e2')!;
    expect(a).toMatchObject({ faded: true, strike: true });
    expect(b).toMatchObject({ faded: true, strike: false });
  });
});

describe('packLanes', () => {
  it('gives disjoint blocks full width', () => {
    const laid = packLanes([block('a', 60, 120), block('b', 180, 240)]);
    expect(laid.every((b) => b.widthFrac === 1 && b.leftFrac === 0)).toBe(true);
    expect(laid[0]).toMatchObject({ top: 60, height: 60 });
  });

  it('splits a simple overlap into two lanes', () => {
    const laid = packLanes([block('a', 60, 180), block('b', 120, 240)]);
    const a = laid.find((b) => b.key === 'a')!;
    const b = laid.find((x) => x.key === 'b')!;
    expect(a.widthFrac).toBe(0.5);
    expect(b.widthFrac).toBe(0.5);
    expect(a.leftFrac).not.toBe(b.leftFrac);
  });

  it('keeps a chained overlap in one cluster and reuses freed lanes', () => {
    // a 0–60, b 30–90, c 70–130: c doesn't overlap a, so it reuses lane 0,
    // but all three share the cluster's 2-lane width.
    const laid = packLanes([block('a', 0, 60), block('b', 30, 90), block('c', 70, 130)]);
    const byKey = Object.fromEntries(laid.map((b) => [b.key, b]));
    expect(byKey.a.widthFrac).toBe(0.5);
    expect(byKey.c.widthFrac).toBe(0.5);
    expect(byKey.c.leftFrac).toBe(byKey.a.leftFrac);
  });

  it('handles a 3-way overlap with three lanes', () => {
    const laid = packLanes([block('a', 0, 100), block('b', 10, 100), block('c', 20, 100)]);
    expect(laid.every((b) => Math.abs(b.widthFrac - 1 / 3) < 1e-9)).toBe(true);
    expect(new Set(laid.map((b) => b.leftFrac)).size).toBe(3);
  });
});

describe('week-strip math', () => {
  it('weekStartOf returns the Sunday on/before', () => {
    expect(weekStartOf('2026-07-28')).toBe('2026-07-26'); // Tue → Sun
    expect(weekStartOf('2026-07-26')).toBe('2026-07-26'); // Sun → itself
    expect(weekStartOf('2026-08-01')).toBe('2026-07-26'); // Sat → prior Sun
  });

  it('weekIndexFor / weekForIndex round-trip around the epoch', () => {
    const epoch = weekEpoch('2026-07-27');
    expect(weekIndexFor('2026-07-27', epoch)).toBe(WEEK_WINDOW);
    const page = weekForIndex(WEEK_WINDOW, epoch);
    expect(page).toHaveLength(7);
    expect(page[0]).toBe('2026-07-26');
    expect(page[6]).toBe('2026-08-01');
    expect(weekIndexFor(page[3], epoch)).toBe(WEEK_WINDOW);
  });

  it('selectionCols spans the pair and clips at Saturday', () => {
    expect(selectionCols('2026-07-28', 1)).toEqual([2]); // Tue
    expect(selectionCols('2026-07-28', 2)).toEqual([2, 3]); // Tue+Wed
    expect(selectionCols('2026-08-01', 2)).toEqual([6]); // Sat → clipped
  });
});

describe('initialScrollY', () => {
  const viewport = 600;

  it('centers-ish on now for today', () => {
    expect(initialScrollY(14 * 60, [], viewport)).toBe(14 * 60 - 600 * 0.3);
  });

  it('lands just above the first event on other days', () => {
    expect(initialScrollY(null, [{ startMin: 540 }, { startMin: 700 }], viewport)).toBe(510);
  });

  it('defaults to 8 AM on empty days and clamps to the scroll range', () => {
    expect(initialScrollY(null, [], viewport)).toBe(480);
    expect(initialScrollY(0, [], viewport)).toBe(0); // early-morning clamp
    expect(initialScrollY(DAY_MIN, [], viewport)).toBe(DAY_MIN - viewport); // late-night clamp
  });
});

describe('railMarks (hourly weather rail)', () => {
  it('maps forecast hours onto the 24h canvas, rounding temps', () => {
    const marks = railMarks([
      { hour: 9, temperature: 18.6, weatherCode: 3 },
      { hour: 14, temperature: 24.2, weatherCode: 61 },
    ]);
    expect(marks).toEqual([
      { minutes: 540, temp: 19, code: 3 },
      { minutes: 840, temp: 24, code: 61 },
    ]);
  });

  it('drops out-of-range and duplicate hours and sorts the rest', () => {
    const marks = railMarks([
      { hour: 25, temperature: 20, weatherCode: 0 },
      { hour: 5, temperature: 12, weatherCode: 0 },
      { hour: 5, temperature: 13, weatherCode: 1 },
      { hour: 1, temperature: 10, weatherCode: 0 },
      { hour: -1, temperature: 8, weatherCode: 0 },
    ]);
    expect(marks.map((m) => m.minutes)).toEqual([60, 300]);
  });

  it('returns nothing without hourly data', () => {
    expect(railMarks(undefined)).toEqual([]);
    expect(railMarks([])).toEqual([]);
  });
});

describe('labels', () => {
  it('formats gutter hours Apple-style', () => {
    expect(hourLabel(0)).toBe('12 AM');
    expect(hourLabel(11)).toBe('11 AM');
    expect(hourLabel(12)).toBe('Noon');
    expect(hourLabel(13)).toBe('1 PM');
  });

  it('formats the now badge without a meridiem', () => {
    expect(nowBadgeLabel(14 * 60 + 8)).toBe('2:08');
    expect(nowBadgeLabel(5)).toBe('12:05');
  });
});
