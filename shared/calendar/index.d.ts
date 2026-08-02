// Type declarations for the shared calendar engine (@household/calendar).
// The engine is pure JS; these types keep TS consumers (mobile) honest at the
// boundary. Record shapes are intentionally loose (Record<string, any>) since
// each platform passes its own model objects through.

export type AnyRecord = Record<string, any>;

export interface AssembleInput {
  events?: AnyRecord[];
  tasks?: AnyRecord[];
  chores?: AnyRecord[];
  people?: AnyRecord[];
  recipeSchedules?: AnyRecord[];
  trips?: AnyRecord[];
  fromDate: Date | string | number;
  toDate: Date | string | number;
  selfId?: string | null;
  groceryShoppingDay?: number | null;
  groceryFrequency?: 'weekly' | 'biweekly';
  groceryAnchor?: string | null;
}

export type OccasionKind = 'birthday' | 'anniversary' | 'marriage' | 'death' | 'custom';

export interface CalendarOccasion {
  id: string;
  kind: OccasionKind;
  name: string;
  /** Display label for the occasion: a friendly noun for known kinds, the raw
   *  contact date label for custom kinds. */
  label: string;
  date: string;
  personId: string;
  relationship?: string;
  /** The original year the occasion happened, when a real year is on file. */
  year?: number | null;
}

export interface CalendarTripOverlay {
  id: string;
  name?: string;
  destination?: string;
  color?: string;
  status?: string;
  ranges: { start: any; end: any; label?: string }[];
}

export interface CalendarData {
  tasks: AnyRecord[];
  chores: AnyRecord[];
  events: AnyRecord[];
  occasions: CalendarOccasion[];
  recipes: AnyRecord[];
  groceryShopping: { id: string; date: string; weekStart: string }[];
  trips: CalendarTripOverlay[];
}

export function computeNextDueDate(task: AnyRecord, fromDate?: Date | string | number | null): Date | null;
export function anchorRecurrence<T extends AnyRecord | null | undefined>(recurrence: T, fromDate?: Date | string | number): T;
export function seedDueDate(recurrence: AnyRecord | null | undefined, fromDate?: Date | string | number): Date | null;
export function avgKmPerDay(logs: Array<{ reading: number; recordedAt: Date | string }> | null | undefined): number | null;
export function estimateDateFromKm(nextDueKm: number, currentKm: number, kmPerDay: number | null | undefined): Date | null;
export function computeNextDueKm(task: { intervalKm?: number | null }, serviceKm: number | null | undefined): number | null;
export function expandRecurringEvent(event: AnyRecord, fromDate: Date, toDate: Date): AnyRecord[];
export function expandRecurringTaskChore(item: AnyRecord, fromDate: Date, toDate: Date): AnyRecord[];
export function occasionOccurrences(dateValue: Date | string, fromDate: Date, toDate: Date): string[];
export function occasionKindFromLabel(label: string | null | undefined): OccasionKind;
export const KNOWN_OCCASION_KINDS: OccasionKind[];
export function assembleCalendarData(input: AssembleInput): CalendarData;

export interface AvailabilityInput {
  /** Already-expanded events (the `events` field of assembleCalendarData). */
  events?: AnyRecord[];
  /** Trip overlays (the `trips` field of assembleCalendarData). */
  trips?: AnyRecord[];
  fromDate: Date | string | number;
  toDate: Date | string | number;
  timezone?: string | null;
  dayStartMinutes?: number;
  dayEndMinutes?: number;
}

export interface AvailabilityDay {
  date: string;
  weekday: string;
  status: 'free' | 'partial' | 'busy' | 'away';
  /** Busy blocks (HH:MM). `title` is present in the full lens, omitted when the
   *  caller strips record detail for the privacy-off availability projection. */
  busy?: { start: string; end: string; title?: string }[];
  free?: { start: string; end: string }[];
  /** Titles of all-day commitments on the day (soft note, does not block hours). */
  allDayCommitments?: string[];
  /** For an 'away' day, the trip name. */
  note?: string;
}

export function deriveAvailability(input: AvailabilityInput): AvailabilityDay[];
