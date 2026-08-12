// The month grid's unbounded-scroll window rules: initial span, edge
// extensions, jump coverage, chunk ranges, and the per-month chunk merge
// (identity dedup for records that intersect two chunks).

import {
  addMonths,
  ensureCovers,
  extendFuture,
  extendPast,
  initialWindow,
  mergeCalendarChunks,
  monthRange,
  monthsIn,
  ymIndex,
  ymKey,
  EXTEND_MONTHS,
  INITIAL_FUTURE_MONTHS,
  INITIAL_PAST_MONTHS,
} from '../calendarWindow';
import type { CalendarData } from '../../api';

const NOW = new Date(2026, 7, 1); // Aug 1 2026 (local)

describe('window math', () => {
  it('initialWindow spans last month through a season ahead', () => {
    const w = initialWindow(NOW);
    expect(w.start).toEqual({ year: 2026, month: 6 }); // July
    expect(w.end).toEqual({ year: 2026, month: 10 }); // November
    expect(ymIndex(w.end) - ymIndex(w.start)).toBe(INITIAL_PAST_MONTHS + INITIAL_FUTURE_MONTHS);
  });

  it('addMonths carries across year boundaries both ways', () => {
    expect(addMonths({ year: 2026, month: 10 }, 3)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -3)).toEqual({ year: 2025, month: 10 });
  });

  it('extendPast/extendFuture grow one edge by EXTEND_MONTHS', () => {
    const w = initialWindow(NOW);
    const past = extendPast(w);
    expect(past.start).toEqual(addMonths(w.start, -EXTEND_MONTHS));
    expect(past.end).toEqual(w.end);
    const fut = extendFuture(w);
    expect(fut.end).toEqual(addMonths(w.end, EXTEND_MONTHS));
    expect(fut.start).toEqual(w.start);
  });

  it('ensureCovers grows to a far target with margin, and no-ops in-window', () => {
    const w = initialWindow(NOW);
    const jumped = ensureCovers(w, { year: 2028, month: 2 });
    expect(jumped.start).toEqual(w.start);
    expect(jumped.end).toEqual({ year: 2028, month: 3 }); // target + 1 margin
    const back = ensureCovers(w, { year: 2025, month: 0 });
    expect(back.start).toEqual({ year: 2024, month: 11 });
    expect(back.end).toEqual(w.end);
    // Already covered → the SAME object, so setState callers can no-op.
    expect(ensureCovers(w, { year: 2026, month: 8 })).toBe(w);
  });

  it('monthsIn lists the inclusive span across a year boundary', () => {
    const months = monthsIn({ start: { year: 2026, month: 10 }, end: { year: 2027, month: 1 } });
    expect(months.map(ymKey)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('monthRange covers first through last day at local midnight', () => {
    const r = monthRange({ year: 2026, month: 1 }); // Feb 2026
    expect(new Date(r.from).getDate()).toBe(1);
    expect(new Date(r.to).getDate()).toBe(28);
    expect(new Date(r.to).getMonth()).toBe(1);
  });
});

describe('mergeCalendarChunks', () => {
  const empty: CalendarData = {
    tasks: [], chores: [], events: [], occasions: [], recipes: [], groceryShopping: [], trips: [],
  };

  it('dedups records that intersect two chunks, keyed by identity', () => {
    const span = { _id: 'e1', title: 'Trip prep', calendarType: 'appointments', startDate: '2026-08-30T12:00:00Z', endDate: '2026-09-02T12:00:00Z' };
    const aug: CalendarData = {
      ...empty,
      events: [span as any],
      tasks: [{ _id: 't1', title: 'Furnace filter' } as any],
      trips: [{ id: 'trip1', name: 'Lake', ranges: [] }],
      groceryShopping: [{ id: 'g1', date: '2026-08-31' }],
    };
    const sep: CalendarData = {
      ...empty,
      events: [span as any],
      tasks: [{ _id: 't1', title: 'Furnace filter' } as any],
      trips: [{ id: 'trip1', name: 'Lake', ranges: [] }],
      groceryShopping: [{ id: 'g1', date: '2026-08-31' }, { id: 'g2', date: '2026-09-07' }],
    };
    const merged = mergeCalendarChunks([aug, sep]);
    expect(merged.events).toHaveLength(1);
    expect(merged.tasks).toHaveLength(1);
    expect(merged.trips).toHaveLength(1);
    expect(merged.groceryShopping.map((g) => g.date)).toEqual(['2026-08-31', '2026-09-07']);
  });

  it('keeps distinct occurrences of a recurring event (same _id, different start)', () => {
    const occ = (startDate: string) => ({ _id: 'r1', title: 'Standup', calendarType: 'appointments', startDate }) as any;
    const merged = mergeCalendarChunks([
      { ...empty, events: [occ('2026-09-01T15:00:00Z')] },
      { ...empty, events: [occ('2026-08-25T15:00:00Z'), occ('2026-09-01T15:00:00Z')] },
    ]);
    expect(merged.events).toHaveLength(2);
    // Re-sorted by start across chunks.
    expect(merged.events.map((e) => e.startDate)).toEqual(['2026-08-25T15:00:00Z', '2026-09-01T15:00:00Z']);
  });

  it('keeps distinct occurrences of a recurring chore/task (same _id, different due date)', () => {
    // The shared engine expands a recurring chore into one instance per due
    // date, stamped with _instanceDate and a Date-typed nextDueDate. Keying on
    // _id alone collapsed them, so the grid showed a monthly chore once.
    const occ = (day: string) =>
      ({ _id: 'c1', title: 'Vacuum', nextDueDate: new Date(`${day}T12:00:00`), _instanceDate: day }) as any;
    const merged = mergeCalendarChunks([
      { ...empty, chores: [occ('2026-08-05')], tasks: [occ('2026-08-05')] },
      { ...empty, chores: [occ('2026-08-05'), occ('2026-09-05')], tasks: [occ('2026-09-05')] },
    ]);
    expect(merged.chores.map((c: any) => c._instanceDate)).toEqual(['2026-08-05', '2026-09-05']);
    expect(merged.tasks).toHaveLength(2);
  });

  it('falls back to nextDueDate when the engine stamped no _instanceDate', () => {
    const occ = (due: string) => ({ _id: 'c2', title: 'Filters', nextDueDate: due }) as any;
    const merged = mergeCalendarChunks([
      { ...empty, chores: [occ('2026-08-05T12:00:00.000Z')] },
      { ...empty, chores: [occ('2026-08-05T12:00:00.000Z'), occ('2026-09-05T12:00:00.000Z')] },
    ]);
    expect(merged.chores).toHaveLength(2);
  });

  it('dedups occasions per date and recipes per schedule', () => {
    const merged = mergeCalendarChunks([
      { ...empty, occasions: [{ id: 'o1', kind: 'birthday', name: 'Ann', label: 'Birthday', date: '2026-08-20T12:00:00Z', contactId: 'p1' } as any], recipes: [{ _id: 's1', scheduledDate: '2026-08-20T12:00:00Z', recipeId: 'rec1' }] },
      { ...empty, occasions: [{ id: 'o1', kind: 'birthday', name: 'Ann', label: 'Birthday', date: '2026-08-20T12:00:00Z', contactId: 'p1' } as any], recipes: [{ _id: 's1', scheduledDate: '2026-08-20T12:00:00Z', recipeId: 'rec1' }] },
    ]);
    expect(merged.occasions).toHaveLength(1);
    expect(merged.recipes).toHaveLength(1);
  });
});
