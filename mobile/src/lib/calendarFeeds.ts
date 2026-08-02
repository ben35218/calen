import AsyncStorage from '@react-native-async-storage/async-storage';
import ICAL from 'ical.js';
import type { CalendarEvent } from '../api';
import { getSubscribedCalendars, CustomCalendar } from './calendarPrefs';
import { queryClient } from './queryClient';

// Subscribed external calendars (ICS/webcal feeds). The subscription record is
// a CustomCalendar with a feedUrl; the events are NOT — they never exist as
// server rows (E2EE: the server must stay blind to event content), so every
// member device fetches the feed itself, expands occurrences for the visible
// window, and lib/calendarData injects them alongside real events. Mirrors the
// holidays pattern: computed on demand, cached locally, read-only.

export const FEED_STALE_MS = 60 * 60 * 1000; // refetch when older than ~1 hour
// Synthetic occurrence ids: `feed:<calendarId>:<occStartIso>:<uid>` (the uid is
// the remainder after the third ':' — feed UIDs may themselves contain ':').
export const FEED_EVENT_ID_PREFIX = 'feed:';

const ICS_KEY_PREFIX = 'hc_feed_ics_';
const META_KEY = 'hc_feed_meta';
// Android AsyncStorage rows cap out around 2MB; oversized feeds stay in-memory
// only (re-fetched on next cold start).
const MAX_CACHED_ICS = 1_500_000;
// Iteration ceiling per recurring event — bounds pathological RRULEs while
// leaving room for e.g. a decade-old daily event iterating up to the window.
const MAX_OCCURRENCE_ITERATIONS = 5000;

export type FeedErrorCode = 'invalid_url' | 'fetch_failed' | 'not_ics';

