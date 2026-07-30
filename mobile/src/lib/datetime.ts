// Shared start→end datetime math for every form that pairs a "Starts" with an
// "Ends" (calendar events, trips, itinerary items, reschedule windows).
//
// The rule these helpers encode is symmetric, so the end is NEVER left before
// the start:
//   • Drag the **end** to at/before the **start** → slide the start back by the
//     same amount so the gap is preserved (8–9am, end → 4am ⇒ start 3am).
//     `startKeepingDuration` / `startTimeKeepingDuration`.
//   • Drag the **start** to at/after the **end** → push the end forward by the
//     same amount so the gap is preserved (8–9am, start → 10am ⇒ end 11am).
//     `endKeepingDuration` / `endTimeKeepingDuration`.
// In each case only the *other* endpoint moves; the one the user is editing
// stays exactly where they put it. When the edit keeps the pair in order we
// leave the other endpoint alone.

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

// The mirror of startKeepingDuration: given the current end, the start **before**
// the edit, and the **new** start, return the end shifted to keep the original
// duration — but only when the new start lands strictly after the end (the case
// the user is editing into). Cross-date aware: the returned end may roll to a
// later day. Returns null when the new start is still at/before the end (leave
// the end put) or the pair had no positive duration to preserve.
export function endKeepingDuration(
  prevStart: DateTimeParts,
  end: DateTimeParts,
  newStart: DateTimeParts
): DateTimeParts | null {
  const anchor = prevStart.date;
  const endMin = daysBetween(anchor, end.date) * MIN_PER_DAY + timeToMinutes(end.time);
  const prevStartMin = timeToMinutes(prevStart.time);
  const newStartMin = daysBetween(anchor, newStart.date) * MIN_PER_DAY + timeToMinutes(newStart.time);
  const duration = endMin - prevStartMin;
  if (duration <= 0) return null; // no positive gap to preserve
  if (newStartMin <= endMin) return null; // start still before the end — nothing to do
  const newEndMin = newStartMin + duration;
  return {
    date: addDays(anchor, Math.floor(newEndMin / MIN_PER_DAY)),
    time: minutesToTime(newEndMin),
  };
}

// Same-day, time-only mirror of startTimeKeepingDuration (a from→to window
// sharing one date). Clamps at 23:59 so the end never rolls to the next day.
// Returns the new end "HH:MM", or null when no shift is needed.
export function endTimeKeepingDuration(
  startTime: string,
  prevEndTime: string,
  newStartTime: string
): string | null {
  const endMin = timeToMinutes(prevEndTime);
  const duration = endMin - timeToMinutes(startTime);
  if (duration <= 0) return null;
  const newStartMin = timeToMinutes(newStartTime);
  if (newStartMin <= endMin) return null;
  return minutesToTime(Math.min(MIN_PER_DAY - 1, newStartMin + duration));
}
