import {
  ordinal,
  recurrenceLabel,
  recurrenceLabelShort,
  makeRecurrenceForm,
  recurrenceToForm,
  buildRecurrencePayload,
  recurrencePreview,
  alertSummary,
  dueStatus,
  dueInLabel,
  parseCalendarDate,
  formatCalendarDate,
  mdiName,
  patchTouchesRecurrence,
  applyRecurrenceAssistPatch,
  recurrenceAssistCurrent,
  recurrenceToRule,
  ruleToRecurrence,
  dueDateForRule,
  excludeUsedAlert,
  ruleDateMismatch,
  ruleLossyForItem,
} from '../recurrence';
import { Recurrence } from '../../api';
import { EMPTY_REPEAT, RepeatRule } from '../eventRepeat';

describe('ordinal', () => {
  it('handles the standard suffixes', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
  });

  it('handles the 11-13 exceptions', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(111)).toBe('111th');
  });

  it('handles 21-23 and beyond', () => {
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(23)).toBe('23rd');
    expect(ordinal(31)).toBe('31st');
  });

  it('returns empty string for null/undefined', () => {
    expect(ordinal(null)).toBe('');
    expect(ordinal(undefined)).toBe('');
  });
});

describe('recurrenceLabel', () => {
  it('returns empty for missing recurrence', () => {
    expect(recurrenceLabel(null)).toBe('');
    expect(recurrenceLabel(undefined)).toBe('');
  });

  it('labels one-time', () => {
    expect(recurrenceLabel({ type: 'one-time' })).toBe('One-time');
  });

  it('labels calendar recurrences with months and day', () => {
    expect(recurrenceLabel({ type: 'calendar', months: [3, 9], dayOfMonth: 15 }))
      .toBe('Every year in March, September on the 15th');
    expect(recurrenceLabel({ type: 'calendar', months: [1] }))
      .toBe('Every year in January');
  });

  it('singularizes the unit when the interval is 1', () => {
    expect(recurrenceLabel({ type: 'interval', intervalValue: 1, intervalUnit: 'weeks' }))
      .toBe('Every 1 week');
    expect(recurrenceLabel({ type: 'interval', intervalValue: 2, intervalUnit: 'weeks' }))
      .toBe('Every 2 weeks');
  });

  it('includes the weekday for weekly recurrences', () => {
    expect(recurrenceLabel({ type: 'interval', intervalValue: 2, intervalUnit: 'weeks', dayOfWeek: 1 }))
      .toBe('Every 2 weeks on Monday');
  });

  it('labels monthly by day-of-month and by nth-weekday', () => {
    expect(recurrenceLabel({ type: 'interval', intervalValue: 1, intervalUnit: 'months', dayOfMonth: 10 }))
      .toBe('Every 1 month on the 10th');
    expect(recurrenceLabel({
      type: 'interval', intervalValue: 3, intervalUnit: 'months', weekOfMonth: 2, dayOfWeek: 5,
    })).toBe('Every 3 months on the second Friday');
    expect(recurrenceLabel({
      type: 'interval', intervalValue: 1, intervalUnit: 'months', weekOfMonth: -1, dayOfWeek: 0,
    })).toBe('Every 1 month on the last Sunday');
  });

  it('labels yearly with month/day anchors', () => {
    expect(recurrenceLabel({
      type: 'interval', intervalValue: 1, intervalUnit: 'years', months: [7], dayOfMonth: 4,
    })).toBe('Every 1 year on July 4th');
    expect(recurrenceLabel({ type: 'interval', intervalValue: 1, intervalUnit: 'years', months: [7] }))
      .toBe('Every 1 year in July');
  });
});

describe('recurrenceLabelShort', () => {
  it('abbreviates months and joins with &', () => {
    expect(recurrenceLabelShort({ type: 'calendar', months: [3, 9], dayOfMonth: 1 }))
      .toBe('Every year in Mar & Sep on the 1st');
  });

  it('drops interval anchors', () => {
    expect(recurrenceLabelShort({
      type: 'interval', intervalValue: 2, intervalUnit: 'weeks', dayOfWeek: 1,
    })).toBe('Every 2 weeks');
  });
});

