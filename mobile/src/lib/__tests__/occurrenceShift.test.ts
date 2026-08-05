// A repeating event is ONE record starting on the series' first day, but the
// user opens it from the calendar cell they tapped. These helpers move a form's
// when-block between those two frames. The failure they guard is silent and
// destructive: without the shift the form shows the wrong day, and without the
// inverse a plain save drags the whole series onto whichever occurrence the
// user happened to open.
//
// Pinned to a DST-observing zone west of UTC — every interesting failure here
// (an hour of drift rounding a day difference, an all-day event sliding off
// noon UTC) only reproduces where the offset changes mid-series.
process.env.TZ = 'America/New_York';

import {
  daysBetween, addDays, shiftEventWhen, occurrenceShiftDays,
  eventWhenFromStored, eventStoredFromWhen, EventWhen,
} from '../calendar';

// If the runner ignores the TZ pin, the DST cases below prove nothing.
const pinned = new Date(2026, 7, 3, 23, 5).toISOString() === '2026-08-04T03:05:00.000Z';

const when = (o: Partial<EventWhen> = {}): EventWhen => ({
  allDay: false,
  date: '2026-08-06',
  startTime: '10:30',
  endDate: '',
  endTime: '11:00',
  ...o,
});

describe('day arithmetic', () => {
  it('pins the test timezone to America/New_York', () => {
    expect(pinned).toBe(true);
  });

  it('counts whole days forward and back', () => {
    expect(daysBetween('2026-08-06', '2026-08-20')).toBe(14);
    expect(daysBetween('2026-08-20', '2026-08-06')).toBe(-14);
    expect(daysBetween('2026-08-06', '2026-08-06')).toBe(0);
  });

  // Read at midnight instead of noon, a spring-forward day is 23h and a
  // fall-back day 25h — enough for the division to round to 0 or 2.
  it('counts across both DST boundaries without rounding away a day', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // spring forward
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1); // fall back
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
  });

  it('adds days across a month, a year, and a leap day', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('round-trips: addDays is the inverse of daysBetween', () => {
    const n = daysBetween('2026-03-01', '2026-11-15');
    expect(addDays('2026-03-01', n)).toBe('2026-11-15');
  });
});

describe('shiftEventWhen', () => {
  it('is identity for a zero shift', () => {
    const w = when();
    expect(shiftEventWhen(w, 0)).toBe(w);
  });

  it('moves the start and keeps the clock times', () => {
    const w = shiftEventWhen(when(), 14);
    expect(w.date).toBe('2026-08-20');
    expect(w.startTime).toBe('10:30');
    expect(w.endTime).toBe('11:00');
  });

  // '' means "ends the same day as it starts". A shift never changes the span,
  // so it must stay '' — writing a concrete end day here would break the End
  // date row's invariant and make a same-day event render as multi-day.
  it('leaves a same-day end unset', () => {
    expect(shiftEventWhen(when(), 14).endDate).toBe('');
  });

  it('carries a multi-day span along whole', () => {
    const w = shiftEventWhen(when({ date: '2026-08-06', endDate: '2026-08-08' }), 14);
    expect(w.date).toBe('2026-08-20');
    expect(w.endDate).toBe('2026-08-22');
  });

  it('preserves the wall clock for a timed event shifted across a DST boundary', () => {
    // Mar 7 → Mar 9 2026 crosses spring-forward; 10:30am must stay 10:30am.
    const moved = shiftEventWhen(when({ date: '2026-03-07' }), 2);
    expect(moved.date).toBe('2026-03-09');
    const stored = eventStoredFromWhen(moved);
    expect(eventWhenFromStored({ ...stored, allDay: false }).startTime).toBe('10:30');
  });

  it('keeps an all-day event pinned to noon UTC across a DST boundary', () => {
    const stored = eventStoredFromWhen(shiftEventWhen(when({ allDay: true, date: '2026-03-07' }), 2));
    expect(stored.startDate).toBe('2026-03-09T12:00:00.000Z');
  });
});

describe('occurrenceShiftDays', () => {
  it('is 0 for a one-off event, whatever day it was opened from', () => {
    expect(occurrenceShiftDays(when(), '2026-08-20', false)).toBe(0);
  });

  it('is 0 when no occurrence day was passed (opened from search)', () => {
    expect(occurrenceShiftDays(when(), undefined, true)).toBe(0);
  });

  it('is 0 on the series own first occurrence', () => {
    expect(occurrenceShiftDays(when(), '2026-08-06', true)).toBe(0);
  });

  it('measures a later occurrence from the series start', () => {
    expect(occurrenceShiftDays(when(), '2026-08-20', true)).toBe(14);
  });
});

describe('the round trip a save depends on', () => {
  // The form displays the occurrence; a whole-series save shifts back. If these
  // two aren't exact inverses, every edit walks the series start.
  it('returns an untouched occurrence edit to the series start', () => {
    const series = when({ date: '2026-08-06' });
    const shift = occurrenceShiftDays(series, '2026-08-20', true);
    const shown = shiftEventWhen(series, shift);
    expect(shown.date).toBe('2026-08-20');
    expect(shiftEventWhen(shown, -shift).date).toBe('2026-08-06');
  });

  it('carries a time-only edit back to the series without moving its day', () => {
    const series = when({ date: '2026-08-06', startTime: '10:30' });
    const shift = occurrenceShiftDays(series, '2026-08-20', true);
    const edited = { ...shiftEventWhen(series, shift), startTime: '09:00' };
    const back = shiftEventWhen(edited, -shift);
    expect(back.date).toBe('2026-08-06');
    expect(back.startTime).toBe('09:00');
  });

  // Moving an occurrence one day later and saving the whole series must move
  // the series start by exactly one day — not onto the occurrence's day.
  it('applies a day move as a delta, not as an absolute date', () => {
    const series = when({ date: '2026-08-06' });
    const shift = occurrenceShiftDays(series, '2026-08-20', true);
    const edited = shiftEventWhen(series, shift);
    const moved = { ...edited, date: '2026-08-21' };
    expect(shiftEventWhen(moved, -shift).date).toBe('2026-08-07');
  });

  it('survives five open→save cycles without drifting', () => {
    let series = when({ date: '2026-08-06' });
    for (let i = 0; i < 5; i++) {
      const shift = occurrenceShiftDays(series, '2026-08-20', true);
      series = shiftEventWhen(shiftEventWhen(series, shift), -shift);
      expect(series.date).toBe('2026-08-06');
    }
  });
});
