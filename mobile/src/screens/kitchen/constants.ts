// Start the week on the grocery shopping day (0=Sun..6=Sat): the most recent
// occurrence of that weekday on or before `d`. The Planner and Grocery panes
// both key their data to this week start.
export function startOfWeek(d: Date, weekStartDay: number): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const diff = (x.getDay() - weekStartDay + 7) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);

export type GroceryFrequency = 'weekly' | 'biweekly';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// One-line summary of the schedule for cards/badges: "Every week on Saturday".
// day == null means no shopping day is configured yet.
export function scheduleSummary(day: number | null, frequency: GroceryFrequency): string {
  if (day == null) return 'Not set — tap to choose a shopping day';
  return `${frequency === 'biweekly' ? 'Every 2 weeks' : 'Every week'} on ${DAY_NAMES_FULL[day]}`;
}

// Days covered by one shopping trip: the planner/grocery "week" is really
// this period.
export const periodDaysOf = (frequency: GroceryFrequency) => (frequency === 'biweekly' ? 14 : 7);

// Local midnight. `iso` reads the *UTC* date, which is right for the
// local-midnight dates the period maths produces but wrong for `new Date()`,
// which carries a time: after ~8pm Eastern the UTC day has already rolled over.
// Normalising first puts both sides of a day comparison on the same footing, in
// any timezone.
export const dayStart = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Where this period's shopping day stands relative to today. Periods tile end
// to end and each *starts* on its shopping day, so the **next upcoming** trip
// is the earliest period start that hasn't passed: this period's, provided the
// one before it already has. On any given weekday that lands a period ahead —
// a period opens on the day you already shopped, so 6 days out of 7 the trip
// you're preparing for belongs to the *next* period.
//
// Both panes read this: the Planner marks the day card, the Grocery list names
// the trip its list is for. Two copies would eventually disagree about what day
// it is — including about the UTC rollover above.
// How far off a date is, in plain words: "today", "tomorrow", "yesterday",
// "in 4 days", "4 days ago". Both ends are normalised to local midnight, so
// this counts *calendar* days — an evening and the next morning are one day
// apart even though barely any hours separate them.
export function relativeDay(target: Date, now = new Date()): string {
  const days = Math.round((dayStart(target).getTime() - dayStart(now).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

const WEEK_WORDS = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

// What to call a shopping period relative to the one you're in: "This Week",
// "Next Week", "Last Week", then "Three Weeks" / "Three Weeks Ago". Dates never
// appear here — the caption beneath names the trip, which is the concrete date
// a shopper actually needs.
//
// Counted in *weeks*, not periods, so a biweekly shopper's next trip reads
// "Two Weeks" — which is when it actually is. (Periods are always a whole
// number of weeks apart: `periodStartOf` snaps to a weekday and a period is 7
// or 14 days, so the division is exact.)
export function periodLabel(weekStart: Date, currentStart: Date): string {
  const weeks = Math.round(
    (dayStart(weekStart).getTime() - dayStart(currentStart).getTime()) / (7 * 86_400_000),
  );
  if (weeks === 0) return 'This Week';
  if (weeks === 1) return 'Next Week';
  if (weeks === -1) return 'Last Week';
  const n = Math.abs(weeks);
  const word = WEEK_WORDS[n] ?? String(n);
  return weeks > 0 ? `${word} Weeks` : `${word} Weeks Ago`;
}

export type ShoppingDayState = 'past' | 'today' | 'next' | 'later';

export function shoppingDayState(weekStart: Date, periodDays: number, now = new Date()): ShoppingDayState {
  const todayStart = dayStart(now);
  const shopDay = dayStart(weekStart);
  if (shopDay.getTime() === todayStart.getTime()) return 'today';
  if (shopDay < todayStart) return 'past';
  const prevShopDay = dayStart(weekStart);
  prevShopDay.setDate(prevShopDay.getDate() - periodDays);
  return prevShopDay < todayStart ? 'next' : 'later';
}

// Start of the shopping period containing `d` — weekly this is startOfWeek;
// biweekly it also snaps back to the anchor's parity (anchor = any known
// shopping day, YYYY-MM-DD) so off-weeks fold into the period that bought them.
export function periodStartOf(d: Date, weekStartDay: number, frequency: GroceryFrequency, anchor?: string | null): Date {
  const w = startOfWeek(d, weekStartDay);
  if (frequency !== 'biweekly' || !anchor) return w;
  const a = startOfWeek(new Date(`${anchor}T00:00:00`), weekStartDay);
  const weeks = Math.round((w.getTime() - a.getTime()) / 604800000);
  if (((weeks % 2) + 2) % 2 === 1) w.setDate(w.getDate() - 7);
  return w;
}