describe('buildRecurrencePayload', () => {
  it('keeps only the weekday anchor for weekly intervals', () => {
    const form = makeRecurrenceForm({
      intervalUnit: 'weeks', dayOfWeek: 2, dayOfMonth: 15, weekOfMonth: 3,
    });
    expect(buildRecurrencePayload(form, 'day')).toEqual({
      type: 'interval', intervalValue: 1, intervalUnit: 'weeks', months: [], dayOfWeek: 2,
    });
  });

  it('keeps dayOfMonth for monthly in day mode, weekOfMonth+dayOfWeek in weekday mode', () => {
    const form = makeRecurrenceForm({
      intervalUnit: 'months', dayOfMonth: 15, weekOfMonth: 2, dayOfWeek: 5,
    });
    expect(buildRecurrencePayload(form, 'day')).toEqual({
      type: 'interval', intervalValue: 1, intervalUnit: 'months', months: [], dayOfMonth: 15,
    });
    expect(buildRecurrencePayload(form, 'weekday')).toEqual({
      type: 'interval', intervalValue: 1, intervalUnit: 'months', months: [], weekOfMonth: 2, dayOfWeek: 5,
    });
  });

  it('keeps months and dayOfMonth for yearly intervals', () => {
    const form = makeRecurrenceForm({
      intervalUnit: 'years', months: [7], dayOfMonth: 4, dayOfWeek: 3,
    });
    expect(buildRecurrencePayload(form, 'day')).toEqual({
      type: 'interval', intervalValue: 1, intervalUnit: 'years', months: [7], dayOfMonth: 4,
    });
  });

  it('keeps months/dayOfMonth for calendar type', () => {
    const form = makeRecurrenceForm({ type: 'calendar', months: [1, 6], dayOfMonth: 1 });
    expect(buildRecurrencePayload(form, 'day')).toEqual({
      type: 'calendar', months: [1, 6], dayOfMonth: 1,
    });
  });

  it('strips everything for one-time', () => {
    const form = makeRecurrenceForm({ type: 'one-time', dayOfMonth: 5, months: [2] });
    expect(buildRecurrencePayload(form, 'day')).toEqual({ type: 'one-time' });
  });
});

describe('recurrenceToForm', () => {
  it('round-trips a saved recurrence through the form', () => {
    const saved: Recurrence = {
      type: 'interval', intervalValue: 3, intervalUnit: 'months', weekOfMonth: 2, dayOfWeek: 5,
    };
    const { form, monthlyMode } = recurrenceToForm(saved);
    expect(monthlyMode).toBe('weekday');
    expect(buildRecurrencePayload(form, monthlyMode)).toEqual({ ...saved, months: [] });
  });

  it('defaults monthlyMode to day when no weekOfMonth', () => {
    const { monthlyMode } = recurrenceToForm({
      type: 'interval', intervalValue: 1, intervalUnit: 'months', dayOfMonth: 10,
    });
    expect(monthlyMode).toBe('day');
  });
});

describe('recurrencePreview', () => {
  it('returns "Runs once" for one-time', () => {
    expect(recurrencePreview(makeRecurrenceForm({ type: 'one-time' }), 'day')).toBe('Runs once');
  });

  it('returns null for calendar with no months selected', () => {
    expect(recurrencePreview(makeRecurrenceForm({ type: 'calendar' }), 'day')).toBeNull();
  });

  it('uses short weekday names for weekly previews', () => {
    const form = makeRecurrenceForm({ intervalValue: 2, intervalUnit: 'weeks', dayOfWeek: 1 });
    expect(recurrencePreview(form, 'day')).toBe('Every 2 weeks on Mon');
  });
});

