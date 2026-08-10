// Client-side calendar loading: fetch raw source records, decrypt them over the
// local replica, and expand into CalendarData with the shared @household/calendar
// engine (the same engine the server runs). Offline-first: falls back to the
// cached source records. See docs/E2EE-SYNC-PLAN.md §9.1 P2.
//
// Two sync modes (stale-while-revalidate). `inline` (the default) awaits the
// server pull before assembling — the right shape for one-shot consumers that
// must see fresh truth (print, the reminder scheduler, the assistant). The
// interactive calendar views pass `background`: they assemble straight from the
// replica (instant paint) while revalidateCalendar() pulls the server in the
// background and invalidates the ['calendar'] queries only when something
// actually changed. A device that has never completed a sync pass (fresh
// install, post-unlock reset) has an empty replica, so `background` silently
// falls back to `inline` rather than flash an empty calendar.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { assembleCalendarData } from '@household/calendar';
import { CalendarData, settingsApi, tripsApi } from '../api';
import { currentUserId, openRecord } from './e2ee';
import { populateRecipeRefs } from './mealSchedule';
import { applyAddonLocks, getOwnedAddonIds } from './addons';
import { getAccessibleCustomCalendarIds } from './calendarPrefs';
import { FeedSource, expandFeedSources, loadFeedSources } from './calendarFeeds';
import { queryClient } from './queryClient';
import * as replica from './replica';
import { hasSyncedRecords, syncRecords } from './records';

export type CalendarSyncMode = 'inline' | 'background';

export interface CalendarSources {
  events: any[]; tasks: any[]; chores: any[]; people: any[]; trips: any[];
  recipeSchedules: any[]; selfId: string | null; groceryShoppingDay: number | null;
  groceryFrequency: 'weekly' | 'biweekly'; groceryAnchor: string | null;
}

// ── Grocery settings cache ───────────────────────────────────────────────────
// The grocery config is the one piece of /settings the calendar needs; cache the
// last fetched values so the background path (and offline) renders the real
// shopping-day markers instead of resetting to defaults.

interface GrocerySettings {
  groceryShoppingDay: number | null;
  groceryFrequency: 'weekly' | 'biweekly';
  groceryAnchor: string | null;
}

const GROCERY_CACHE_KEY = 'hc_grocery_settings';
const DEFAULT_GROCERY: GrocerySettings = { groceryShoppingDay: null, groceryFrequency: 'weekly', groceryAnchor: null };

async function readGroceryCache(): Promise<GrocerySettings> {
  try {
    const raw = await AsyncStorage.getItem(GROCERY_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_GROCERY };
    return {
      groceryShoppingDay: typeof parsed.groceryShoppingDay === 'number' ? parsed.groceryShoppingDay : null,
      groceryFrequency: parsed.groceryFrequency === 'biweekly' ? 'biweekly' : 'weekly',
      groceryAnchor: typeof parsed.groceryAnchor === 'string' ? parsed.groceryAnchor : null,
    };
  } catch {
    return { ...DEFAULT_GROCERY };
  }
}

