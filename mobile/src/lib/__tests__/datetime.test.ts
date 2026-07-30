import {
  startKeepingDuration, startTimeKeepingDuration,
  endKeepingDuration, endTimeKeepingDuration,
  addDays, daysBetween, minutesToTime, timeToMinutes,
} from '../datetime';

const D = '2026-07-29';

describe('startKeepingDuration (date+time pairs)', () => {
  it('drags the start back when the end moves before it, preserving the gap', () => {
    // 8–9am, end → 4am ⇒ start becomes 3am (the canonical example)
    const out = startKeepingDuration({ date: D, time: '08:00' }, { date: D, time: '09:00' }, { date: D, time: '04:00' });
    expect(out).toEqual({ date: D, time: '03:00' });
  });

  it('leaves the start alone when the new end is still after it', () => {
    expect(startKeepingDuration({ date: D, time: '08:00' }, { date: D, time: '09:00' }, { date: D, time: '10:00' })).toBeNull();
  });

  it('does nothing when the pair had no positive duration', () => {
    expect(startKeepingDuration({ date: D, time: '08:00' }, { date: D, time: '08:00' }, { date: D, time: '04:00' })).toBeNull();
  });

  it('rolls the start to the previous day when the shift crosses midnight', () => {
    // 00:30–01:00 (30 min), end → 00:10 ⇒ start 23:40 the day before
    const out = startKeepingDuration({ date: D, time: '00:30' }, { date: D, time: '01:00' }, { date: D, time: '00:10' });
    expect(out).toEqual({ date: '2026-07-28', time: '23:40' });
  });

  it('preserves a multi-day span for date-only pairs', () => {
    // 3-day trip (29th→1st), end pulled to the 28th ⇒ start slides back 3 days to the 25th
    const out = startKeepingDuration({ date: D, time: '00:00' }, { date: '2026-08-01', time: '00:00' }, { date: '2026-07-28', time: '00:00' });
    expect(out).toEqual({ date: '2026-07-25', time: '00:00' });
  });

  it('accounts for a multi-day original end when shifting', () => {
    // start 29th 10:00, end 30th 12:00 (26h), end → 29th 08:00 ⇒ start 28th 06:00
    const out = startKeepingDuration({ date: D, time: '10:00' }, { date: '2026-07-30', time: '12:00' }, { date: D, time: '08:00' });
    expect(out).toEqual({ date: '2026-07-28', time: '06:00' });
  });
});

describe('startTimeKeepingDuration (same-day time windows)', () => {
  it('pulls the start back and clamps at midnight', () => {
    expect(startTimeKeepingDuration('08:00', '09:00', '04:00')).toBe('03:00');
    // would land before 00:00 → clamped
    expect(startTimeKeepingDuration('01:00', '02:00', '00:30')).toBe('00:00');
  });

  it('returns null when the end stays after the start or the window is empty', () => {
    expect(startTimeKeepingDuration('08:00', '09:00', '10:00')).toBeNull();
    expect(startTimeKeepingDuration('08:00', '08:00', '04:00')).toBeNull();
  });
});

describe('endKeepingDuration (date+time pairs)', () => {
  it('pushes the end forward when the start moves past it, preserving the gap', () => {
    // 8–9am, start → 10am ⇒ end becomes 11am (mirror of the canonical example)
    const out = endKeepingDuration({ date: D, time: '08:00' }, { date: D, time: '09:00' }, { date: D, time: '10:00' });
    expect(out).toEqual({ date: D, time: '11:00' });
  });

  it('leaves the end alone when the new start is still before it', () => {
    expect(endKeepingDuration({ date: D, time: '08:00' }, { date: D, time: '09:00' }, { date: D, time: '08:30' })).toBeNull();
  });

  it('leaves the end alone when the new start exactly equals it (zero-length allowed)', () => {
    expect(endKeepingDuration({ date: D, time: '08:00' }, { date: D, time: '09:00' }, { date: D, time: '09:00' })).toBeNull();
  });

  it('does nothing when the pair had no positive duration', () => {
    expect(endKeepingDuration({ date: D, time: '09:00' }, { date: D, time: '09:00' }, { date: D, time: '10:00' })).toBeNull();
  });

  it('rolls the end to the next day when the shift crosses midnight', () => {
    // 23:00–23:30 (30 min), start → 23:50 ⇒ end 00:20 the next day
    const out = endKeepingDuration({ date: D, time: '23:00' }, { date: D, time: '23:30' }, { date: D, time: '23:50' });
    expect(out).toEqual({ date: '2026-07-30', time: '00:20' });
  });

  it('closes the equal-date hole: start date advanced onto a same-clock end pushes the end out', () => {
    // start 29th 09:00 → 30th 08:00 (23h), start date → 30th ⇒ end 31st 08:00 (span kept)
    const out = endKeepingDuration({ date: D, time: '09:00' }, { date: '2026-07-30', time: '08:00' }, { date: '2026-07-30', time: '09:00' });
    expect(out).toEqual({ date: '2026-07-31', time: '08:00' });
  });

  it('preserves a multi-day span for date-only pairs', () => {
    // 3-day trip (29th→1st), start pushed to the 1st ⇒ end slides forward 3 days to the 4th
    const out = endKeepingDuration({ date: D, time: '00:00' }, { date: '2026-08-01', time: '00:00' }, { date: '2026-08-01', time: '00:00' });
    expect(out).toBeNull(); // start == end date, zero shift trigger
    const out2 = endKeepingDuration({ date: D, time: '00:00' }, { date: '2026-08-01', time: '00:00' }, { date: '2026-08-02', time: '00:00' });
    expect(out2).toEqual({ date: '2026-08-05', time: '00:00' });
  });
});

describe('endTimeKeepingDuration (same-day time windows)', () => {
  it('pushes the end forward and clamps at 23:59', () => {
    expect(endTimeKeepingDuration('09:00', '12:00', '13:00')).toBe('16:00');
    // would land after 23:59 → clamped
    expect(endTimeKeepingDuration('22:00', '23:00', '23:30')).toBe('23:59');
  });

  it('returns null when the start stays before the end or the window is empty', () => {
    expect(endTimeKeepingDuration('09:00', '12:00', '10:00')).toBeNull();
    expect(endTimeKeepingDuration('09:00', '09:00', '13:00')).toBeNull();
  });
});

describe('date/time primitives', () => {
  it('addDays handles negative offsets and month boundaries', () => {
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
  });
  it('daysBetween counts whole days', () => {
    expect(daysBetween('2026-07-29', '2026-08-01')).toBe(3);
    expect(daysBetween('2026-08-01', '2026-07-29')).toBe(-3);
  });
  it('minutesToTime / timeToMinutes round-trip and wrap', () => {
    expect(minutesToTime(timeToMinutes('23:45'))).toBe('23:45');
    expect(minutesToTime(-20)).toBe('23:40');
  });
});