describe('alertSummary', () => {
  it('reports no alerts when both are unset', () => {
    expect(alertSummary({})).toBe('No alerts');
  });

  it('phrases day counts naturally', () => {
    expect(alertSummary({ reminderDaysBefore: 0 })).toBe('On the due date');
    expect(alertSummary({ reminderDaysBefore: 1 })).toBe('1 day before');
    expect(alertSummary({ reminderDaysBefore: 7 })).toBe('1 week before');
    expect(alertSummary({ reminderDaysBefore: 3 })).toBe('3 days before');
  });

  it('joins two alerts and appends owner audience', () => {
    expect(alertSummary({ reminderDaysBefore: 7, alert2DaysBefore: 1, alertAudience: 'owner' }))
      .toBe('1 week before · 1 day before · you only');
  });
});

describe('excludeUsedAlert', () => {
  const opts = [
    { label: 'None', value: -1 },
    { label: 'Custom…', value: -2 },
    { label: 'On the day', value: 0 },
    { label: '1 day before', value: 1 },
    { label: '1 week before', value: 7 },
  ];

  it('returns the full list when nothing is used yet', () => {
    expect(excludeUsedAlert(opts, null)).toEqual(opts);
    expect(excludeUsedAlert(opts, undefined)).toEqual(opts);
  });

  it('does not filter on a negative sentinel (None/Custom)', () => {
    expect(excludeUsedAlert(opts, -1)).toEqual(opts);
  });

  it('removes the value already chosen in the paired slot', () => {
    expect(excludeUsedAlert(opts, 1).map((o) => o.value)).toEqual([-1, -2, 0, 7]);
  });

  it('keeps the "off" and Custom sentinels even when a real value is used', () => {
    const kept = excludeUsedAlert(opts, 0).map((o) => o.value);
    expect(kept).toContain(-1);
    expect(kept).toContain(-2);
    expect(kept).not.toContain(0);
  });

  it('never hides the slot\'s own current value (legacy duplicate stays visible)', () => {
    // Pre-existing data where both slots equal 7: this slot must still show 7.
    expect(excludeUsedAlert(opts, 7, 7).map((o) => o.value)).toContain(7);
  });
});

describe('dueStatus', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 8, 9, 30)); // July 8 2026, local
  });
  afterEach(() => jest.useRealTimers());

  it('returns none when no date', () => {
    expect(dueStatus(null)).toEqual({ status: 'none', label: 'No date' });
  });

  it('flags past dates as overdue', () => {
    expect(dueStatus('2026-07-07').status).toBe('overdue');
  });

  it('flags today and the next 6 days as due soon', () => {
    expect(dueStatus('2026-07-08').status).toBe('soon');
    expect(dueStatus('2026-07-14').status).toBe('soon');
  });

  it('flags dates 7+ days out as upcoming', () => {
    expect(dueStatus('2026-07-15').status).toBe('upcoming');
  });
});

describe('dueInLabel', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 8, 9, 30)); // July 8 2026, local
  });
  afterEach(() => jest.useRealTimers());

  it('returns Not set when no date', () => {
    expect(dueInLabel(null)).toBe('Not set');
  });

  it('labels today and future dates', () => {
    expect(dueInLabel('2026-07-08')).toBe('Due today');
    expect(dueInLabel('2026-07-09')).toBe('Due in 1 day');
    expect(dueInLabel('2026-07-12')).toBe('Due in 4 days');
  });

  it('reports a past day as past', () => {
    expect(dueInLabel('2026-07-07')).toBe('Due yesterday');
    expect(dueInLabel('2026-07-01')).toBe('Due 7 days ago');
  });
});

describe('parseCalendarDate', () => {
  it('reads a UTC-midnight ISO string as the same calendar day locally', () => {
    const d = parseCalendarDate('2026-03-05T00:00:00.000Z');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(12);
  });

  it('handles plain YYYY-MM-DD strings', () => {
    const d = parseCalendarDate('2026-12-31');
    expect(d.getDate()).toBe(31);
    expect(d.getMonth()).toBe(11);
  });
});

