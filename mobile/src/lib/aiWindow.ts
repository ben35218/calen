// Signal-parity G4 — query-scoped AI context.
//
// The calendar assistant used to ship the ENTIRE decrypted calendar (every event,
// task, chore, and trip the household ever had) to the AI route on every turn.
// This module narrows that to a date window DERIVED FROM THE CONVERSATION, so only
// the records a turn plausibly needs leave the device — the G-phase "minimum
// context is the default" principle, applied to the biggest remaining payload.
//
// Two pure functions (unit-tested, no I/O):
//   deriveAiWindow(texts, now, focusDate?) — cheap heuristics over the chat text
//     (relative terms, month names, explicit years/durations) → a [from, to]
//     window, defaulting to a modest span around "now".
//   scopeCalendarSources(sources, window) — filter the decrypted sources to that
//     window, but ALWAYS keep recurring items (a weekly event started long ago
//     still has occurrences inside any window — dropping it by base date would
//     break recurrence and regress quality). The server then expands recurrence
//     over exactly this scoped set, so far-off ONE-OFF records simply never leave.
//
// Widening is conversation-driven: because the window is recomputed from the whole
// chat each turn, a follow-up that names a later date (or a duration like "next 2
// years") expands the next turn's window to cover it. Recurring items are never
// gated, so recurrence questions work at any range regardless of the window.

import { assembleCalendarData, deriveAvailability } from '@household/calendar';

const DAY = 24 * 60 * 60 * 1000;

// Baseline span when the conversation gives no date hint: a little past + the
// coming half-year (the common "what's up soon" assistant use).
const BASELINE_PAST_DAYS = 45;
const BASELINE_FUTURE_DAYS = 183;
// Hard bounds so a wild parse (or a huge duration) can't ship the whole history.
const MAX_PAST_DAYS = 730;   // 2 years
const MAX_FUTURE_DAYS = 1095; // 3 years

export interface AiWindow { from: Date; to: Date; }

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function clampWindow(from: Date, to: Date, now: Date): AiWindow {
  const minFrom = now.getTime() - MAX_PAST_DAYS * DAY;
  const maxTo = now.getTime() + MAX_FUTURE_DAYS * DAY;
  let f = Math.max(from.getTime(), minFrom);
  let t = Math.min(to.getTime(), maxTo);
  if (f > t) { const m = Math.min(f, t); f = m; t = Math.max(from.getTime(), to.getTime()); }
  return { from: new Date(f), to: new Date(Math.min(t, maxTo)) };
}

// Derive the relevant window from the conversation. `texts` = the turn's message
// contents (any roles); `focusDate` = the date of an event the chat was opened
// from (Ask-Calen-from-event), always kept in scope.
export function deriveAiWindow(texts: string[], now: Date = new Date(), focusDate?: Date | null): AiWindow {
  const text = texts.join('  ').toLowerCase();

  // Baseline span around now.
  let from = new Date(now.getTime() - BASELINE_PAST_DAYS * DAY);
  let to = new Date(now.getTime() + BASELINE_FUTURE_DAYS * DAY);
  const widenTo = (d: Date) => { if (d.getTime() > to.getTime()) to = d; };
  const widenFrom = (d: Date) => { if (d.getTime() < from.getTime()) from = d; };

  // Explicit calendar years (e.g. "2027") → cover that whole year.
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const y = Number(m[1]);
    widenFrom(new Date(y, 0, 1));
    widenTo(new Date(y, 11, 31, 23, 59, 59));
  }

  // "next year" / "last year".
  if (/\bnext year\b/.test(text)) widenTo(new Date(now.getFullYear() + 1, 11, 31));
  if (/\b(last|previous) year\b/.test(text)) widenFrom(new Date(now.getFullYear() - 1, 0, 1));

  // Bare month names → the nearest upcoming occurrence of that month (or, with
  // "last", the most recent past one). Covers the whole month generously.
  for (let i = 0; i < MONTHS.length; i++) {
    if (!new RegExp(`\\b${MONTHS[i]}\\b`).test(text)) continue;
    const past = /\blast\b/.test(text);
    let year = now.getFullYear();
    if (!past && i < now.getMonth()) year += 1;   // month already passed this year → next year
    if (past && i > now.getMonth()) year -= 1;     // "last <month>" that hasn't happened yet → last year
    widenFrom(new Date(year, i, 1));
    widenTo(new Date(year, i + 1, 0, 23, 59, 59)); // last day of that month
  }

  // Durations: "next/in N weeks|months|years" (future) and "last/past N …" / "N …
  // ago" (past). Also the unqualified "next/coming N months" → future.
  for (const m of text.matchAll(/\b(\d{1,2})\s*(day|week|month|year)s?\b/g)) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === 'day' ? n * DAY : unit === 'week' ? n * 7 * DAY
      : unit === 'month' ? n * 31 * DAY : n * 366 * DAY;
    // Decide direction from nearby words; default to future (the common ask).
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 16), idx);
    const after = text.slice(idx, idx + (m[0]?.length ?? 0) + 6);
    if (/\b(last|past|previous)\b/.test(before) || /\bago\b/.test(after)) widenFrom(new Date(now.getTime() - ms));
    else widenTo(new Date(now.getTime() + ms));
  }

  // Backward-looking intent → widen the past bound so history questions work.
  if (/\b(ago|last month|last week|recently|since|history|used to|when did i last|previous)\b/.test(text)) {
    widenFrom(new Date(now.getTime() - 365 * DAY));
  }

  // Keep a focused event (Ask-Calen-from-event) in scope with a little padding.
  if (focusDate && !Number.isNaN(focusDate.getTime())) {
    widenFrom(new Date(focusDate.getTime() - 7 * DAY));
    widenTo(new Date(focusDate.getTime() + 7 * DAY));
  }

  return clampWindow(from, to, now);
}

