// Shared recurrence logic ported from the web client. The web app duplicated
// this `recurrenceLabel`/save-rebuild logic across TaskFormView, ChoreFormView,
// TaskDetailView, ChoreDetailView, and the dashboards; here it lives once.
import { seedDueDate } from '@household/calendar';
import { Recurrence, IntervalUnit, RecurrenceType, FormAssistField } from '../api';
import type { RepeatRule, WeekdayKind } from './eventRepeat';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTH_OPTIONS = MONTH_NAMES.map((title, i) => ({ label: title, value: i + 1 }));

export const RECURRENCE_TYPE_OPTIONS: { label: string; value: RecurrenceType }[] = [
  { label: 'Interval (every N days/weeks/months/years)', value: 'interval' },
  { label: 'Calendar (specific months of the year)', value: 'calendar' },
  { label: 'One-time', value: 'one-time' },
];

export const INTERVAL_UNIT_OPTIONS: { label: string; value: IntervalUnit }[] = [
  { label: 'Days', value: 'days' },
  { label: 'Weeks', value: 'weeks' },
  { label: 'Months', value: 'months' },
  { label: 'Years', value: 'years' },
];

export const WEEK_OF_MONTH_OPTIONS = [
  { label: 'First', value: 1 },
  { label: 'Second', value: 2 },
  { label: 'Third', value: 3 },
  { label: 'Fourth', value: 4 },
  { label: 'Last', value: -1 },
];

export const ALERT_DAY_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'No alert', value: null },
  { label: 'On the due date', value: 0 },
  { label: '1 day before', value: 1 },
  { label: '2 days before', value: 2 },
  { label: '3 days before', value: 3 },
  { label: '1 week before', value: 7 },
];

export const AUDIENCE_OPTIONS = [
  { label: 'Everyone in the household', value: 'everyone' },
  { label: 'Only me', value: 'owner' },
];

// Offsets (days before the occasion) offered by the Occasions calendar's
// calendar-level alert settings. `null` = that alert slot is off.
export const OCCASION_ALERT_OFFSET_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'No alert', value: null },
  { label: 'On the day', value: 0 },
  { label: '3 days before', value: 3 },
  { label: '1 week before', value: 7 },
  { label: '2 weeks before', value: 14 },
];

// Drop an alert value already chosen in the paired slot so the same reminder
// can't be picked twice across two alert fields. Sentinels (None `-1`, Custom
// `-2`, and any negative marker) are always kept, as is `self` — the value this
// slot currently holds — so pre-existing/legacy duplicates still render instead
// of showing an empty field.
export function excludeUsedAlert<T extends { value: number }>(
  options: T[],
  used: number | null | undefined,
  self?: number | null,
): T[] {
  if (used == null || used < 0) return options;
  return options.filter((o) => o.value < 0 || o.value === self || o.value !== used);
}