describe('formatCalendarDate', () => {
  it('returns Not set for missing dates', () => {
    expect(formatCalendarDate(null)).toBe('Not set');
    expect(formatCalendarDate(undefined)).toBe('Not set');
  });

  it('formats the UTC calendar day, not the local shift of midnight', () => {
    expect(formatCalendarDate('2026-03-05T00:00:00.000Z')).toMatch(/Mar 5, 2026/);
  });
});

describe('mdiName', () => {
  it('strips the mdi- prefix', () => {
    expect(mdiName('mdi-broom')).toBe('broom');
    expect(mdiName('calendar')).toBe('calendar');
  });

  it('falls back to broom', () => {
    expect(mdiName(null)).toBe('broom');
    expect(mdiName('')).toBe('broom');
  });
});

describe('form-assist recurrence patches', () => {
  const weekly = (day: number): RepeatRule => ({
    ...EMPTY_REPEAT,
    freq: 'weekly',
    interval: 1,
    daysOfWeek: [day],
  });

  it('detects repeat* keys', () => {
    expect(patchTouchesRecurrence({ repeatWeekday: 6 })).toBe(true);
    expect(patchTouchesRecurrence({ title: 'x' })).toBe(false);
  });

  it('changes an existing weekly rule to a new weekday ("laundry on Saturdays")', () => {
    // Started weekly on Sunday (0); user asks for Saturday (6).
    const next = applyRecurrenceAssistPatch(weekly(0), { repeatWeekday: 6 });
    expect(next.freq).toBe('weekly');
    expect(next.daysOfWeek).toEqual([6]);
    // The rule the form saves resolves to a Saturday weekly recurrence.
    expect(ruleToRecurrence(next)).toMatchObject({ type: 'interval', intervalUnit: 'weeks', dayOfWeek: 6 });
  });

  it('infers weekly frequency from a bare weekday when none is set', () => {
    const next = applyRecurrenceAssistPatch({ ...EMPTY_REPEAT }, { repeatWeekday: 3 });
    expect(next.freq).toBe('weekly');
    expect(next.daysOfWeek).toEqual([3]);
  });

  it('applies frequency + interval together', () => {
    const next = applyRecurrenceAssistPatch({ ...EMPTY_REPEAT }, { repeatFrequency: 'monthly', repeatInterval: 3, repeatDayOfMonth: 15 });
    expect(next.freq).toBe('monthly');
    expect(next.interval).toBe(3);
    expect(next.daysOfMonth).toEqual([15]);
  });

  it('turns repeating off with "none"', () => {
    const next = applyRecurrenceAssistPatch(weekly(1), { repeatFrequency: 'none' });
    expect(next.freq).toBe('');
    expect(ruleToRecurrence(next)).toEqual({ type: 'one-time' });
  });

  it('ignores out-of-range values', () => {
    const base = weekly(2);
    expect(applyRecurrenceAssistPatch(base, { repeatWeekday: 9 }).daysOfWeek).toEqual([2]);
    expect(applyRecurrenceAssistPatch(base, { repeatDayOfMonth: 40 }).daysOfMonth).toEqual([]);
    expect(applyRecurrenceAssistPatch(base, { repeatInterval: 0 }).interval).toBe(1);
  });

  it('projects a rule onto the assist field names', () => {
    expect(recurrenceAssistCurrent(weekly(6))).toEqual({
      repeatFrequency: 'weekly',
      repeatInterval: 1,
      repeatWeekday: 6,
      repeatDayOfMonth: null,
      repeatMonths: [],
    });
  });
});

