import { startKeepingDuration, startTimeKeepingDuration, addDays, daysBetween, minutesToTime, timeToMinutes } from '../datetime';

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