export function ordinal(n: number | null | undefined): string {
  if (n == null) return '';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Human-readable summary of a stored recurrence (full month/day names).
export function recurrenceLabel(r?: Recurrence | null): string {
  if (!r) return '';
  if (r.type === 'one-time') return 'One-time';
  if (r.type === 'calendar') {
    const months = r.months?.map((m) => MONTH_NAMES[m - 1]).join(', ');
    const day = r.dayOfMonth ? ` on the ${ordinal(r.dayOfMonth)}` : '';
    return months ? `Every year in ${months}${day}` : 'Calendar';
  }
  if (r.type === 'interval') {
    const n = r.intervalValue;
    const unit = n === 1 ? r.intervalUnit?.replace(/s$/, '') : r.intervalUnit;
    let label = `Every ${n} ${unit}`;
    if (r.intervalUnit === 'weeks' && r.dayOfWeek != null) {
      label += ` on ${WEEKDAY_NAMES[r.dayOfWeek]}`;
    }
    if (r.intervalUnit === 'months') {
      if (r.weekOfMonth != null && r.dayOfWeek != null) {
        const pos = r.weekOfMonth === -1
          ? 'last'
          : ['', 'first', 'second', 'third', 'fourth'][r.weekOfMonth];
        label += ` on the ${pos} ${WEEKDAY_NAMES[r.dayOfWeek]}`;
      } else if (r.dayOfMonth) {
        label += ` on the ${ordinal(r.dayOfMonth)}`;
      }
    }
    if (r.intervalUnit === 'years') {
      const m = r.months?.[0];
      const d = r.dayOfMonth;
      if (m && d) label += ` on ${MONTH_NAMES[m - 1]} ${ordinal(d)}`;
      else if (m) label += ` in ${MONTH_NAMES[m - 1]}`;
      else if (d) label += ` on the ${ordinal(d)}`;
    }
    return label;
  }
  return '';
}

// Short summary used on template cards (abbreviated months, no day suffixes).
export function recurrenceLabelShort(r?: Recurrence | null): string {
  if (!r) return '';
  if (r.type === 'one-time') return 'One-time';
  if (r.type === 'calendar') {
    const months = r.months?.map((m) => MONTH_NAMES[m - 1].slice(0, 3)).join(' & ');
    const day = r.dayOfMonth ? ` on the ${ordinal(r.dayOfMonth)}` : '';
    return `Every year in ${months}${day}`;
  }
  if (r.type === 'interval') {
    const n = r.intervalValue;
    const unit = n === 1 ? r.intervalUnit?.replace(/s$/, '') : r.intervalUnit;
    return `Every ${n} ${unit}`;
  }
  return '';
}

// The editable form shape — keeps every anchor field around while editing; the
// irrelevant ones are stripped at save time by `buildRecurrencePayload`.
export interface RecurrenceForm {
  type: RecurrenceType;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  months: number[];
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  weekOfMonth: number | null;
}

export type MonthlyMode = 'day' | 'weekday';

export function makeRecurrenceForm(defaults?: Partial<RecurrenceForm>): RecurrenceForm {
  return {
    type: 'interval',
    intervalValue: 1,
    intervalUnit: 'weeks',
    months: [],
    dayOfMonth: null,
    dayOfWeek: null,
    weekOfMonth: null,
    ...defaults,
  };
}

// Reverse of buildRecurrencePayload: hydrate the editable form from saved data.
export function recurrenceToForm(
  r: Recurrence | undefined | null,
  defaults?: Partial<RecurrenceForm>,
): { form: RecurrenceForm; monthlyMode: MonthlyMode } {
  const form = makeRecurrenceForm({ ...defaults, ...(r || {}) } as Partial<RecurrenceForm>);
  const monthlyMode: MonthlyMode =
    form.intervalUnit === 'months' && form.weekOfMonth != null ? 'weekday' : 'day';
  return { form, monthlyMode };
}

// Strip the editable form down to only the anchor fields relevant to the chosen
// unit/mode — mirrors the save() logic shared by TaskFormView/ChoreFormView.
export function buildRecurrencePayload(form: RecurrenceForm, monthlyMode: MonthlyMode): Recurrence {
  const { type, intervalValue, intervalUnit, dayOfWeek, dayOfMonth, weekOfMonth, months } = form;
  const rec: Recurrence = { type };

  if (type === 'interval') {
    rec.intervalValue = intervalValue;
    rec.intervalUnit = intervalUnit;
    rec.months = [];
    if (intervalUnit === 'weeks' && dayOfWeek != null) rec.dayOfWeek = dayOfWeek;
    if (intervalUnit === 'months') {
      if (monthlyMode === 'weekday' && weekOfMonth != null && dayOfWeek != null) {
        rec.weekOfMonth = weekOfMonth;
        rec.dayOfWeek = dayOfWeek;
      } else if (monthlyMode === 'day' && dayOfMonth) {
        rec.dayOfMonth = dayOfMonth;
      }
    }
    if (intervalUnit === 'years') {
      if (months?.length) rec.months = months;
      if (dayOfMonth) rec.dayOfMonth = dayOfMonth;
    }
  } else if (type === 'calendar') {
    rec.months = months || [];
    if (dayOfMonth) rec.dayOfMonth = dayOfMonth;
  }

  return rec;
}

// Live preview while editing (mirrors recurrencePreview in the web forms).
export function recurrencePreview(form: RecurrenceForm, monthlyMode: MonthlyMode): string | null {
  if (!form.type || form.type === 'one-time') return 'Runs once';
  if (form.type === 'calendar') {
    if (!form.months?.length) return null;
    const monthStr = form.months.map((m) => MONTH_NAMES[m - 1]).join(', ');
    const dayStr = form.dayOfMonth ? ` on the ${ordinal(form.dayOfMonth)}` : '';
    return `Every year in ${monthStr}${dayStr}`;
  }
  if (form.type === 'interval') {
    if (!form.intervalValue || !form.intervalUnit) return null;
    const n = form.intervalValue;
    const unit = n === 1 ? form.intervalUnit.replace(/s$/, '') : form.intervalUnit;
    let base = `Every ${n} ${unit}`;
    if (form.intervalUnit === 'weeks' && form.dayOfWeek != null) {
      base += ` on ${WEEKDAYS[form.dayOfWeek]}`;
    }
    if (form.intervalUnit === 'months') {
      if (monthlyMode === 'weekday' && form.weekOfMonth != null && form.dayOfWeek != null) {
        const pos = WEEK_OF_MONTH_OPTIONS.find((w) => w.value === form.weekOfMonth)?.label ?? '';
        base += ` on the ${pos} ${WEEKDAY_NAMES[form.dayOfWeek]}`;
      } else if (form.dayOfMonth) {
        base += ` on the ${ordinal(form.dayOfMonth)}`;
      }
    }
    if (form.intervalUnit === 'years') {
      const month = form.months?.[0];
      const day = form.dayOfMonth;
      if (month && day) base += ` on ${MONTH_NAMES[month - 1]} ${ordinal(day)}`;
      else if (month) base += ` in ${MONTH_NAMES[month - 1]}`;
      else if (day) base += ` on the ${ordinal(day)}`;
    }
    return base;
  }
  return null;
}

// Alert summary used on detail screens.
export function alertSummary(opts: {
  reminderDaysBefore?: number | null;
  alert2DaysBefore?: number | null;
  alertAudience?: string;
}): string {
  const phrase = (days?: number | null) => {
    if (days == null) return null;
    if (days === 0) return 'On the due date';
    if (days === 1) return '1 day before';
    if (days === 7) return '1 week before';
    return `${days} days before`;
  };
  const parts = [phrase(opts.reminderDaysBefore), phrase(opts.alert2DaysBefore)].filter(Boolean) as string[];
  if (!parts.length) return 'No alerts';
  if (opts.alertAudience === 'owner') parts.push('you only');
  return parts.join(' · ');
}

// Due-date status used by the maintenance list rows and task detail header.
export type DueStatus = 'overdue' | 'soon' | 'upcoming' | 'none';

export function dueStatus(nextDueDate?: string | null): { status: DueStatus; label: string } {
  if (!nextDueDate) return { status: 'none', label: 'No date' };
  const due = parseCalendarDate(nextDueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + 7);
  if (due < today) return { status: 'overdue', label: 'Overdue' };
  if (due < soon) return { status: 'soon', label: 'Due Soon' };
  return { status: 'upcoming', label: 'Upcoming' };
}

// Relative countdown for a chore's due date: "Due today", "Due in N days", or —
// for a day genuinely behind us (a tapped past occurrence, a past one-time
// chore) — "Due yesterday" / "Due N days ago". Series callers must pass the
// next occurrence computed from today (repeatingItemScope's
// nextOccurrenceFrom), never the raw `nextDueDate` anchor, which nothing
// advances and so goes stale the moment its first occurrence passes.
export function dueInLabel(d?: string | null): string {
  if (!d) return 'Not set';
  const due = parseCalendarDate(d);
  due.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days === 0) return 'Due today';
  if (days === -1) return 'Due yesterday';
  if (days < 0) return `Due ${-days} days ago`;
  return `Due in ${days} day${days === 1 ? '' : 's'}`;
}

