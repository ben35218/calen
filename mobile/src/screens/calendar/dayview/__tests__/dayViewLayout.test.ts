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
  longPressDraft,
  minutesInto,
  addDays,
  diffDays,
  hourLabel,
  nowBadgeLabel,
  timeRangeLabel,
  blockDetail,
  blockTitleLines,
  travelBandLabel,
  travelAccessibilityLabel,
  TimedBlock,
  EventStatus,
  EVENT_ICON,
  WEEK_WINDOW,
  MIN_BLOCK,
  DAY_MIN,
} from '../dayViewLayout';
import { DayItems, GROCERY_ICON, RECIPE_ICON } from '../../../../lib/calendar';
import { occasionIcon } from '../../../../lib/occasions';

const CAL_COLORS = {
  maintenance: '#1976D2',
  chores: '#F57C00',
  recipes: '#00897B',
  birthdays: '#E91E63',
};

const NO_STATUS: EventStatus = { isCancelled: () => false, isReschedulePending: () => false };

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
    // All-day events are badged with the generic calendar glyph.
    expect(allDay[0]).toMatchObject({ kind: 'event', icon: EVENT_ICON });
  });

  it('carries the location and travel time a block card renders', () => {
    const day = emptyDay();
    day.events = [
      {
        _id: 'e1', title: 'EarlyON Alfred', calendarType: 'activities',
        startDate: iso('2026-07-27', '09:00'), endDate: iso('2026-07-27', '11:00'),
        location: '520 St Philippe St', travelMinutes: 15,
      },
      // No drive time set: the block must not claim one.
      { _id: 'e2', title: 'Swim', calendarType: 'activities', startDate: iso('2026-07-27', '13:00'), travelMinutes: null },
    ] as any;
    const { timed } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS);
    expect(timed[0]).toMatchObject({ location: '520 St Philippe St', travelMinutes: 15 });
    expect(timed[1].travelMinutes).toBeUndefined();
  });

  it('badges occasions with their kind icon in the birthdays colour', () => {
    const day = emptyDay();
    day.occasions = [
      { id: 'o1', kind: 'birthday', name: 'Ada', label: 'Birthday', date: '2026-07-27', contactId: 'p1' },
    ] as any;
    const { allDay } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS);
    const occ = allDay.find((a) => a.kind === 'occasion');
    expect(occ).toMatchObject({ kind: 'occasion', color: CAL_COLORS.birthdays, icon: occasionIcon('birthday') });
    expect(occ?.muted).toBeFalsy();
  });

  // A meal has to read as a meal on every calendar surface, so the day view
  // badges recipes and the shopping day with the same glyphs the month grid and
  // the list view use — and shows the recipe's own name, which only arrives
  // because lib/calendarData joins the title back onto the schedule.
  it('badges meals and the shopping day with the shared calendar glyphs', () => {
    const day = emptyDay();
    day.recipes = [{ title: 'Tacos', recipeId: 'r1' }];
    day.grocery = true;
    const { allDay } = normalizeDay(day, [], '2026-07-27', CAL_COLORS, NO_STATUS);

    expect(allDay.find((a) => a.kind === 'recipe')).toMatchObject({
      title: 'Tacos', icon: RECIPE_ICON, color: CAL_COLORS.recipes, id: 'r1',
    });
    // Both take the Meals calendar's colour — the shopping day is part of that
    // calendar, not a colour of its own (it used to be a hard-coded yellow).
    expect(allDay.find((a) => a.kind === 'grocery')).toMatchObject({
      title: 'Grocery shopping', icon: GROCERY_ICON, color: CAL_COLORS.recipes,
    });
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

  it('renders date-only tasks as muted all-day chips', () => {
    const day = emptyDay();
    day.tasks = [{ _id: 't1', title: 'Furnace filter' }] as any;
    const { allDay, timed } = normalizeDay(day, [], '2026-07-28', CAL_COLORS, NO_STATUS);
    expect(timed).toHaveLength(0);
    const task = allDay.find((a) => a.kind === 'task');
    expect(task).toMatchObject({ kind: 'task', muted: true });
  });

  it('renders chores tinted in the Chores colour, badged with their own icon (not muted)', () => {
    const day = emptyDay();
    day.chores = [{ _id: 'c1', title: 'Garbage + Blue Bin', icon: 'mdi-trash-can' }] as any;
    const { allDay, timed } = normalizeDay(day, [], '2026-07-28', CAL_COLORS, NO_STATUS);
    expect(timed).toHaveLength(0);
    const chore = allDay.find((a) => a.kind === 'chore');
    expect(chore).toMatchObject({ kind: 'chore', color: CAL_COLORS.chores, icon: 'mdi-trash-can' });
    expect(chore?.muted).toBeFalsy();
  });

  it('marks cancelled / reschedule-pending events faded and struck', () => {
    const day = emptyDay();
    day.events = [
      { _id: 'e1', title: 'A', calendarType: 'appointments', startDate: iso('2026-07-27', '10:00'), endDate: iso('2026-07-27', '11:00') },
      { _id: 'e2', title: 'B', calendarType: 'appointments', startDate: iso('2026-07-27', '12:00'), endDate: iso('2026-07-27', '13:00') },
    ] as any;
    const status: EventStatus = {
      isCancelled: (id) => id === 'e1',
      isReschedulePending: (id) => id === 'e2',
    };
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

  it('extends a block upward by its travel time', () => {
    const [b] = packLanes([{ ...block('a', 600, 660), travelMinutes: 20 }]);
    // Starts at the departure, spans the drive plus the event.
    expect(b).toMatchObject({ top: 580, height: 80, travelHeight: 20 });
  });

  it('reports no travel band for an event without a drive time', () => {
    expect(packLanes([block('a', 600, 660)])[0]).toMatchObject({ top: 600, height: 60, travelHeight: 0 });
  });

  it('clips a travel band that would start before midnight', () => {
    const [b] = packLanes([{ ...block('a', 20, 80), travelMinutes: 45 }]);
    expect(b).toMatchObject({ top: 0, height: 80, travelHeight: 20 });
  });

  it('collides on the travel band — you cannot drive and sit in a meeting', () => {
    // The meeting ends at 600; the drive to the 620 event starts at 590.
    const laid = packLanes([block('meeting', 540, 600), { ...block('away', 620, 700), travelMinutes: 30 }]);
    expect(laid.every((b) => b.widthFrac === 0.5)).toBe(true);
    expect(laid[0].leftFrac).not.toBe(laid[1].leftFrac);
  });

  it('leaves blocks that only APPEAR to overlap alone once the drive is short enough', () => {
    const laid = packLanes([block('meeting', 540, 600), { ...block('away', 620, 700), travelMinutes: 15 }]);
    expect(laid.every((b) => b.widthFrac === 1)).toBe(true);
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

  it('counts a travel band as part of the first event', () => {
    expect(initialScrollY(null, [{ startMin: 540, travelMinutes: 60 }], viewport)).toBe(450);
  });

  it('defaults to 8 AM on empty days and clamps to the scroll range', () => {
    expect(initialScrollY(null, [], viewport)).toBe(480);
    expect(initialScrollY(0, [], viewport)).toBe(0); // early-morning clamp
    expect(initialScrollY(DAY_MIN, [], viewport)).toBe(DAY_MIN - viewport); // late-night clamp
  });
});

describe('longPressDraft (long-press → new-event seed)', () => {
  it('snaps the press to its 15-minute slot, one hour long, all-day off', () => {
    // 9:22 AM press (1 px/min) → the 9:15 slot.
    expect(longPressDraft('2026-08-14', 9 * 60 + 22)).toEqual({
      allDay: false,
      startTime: '09:15',
      endTime: '10:15',
    });
    expect(longPressDraft('2026-08-14', 0)).toEqual({
      allDay: false,
      startTime: '00:00',
      endTime: '01:00',
    });
  });

  it('rolls the end past midnight into the next day from a last-hour press', () => {
    expect(longPressDraft('2026-08-14', 23 * 60 + 40)).toEqual({
      allDay: false,
      startTime: '23:30',
      endTime: '00:30',
      endDate: '2026-08-15',
    });
  });

  it('clamps a press beyond the canvas to the last slot of the day', () => {
    expect(longPressDraft('2026-08-14', DAY_MIN + 50)).toEqual({
      allDay: false,
      startTime: '23:45',
      endTime: '00:45',
      endDate: '2026-08-15',
    });
    expect(longPressDraft('2026-08-14', -10).startTime).toBe('00:00');
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

  it('collapses a block’s start–end range the way Apple does', () => {
    // One meridiem when both sides share it, and no ":00" on the hour.
    expect(timeRangeLabel(9 * 60, 11 * 60)).toBe('9 – 11AM');
    expect(timeRangeLabel(13 * 60, 14 * 60 + 30)).toBe('1 – 2:30PM');
    // Crossing noon, each side has to carry its own.
    expect(timeRangeLabel(11 * 60 + 30, 13 * 60)).toBe('11:30AM – 1PM');
    // Midnight and noon read as 12, not 0.
    expect(timeRangeLabel(0, 30)).toBe('12 – 12:30AM');
    expect(timeRangeLabel(12 * 60, 13 * 60)).toBe('12 – 1PM');
  });
});

describe('block detail tiers', () => {
  it('shows title, location and time only where all three fit', () => {
    expect(blockDetail(58)).toBe('full'); // a one-hour event
    expect(blockDetail(56)).toBe('full');
    expect(blockDetail(55)).toBe('medium');
  });

  it('drops to title + time, then to the title alone, as the block shrinks', () => {
    expect(blockDetail(38)).toBe('medium');
    expect(blockDetail(37)).toBe('compact');
    expect(blockDetail(MIN_BLOCK - 2)).toBe('compact'); // the shortest block there is
  });

  it('gives the title a second line only where one fits above the meta rows', () => {
    expect(blockTitleLines(78)).toBe(2);
    expect(blockTitleLines(77)).toBe(1);
  });
});

describe('travel band labels', () => {
  it('names travel outright when the band can carry a line', () => {
    expect(travelBandLabel(15, 15)).toBe('15 min travel');
    expect(travelBandLabel(90, 90)).toBe('1 hr 30 min travel');
  });

  it('falls silent on a band too short to print one', () => {
    expect(travelBandLabel(13, 13)).toBeNull();
    expect(travelBandLabel(0, 60)).toBeNull();
  });

  it('always spells the band out for a screen reader', () => {
    expect(travelAccessibilityLabel(30, 10 * 60)).toBe(
      '30 min travel time before this event — leave by 9:30 AM'
    );
  });
});
