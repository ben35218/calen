// Presentation helpers for Occasions (birthdays + labeled contact dates). The
// occasion KIND comes from the shared calendar engine (occasionKindFromLabel);
// these map a kind + label to the title, icon, and noun the calendar screens,
// search, print, notifications, and the Occasions list all render consistently.
import type { CalendarOccasion } from '../api';

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

// "turns 30" / "5 years" style suffix when a real origin year is on file.
export function occasionYearsSuffix(o: Pick<CalendarOccasion, 'kind' | 'year' | 'date'>): string | null {
  if (!o.year) return null;
  const occYear = Number(String(o.date).slice(0, 4));
  const n = occYear - o.year;
  if (n <= 0) return null;
  return o.kind === 'birthday' ? `turns ${n}` : `${n} years`;
}