// ── Source scoping ──────────────────────────────────────────────────────────

type Rec = Record<string, any>;
const time = (v: unknown): number | null => {
  if (!v) return null;
  const t = new Date(v as string).getTime();
  return Number.isNaN(t) ? null : t;
};
const isRecurringEvent = (e: Rec): boolean => !!e?.recurrence?.freq;
const isRecurringTask = (t: Rec): boolean => !!t?.recurrence && t.recurrence.type && t.recurrence.type !== 'one-time';

// Does [start, end] overlap the window? A missing end is treated as a point at
// start; a missing start means "undateable" → kept (caller decides).
function overlaps(startMs: number | null, endMs: number | null, w: AiWindow): boolean {
  if (startMs == null) return true; // undateable → don't drop it
  const s = startMs;
  const e = endMs ?? startMs;
  return s <= w.to.getTime() && e >= w.from.getTime();
}

// Filter the decrypted calendar sources to the window. Recurring events/tasks/
// chores are ALWAYS kept (their occurrences can fall anywhere); one-off dated
// records outside the window are dropped. Contacts (the roster — birthdays span the
// year and it's small + already consent-gated) and recipe schedules are kept as-is.
export function scopeCalendarSources<T extends Rec>(sources: T, window: AiWindow): T {
  if (!sources) return sources;
  const events = Array.isArray(sources.events) ? sources.events.filter(
    (e: Rec) => isRecurringEvent(e) || overlaps(time(e.startDate), time(e.endDate), window),
  ) : sources.events;
  const keepDue = (item: Rec, recurring: boolean) =>
    recurring || overlaps(time(item.nextDueDate), null, window);
  const tasks = Array.isArray(sources.tasks) ? sources.tasks.filter(
    (t: Rec) => keepDue(t, isRecurringTask(t)),
  ) : sources.tasks;
  const chores = Array.isArray(sources.chores) ? sources.chores.filter(
    (c: Rec) => keepDue(c, isRecurringTask(c)),
  ) : sources.chores;
  const trips = Array.isArray(sources.trips) ? sources.trips.filter(
    (t: Rec) => overlaps(time(t.startDate), time(t.endDate), window),
  ) : sources.trips;

  return { ...sources, events, tasks, chores, trips };
}

// ── Availability-only projection (privacy toggle OFF) ────────────────────────
//
// When "Use personal & contact info in prompts" is off, the calendar RECORDS
// never leave the device — only the user's free/busy availability does. This
// reduces the raw sources over the window to the same free/busy shape the
// server's get_availability returns, but with every record-identifying detail
// stripped: busy blocks lose their event titles, all-day events collapse to a
// bare count, and 'away' days drop the trip name. The result carries times and
// statuses only, so the assistant can still plan around commitments it cannot
// see. Uses the shared engine (the same code the server would run), so an
// availability answer is identical whether computed here or server-side.

export interface AvailabilitySlot { start: string; end: string; }
export interface AvailabilityDay {
  date: string;
  weekday: string;
  status: 'free' | 'partial' | 'busy' | 'away';
  busy?: AvailabilitySlot[];
  free?: AvailabilitySlot[];
  allDayCommitments?: number;
}

export function availabilityForWindow(
  sources: Rec,
  window: AiWindow,
  timezone: string | null = null,
): AvailabilityDay[] {
  if (!sources) return [];
  const data = assembleCalendarData({
    events: Array.isArray(sources.events) ? sources.events : [],
    trips: Array.isArray(sources.trips) ? sources.trips : [],
    fromDate: window.from,
    toDate: window.to,
    selfId: sources.selfId != null ? String(sources.selfId) : null,
  });
  const days = deriveAvailability({
    events: data.events,
    trips: data.trips,
    fromDate: window.from,
    toDate: window.to,
    timezone,
  }) as Rec[];

  // Strip everything that identifies a record — titles, all-day event names, and
  // the trip name behind an 'away' day — leaving free/busy time only.
  return days.map((d): AvailabilityDay => {
    if (d.status === 'away') return { date: d.date, weekday: d.weekday, status: 'away' };
    const out: AvailabilityDay = { date: d.date, weekday: d.weekday, status: d.status };
    if (Array.isArray(d.busy)) out.busy = d.busy.map((b: Rec) => ({ start: b.start, end: b.end }));
    if (Array.isArray(d.free)) out.free = d.free.map((f: Rec) => ({ start: f.start, end: f.end }));
    if (Array.isArray(d.allDayCommitments)) out.allDayCommitments = d.allDayCommitments.length;
    return out;
  });
}
