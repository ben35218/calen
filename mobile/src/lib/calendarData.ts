// Client-side calendar loading: fetch raw source records, decrypt them over the
// local replica, and expand into CalendarData with the shared @household/calendar
// engine (the same engine the server runs). Offline-first: falls back to the
// cached source records. See docs/E2EE-SYNC-PLAN.md §9.1 P2.

import { assembleCalendarData } from '@household/calendar';
import { CalendarData, settingsApi, tripsApi } from '../api';
import { currentUserId, openRecord } from './e2ee';
import { applyAddonLocks, getOwnedAddonIds } from './addons';
import { getAccessibleCustomCalendarIds } from './calendarPrefs';
import { getFeedEvents } from './calendarFeeds';
import * as replica from './replica';
import { syncRecords } from './records';

export interface CalendarSources {
  events: any[]; tasks: any[]; chores: any[]; people: any[]; trips: any[];
  recipeSchedules: any[]; selfId: string | null; groceryShoppingDay: number | null;
  groceryFrequency: 'weekly' | 'biweekly'; groceryAnchor: string | null;
}

// Load the calendar sources from the local replica (Signal-parity C3b). The
// content records (events/tasks/chores/people/recipe schedules) now live in the
// unified opaque store: syncRecords() pulls /records/sync, decrypts each row via
// openOpaqueRecord, and buckets it into its per-collection replica — so the
// replica already holds the DECRYPTED records, and this just reads them. (Trips
// stay their own collection — not migrated — so they're still fetched + decrypted
// here.) The non-content routing bits the old /calendar/raw returned (selfId,
// grocery config) come from the auth session + settings, never from the store.
// Offline-first: a failed sync/settings fetch falls back to the cached replica.
// Reused by the Calendar Assistant so list_events/call_business run without any
// server plaintext (§9.1 P4c).
export async function loadCalendarSources({ from, to }: { from: string; to: string }): Promise<CalendarSources> {
  // Pull the unified feed into the replica (best-effort — offline reads the cache).
  await syncRecords().catch(() => {});

  // selfId = the signed-in user (identifies their self-Person for birthdays).
  const selfId = currentUserId();
  // null = no shopping day configured; the engine then emits no grocery markers.
  let groceryShoppingDay: number | null = null;
  let groceryFrequency: 'weekly' | 'biweekly' = 'weekly';
  let groceryAnchor: string | null = null;
  try {
    const { data } = await settingsApi.get();
    groceryShoppingDay = data.groceryShoppingDay ?? null;
    groceryFrequency = (data.groceryFrequency as 'weekly' | 'biweekly') ?? 'weekly';
    groceryAnchor = (data.groceryAnchor as string | null) ?? null;
  } catch { /* keep defaults */ }

  // Content collections: read the decrypted rows straight from the replica. Trips
  // are still a per-collection resource (D2), fetched + decrypted separately.
  const [events, tasks, chores, people, recipeSchedules, trips] = await Promise.all([
    replica.getAll<any>('CalendarEvent').catch(() => []),
    replica.getAll<any>('MaintenanceTask').catch(() => []),
    replica.getAll<any>('Chore').catch(() => []),
    replica.getAll<any>('Person').catch(() => []),
    replica.getAll<any>('RecipeSchedule').catch(() => []),
    loadTrips(),
  ]);

  return { events, tasks, chores, people, trips, recipeSchedules, selfId, groceryShoppingDay, groceryFrequency, groceryAnchor };
}

// Trips stay their own (non-migrated) collection; fetch + decrypt them for the
// calendar overlay, offline-first over their replica bucket.
async function loadTrips(): Promise<any[]> {
  try {
    const { data } = await tripsApi.list();
    const decrypted = await Promise.all((data || []).map((t) => openRecord('Trip', t as any)));
    replica.upsert('Trip', decrypted as any).catch(() => {});
    return decrypted;
  } catch {
    return replica.getAll<any>('Trip').catch(() => []);
  }
}

export async function loadCalendarData({ from, to }: { from: string; to: string }): Promise<CalendarData> {
  const s = await loadCalendarSources({ from, to });
  const data = assembleCalendarData({
    events: s.events,
    tasks: s.tasks,
    chores: s.chores,
    people: s.people,
    trips: s.trips,
    recipeSchedules: s.recipeSchedules,
    fromDate: new Date(from),
    toDate: new Date(to),
    selfId: s.selfId,
    groceryShoppingDay: s.groceryShoppingDay,
    groceryFrequency: s.groceryFrequency,
    groceryAnchor: s.groceryAnchor,
  }) as unknown as CalendarData;

  // Access control for custom calendars: hide a housemate's events on
  // calendars not shared with this user. Enforced here — the one chokepoint
  // every calendar view and the reminder scheduler load through — because the
  // server can't filter these post-§9.
  const accessible = await getAccessibleCustomCalendarIds();
  data.events = (data.events ?? []).filter(
    (e) => !e.calendarType?.startsWith('custom-') || accessible.has(e.calendarType)
  );

  // Feature-calendar add-ons: locked features' items never render anywhere.
  // Enforced at this same chokepoint (client-side — the server can't see
  // record types) so every view, search, print, and the reminder scheduler
  // exclude them together. Data is retained; purchasing restores it.
  applyAddonLocks(data, await getOwnedAddonIds());

  // Subscribed ICS feeds: expanded client-side (the events never touch the
  // server — E2EE), injected here so every view and the reminder scheduler see
  // them. Access filtering is inherent: only calendars visible to this user
  // are in the subscription list.
  const feedEvents = await getFeedEvents({ from, to });
  if (feedEvents.length) {
    data.events = [...data.events, ...feedEvents].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
    );
  }
  return data;
}