// ── dueDateForRule ───────────────────────────────────────────────────────────
// The chore form reseeds Next Due Date from this whenever the repeat changes.
describe('dueDateForRule', () => {
  const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ ...EMPTY_REPEAT, ...patch });
  const from = new Date(2026, 7, 4, 12); // Tue 4 Aug 2026, local noon
  const ymd = (d: Date | null) =>
    d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  it('counts forward from the given day for a daily rule', () => {
    expect(ymd(dueDateForRule(rule({ freq: 'daily', interval: 3 }), from))).toBe('2026-08-07');
  });

  it('lands on the chosen weekday for a weekly rule', () => {
    expect(ymd(dueDateForRule(rule({ freq: 'weekly', interval: 1, daysOfWeek: [6] }), from))).toBe('2026-08-15');
  });

  it('lands on the chosen date for a monthly rule', () => {
    expect(ymd(dueDateForRule(rule({ freq: 'monthly', interval: 1, daysOfMonth: [1] }), from))).toBe('2026-09-01');
  });

  it('uses the next occurrence of a yearly rule’s month, not a year out', () => {
    expect(ymd(dueDateForRule(rule({ freq: 'yearly', interval: 1, months: [9] }), from))).toBe('2026-09-01');
  });

  it('implies no date when the rule does not repeat, so a picked date stands', () => {
    expect(dueDateForRule(rule({ freq: '' }), from)).toBeNull();
  });
});

