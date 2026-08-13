import { EMPTY_REPEAT, RepeatRule, repeatsLine } from '../eventRepeat';

// The chore/task forms' Repeat row is this one self-labeled line — the whole
// rule must read at a glance, abbreviated enough to hold a single line.
describe('repeatsLine', () => {
  const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ ...EMPTY_REPEAT, ...patch });

  it('spells the interval and abbreviates weekdays with an ampersand', () => {
    expect(repeatsLine(rule({ freq: 'weekly', daysOfWeek: [2, 4] })))
      .toBe('Repeats every 1 week on Tue & Thu');
    expect(repeatsLine(rule({ freq: 'weekly', interval: 2, daysOfWeek: [3, 4] })))
      .toBe('Repeats every 2 weeks on Wed & Thu');
    expect(repeatsLine(rule({ freq: 'weekly', daysOfWeek: [1, 3, 5] })))
      .toBe('Repeats every 1 week on Mon, Wed & Fri');
  });

  it('never says "Weekly" — a plain rule still spells the cadence', () => {
    expect(repeatsLine(rule({ freq: 'weekly' }))).toBe('Repeats every 1 week');
    expect(repeatsLine(rule({ freq: 'daily' }))).toBe('Repeats every 1 day');
    expect(repeatsLine(rule({ freq: 'daily', interval: 3 }))).toBe('Repeats every 3 days');
  });

  it('phrases monthly numbered dates and ordinal weekdays', () => {
    expect(repeatsLine(rule({ freq: 'monthly', daysOfMonth: [1, 15] })))
      .toBe('Repeats every 1 month on the 1st & 15th');
    expect(repeatsLine(rule({ freq: 'monthly', weekOfMonth: 2, weekdayKind: 'tue' })))
      .toBe('Repeats every 1 month on the second Tuesday');
  });

  it('abbreviates yearly months', () => {
    expect(repeatsLine(rule({ freq: 'yearly', months: [6, 12] })))
      .toBe('Repeats every 1 year in Jun & Dec');
  });

  it('says so when the rule is off', () => {
    expect(repeatsLine(rule({ freq: '' }))).toBe('Does not repeat');
  });
});
