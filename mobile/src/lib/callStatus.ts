// Post-call status for calendar events, derived from the shared ['calls'] query
// (the same cache the event view and Invitations poll). Used to dim events whose
// AI call has resolved: a confirmed cancellation, or a confirmed reschedule the
// user hasn't applied to the event's time yet.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { callsApi, PhoneCallRecord } from '../api';

const CALL_TERMINAL = ['ended', 'failed'];

// Shared read of the household's recent calls. Keyed identically to the event
// view so react-query dedupes it; polls only while a call is still running.
export function useCalls() {
  return useQuery({
    queryKey: ['calls'],
    queryFn: async () => (await callsApi.list()).data,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => !CALL_TERMINAL.includes(c.status)) ? 10_000 : false,
  });
}

// Which events an AI call has resolved, derived from the confirmed call itself
// (not a stored flag — the server can't set one under E2EE, so the signal is the
// call record). Both states clear once the call notice is **acknowledged**
// (Dismiss on the event view / OK in Invitations), which returns the event to a
// normal appearance:
//   • cancelled          — a confirmed CANCEL call, dims + strikes the event.
//   • reschedulePending  — a confirmed RESCHEDULE the user hasn't applied yet
//                          (still at the old time), dims the event.
//
// **Per-occurrence scoping.** A recurring event is one record: every occurrence
// shares its id. A call placed against one occurrence carries that occurrence's
// local Y-M-D (`occurrenceDate`), so its confirmed outcome dims ONLY that
// instance. A call with no `occurrenceDate` (non-recurring event, or a legacy
// row) is unscoped — it matches the event on every day it renders (preserving
// the multi-day-span behavior). Callers pass the date of the occurrence they're
// rendering; `isCancelled(id, date)` returns true when a matching call exists.
export interface EventStatus {
  isCancelled: (eventId: string, occurrenceDate?: string) => boolean;
  isReschedulePending: (eventId: string, occurrenceDate?: string) => boolean;
}

// Per event id: `true` = an unscoped confirmed call (matches every day); a Set =
// the specific occurrence dates confirmed calls resolved.
type DateMatch = Map<string, true | Set<string>>;

function addMatch(map: DateMatch, id: string, date: string | null | undefined) {
  const cur = map.get(id);
  if (cur === true) return; // an unscoped call already covers every day
  if (!date) { map.set(id, true); return; }
  if (cur instanceof Set) cur.add(date);
  else map.set(id, new Set([date]));
}

function matches(map: DateMatch, id: string, date?: string): boolean {
  const v = map.get(id);
  if (v === undefined) return false;
  if (v === true) return true; // unscoped call → every occurrence
  return date != null && v.has(date); // scoped → only the matching date
}

// Pure builder (exported so the day-view layout test can construct a status).
export function buildEventStatus(calls: PhoneCallRecord[] | undefined): EventStatus {
  const cancelled: DateMatch = new Map();
  const reschedule: DateMatch = new Map();
  for (const c of calls ?? []) {
    if (!c.eventId || c.outcome !== 'confirmed' || c.acknowledged) continue;
    if (c.action === 'cancel') addMatch(cancelled, c.eventId, c.occurrenceDate);
    else if (c.action === 'reschedule') addMatch(reschedule, c.eventId, c.occurrenceDate);
  }
  return {
    isCancelled: (id, date) => matches(cancelled, id, date),
    isReschedulePending: (id, date) => matches(reschedule, id, date),
  };
}

// Memoised on the calls data so the returned matchers keep a stable identity
// across renders — safe to pass into other hooks' dependency arrays.
export function useCallEventStatus(): EventStatus {
  const { data } = useCalls();
  return useMemo(() => buildEventStatus(data), [data]);
}

// The most recent call placed for a given event / occurrence, if any (newest
// first from the API). A non-null `occurrenceDate` scopes to that instance
// (matching calls placed for that date, plus unscoped/legacy calls).
export function latestCallForEvent(
  calls: PhoneCallRecord[] | undefined,
  eventId: string,
  occurrenceDate?: string,
): PhoneCallRecord | undefined {
  return (calls ?? []).find(
    (c) => c.eventId === eventId && (c.occurrenceDate == null || c.occurrenceDate === occurrenceDate),
  );
}