// ── ruleDateMismatch ─────────────────────────────────────────────────────────
// The chore/task forms refuse to anchor a repeating series on a day its own
// rule never generates ("every week on Tuesday" due on a Wednesday). A detached
// "This Chore Only" save is exempt at the call site — it saves as one-time.
describe('ruleDateMismatch', () => {
  const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ ...EMPTY_REPEAT, ...patch });
  // Aug 2026: the 1st is a Saturday, so the 4th/11th/18th/25th are Tuesdays.

  it('accepts a date on the rule’s weekday', () => {
    expect(ruleDateMismatch(rule({ freq: 'weekly', daysOfWeek: [2] }), '2026-08-11')).toBeNull();
  });

  it('rejects a weekly date off the rule’s weekday, naming both sides', () => {
    const msg = ruleDateMismatch(rule({ freq: 'weekly', daysOfWeek: [2] }), '2026-08-12');
    expect(msg).toContain('Tuesday');
    expect(msg).toContain('Wednesday');
  });

  it('refuses a multi-day weekly rule outright — the sealed model stores one weekday', () => {
    // Previously accepted (the anchor merely had to land on ONE of the days),
    // which enshrined the silent collapse: ruleToRecurrence kept only the
    // first day, so "Tue & Thu" saved as Tuesday-only. Validation now mirrors
    // what is persistable: a multi-day rule is refused even on a matching day.
    const r = rule({ freq: 'weekly', interval: 2, daysOfWeek: [3, 4] });
    const msg = ruleDateMismatch(r, '2026-08-13'); // a Thursday — one of the picked days
    expect(msg).toContain('Wednesday and Thursday');
    expect(msg).toContain('one weekday');
    expect(ruleDateMismatch(r, '2026-08-14')).not.toBeNull();
  });

  it('pins no day for daily, plain, and off rules', () => {
    expect(ruleDateMismatch(rule({ freq: 'daily' }), '2026-08-12')).toBeNull();
    expect(ruleDateMismatch(rule({ freq: 'weekly' }), '2026-08-12')).toBeNull();
    expect(ruleDateMismatch(rule({ freq: '' }), '2026-08-12')).toBeNull();
  });

  it('checks monthly numbered dates', () => {
    const r = rule({ freq: 'monthly', daysOfMonth: [15] });
    expect(ruleDateMismatch(r, '2026-08-15')).toBeNull();
    expect(ruleDateMismatch(r, '2026-08-14')).toContain('15th');
  });

  it('checks the monthly ordinal weekday, including which one of the month', () => {
    const r = rule({ freq: 'monthly', weekOfMonth: 2, weekdayKind: 'tue' });
    expect(ruleDateMismatch(r, '2026-08-11')).toBeNull(); // the second Tuesday
    expect(ruleDateMismatch(r, '2026-08-12')).toContain('second Tuesday'); // a Wednesday
    expect(ruleDateMismatch(r, '2026-08-04')).toContain('second Tuesday'); // the FIRST Tuesday
  });

  it('counts last / next-to-last from the end of the month', () => {
    const last = rule({ freq: 'monthly', weekOfMonth: -1, weekdayKind: 'tue' });
    expect(ruleDateMismatch(last, '2026-08-25')).toBeNull();
    expect(ruleDateMismatch(last, '2026-08-18')).not.toBeNull();
    const nextToLast = rule({ freq: 'monthly', weekOfMonth: -2, weekdayKind: 'tue' });
    expect(ruleDateMismatch(nextToLast, '2026-08-18')).toBeNull();
  });

  it('accepts fifth and next-to-last ordinals on their exact days (post-engine-fix)', () => {
    const fifth = rule({ freq: 'monthly', weekOfMonth: 5, weekdayKind: 'tue' });
    expect(ruleDateMismatch(fifth, '2026-09-29')).toBeNull(); // the fifth Tuesday of Sep 2026
    expect(ruleDateMismatch(fifth, '2026-09-22')).toContain('fifth Tuesday'); // only the fourth
  });

  it('refuses the aggregate weekday/weekend/day kinds — the sealed model stores a specific weekday', () => {
    // Previously these validated by class; the chore/task Recurrence model has
    // only a single dayOfWeek, so ruleToRecurrence dropped them entirely and
    // the series saved as a plain monthly. They are now refused regardless of
    // the date, matching the restricted Repeat picker.
    expect(ruleDateMismatch(rule({ freq: 'monthly', weekOfMonth: 1, weekdayKind: 'weekday' }), '2026-08-03'))
      .toContain('specific weekday');
    expect(ruleDateMismatch(rule({ freq: 'monthly', weekOfMonth: 1, weekdayKind: 'weekend' }), '2026-08-01'))
      .toContain('specific weekday');
    expect(ruleDateMismatch(rule({ freq: 'monthly', weekOfMonth: -1, weekdayKind: 'day' }), '2026-08-31'))
      .toContain('specific weekday');
  });

  it('checks yearly months', () => {
    const r = rule({ freq: 'yearly', months: [6, 12] });
    expect(ruleDateMismatch(r, '2026-12-05')).toBeNull();
    expect(ruleDateMismatch(r, '2026-08-12')).toContain('June or December');
  });

  it('flags a lossy rule even with no date picked yet', () => {
    expect(ruleDateMismatch(rule({ freq: 'weekly', daysOfWeek: [2, 4] }), '')).toContain('one weekday');
  });

  // ── Short-month clamping (mirrors the engine's clampDay) ───────────────────
  // The expansion engine clamps a day past the end of a month to that month's
  // last day, so those clamped dates are dates the rule GENERATES — the form's
  // own auto-reseed writes them, and a series edit opened on one must save.
  describe('accepts the engine-clamped last day of a short month', () => {
    it('rule 31: the last day of any shorter month, and the real 31st', () => {
      const r = rule({ freq: 'monthly', daysOfMonth: [31] });
      expect(ruleDateMismatch(r, '2026-08-31')).toBeNull(); // long month, exact
      expect(ruleDateMismatch(r, '2026-09-30')).toBeNull(); // 30-day month, clamped
      expect(ruleDateMismatch(r, '2027-02-28')).toBeNull(); // Feb, non-leap
      expect(ruleDateMismatch(r, '2028-02-29')).toBeNull(); // Feb, leap
    });

    it('rule 31: still rejects days that are not the clamp target', () => {
      const r = rule({ freq: 'monthly', daysOfMonth: [31] });
      expect(ruleDateMismatch(r, '2026-09-29')).toContain('31st');
      expect(ruleDateMismatch(r, '2026-08-30')).toContain('31st'); // Aug HAS a 31st
      expect(ruleDateMismatch(r, '2027-02-27')).toContain('31st');
      expect(ruleDateMismatch(r, '2028-02-28')).toContain('31st'); // leap Feb ends on the 29th
    });

    it('rule 30: clamps only in February', () => {
      const r = rule({ freq: 'monthly', daysOfMonth: [30] });
      expect(ruleDateMismatch(r, '2026-09-30')).toBeNull(); // exact
      expect(ruleDateMismatch(r, '2027-02-28')).toBeNull(); // non-leap Feb, clamped
      expect(ruleDateMismatch(r, '2028-02-29')).toBeNull(); // leap Feb, clamped
      expect(ruleDateMismatch(r, '2026-04-29')).toContain('30th');
      expect(ruleDateMismatch(r, '2026-08-31')).toContain('30th'); // past the rule day
    });

    it('rule 29: Feb 28 passes only in a non-leap year', () => {
      const r = rule({ freq: 'monthly', daysOfMonth: [29] });
      expect(ruleDateMismatch(r, '2027-02-28')).toBeNull(); // non-leap: clamped
      expect(ruleDateMismatch(r, '2028-02-29')).toBeNull(); // leap: exact
      expect(ruleDateMismatch(r, '2028-02-28')).toContain('29th'); // leap Feb has a real 29th
      expect(ruleDateMismatch(r, '2026-03-28')).toContain('29th');
    });

    it('accepts the monthly-31 auto-reseeded due date end to end', () => {
      // dueDateFor writes exactly what the engine generates; the validator must
      // never refuse it (this was the unsaveable "monthly on the 31st" chore).
      const r = rule({ freq: 'monthly', daysOfMonth: [31] });
      const seeded = dueDateForRule(r, new Date(2026, 7, 14, 12)); // Aug 14 → Sep 30 (clamped)
      const iso = seeded && `${seeded.getFullYear()}-${String(seeded.getMonth() + 1).padStart(2, '0')}-${String(seeded.getDate()).padStart(2, '0')}`;
      expect(iso).toBe('2026-09-30');
      expect(ruleDateMismatch(r, iso as string)).toBeNull();
    });
  });

  describe('yearly rules with an anchor day (calendar-type round-trip)', () => {
    it('checks the day of month, clamp-aware, plus the month set', () => {
      const r = rule({ freq: 'yearly', months: [3, 9], daysOfMonth: [15] });
      expect(ruleDateMismatch(r, '2026-09-15')).toBeNull();
      expect(ruleDateMismatch(r, '2026-09-14')).toContain('15th');
      expect(ruleDateMismatch(r, '2026-08-15')).toContain('March or September');
      const feb = rule({ freq: 'yearly', months: [2], daysOfMonth: [31] });
      expect(ruleDateMismatch(feb, '2027-02-28')).toBeNull(); // engine clamps Feb 31 → 28
      expect(ruleDateMismatch(feb, '2027-02-27')).toContain('31st');
    });
  });
});