// Fetch the grocery config and refresh the cache. Null on failure (offline).
async function fetchGrocerySettings(): Promise<GrocerySettings | null> {
  try {
    const { data } = await settingsApi.get();
    const next: GrocerySettings = {
      groceryShoppingDay: data.groceryShoppingDay ?? null,
      groceryFrequency: (data.groceryFrequency as 'weekly' | 'biweekly') ?? 'weekly',
      groceryAnchor: (data.groceryAnchor as string | null) ?? null,
    };
    AsyncStorage.setItem(GROCERY_CACHE_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  } catch {
    return null;
  }
}

// ── Background revalidation ──────────────────────────────────────────────────

let revalidating: Promise<void> | null = null;
let lastRevalidatedAt = 0;
// Floor between passes: an invalidation-triggered refetch re-enters here, and
// several views mounting in quick succession must not each start a full pull.
const REVALIDATE_MIN_INTERVAL_MS = 10_000;

// Pull the server truth (records feed + grocery settings + trips) behind the
// already-painted replica, and invalidate the ['calendar'] queries only when
// something actually changed — unchanged passes end quietly, which is also what
// keeps the invalidate → refetch → revalidate cycle from spinning.
export function revalidateCalendar(): Promise<void> {
  if (revalidating) return revalidating;
  if (Date.now() - lastRevalidatedAt < REVALIDATE_MIN_INTERVAL_MS) return Promise.resolve();
  revalidating = (async () => {
    const cached = await readGroceryCache();
    const [recs, grocery, tripsRes] = await Promise.all([
      syncRecords().catch(() => null),
      fetchGrocerySettings(),
      fetchTripsIntoReplica(),
    ]);
    const changed =
      (recs ? recs.upserted + recs.removed > 0 : false) ||
      (grocery ? JSON.stringify(grocery) !== JSON.stringify(cached) : false) ||
      (tripsRes?.changed ?? false);
    lastRevalidatedAt = Date.now();
    if (changed) queryClient.invalidateQueries({ queryKey: ['calendar'] });
  })().finally(() => {
    revalidating = null;
  });
  return revalidating;
}

// Poke-friendly revalidation: a server poke (socket message, reconnect,
// foreground) must never be silently dropped by the floor above — a poke means
// the server HAS something new. If a pass ran too recently, park a single
// trailing timer at the floor's expiry instead; bursts of pokes coalesce into
// that one pending pass. Staleness after a poke is therefore bounded by
// REVALIDATE_MIN_INTERVAL_MS, never unbounded.
let pendingRevalidate: ReturnType<typeof setTimeout> | null = null;

export function scheduleRevalidate(): void {
  if (pendingRevalidate) return;
  const wait = Math.max(0, REVALIDATE_MIN_INTERVAL_MS - (Date.now() - lastRevalidatedAt));
  pendingRevalidate = setTimeout(() => {
    pendingRevalidate = null;
    // A pass already in flight may have queried the server BEFORE the poke's
    // write landed — joining it could still miss the change. Re-schedule after
    // it settles instead (that trailing pass waits out the floor, so this
    // converges rather than spins).
    const inFlight = revalidating;
    if (inFlight) {
      void inFlight.then(() => scheduleRevalidate());
      return;
    }
    void revalidateCalendar();
  }, wait);
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
export async function loadCalendarSources(
  // from/to are accepted for signature compatibility but unused: the replica
  // holds everything, so the sources are range-independent (ranges only matter
  // to expansion).
  { sync = 'inline' }: { from?: string; to?: string; sync?: CalendarSyncMode } = {},
): Promise<CalendarSources> {
  const mode: CalendarSyncMode = sync === 'background' && (await hasSyncedRecords()) ? 'background' : 'inline';

  // null shopping day = none configured; the engine then emits no grocery markers.
  let grocery: GrocerySettings;
  if (mode === 'inline') {
    // Pull the unified feed into the replica (best-effort — offline reads the
    // cache), with the settings fetch alongside rather than after it.
    const [, fetched] = await Promise.all([syncRecords().catch(() => {}), fetchGrocerySettings()]);
    grocery = fetched ?? (await readGroceryCache());
  } else {
    grocery = await readGroceryCache();
    void revalidateCalendar();
  }

  // selfId = the signed-in user (identifies their self-Person for birthdays).
  const selfId = currentUserId();

  // Content collections: read the decrypted rows straight from the replica. Trips
  // are still a per-collection resource (D2), fetched + decrypted separately.
  const [events, tasks, chores, people, schedules, recipes, trips] = await Promise.all([
    replica.getAll<any>('CalendarEvent').catch(() => []),
    replica.getAll<any>('MaintenanceTask').catch(() => []),
    replica.getAll<any>('Chore').catch(() => []),
    replica.getAll<any>('Person').catch(() => []),
    replica.getAll<any>('RecipeSchedule').catch(() => []),
    replica.getAll<any>('Recipe').catch(() => []),
    mode === 'inline' ? loadTrips() : replica.getAll<any>('Trip').catch(() => []),
  ]);

  // Re-attach each scheduled meal's recipe title from the Recipe replica — the
  // same content-blind-store join the planner window needs (lib/mealSchedule).
  const recipeSchedules = populateRecipeRefs(schedules, recipes);

  return { events, tasks, chores, people, trips, recipeSchedules, selfId, ...grocery };
}

// Fetch + decrypt the trips collection and reconcile the replica's Trip bucket
// to it (including removals — the sole reader in background mode is the replica,
// so a server-deleted trip must not linger there). Null on failure (offline /
// locked); `changed` compares (_id, updatedAt) pairs against the prior bucket.
async function fetchTripsIntoReplica(): Promise<{ trips: any[]; changed: boolean } | null> {
  try {
    const { data } = await tripsApi.list();
    const decrypted = await Promise.all((data || []).map((t) => openRecord('Trip', t as any)));
    const prev = await replica.getAll<any>('Trip').catch(() => []);
    const rowKey = (r: any) => `${r._id}:${r.updatedAt ?? ''}`;
    const prevKeys = new Set(prev.map(rowKey));
    const changed = prev.length !== decrypted.length || decrypted.some((t: any) => !prevKeys.has(rowKey(t)));
    const fetchedIds = new Set(decrypted.map((t: any) => t._id));
    await Promise.all(
      prev.filter((t: any) => !fetchedIds.has(t._id)).map((t: any) => replica.remove('Trip', t._id).catch(() => {})),
    );
    await replica.upsert('Trip', decrypted as any).catch(() => {});
    return { trips: decrypted, changed };
  } catch {
    return null;
  }
}

// Trips stay their own (non-migrated) collection; fetch + decrypt them for the
// calendar overlay, offline-first over their replica bucket.
async function loadTrips(): Promise<any[]> {
  const res = await fetchTripsIntoReplica();
  if (res) return res.trips;
  return replica.getAll<any>('Trip').catch(() => []);
}

// The range-independent half of a calendar load: the replica sources plus the
// two access inputs the expansion chokepoint filters on. The month grid loads
// this ONCE per sync pass and then expands months out of it incrementally as
// the user scrolls — the sources never depended on the requested range (the
// replica holds everything), so splitting them out is what makes the grid's
// unbounded window cheap: extending the window re-runs expansion only, never
// the replica read.
export interface CalendarWindowSources {
  sources: CalendarSources;
  accessibleCustomIds: Set<string>;
  ownedAddonIds: Set<string>;
  feedSources: FeedSource[];
}

export async function loadCalendarWindowSources(
  { sync }: { sync?: CalendarSyncMode } = {},
): Promise<CalendarWindowSources> {
  const [sources, accessibleCustomIds, ownedAddonIds, feedSources] = await Promise.all([
    loadCalendarSources({ sync }),
    getAccessibleCustomCalendarIds(),
    getOwnedAddonIds(),
    loadFeedSources(),
  ]);
  return { sources, accessibleCustomIds, ownedAddonIds, feedSources };
}

// The range-dependent half: expand one span of already-loaded sources into
// CalendarData — the shared engine plus the chokepoint filters every calendar
// consumer must pass through together (custom-calendar access, add-on locks,
// ICS feed injection). SYNCHRONOUS on purpose: expansion is derived data, so
// the month grid computes it at render time (memoized per month) rather than
// round-tripping through async query state — a data change then repaints in
// one pass, with no intermediate frames.
export function expandCalendarRange(
  win: CalendarWindowSources,
  from: string,
  to: string,
): CalendarData {
  const s = win.sources;
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
  data.events = (data.events ?? []).filter(
    (e) => !e.calendarType?.startsWith('custom-') || win.accessibleCustomIds.has(e.calendarType)
  );

  // Feature-calendar add-ons: locked features' items never render anywhere.
  // Enforced at this same chokepoint (client-side — the server can't see
  // record types) so every view, search, print, and the reminder scheduler
  // exclude them together. Data is retained; purchasing restores it.
  applyAddonLocks(data, win.ownedAddonIds);

  // Subscribed ICS feeds: expanded client-side (the events never touch the
  // server — E2EE), injected here so every view and the reminder scheduler see
  // them. Access filtering is inherent: only calendars visible to this user
  // are in the subscription list.
  const feedEvents = expandFeedSources(win.feedSources, { from, to });
  if (feedEvents.length) {
    data.events = [...data.events, ...feedEvents].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
    );
  }
  return data;
}

export async function loadCalendarData(
  { from, to, sync }: { from: string; to: string; sync?: CalendarSyncMode },
): Promise<CalendarData> {
  return expandCalendarRange(await loadCalendarWindowSources({ sync }), from, to);
}