export class FeedError extends Error {
  code: FeedErrorCode;
  constructor(code: FeedErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

interface FeedMeta {
  url: string;
  fetchedAt: number;
  name?: string;
  error?: string;
  errorAt?: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

let metaState: Record<string, FeedMeta> | null = null;
// Raw ICS text per calendar (mirrors AsyncStorage; sole home for oversized feeds).
const icsMemory = new Map<string, string>();
// Parsed VEVENTs per calendar, rebuilt whenever the ICS text changes.
const parsedCache = new Map<string, { ics: string; calName: string | null; events: ICAL.Event[] }>();
// Occurrences from the latest expansion, so EventFormScreen can resolve a
// tapped synthetic id without re-expanding.
const lastExpandedById = new Map<string, CalendarEvent>();
// One in-flight refresh per calendar.
const refreshing = new Map<string, Promise<void>>();

async function loadMeta(): Promise<Record<string, FeedMeta>> {
  if (metaState) return metaState;
  try {
    metaState = JSON.parse((await AsyncStorage.getItem(META_KEY)) || '{}');
  } catch {
    metaState = {};
  }
  return metaState!;
}

function saveMeta() {
  if (metaState) AsyncStorage.setItem(META_KEY, JSON.stringify(metaState)).catch(() => {});
}

// ── URL + fetch ──────────────────────────────────────────────────────────────

// 'webcal://x' → 'https://x'. Throws invalid_url unless http(s) remains — the
// server applies the same rule on create (routes/calendars.js).
export function normalizeFeedUrl(raw: string): string {
  const url = String(raw || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) throw new FeedError('invalid_url');
  return url;
}

async function fetchIcs(url: string): Promise<string> {
  let res: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    res = await fetch(url, { signal: abort.signal });
  } catch (e: any) {
    throw new FeedError('fetch_failed', e?.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new FeedError('fetch_failed', `HTTP ${res.status}`);
  return res.text();
}

// ── Parsing (ical.js) ────────────────────────────────────────────────────────

function parseIcs(ics: string): { calName: string | null; events: ICAL.Event[] } {
  let comp: ICAL.Component;
  try {
    comp = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new FeedError('not_ics');
  }
  if (comp.name !== 'vcalendar' && !comp.getFirstSubcomponent('vevent')) {
    throw new FeedError('not_ics');
  }

  // Register the feed's own timezone definitions so DTSTART;TZID=… converts to
  // the right UTC instant. A TZID without a VTIMEZONE falls back to floating
  // time — the best available reading.
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(vtz);
    if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
  }

  // Group VEVENTs by UID: the component without RECURRENCE-ID is the master;
  // ones with it are modified occurrences, related as exceptions so the
  // iterator applies them. An override without a master renders standalone.
  const byUid = new Map<string, { master?: ICAL.Component; overrides: ICAL.Component[] }>();
  for (const ev of comp.getAllSubcomponents('vevent')) {
    const uid = String(ev.getFirstPropertyValue('uid') ?? `no-uid-${byUid.size}`);
    const entry = byUid.get(uid) ?? { overrides: [] };
    if (ev.getFirstPropertyValue('recurrence-id')) entry.overrides.push(ev);
    else entry.master = ev;
    byUid.set(uid, entry);
  }

  const events: ICAL.Event[] = [];
  for (const { master, overrides } of byUid.values()) {
    if (master) {
      const event = new ICAL.Event(master);
      for (const ov of overrides) {
        try {
          event.relateException(new ICAL.Event(ov));
        } catch {} // malformed exception — keep the series
      }
      events.push(event);
    } else {
      for (const ov of overrides) events.push(new ICAL.Event(ov));
    }
  }
  const calName = comp.getFirstPropertyValue('x-wr-calname');
  return { calName: calName ? String(calName) : null, events };
}

function parsedFor(calendarId: string, ics: string) {
  const hit = parsedCache.get(calendarId);
  if (hit && hit.ics === ics) return hit;
  const parsed = { ics, ...parseIcs(ics) };
  parsedCache.set(calendarId, parsed);
  return parsed;
}

// ── Occurrence → CalendarEvent mapping ───────────────────────────────────────

function allDayIso(t: ICAL.Time): string {
  // The app stores all-day events at noon UTC (see EventFormScreen /
  // shared/calendar) so they render on the same date in every timezone.
  return `${t.toString().slice(0, 10)}T12:00:00.000Z`;
}

function toCalendarEvent(
  calendarId: string,
  item: ICAL.Event,
  startDate: ICAL.Time,
  endDate: ICAL.Time | null
): CalendarEvent {
  const allDay = !!startDate.isDate;
  let start: string;
  let end: string | undefined;
  if (allDay) {
    start = allDayIso(startDate);
    if (endDate) {
      // ICS all-day DTEND is exclusive; the app's endDate is inclusive.
      const inclusive = endDate.clone();
      inclusive.adjust(-1, 0, 0, 0);
      const endIso = allDayIso(inclusive);
      if (endIso !== start) end = endIso;
    }
  } else {
    start = startDate.toJSDate().toISOString();
    if (endDate) {
      const endIso = endDate.toJSDate().toISOString();
      if (endIso !== start) end = endIso;
    }
  }
  const description = item.description || undefined;
  const location = item.location || undefined;
  return {
    _id: `${FEED_EVENT_ID_PREFIX}${calendarId}:${start}:${item.uid ?? ''}`,
    title: item.summary || '(No title)',
    calendarType: calendarId,
    allDay,
    startDate: start,
    ...(end ? { endDate: end } : {}),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    reminderMinutes: null,
    alert2Minutes: null,
    readOnly: true,
  };
}

function expandEvents(
  calendarId: string,
  events: ICAL.Event[],
  fromDate: Date,
  toDate: Date
): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const fromMs = fromDate.getTime();
  const toMs = toDate.getTime();

  const eventMs = (e: CalendarEvent) => ({
    start: new Date(e.startDate).getTime(),
    end: new Date(e.endDate ?? e.startDate).getTime(),
  });

  for (const event of events) {
    try {
      if (event.isRecurring()) {
        // Iterate from the real DTSTART — event.iterator(startTime) would
        // REPLACE dtstart, re-anchoring occurrence clock times and dropping
        // the all-day flag. Occurrences before the window (minus the event's
        // duration and a day of slack for date/zone skew) skip cheaply.
        const durMs = Math.max(0, (event.duration?.toSeconds() ?? 0) * 1000);
        const skipBefore = fromMs - durMs - 86_400_000;
        const windowEnd = ICAL.Time.fromJSDate(toDate, true);
        const it = event.iterator();
        let next: ICAL.Time | null;
        let guard = 0;
        while ((next = it.next()) && guard++ < MAX_OCCURRENCE_ITERATIONS) {
          if (next.compare(windowEnd) > 0) break;
          if (next.toJSDate().getTime() < skipBefore) continue;
          // getOccurrenceDetails applies any RECURRENCE-ID override (time,
          // title, location…) to this instance.
          const occ = event.getOccurrenceDetails(next);
          const mapped = toCalendarEvent(calendarId, occ.item, occ.startDate, occ.endDate);
          const { start, end } = eventMs(mapped);
          if (end >= fromMs && start <= toMs) out.push(mapped);
        }
      } else {
        const mapped = toCalendarEvent(calendarId, event, event.startDate, event.endDate);
        const { start, end } = eventMs(mapped);
        if (end >= fromMs && start <= toMs) out.push(mapped);
      }
    } catch {} // one malformed VEVENT must not sink the feed
  }
  return out;
}

// ── Cache + refresh ──────────────────────────────────────────────────────────

async function loadCachedIcs(calendarId: string): Promise<string | null> {
  const mem = icsMemory.get(calendarId);
  if (mem) return mem;
  const stored = await AsyncStorage.getItem(ICS_KEY_PREFIX + calendarId).catch(() => null);
  if (stored) icsMemory.set(calendarId, stored);
  return stored;
}

async function storeIcs(calendarId: string, ics: string) {
  icsMemory.set(calendarId, ics);
  if (ics.length <= MAX_CACHED_ICS) {
    await AsyncStorage.setItem(ICS_KEY_PREFIX + calendarId, ics).catch(() => {});
  } else {
    await AsyncStorage.removeItem(ICS_KEY_PREFIX + calendarId).catch(() => {});
  }
}

// Fetch a calendar's feed now and cache it. Returns whether the ICS changed.
async function fetchAndStore(cal: CustomCalendar): Promise<boolean> {
  const meta = await loadMeta();
  const url = normalizeFeedUrl(cal.feedUrl!);
  try {
    const ics = await fetchIcs(url);
    const { calName } = parsedFor(cal.id, ics); // validates before caching
    const prev = await loadCachedIcs(cal.id);
    await storeIcs(cal.id, ics);
    meta[cal.id] = { url, fetchedAt: Date.now(), name: calName ?? undefined };
    saveMeta();
    return prev !== ics;
  } catch (e: any) {
    meta[cal.id] = {
      ...(meta[cal.id] ?? { url, fetchedAt: 0 }),
      url,
      error: e instanceof FeedError ? e.code : e?.message ?? 'error',
      errorAt: Date.now(),
    };
    saveMeta();
    throw e;
  }
}

function backgroundRefresh(cal: CustomCalendar) {
  if (refreshing.has(cal.id)) return;
  const p = fetchAndStore(cal)
    .then((changed) => {
      // Every calendar screen loads through ['calendar', …] queries.
      if (changed) queryClient.invalidateQueries({ queryKey: ['calendar'] });
    })
    .catch(() => {}) // recorded in meta; stale cache keeps rendering
    .finally(() => refreshing.delete(cal.id));
  refreshing.set(cal.id, p);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Validate a candidate URL for the subscribe screen: fetch, parse, and return
// enough for a preview card. Throws FeedError (invalid_url | fetch_failed |
// not_ics).
export async function previewFeed(rawUrl: string): Promise<{
  url: string;
  name: string | null;
  eventCount: number;
  sample: { title: string; date: string }[];
}> {
  const url = normalizeFeedUrl(rawUrl);
  const ics = await fetchIcs(url);
  const { calName, events } = parseIcs(ics);
  // Next few upcoming occurrences (90-day horizon), else the first few masters.
  const now = new Date();
  const horizon = new Date(now.getTime() + 90 * 86_400_000);
  let upcoming = expandEvents('preview', events, now, horizon)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 3);
  if (!upcoming.length) {
    upcoming = events
      .slice(0, 3)
      .map((e) => toCalendarEvent('preview', e, e.startDate, e.endDate))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
  }
  return {
    url,
    name: calName,
    eventCount: events.length,
    sample: upcoming.map((e) => ({ title: e.title, date: e.startDate })),
  };
}

// A subscribed feed's parsed masters, ready for range expansion. Opaque to
// callers — produced by loadFeedSources, consumed by expandFeedSources.
export interface FeedSource {
  calendarId: string;
  events: ICAL.Event[];
}

// The async half of feed expansion: resolve every subscribed feed's parsed
// masters. Renders from cache immediately (even stale), fetching inline only
// for a feed with no cache yet; stale feeds refresh in the background and
// invalidate the calendar queries on change. Range-independent — load once,
// then expand any number of ranges synchronously with expandFeedSources.
export async function loadFeedSources(): Promise<FeedSource[]> {
  const subs = await getSubscribedCalendars();
  if (!subs.length) return [];
  const meta = await loadMeta();
  const out: FeedSource[] = [];
  for (const cal of subs) {
    try {
      let ics = await loadCachedIcs(cal.id);
      if (!ics) {
        await fetchAndStore(cal);
        ics = icsMemory.get(cal.id) ?? null;
      } else if (Date.now() - (meta[cal.id]?.fetchedAt ?? 0) > FEED_STALE_MS) {
        backgroundRefresh(cal);
      }
      if (!ics) continue;
      const { events } = parsedFor(cal.id, ics);
      out.push({ calendarId: cal.id, events });
    } catch {} // offline / bad feed — meta carries the error, others still render
  }
  return out;
}

// The sync half: expand loaded feed sources into CalendarEvent occurrences
// within [from, to]. Pure CPU — safe to call per month from render-time
// derived-data computation.
export function expandFeedSources(
  sources: FeedSource[],
  range: { from: string; to: string },
): CalendarEvent[] {
  const fromDate = new Date(range.from);
  const toDate = new Date(range.to);
  const out: CalendarEvent[] = [];
  for (const s of sources) out.push(...expandEvents(s.calendarId, s.events, fromDate, toDate));
  for (const e of out) lastExpandedById.set(e._id, e);
  return out;
}

// Expand every subscribed calendar's feed into CalendarEvent occurrences within
// [from, to] — the one-shot composition of the two halves above.
export async function getFeedEvents(range: { from: string; to: string }): Promise<CalendarEvent[]> {
  return expandFeedSources(await loadFeedSources(), range);
}

// Force-refetch one feed now. Throws (FeedError) so the UI can surface failure.
export async function refreshFeed(calendarId: string): Promise<void> {
  const cal = (await getSubscribedCalendars()).find((c) => c.id === calendarId);
  if (!cal) return;
  const changed = await fetchAndStore(cal);
  if (changed) queryClient.invalidateQueries({ queryKey: ['calendar'] });
}

export async function getFeedMeta(
  calendarId: string
): Promise<{ lastFetched: number | null; error?: string }> {
  const meta = await loadMeta();
  const m = meta[calendarId];
  if (!m) return { lastFetched: null };
  return { lastFetched: m.fetchedAt || null, error: m.error };
}

// Called after unsubscribing (kept out of calendarPrefs.removeCalendar to
// avoid an import cycle).
export async function dropFeedCache(calendarId: string): Promise<void> {
  icsMemory.delete(calendarId);
  parsedCache.delete(calendarId);
  const meta = await loadMeta();
  delete meta[calendarId];
  saveMeta();
  await AsyncStorage.removeItem(ICS_KEY_PREFIX + calendarId).catch(() => {});
}

// Resolve a tapped occurrence from the most recent expansion (EventFormScreen's
// queryFn branch for feed: ids).
export function getFeedEventById(id: string): CalendarEvent | null {
  return lastExpandedById.get(id) ?? null;
}