// ── ruleLossyForItem ─────────────────────────────────────────────────────────
// The save-time backstop behind the restricted Repeat picker: the sealed
// chore/task Recurrence stores ONE dayOfWeek / dayOfMonth and only Sun..Sat
// ordinal kinds, and `ruleToRecurrence` degrades anything else silently
// ("Tue & Thu" used to save as Tuesday-only). Any rule it flags is refused by
// both forms via ruleDateMismatch — whatever entry point produced it.
describe('ruleLossyForItem', () => {
  const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ ...EMPTY_REPEAT, ...patch });

  it('refuses multi-day weekly and monthly rules, naming the days', () => {
    expect(ruleLossyForItem(rule({ freq: 'weekly', daysOfWeek: [2, 4] })))
      .toContain('Tuesday and Thursday');
    expect(ruleLossyForItem(rule({ freq: 'monthly', daysOfMonth: [5, 20] })))
      .toContain('5th and 20th');
  });

  it('refuses the day/weekday/weekend ordinal kinds', () => {
    expect(ruleLossyForItem(rule({ freq: 'monthly', weekOfMonth: 1, weekdayKind: 'day' }))).not.toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'monthly', weekOfMonth: -1, weekdayKind: 'weekday' }))).not.toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'monthly', weekOfMonth: 2, weekdayKind: 'weekend' }))).not.toBeNull();
  });

  it('refuses a yearly within-year ordinal rule (nowhere to store it)', () => {
    expect(ruleLossyForItem(rule({ freq: 'yearly', months: [6], weekOfMonth: 2, weekdayKind: 'tue' }))).not.toBeNull();
  });

  it('passes single-day rules and concrete ordinal weekdays, including 5 and -2', () => {
    expect(ruleLossyForItem(rule({ freq: 'weekly', daysOfWeek: [4] }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'monthly', daysOfMonth: [20] }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'monthly', weekOfMonth: 2, weekdayKind: 'tue' }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'monthly', weekOfMonth: 5, weekdayKind: 'tue' }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'monthly', weekOfMonth: -2, weekdayKind: 'fri' }))).toBeNull();
  });

  it('passes daily, plain rules, yearly month sets, and "off"', () => {
    expect(ruleLossyForItem(rule({ freq: 'daily' }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'weekly' }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'yearly', months: [3, 9] }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: '' }))).toBeNull();
  });

  it('passes a yearly rule carrying a single anchor day, refuses multiple', () => {
    // The lossless calendar-type round-trip ({months, dayOfMonth} ⇄ rule) must
    // not be refused; a multi-day set would degrade to its first day and is.
    expect(ruleLossyForItem(rule({ freq: 'yearly', months: [3, 9], daysOfMonth: [15] }))).toBeNull();
    expect(ruleLossyForItem(rule({ freq: 'yearly', months: [3, 9], daysOfMonth: [5, 20] })))
      .toContain('one day of the month');
  });
});