// MongoDB stores date-only inputs as UTC midnight, which shifts to the previous
// day in negative-offset timezones. Parse the UTC YYYY-MM-DD at local noon.
export function parseCalendarDate(d: string): Date {
  const iso = new Date(d).toISOString();
  const [y, mo, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, mo - 1, day, 12, 0, 0);
}

export function formatCalendarDate(d?: string | null): string {
  if (!d) return 'Not set';
  return parseCalendarDate(d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Strip the web's `mdi-` prefix so the name matches @expo/vector-icons'
// MaterialCommunityIcons glyph set.
export function mdiName(icon?: string | null): string {
  return (icon || 'mdi-broom').replace(/^mdi-/, '');
}

// ----- Bridge to the calendar's shared Repeat screen (lib/eventRepeat) --------
// Tasks and calendar events use different recurrence shapes. These convert
// between them so the maintenance task form can reuse the calendar's drill-in
// Repeat editor. The mapping is lossy where the models diverge: task 'one-time'
// has no repeat rule; tasks track only a single weekday / month-day; and the
// 'day'/'weekday'/'weekend' ordinal kinds have no single-weekday task analogue.
const WEEKDAY_KINDS: WeekdayKind[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const EMPTY_RULE: RepeatRule = {
  freq: '', interval: 1, daysOfWeek: [], daysOfMonth: [], months: [], weekOfMonth: null, weekdayKind: null,
};

export function recurrenceToRule(r?: Recurrence | null): RepeatRule {
  const rule: RepeatRule = { ...EMPTY_RULE };
  if (!r || r.type === 'one-time') return rule;
  if (r.type === 'calendar') {
    rule.freq = 'yearly';
    rule.months = r.months?.length ? [...r.months] : [];
    return rule;
  }
  rule.interval = r.intervalValue || 1;
  switch (r.intervalUnit) {
    case 'days':
      rule.freq = 'daily';
      break;
    case 'months':
      rule.freq = 'monthly';
      if (r.weekOfMonth != null && r.dayOfWeek != null) {
        rule.weekOfMonth = r.weekOfMonth;
        rule.weekdayKind = WEEKDAY_KINDS[r.dayOfWeek] ?? 'sun';
      } else if (r.dayOfMonth != null) {
        rule.daysOfMonth = [r.dayOfMonth];
      }
      break;
    case 'years':
      rule.freq = 'yearly';
      if (r.months?.length) rule.months = [...r.months];
      break;
    case 'weeks':
    default:
      rule.freq = 'weekly';
      if (r.dayOfWeek != null) rule.daysOfWeek = [r.dayOfWeek];
      break;
  }
  return rule;
}

// ----- Form-assist ("Ask Calen") over the RepeatRule -------------------------
// The generic form-assist endpoint only understands flat fields, so the repeat
// rule is exposed to the assistant as a handful of primitives and reassembled
// here. This covers the common chore/task cadences — daily, every-N, weekly on a
// day, monthly on a date, yearly in months. The niche "on the 2nd Tuesday"
// ordinal form (weekOfMonth + weekdayKind) has no primitive here and stays
// editable only on the Repeat screen.
export const REPEAT_FREQ_ASSIST_OPTIONS: { label: string; value: string }[] = [
  { label: 'Does not repeat', value: 'none' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

// The assist field names that map onto the RepeatRule (kept in one place so the
// form's applyPatch can detect and strip them before its own field loop).
export const RECURRENCE_ASSIST_KEYS = [
  'repeatFrequency',
  'repeatInterval',
  'repeatWeekday',
  'repeatDayOfMonth',
  'repeatMonths',
] as const;

export function recurrenceAssistFields(): FormAssistField[] {
  return [
    {
      name: 'repeatFrequency',
      type: 'select',
      label: 'Repeat frequency',
      description: 'How often the chore/task repeats',
      options: REPEAT_FREQ_ASSIST_OPTIONS,
    },
    {
      name: 'repeatInterval',
      type: 'number',
      label: 'Repeat interval',
      description: 'Repeat every N periods (2 = every other week/month/…). Leave at 1 unless the user asks for a longer gap.',
    },
    {
      name: 'repeatWeekday',
      type: 'select',
      label: 'Weekly day',
      description: 'For a weekly repeat, which day of the week it falls on',
      options: WEEKDAY_NAMES.map((n, i) => ({ label: n, value: i })),
    },
    {
      name: 'repeatDayOfMonth',
      type: 'number',
      label: 'Monthly day',
      description: 'For a monthly repeat, which day of the month (1–31)',
    },
    {
      name: 'repeatMonths',
      type: 'multiselect',
      label: 'Yearly months',
      description: 'For a yearly repeat, which month(s) it runs in',
      options: MONTH_OPTIONS,
    },
  ];
}

// The current RepeatRule projected onto the assist field names, so the assistant
// can reason over (and selectively change) the existing cadence.
export function recurrenceAssistCurrent(rule: RepeatRule): Record<string, unknown> {
  return {
    repeatFrequency: rule.freq || 'none',
    repeatInterval: rule.interval || 1,
    repeatWeekday: rule.daysOfWeek[0] ?? null,
    repeatDayOfMonth: rule.daysOfMonth[0] ?? null,
    repeatMonths: rule.months,
  };
}

export function patchTouchesRecurrence(patch: Record<string, unknown>): boolean {
  return RECURRENCE_ASSIST_KEYS.some((k) => k in patch);
}

// Merge an assist patch's repeat* keys into the existing RepeatRule. Only the
// keys present in the patch move; a bare weekday/day/months implies its owning
// frequency when none is set yet, so "make it Saturdays" alone still works.
export function applyRecurrenceAssistPatch(prev: RepeatRule, patch: Record<string, unknown>): RepeatRule {
  const next: RepeatRule = {
    ...prev,
    daysOfWeek: [...prev.daysOfWeek],
    daysOfMonth: [...prev.daysOfMonth],
    months: [...prev.months],
  };
  if ('repeatFrequency' in patch) {
    const f = patch.repeatFrequency;
    next.freq = f === 'none' || f == null ? '' : (f as RepeatRule['freq']);
  }
  if (typeof patch.repeatInterval === 'number' && patch.repeatInterval >= 1) {
    next.interval = Math.round(patch.repeatInterval);
  }
  if (patch.repeatWeekday != null) {
    const d = Number(patch.repeatWeekday);
    if (d >= 0 && d <= 6) {
      next.daysOfWeek = [d];
      if (!next.freq) next.freq = 'weekly';
    }
  }
  if (patch.repeatDayOfMonth != null) {
    const d = Number(patch.repeatDayOfMonth);
    if (d >= 1 && d <= 31) {
      next.daysOfMonth = [d];
      if (!next.freq) next.freq = 'monthly';
    }
  }
  if (Array.isArray(patch.repeatMonths) && patch.repeatMonths.length) {
    next.months = patch.repeatMonths.map(Number).filter((m) => m >= 1 && m <= 12);
    if (!next.freq) next.freq = 'yearly';
  }
  return next;
}

// The first due date a repeat rule implies, counting from `from` (today on a
// form). Changing the Repeat row on a chore form reseeds Next Due Date from
// this — a date the old cadence produced means nothing under the new one. A rule
// with no frequency ("Does not repeat") implies no date and returns null, so
// turning the repeat off leaves the date the user picked alone.
export function dueDateForRule(rule: RepeatRule, from: Date = new Date()): Date | null {
  const d = seedDueDate(ruleToRecurrence(rule), from);
  return d ? new Date(d) : null;
}

const orList = (parts: string[]) =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
const ORDINAL_LABELS: Record<number, string> = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last', [-2]: 'next to last',
};

// A due date the repeat rule itself would never generate — "every week on
// Tuesday" anchored on a Wednesday. The stored anchor IS the series' pattern
// day, so a mismatched anchor makes every future occurrence wrong; the chore
// and task forms refuse to save the combination (except a detached
// "This Chore Only" copy, which saves as one-time and may land anywhere).
// Returns a user-facing message naming the conflict, or null when the date
// fits — or when the rule pins no days at all (daily, plain weekly/monthly).
export function ruleDateMismatch(rule: RepeatRule, date: string): string | null {
  const clause = mismatchClause(rule, date);
  return clause ? `${clause} Pick a matching date or change the repeat.` : null;
}

function mismatchClause(rule: RepeatRule, date: string): string | null {
  if (!rule.freq || !date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const dow = d.getDay();
  const dayName = WEEKDAY_NAMES[dow];

  if (rule.freq === 'weekly' && rule.daysOfWeek.length && !rule.daysOfWeek.includes(dow)) {
    const days = [...rule.daysOfWeek].sort((a, b) => a - b).map((n) => WEEKDAY_NAMES[n]);
    return `The repeat is on ${orList(days)}, but this date falls on a ${dayName}.`;
  }

  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && rule.weekOfMonth != null && rule.weekdayKind) {
    const ord = ORDINAL_LABELS[rule.weekOfMonth] ?? '';
    const kind = WEEKDAY_KINDS.indexOf(rule.weekdayKind);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    if (kind >= 0) {
      const slot = `the ${ord} ${WEEKDAY_NAMES[kind]} of the month`;
      if (dow !== kind) {
        return `The repeat is on ${slot}, but this date falls on a ${dayName}.`;
      }
      // Right weekday — is it also the right one of the month? (1..5 count from
      // the start; -1/-2 from the end.)
      const nth = Math.ceil(d.getDate() / 7);
      const nthFromEnd = Math.ceil((lastDay - d.getDate() + 1) / 7);
      const fits =
        rule.weekOfMonth > 0 ? nth === rule.weekOfMonth : nthFromEnd === -rule.weekOfMonth;
      if (!fits) {
        return `The repeat is on ${slot}, but this date isn't that ${WEEKDAY_NAMES[kind]}.`;
      }
    } else if (rule.weekdayKind === 'weekday' && (dow === 0 || dow === 6)) {
      return `The repeat is on a weekday, but this date falls on a ${dayName}.`;
    } else if (rule.weekdayKind === 'weekend' && dow >= 1 && dow <= 5) {
      return `The repeat is on a weekend day, but this date falls on a ${dayName}.`;
    } else if (rule.weekdayKind === 'day') {
      const want = rule.weekOfMonth > 0 ? rule.weekOfMonth : lastDay + 1 + rule.weekOfMonth;
      if (d.getDate() !== want) {
        return `The repeat is on the ${ord} day of the month, but this date is the ${ordinal(d.getDate())}.`;
      }
    }
  } else if (rule.freq === 'monthly' && rule.daysOfMonth.length && !rule.daysOfMonth.includes(d.getDate())) {
    const days = [...rule.daysOfMonth].sort((a, b) => a - b).map(ordinal);
    return `The repeat is on the ${orList(days)} of the month, but this date is the ${ordinal(d.getDate())}.`;
  }

  if (rule.freq === 'yearly' && rule.months.length && !rule.months.includes(d.getMonth() + 1)) {
    const months = [...rule.months].sort((a, b) => a - b).map((n) => MONTH_NAMES[n - 1]);
    return `The repeat is in ${orList(months)}, but this date is in ${MONTH_NAMES[d.getMonth()]}.`;
  }

  return null;
}

export function ruleToRecurrence(rule: RepeatRule): Recurrence {
  if (!rule.freq) return { type: 'one-time' };
  // Multiple months only exist in the task 'calendar' type.
  if (rule.freq === 'yearly' && rule.months.length > 1) {
    return { type: 'calendar', months: [...rule.months].sort((a, b) => a - b) };
  }
  const rec: Recurrence = { type: 'interval', intervalValue: rule.interval || 1, months: [] };
  switch (rule.freq) {
    case 'daily':
      rec.intervalUnit = 'days';
      break;
    case 'weekly':
      rec.intervalUnit = 'weeks';
      if (rule.daysOfWeek.length) rec.dayOfWeek = [...rule.daysOfWeek].sort((a, b) => a - b)[0];
      break;
    case 'monthly':
      rec.intervalUnit = 'months';
      if (rule.weekOfMonth != null && rule.weekdayKind) {
        const d = WEEKDAY_KINDS.indexOf(rule.weekdayKind);
        if (d >= 0) {
          rec.weekOfMonth = rule.weekOfMonth;
          rec.dayOfWeek = d;
        } else if (rule.daysOfMonth.length) {
          rec.dayOfMonth = rule.daysOfMonth[0];
        }
      } else if (rule.daysOfMonth.length) {
        rec.dayOfMonth = [...rule.daysOfMonth].sort((a, b) => a - b)[0];
      }
      break;
    case 'yearly':
      rec.intervalUnit = 'years';
      if (rule.months.length) rec.months = [...rule.months];
      break;
  }
  return rec;
}
