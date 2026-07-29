// Shared start→end datetime math for every form that pairs a "Starts" with an
// "Ends" (calendar events, trips, itinerary items, reschedule windows).
//
// The rule these helpers encode: when the user drags the **end** to at/before
// the **start**, slide the start back by the same amount so the gap the user
// already chose is preserved — 8–9am with the end moved to 4am makes the start
// 3am. Only the start moves; the end stays exactly where the user put it. When
// the new end is still after the start we leave the start alone.

export type DateTimeParts = { date: string; time: string };

const MIN_PER_DAY = 1440;

// Minutes since midnight for an "HH:MM" (or "HH:MM:SS") string. Bad input → 0.
export function timeToMinutes(time: string): number {
  const [h, m] = (time || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// "HH:MM" for minutes-since-midnight, wrapping into [0, 1440).
export function minutesToTime(min: number): string {
  const wrapped = ((Math.round(min) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// Whole days from a→b for "YYYY-MM-DD" strings (b − a). Anchored at local
// midnight and rounded so DST-short/long days still count as one.
export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((db - da) / 86400000);
}

// "YYYY-MM-DD" for `n` days after `date` (n may be negative).
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Given the current start, the end **before** the edit, and the **new** end,
// return the start shifted to keep the original duration — but only when the new
// end lands strictly before the start (the case the user is editing into).
// Cross-date aware: the returned start may roll to an earlier day. Returns null
// when the new end is still at/after the start (leave the start put) or when the
// pair had no positive duration to preserve.
export function startKeepingDuration(
  start: DateTimeParts,
  prevEnd: DateTimeParts,
  newEnd: DateTimeParts
): DateTimeParts | null {
  const anchor = start.date;
  const startMin = timeToMinutes(start.time);
  const prevEndMin = daysBetween(anchor, prevEnd.date) * MIN_PER_DAY + timeToMinutes(prevEnd.time);
  const newEndMin = daysBetween(anchor, newEnd.date) * MIN_PER_DAY + timeToMinutes(newEnd.time);
  const duration = prevEndMin - startMin;
  if (duration <= 0) return null; // no positive gap to preserve
  if (newEndMin >= startMin) return null; // end still after the start — nothing to do
  const newStartMin = newEndMin - duration;
  return {
    date: addDays(anchor, Math.floor(newStartMin / MIN_PER_DAY)),
    time: minutesToTime(newStartMin),
  };
}

// Same-day, time-only variant (a from→to window sharing one date, e.g. reschedule
// options). Clamps at 00:00 so the start never rolls to the previous day. Returns
// the new start "HH:MM", or null when no shift is needed.
export function startTimeKeepingDuration(
  startTime: string,
  prevEndTime: string,
  newEndTime: string
): string | null {
  const startMin = timeToMinutes(startTime);
  const duration = timeToMinutes(prevEndTime) - startMin;
  if (duration <= 0) return null;
  const newEndMin = timeToMinutes(newEndTime);
  if (newEndMin >= startMin) return null;
  return minutesToTime(Math.max(0, newEndMin - duration));
}
