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
  parseCalendarDate,
  formatCalendarDate,
  mdiName,
  patchTouchesRecurrence,
  applyRecurrenceAssistPatch,
  recurrenceAssistCurrent,
  ruleToRecurrence,
  dueDateForRule,
  excludeUsedAlert,
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
