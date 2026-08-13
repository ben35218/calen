// Event repeat rules — the form state / API shape shared by the event form's
// Repeat row and the pushed Repeat screen. Mirrors the stored recurrence
// (server models/CalendarEvent.js) and the shared expansion engine
// (shared/calendar/index.js).

export type RepeatFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type WeekdayKind =
  | 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
  | 'day' | 'weekday' | 'weekend';

export interface RepeatRule {
  freq: RepeatFreq | '';
  interval: number;
  // Weekly: which weekdays (0=Sun..6=Sat).
  daysOfWeek: number[];
  // Monthly "each": numbered dates of the month (1..31).
  daysOfMonth: number[];
  // Yearly: which months (1..12).
  months: number[];
  // Monthly "on the" / yearly "days of week": ordinal (1..5, -1=last,
  // -2=next to last) + day kind. For yearly it applies within each month.
  weekOfMonth: number | null;
  weekdayKind: WeekdayKind | null;
}

export const EMPTY_REPEAT: RepeatRule = {
  freq: '',
  interval: 1,
  daysOfWeek: [],
  daysOfMonth: [],
  months: [],
  weekOfMonth: null,
  weekdayKind: null,
};

export const FREQ_OPTIONS: { label: string; value: RepeatFreq }[] = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

export const FREQ_UNITS: Record<RepeatFreq, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
};

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const ORDINAL_OPTIONS: { label: string; value: number }[] = [
  { label: 'first', value: 1 },
  { label: 'second', value: 2 },
  { label: 'third', value: 3 },
  { label: 'fourth', value: 4 },
  { label: 'fifth', value: 5 },
  { label: 'next to last', value: -2 },
  { label: 'last', value: -1 },
];

export const WEEKDAY_KIND_OPTIONS: { label: string; value: WeekdayKind }[] = [
  { label: 'Sunday', value: 'sun' },
  { label: 'Monday', value: 'mon' },
  { label: 'Tuesday', value: 'tue' },
  { label: 'Wednesday', value: 'wed' },
  { label: 'Thursday', value: 'thu' },
  { label: 'Friday', value: 'fri' },
  { label: 'Saturday', value: 'sat' },
  { label: 'day', value: 'day' },
  { label: 'weekday', value: 'weekday' },
  { label: 'weekend day', value: 'weekend' },
];

// A rule the plain Repeat options (Daily/Weekly/Monthly/Yearly) can't express —
// shown as the custom row and edited on the Repeat screen.
export function isCustomRule(r: RepeatRule): boolean {
  return !!r.freq && (
    r.interval > 1 ||
    r.daysOfWeek.length > 0 ||
    r.daysOfMonth.length > 0 ||
    r.months.length > 0 ||
    r.weekOfMonth != null
  );
}

const ordinalSuffix = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10];
const nth = (n: number) => `${n}${ordinalSuffix(n)}`;

const listJoin = (parts: string[]) =>
  parts.length <= 1
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

// "Every 2 weeks on Monday and Wednesday", "Monthly on the second Tuesday", …
export function repeatSummary(r: RepeatRule): string {
  if (!r.freq) return 'Never';
  const many = FREQ_UNITS[r.freq][1];
  const every =
    r.interval > 1
      ? `Every ${r.interval} ${many}`
      : { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[r.freq];

  if (r.freq === 'weekly' && r.daysOfWeek.length) {
    const days = [...r.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]);
    return `${every} on ${listJoin(days)}`;
  }
  if (r.freq === 'monthly' && r.daysOfMonth.length) {
    const days = [...r.daysOfMonth].sort((a, b) => a - b).map(nth);
    return `${every} on the ${listJoin(days)}`;
  }
  if (r.freq === 'monthly' && r.weekOfMonth != null && r.weekdayKind) {
    return `${every} on the ${ordinalPhrase(r)}`;
  }
  if (r.freq === 'yearly' && r.months.length) {
    const months = [...r.months].sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1]);
    return r.weekOfMonth != null && r.weekdayKind
      ? `${every} on the ${ordinalPhrase(r)} of ${listJoin(months)}`
      : `${every} in ${listJoin(months)}`;
  }
  return every;
}

// The chore/task forms show the Repeat row as ONE self-labeled line —
// "Repeats every 1 week on Tue & Thu" — so the whole rule reads at a glance
// with no left label competing for the row's width. The interval is always
// spelled ("every 1 week", never "Weekly") and day/month names abbreviated,
// keeping the line short enough to stay on one line.
export function repeatsLine(r: RepeatRule): string {
  if (!r.freq) return 'Does not repeat';
  const [one, many] = FREQ_UNITS[r.freq];
  const every = `Repeats every ${r.interval} ${r.interval === 1 ? one : many}`;

  if (r.freq === 'weekly' && r.daysOfWeek.length) {
    const days = [...r.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d].slice(0, 3));
    return `${every} on ${ampJoin(days)}`;
  }
  if (r.freq === 'monthly' && r.daysOfMonth.length) {
    const days = [...r.daysOfMonth].sort((a, b) => a - b).map(nth);
    return `${every} on the ${ampJoin(days)}`;
  }
  if (r.freq === 'monthly' && r.weekOfMonth != null && r.weekdayKind) {
    return `${every} on the ${ordinalPhrase(r)}`;
  }
  if (r.freq === 'yearly' && r.months.length) {
    const months = [...r.months].sort((a, b) => a - b).map((m) => MONTH_ABBREV[m - 1]);
    return r.weekOfMonth != null && r.weekdayKind
      ? `${every} on the ${ordinalPhrase(r)} of ${ampJoin(months)}`
      : `${every} in ${ampJoin(months)}`;
  }
  return every;
}

const ampJoin = (parts: string[]) =>
  parts.length <= 1
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;

// "second Tuesday", "last weekend day", …
function ordinalPhrase(r: RepeatRule): string {
  const ord = ORDINAL_OPTIONS.find((o) => o.value === r.weekOfMonth)?.label ?? '';
  const kind = WEEKDAY_KIND_OPTIONS.find((o) => o.value === r.weekdayKind)?.label ?? '';
  return `${ord} ${kind}`;
}