// ── calendar-type dayOfMonth round-trip ──────────────────────────────────────
// "Mar & Sep on the 15th" (type 'calendar', written by web/legacy or the yearly
// month-multiselect) used to lose its dayOfMonth through the Repeat-screen
// bridge — recurrenceToRule dropped it and ruleToRecurrence rebuilt without it,
// so the engine (day = r.dayOfMonth || 1) silently moved every occurrence to
// the 1st on the next edit-save.
describe('recurrenceToRule / ruleToRecurrence dayOfMonth round-trip', () => {
  it('carries a calendar recurrence\'s dayOfMonth into the rule and back', () => {
    const rec: Recurrence = { type: 'calendar', months: [3, 9], dayOfMonth: 15 };
    const rule = recurrenceToRule(rec);
    expect(rule).toMatchObject({ freq: 'yearly', months: [3, 9], daysOfMonth: [15] });
    expect(ruleToRecurrence(rule)).toEqual({ type: 'calendar', months: [3, 9], dayOfMonth: 15 });
  });

  it('expansion of the round-tripped recurrence fires on the 15th', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 4, 9)); // Aug 4 2026
    try {
      const rule = recurrenceToRule({ type: 'calendar', months: [3, 9], dayOfMonth: 15 });
      const d = dueDateForRule(rule);
      expect(d?.getMonth()).toBe(8); // September
      expect(d?.getDate()).toBe(15);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves a legacy record without dayOfMonth on the 1st, as today', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 4, 9));
    try {
      const rule = recurrenceToRule({ type: 'calendar', months: [3, 9] });
      expect(rule.daysOfMonth).toEqual([]);
      const back = ruleToRecurrence(rule);
      expect(back).toEqual({ type: 'calendar', months: [3, 9] });
      expect('dayOfMonth' in back).toBe(false);
      const d = dueDateForRule(rule);
      expect(d?.getMonth()).toBe(8);
      expect(d?.getDate()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('carries the yearly interval anchor day too (single-month yearly)', () => {
    const rec: Recurrence = { type: 'interval', intervalValue: 1, intervalUnit: 'years', months: [7], dayOfMonth: 4 };
    const rule = recurrenceToRule(rec);
    expect(rule).toMatchObject({ freq: 'yearly', months: [7], daysOfMonth: [4] });
    expect(ruleToRecurrence(rule)).toEqual({
      type: 'interval', intervalValue: 1, intervalUnit: 'years', months: [7], dayOfMonth: 4,
    });
  });
});
