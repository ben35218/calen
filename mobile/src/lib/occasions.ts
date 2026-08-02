// Presentation helpers for Occasions (birthdays + labeled contact dates). The
// occasion KIND comes from the shared calendar engine (occasionKindFromLabel);
// these map a kind + label to the title, icon, and noun the calendar screens,
// search, print, notifications, and the Occasions list all render consistently.
import type { CalendarOccasion, Person } from '../api';
import { occasionKindFromLabel } from '@household/calendar';
import { normalizePerson } from './personFields';

export type OccasionKind = CalendarOccasion['kind'];

// A friendly noun per kind. Custom occasions use their raw label instead.
const OCCASION_NOUN: Record<OccasionKind, string> = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  marriage: 'Marriage',
  death: 'Remembrance',
  custom: 'Occasion',
};

// MaterialCommunityIcons glyph per kind.
const OCCASION_ICON: Record<OccasionKind, string> = {
  birthday: 'cake-variant',
  anniversary: 'heart',
  marriage: 'ring',
  death: 'candle',
  custom: 'calendar-star',
};

export function occasionNoun(o: Pick<CalendarOccasion, 'kind' | 'label'>): string {
  return o.kind === 'custom' ? (o.label || 'Occasion') : OCCASION_NOUN[o.kind];
}

export function occasionIcon(kind: OccasionKind): string {
  return OCCASION_ICON[kind] ?? OCCASION_ICON.custom;
}

// The one-line title shown on a calendar chip / list row / notification.
export function occasionTitle(o: Pick<CalendarOccasion, 'kind' | 'name' | 'label'>): string {
  switch (o.kind) {
    case 'birthday': return `${o.name}'s Birthday`;
    case 'anniversary': return `${o.name}'s Anniversary`;
    case 'marriage': return `${o.name}'s Marriage`;
    case 'death': return `Remembering ${o.name}`;
    default: return `${o.name} — ${o.label || 'Occasion'}`;
  }
}

// A stable identity for one occasion, shared by the calendar (which knows the
// CalendarOccasion) and the Occasions list (which rebuilds items from People) so
// a tapped occasion can be located + highlighted in the list.
export interface OccasionFocus {
  personId: string;
  kind: OccasionKind;
  month: number; // 1-based
  day: number;
  label: string;
}

// Build the focus param from a calendar occasion (its `date` is this year's
// occurrence — we key on month/day, which is year-independent).
export function occasionFocusFrom(o: CalendarOccasion): OccasionFocus {
  return {
    personId: o.personId,
    kind: o.kind,
    month: Number(String(o.date).slice(5, 7)),
    day: Number(String(o.date).slice(8, 10)),
    label: o.label,
  };
}

// The match key both surfaces compute to line a tapped occasion up with its list row.
export function occasionFocusKey(f: OccasionFocus): string {
  return `${f.personId}|${f.kind}|${f.month}|${f.day}|${f.label}`;
}

// --- Occasions list windowing ---------------------------------------------
//
// The Occasions list reads as a timeline anchored on today: occasions that
// happened within PAST_WINDOW_DAYS linger under "Recently observed", today's
// sit at the anchor, and upcoming ones split into a highlighted COMING_UP_DAYS
// "Coming up" horizon and a collapsed "Later this year" tail.

// How long a passed occasion lingers in "Recently observed" before it drops off.
export const PAST_WINDOW_DAYS = 7;
// The highlighted plan-ahead horizon; beyond it occasions fold into "Later this year".
export const COMING_UP_DAYS = 60;

export interface Occasion {
  person: Person;
  kind: OccasionKind;
  label: string;   // 'Birthday' or the raw contact date label
  month: number;   // 1-based
  day: number;
  offset: number;  // signed days to the nearest relevant occurrence: <0 recently passed, 0 today, >0 upcoming
  years: number | null; // age / years since, as of the occurrence in view
  hidden: boolean; // the person is excluded from the Occasions calendar
}

// Parse a YYYY-MM-DD value; returns null when it isn't a real month/day.
function parseYmd(value: string | undefined): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

// Every occasion on file (birthdays + labeled contact dates), each anchored to the
// occurrence nearest to today: a recently-passed one within PAST_WINDOW_DAYS (negative
// offset), today (0), otherwise the next upcoming one (positive offset). Sorted
// chronologically so the list reads recently-passed → today → upcoming. `now` is
// injectable for testing.
export function collectOccasions(people: Person[], now: Date = new Date()): Occasion[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayMs = today.getTime();
  const out: Occasion[] = [];
  const add = (person: Person, kind: OccasionKind, label: string, value: string | undefined) => {
    const p = parseYmd(value);
    if (!p) return;
    const thisYear = new Date(today.getFullYear(), p.mo - 1, p.d);
    const passedOrToday = thisYear.getTime() <= todayMs;
    const past = passedOrToday ? thisYear : new Date(today.getFullYear() - 1, p.mo - 1, p.d);
    const future = passedOrToday ? new Date(today.getFullYear() + 1, p.mo - 1, p.d) : thisYear;
    const daysSince = Math.round((todayMs - past.getTime()) / 86400000);
    const daysUntil = Math.round((future.getTime() - todayMs) / 86400000);
    let offset: number;
    let occ: Date;
    if (daysSince === 0) { offset = 0; occ = past; }
    else if (daysSince <= PAST_WINDOW_DAYS) { offset = -daysSince; occ = past; }
    else { offset = daysUntil; occ = future; }
    const years = p.y > 1900 && p.y <= occ.getFullYear() ? occ.getFullYear() - p.y : null;
    out.push({ person, kind, label, month: p.mo, day: p.d, offset, years, hidden: Boolean(person.occasionsHidden) });
  };
  for (const person of people) {
    if (person.birthday) add(person, 'birthday', 'Birthday', String(person.birthday).slice(0, 10));
    for (const entry of normalizePerson(person).dates) {
      add(person, occasionKindFromLabel(entry.label), entry.label || 'Date', entry.value);
    }
  }
  return out.sort((a, b) => a.offset - b.offset || a.person.name.localeCompare(b.person.name));
}

// Relative label for an occasion's offset: "Yesterday" / "3 days ago" / "Today"
// / "Tomorrow" / "in N days".
export function whenLabel(offset: number): string {
  if (offset === 0) return 'Today';
  if (offset === -1) return 'Yesterday';
  if (offset < 0) return `${-offset} days ago`;
  if (offset === 1) return 'Tomorrow';
  return `in ${offset} days`;
}

// "turns 30" / "5 years" style suffix when a real origin year is on file.
export function occasionYearsSuffix(o: Pick<CalendarOccasion, 'kind' | 'year' | 'date'>): string | null {
  if (!o.year) return null;
  const occYear = Number(String(o.date).slice(0, 4));
  const n = occYear - o.year;
  if (n <= 0) return null;
  return o.kind === 'birthday' ? `turns ${n}` : `${n} years`;
}
