import { useQuery } from '@tanstack/react-query';
import { householdApi } from '../api';
import {
  CALENDARS,
  CALENDAR_GROUP_KEYS,
  CalendarDef,
  CalendarGroupKey,
  CustomCalendar,
  calendarGroupOf,
  sortByCalendarOrder,
  sortByGroupOrder,
  useCalendarGroupOrder,
  useCalendarOrder,
  useCustomCalendars,
  useDeletedDefaultCalendars,
} from '../lib/calendarPrefs';
import { useOwnedAddons } from '../lib/addons';

// The one place the calendar lists are sectioned and sorted. Both the Calendars
// manager and Colors & Order render from this, because the two screens have to
// agree: Colors & Order is where the user SETS the arrangement, so a calendar
// it files under a different section (or leaves out entirely — the bug this
// hook fixes, where Colors & Order only knew the built-ins and holiday
// calendars) makes their reordering look like it did nothing.

export const CALENDAR_GROUP_LABELS: Record<CalendarGroupKey, string> = {
  household: 'HOUSEHOLD',
  justMe: 'JUST ME',
  shared: 'SHARED',
};

// One row of a section. Built-in and custom calendars are ONE sequence, not a
// built-ins block followed by a customs block: keeping them as two lists sorted
// independently pinned every custom calendar below every built-in, so a
// newly-added calendar sat at the bottom of HOUSEHOLD and neither it nor the
// built-ins above it could be moved past each other (reported 2026-08-23).
// `kind` is what the row renderers dispatch on — the two draw differently
// (Open pill target, subtitle), but they sort as peers.
export type CalendarGroupItem =
  | { kind: 'default'; id: string; cal: CalendarDef }
  | { kind: 'custom'; id: string; cal: CustomCalendar };

export interface CalendarGroup {
  key: CalendarGroupKey;
  label: string;
  items: CalendarGroupItem[];
}

export function useCalendarGroups() {
  const { calendars: customCalendars } = useCustomCalendars();
  const { deletedIds } = useDeletedDefaultCalendars();
  const { order, setOrder } = useCalendarOrder();
  const { groupOrder, setGroupOrder } = useCalendarGroupOrder();
  const { isUnlocked } = useOwnedAddons();

  // In a single-member household the Just me / Household split carries no
  // information — everything IS the household — so JUST ME merges into
  // HOUSEHOLD for display. The data stays unshared: when a second member
  // joins, unshared calendars move to a now-meaningful JUST ME group instead
  // of being silently exposed. Unknown member count (first load) keeps the
  // split, the safe reading.
  const membersQ = useQuery({
    queryKey: ['household', 'memberCount'],
    queryFn: async () => (await householdApi.get()).data.members?.length ?? 1,
    staleTime: 5 * 60_000,
  });
  const solo = membersQ.data === 1;

  // Built-ins the household actually has: deleted ones are gone until restored,
  // and locked add-on calendars aren't theirs yet (calendar.md → add-ons: a
  // locked id hides from every calendar-list surface, this one included).
  // They lead the section's NATURAL order (what an untouched account sees);
  // once the user arranges the section, the saved sequence decides.
  const defaults: CalendarGroupItem[] = CALENDARS
    .filter((c) => !deletedIds.includes(c.id) && isUnlocked(c.id))
    .map((cal) => ({ kind: 'default', id: cal.id, cal }));
  const customIn = (keys: CalendarGroupKey[]): CalendarGroupItem[] =>
    customCalendars
      .filter((c) => keys.includes(calendarGroupOf(c)))
      .map((cal) => ({ kind: 'custom', id: cal.id, cal }));
  const section = (key: CalendarGroupKey, items: CalendarGroupItem[]): CalendarGroup => ({
    key,
    label: CALENDAR_GROUP_LABELS[key],
    items: sortByCalendarOrder(items, order),
  });

  const byKey: Record<CalendarGroupKey, CalendarGroup> = {
    household: section('household', [
      ...defaults,
      ...customIn(solo ? ['household', 'justMe'] : ['household']),
    ]),
    justMe: section('justMe', solo ? [] : customIn(['justMe'])),
    shared: section('shared', customIn(['shared'])),
  };

  return {
    groups: sortByGroupOrder(CALENDAR_GROUP_KEYS.map((k) => byKey[k]), groupOrder),
    // The whole sequence, so a screen that reorders writes back an absolute
    // list rather than a delta (matching setOrder / setGroupOrder's contract).
    order,
    setOrder,
    groupOrder,
    setGroupOrder,
  };
}
