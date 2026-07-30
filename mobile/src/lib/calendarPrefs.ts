import { startTransition, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAllHolidayIds,
  getCountryHolidayIds,
  getHolidayDefs,
  holidayCalendarName,
  COUNTRIES,
  DEFAULT_COUNTRY,
  CountryCode,
} from './holidays';
import { applyCalendarColorOverrides } from './calendar';
import { customCalendarsApi, CustomCalendarRecord, CalendarAccess } from '../api';

// AsyncStorage-backed equivalents of the web's localStorage singletons
// (hc_calendar_visibility / hc_holiday_enabled). A tiny subscriber store keeps
// every mounted hook in sync, mirroring Vue's module-level refs so a change in
// CalendarsView/HolidaysView is reflected live in the calendar + events list.

const VIS_KEY = 'hc_calendar_visibility';
const HOL_KEY = 'hc_holiday_enabled'; // legacy: enabled list from the CA-only era
const HOL_DISABLED_KEY = 'hc_holiday_disabled'; // legacy: single-calendar disabled list
const HOL_COUNTRY_KEY = 'hc_holiday_country'; // legacy: single global country choice
// The per-country holiday calendars (device-local; each an added country).
// Legacy since holiday calendars became server-backed CustomCalendars — read
// once as the migration source, then left untouched.
const HOL_CALS_KEY = 'hc_holiday_calendars';
// Set once device-local holiday calendars have been uploaded as server-backed
// CustomCalendars (guards against re-seeding a deleted holiday calendar).
const HOL_MIGRATED_KEY = 'hc_holiday_cals_migrated';
// The built-in id the single Holidays calendar used before per-country calendars.
const LEGACY_HOLIDAY_ID = 'canadian-holidays';
const COLORS_KEY = 'hc_calendar_colors';
// User-chosen display order for calendars (a list of calendar ids). Sparse:
// ids not listed fall back to their natural order after the listed ones, so a
// newly added calendar simply appends. Device-local, like the other prefs.
const ORDER_KEY = 'hc_calendar_order';
const CUSTOM_KEY = 'hc_custom_calendars';
// Set once the device's pre-server (local-only) custom calendars have been
// uploaded; guards against re-creating calendars deleted on another device.
const CUSTOM_SYNCED_KEY = 'hc_custom_calendars_synced';
const DELETED_DEFAULTS_KEY = 'hc_deleted_default_calendars';
const DEFAULT_ALERTS_OFF_KEY = 'hc_default_calendar_alerts_off';
// Set once the built-in "Vacations" calendar's stored prefs have been remapped
// from its old id (`vacations`) to `trips` (see migrateVacationsToTrips).
const TRIPS_RENAME_KEY = 'hc_trips_rename_migrated';
// The month grid's display density (the top-right view switcher). Device-local,
// like the other calendar prefs; mirrors Apple Calendar's Compact/Stacked/
// Details/List modes.
const DENSITY_KEY = 'hc_month_density';
// The day view's display mode (its own top-right view switcher). Device-local;
// mirrors Apple Calendar's Single Day / Multi Day / List day modes.
const DAY_VIEW_KEY = 'hc_day_view_mode';
// Calendar-level alert config for the Occasions calendar (birthdays + labeled
// contact dates). One config for the whole calendar — no per-occasion override.
// Device-local; on-device reminders (lib/notifications) read it. Defaults: an
// alert at NOON the day of the occasion AND one 2 weeks (14 days) before.
const OCCASION_ALERTS_KEY = 'hc_occasion_alert_prefs';

// The built-in calendars the user may delete from the Calendars view (and add
// back via Add Calendar) — every default, including the "Other" group
// (Birthdays/Holidays/Weather).
export const DELETABLE_DEFAULT_IDS = [
  'activities', 'appointments', 'chores', 'recipes', 'maintenance', 'trips',
  'birthdays', 'weather',
];

// Holiday ids that existed when prefs were Canada-only (the HOL_KEY era).
// Used to migrate the legacy enabled-list to the disabled-list: any id NOT in
// this set was added later (other countries) and must default to enabled.
const LEGACY_CA_IDS = [
  'new-years-day', 'good-friday', 'easter-sunday', 'victoria-day', 'canada-day',
  'labour-day', 'truth-reconciliation', 'thanksgiving', 'remembrance-day',
  'christmas-day', 'boxing-day', 'valentines-day', 'st-patricks-day',
  'mothers-day', 'fathers-day', 'halloween', 'lunar-new-year', 'vaisakhi',
  'diwali', 'hanukkah', 'eid-al-fitr', 'eid-al-adha',
];

export interface CalendarDef {
  id: string;
  name: string;
  color: string;
  group: 'basic' | 'advanced';
}

// Mirrors CalendarsView.vue (superset of the events-list calendars).
export const CALENDARS: CalendarDef[] = [
  { id: 'activities', name: 'Activities', color: '#388E3C', group: 'basic' },
  { id: 'appointments', name: 'Appointments', color: '#1976D2', group: 'basic' },
  { id: 'birthdays', name: 'Occasions', color: '#E91E63', group: 'basic' },
  { id: 'weather', name: 'Weather', color: '#0288D1', group: 'basic' },
  { id: 'chores', name: 'Chores', color: '#F57C00', group: 'advanced' },
  { id: 'recipes', name: 'Meals', color: '#00897B', group: 'advanced' },
  { id: 'maintenance', name: 'Maintenance', color: '#1976D2', group: 'advanced' },
  { id: 'trips', name: 'Trips', color: '#5E35B1', group: 'advanced' },
];

// A user-created calendar (Calendars → Add Calendar), server-backed via
// customCalendarsApi with AsyncStorage as the offline warm-start cache. `id`
// is the server record's `key` (`custom-<slug>`) — what events reference via
// calendarType. Sharing tiers: the whole household (supersedes `sharedWith`),
// specific household members (user ids), or people outside the household
// (emails; stored intent — no invitation flow yet). `mine` = created by this
// user; only the creator can edit or delete.
export interface CustomCalendar {
  id: string;
  name: string;
  color: string;
  // When off, events on this calendar never display alerts.
  alertsEnabled: boolean;
  sharedWithHousehold: boolean;
  // One access level for household-wide sharing; per-person otherwise.
  householdAccess: CalendarAccess;
  sharedWith: { userId: string; access: CalendarAccess }[];
  sharedWithOutside: { email?: string; phone?: string; access: CalendarAccess }[];
  // ICS subscription source. Present => read-only subscribed calendar whose
  // events each device fetches/expands itself (lib/calendarFeeds) — they never
  // exist as server event rows.
  feedUrl?: string;
  // Present => read-only holiday calendar. Its events are the country's
  // holidays, computed on each device (see useHolidayCalendars); sharing the
  // record syncs this config so housemates show the same holidays.
  holiday?: { country: CountryCode; selectedRegions: string[]; disabledIds: string[] };
  mine: boolean;
  // This user's effective event permission (owner → 'full').
  access: CalendarAccess;
}

function fromRecord(r: CustomCalendarRecord): CustomCalendar {
  return {
    id: r.key,
    name: r.name,
    color: r.color,
    alertsEnabled: r.alertsEnabled !== false,
    sharedWithHousehold: !!r.sharedWithHousehold,
    householdAccess: r.householdAccess === 'view' ? 'view' : 'full',
    sharedWith: r.sharedWith ?? [],
    sharedWithOutside: r.sharedWithOutside ?? [],
    feedUrl: r.feedUrl || undefined,
    holiday: r.holiday?.country
      ? {
          country: r.holiday.country as CountryCode,
          selectedRegions: r.holiday.selectedRegions ?? [],
          disabledIds: r.holiday.disabledIds ?? [],
        }
      : undefined,
    mine: !!r.mine,
    access: r.access === 'view' ? 'view' : 'full',
  };
}

// Palette offered wherever the user picks a calendar colour (colour editor,
// Add Calendar).
export const COLOR_PRESETS = [
  '#1976D2', '#0288D1', '#00ACC1', '#00897B', '#43A047', '#388E3C',
  '#F9A825', '#F57C00', '#D32F2F', '#C2185B', '#E91E63', '#8E24AA',
  '#7B1FA2', '#5E35B1', '#3949AB', '#546E7A', '#6D4C41', '#455A64',
];

const ALL_HOLIDAY_IDS = getAllHolidayIds();

// A per-country holiday calendar the user added (Calendars → Add Calendar → a
// holiday calendar). Device-local: its holidays are computed client-side from
// lib/holidays, so nothing is server-backed. `id` is `holiday-<country>` and is
// what synthesized holiday items reference via calendarType.
//
// National (statutory) holidays are always shown. Provincial/state holidays are
// opt-IN by subdivision: `selectedRegions` holds the region names (matching
// HolidayDef.region) whose holidays are included — pick one or many. Cultural
// and religious holidays are opt-OUT per holiday via `disabledIds`.
export interface HolidayCalendar {
  id: string;
  country: CountryCode;
  name: string;
  color: string;
  selectedRegions: string[];
  disabledIds: string[];
}

// The stable calendar id for a country's holidays.
export function holidayCalendarId(country: CountryCode): string {
  return `holiday-${country}`;
}

// Default accent colour per country's holiday calendar (CA keeps the legacy red).
const HOLIDAY_CALENDAR_COLORS: Record<CountryCode, string> = {
  CA: '#D32F2F',
  US: '#1565C0',
  GB: '#6A1B9A',
  AU: '#00838F',
};

// Default name + colour for a new holiday calendar (seeds the create form).
export function holidayCalendarSeed(country: CountryCode): { name: string; color: string } {
  return { name: holidayCalendarName(country), color: HOLIDAY_CALENDAR_COLORS[country] };
}

function makeHolidayCalendar(
  country: CountryCode,
  disabledIds: string[] = [],
  selectedRegions: string[] = []
): HolidayCalendar {
  return {
    id: holidayCalendarId(country),
    country,
    name: holidayCalendarName(country),
    color: HOLIDAY_CALENDAR_COLORS[country],
    selectedRegions,
    disabledIds,
  };
}

// Enabled holiday ids for a calendar, in the shape getHolidays() wants:
// national holidays are always on; provincial/state holidays only for the
// selected regions; cultural/religious on unless individually disabled.
export function holidayEnabledIds(cal: HolidayCalendar): string[] {
  const regions = new Set(cal.selectedRegions);
  const disabled = new Set(cal.disabledIds);
  const out: string[] = [];
  for (const d of getHolidayDefs(cal.country)) {
    if (d.group === 'statutory') out.push(d.id);
    else if (d.group === 'regional') {
      if (d.region && regions.has(d.region)) out.push(d.id);
    } else if (!disabled.has(d.id)) out.push(d.id);
  }
  return out;
}

// Default colour per calendar id (the source of truth for the picker's reset).
export const DEFAULT_CALENDAR_COLORS: Record<string, string> = Object.fromEntries(
  CALENDARS.map((c) => [c.id, c.color])
);

type VisMap = Record<string, boolean>;
type ColorMap = Record<string, string>;

// The month grid's display density. `details` (event chips with title + time) is
// the default and matches the pre-switcher behavior.
export type MonthDensity = 'compact' | 'stacked' | 'details' | 'list';
const DEFAULT_DENSITY: MonthDensity = 'details';
const DENSITIES: MonthDensity[] = ['compact', 'stacked', 'details', 'list'];

// The day view's display mode: hour-grid over one day, hour-grid over two days,
// or the multi-day agenda list.
export type DayViewMode = 'single' | 'multi' | 'list';
const DEFAULT_DAY_VIEW: DayViewMode = 'single';
const DAY_VIEWS: DayViewMode[] = ['single', 'multi', 'list'];

// Calendar-level alert config for the Occasions calendar. `offsets` are days
// before the occasion (0 = the day of); `time` is the wall-clock `HH:mm` both
// alerts fire at. Defaults: noon on the day AND two weeks before.
export interface OccasionAlertPrefs { offsets: number[]; time: string }
const DEFAULT_OCCASION_ALERTS: OccasionAlertPrefs = { offsets: [0, 14], time: '12:00' };

// ── In-memory state + subscribers ───────────────────────────────────────────
let visState: VisMap | null = null;
// Device-local holiday calendars found at load, awaiting one-time upload to the
// server (see refreshCustomCalendars). Holiday calendars are now derived from
// customState — this only feeds the migration.
let pendingLocalHolidayCals: HolidayCalendar[] = [];
// True when pendingLocalHolidayCals is the FRESH-INSTALL seed (not real legacy
// data): the seed was minted by us this session, so it's also safe to
// auto-select the home province/state on it after upload.
let freshHolidaySeed = false;
let colorOverrideState: ColorMap = {}; // sparse — only user overrides
let orderState: string[] | null = null; // sparse — ids the user reordered
let customState: CustomCalendar[] | null = null;
let deletedDefaultsState: string[] | null = null;
let defaultAlertsOffState: string[] | null = null;
let densityState: MonthDensity | null = null;
let dayViewState: DayViewMode | null = null;
let occasionAlertState: OccasionAlertPrefs | null = null;
const visSubs = new Set<() => void>();
const colorSubs = new Set<() => void>();
const orderSubs = new Set<() => void>();
const customSubs = new Set<() => void>();
const deletedSubs = new Set<() => void>();
const defaultAlertsSubs = new Set<() => void>();
const densitySubs = new Set<() => void>();
const dayViewSubs = new Set<() => void>();
const occasionAlertSubs = new Set<() => void>();
let loaded = false;

// Best-effort country from the device locale (e.g. "en-CA" → CA). Only used
// until the user picks a country explicitly; falls back to the United States.
function detectCountry(): CountryCode {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const region = locale.split('-').find((part) => /^[A-Z]{2}$/.test(part));
    if (region && COUNTRIES.some((c) => c.code === region)) return region as CountryCode;
  } catch {}
  return DEFAULT_COUNTRY;
}

// Holiday calendars are server-backed CustomCalendars carrying a `holiday`
// config; each device computes their dates locally (see getHolidays). Derived
// from customState so sharing, colour, and visibility come for free.
function holidayCalFromCustom(c: CustomCalendar): HolidayCalendar | null {
  if (!c.holiday) return null;
  return {
    id: c.id,
    country: c.holiday.country,
    name: c.name,
    color: c.color,
    selectedRegions: c.holiday.selectedRegions,
    disabledIds: c.holiday.disabledIds,
  };
}
function deriveHolidayCals(): HolidayCalendar[] {
  return (customState ?? [])
    .map(holidayCalFromCustom)
    .filter((c): c is HolidayCalendar => c !== null);
}

// Exported for Places autocomplete biasing (lib/placeBias.ts), which uses the
// holiday country as its coarse locality fallback: the first added holiday
// calendar's country, else the device locale.
export function effectiveCountry(): CountryCode {
  return deriveHolidayCals()[0]?.country ?? detectCountry();
}

// Derive the disabled-list from a legacy CA-era enabled-list (or null when
// there is no legacy data). Only ids that existed back then can be disabled;
// ids added since (other countries' holidays) always default to enabled.
// Exported for tests.
export function migrateLegacyEnabledList(legacyEnabled: unknown): string[] | null {
  if (!Array.isArray(legacyEnabled)) return null;
  const enabled = new Set(legacyEnabled);
  return LEGACY_CA_IDS.filter((id) => !enabled.has(id));
}

// Merge overrides over defaults into a full id→colour map.
function mergedColors(): ColorMap {
  const out: ColorMap = { ...DEFAULT_CALENDAR_COLORS };
  for (const id of Object.keys(colorOverrideState)) out[id] = colorOverrideState[id];
  return out;
}

// Push the effective override map (custom calendar colours + user overrides)
// into lib/calendar's colorOf, so event chips/bars/dots resolve custom
// calendars everywhere the built-ins already do.
function syncColorOverrides() {
  const seeded: ColorMap = {};
  // Custom calendars — subscriptions and holiday calendars included — carry
  // their own colour, so colorOf resolves them everywhere; user overrides
  // (colorOverrideState) still win.
  for (const c of customState ?? []) seeded[c.id] = c.color;
  applyCalendarColorOverrides({ ...seeded, ...colorOverrideState });
}

function defaultVis(): VisMap {
  return Object.fromEntries(CALENDARS.map((c) => [c.id, true]));
}

// One-time: the built-in trips calendar was renamed from the id `vacations` to
// `trips`. Remap that id anywhere it's stored so a user's existing visibility,
// colour, order, deletion, and alert prefs carry over instead of resetting to
// the default. Runs before the reads below so they see the migrated data.
async function migrateVacationsToTrips() {
  try {
    if (await AsyncStorage.getItem(TRIPS_RENAME_KEY)) return;
    // Object maps keyed by calendar id (visibility, colour overrides).
    for (const key of [VIS_KEY, COLORS_KEY]) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'vacations' in obj) {
        if (!('trips' in obj)) obj.trips = obj.vacations;
        delete obj.vacations;
        await AsyncStorage.setItem(key, JSON.stringify(obj));
      }
    }
    // Arrays of calendar ids (order, deleted defaults, muted-alert defaults).
    for (const key of [ORDER_KEY, DELETED_DEFAULTS_KEY, DEFAULT_ALERTS_OFF_KEY]) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.includes('vacations')) {
        const next = arr.map((id) => (id === 'vacations' ? 'trips' : id));
        await AsyncStorage.setItem(key, JSON.stringify(next));
      }
    }
    await AsyncStorage.setItem(TRIPS_RENAME_KEY, '1');
  } catch {
    // Best-effort; leave the flag unset so the next launch retries.
  }
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  await migrateVacationsToTrips();
  try {
    const rawVis = await AsyncStorage.getItem(VIS_KEY);
    const saved: VisMap = rawVis ? JSON.parse(rawVis) : {};
    const vis = defaultVis();
    // If saved predates the holidays calendar, keep all visible (matches web).
    // Copy every saved id (not just built-ins) so custom calendars keep their
    // visibility; stale ids are harmless — only the calendar lists iterate.
    if ('canadian-holidays' in saved) {
      for (const id of Object.keys(saved)) vis[id] = saved[id];
    }
    visState = vis;
  } catch {
    visState = defaultVis();
  }
  // Collect any device-local holiday calendars as the migration source (they're
  // uploaded as server-backed CustomCalendars by refreshCustomCalendars). A
  // stored empty array is respected (the user removed their holidays); only a
  // truly-absent key seeds the detected country.
  try {
    if (await AsyncStorage.getItem(HOL_MIGRATED_KEY)) {
      pendingLocalHolidayCals = [];
    } else {
      const rawCals = await AsyncStorage.getItem(HOL_CALS_KEY);
      if (rawCals) {
        const parsed = JSON.parse(rawCals);
        pendingLocalHolidayCals = (Array.isArray(parsed) ? parsed : [])
          .filter((c: any) => c && COUNTRIES.some((cc) => cc.code === c.country))
          .map((c: any): HolidayCalendar => ({
            id: c.id || holidayCalendarId(c.country),
            country: c.country,
            name: c.name || holidayCalendarName(c.country),
            color: c.color || HOLIDAY_CALENDAR_COLORS[c.country as CountryCode],
            selectedRegions: Array.isArray(c.selectedRegions) ? c.selectedRegions : [],
            disabledIds: Array.isArray(c.disabledIds) ? c.disabledIds : [],
          }));
      } else {
        // Pre-per-country install: migrate the single global Holidays calendar
        // (or seed one for the detected country on a fresh install).
        let country: CountryCode = detectCountry();
        try {
          const rawCountry = await AsyncStorage.getItem(HOL_COUNTRY_KEY);
          if (COUNTRIES.some((c) => c.code === rawCountry)) country = rawCountry as CountryCode;
        } catch {}
        let legacyDisabled: string[] = [];
        try {
          const rawDisabled = await AsyncStorage.getItem(HOL_DISABLED_KEY);
          if (rawDisabled) legacyDisabled = JSON.parse(rawDisabled);
          else {
            const rawHol = await AsyncStorage.getItem(HOL_KEY);
            legacyDisabled = migrateLegacyEnabledList(rawHol ? JSON.parse(rawHol) : null) ?? [];
          }
        } catch {}
        const countryIds = new Set(getCountryHolidayIds(country));
        const scopedDisabled = (Array.isArray(legacyDisabled) ? legacyDisabled : []).filter((id) =>
          countryIds.has(id)
        );
        const seeded = makeHolidayCalendar(country, scopedDisabled);
        // Carry the old single-Holidays visibility onto the seed's id so the
        // migration preserves a hidden state.
        if (visState && LEGACY_HOLIDAY_ID in visState) {
          visState = { ...visState, [seeded.id]: visState[LEGACY_HOLIDAY_ID] };
          AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
        }
        pendingLocalHolidayCals = [seeded];
        freshHolidaySeed = true;
      }
    }
  } catch {
    pendingLocalHolidayCals = [];
  }
  try {
    const rawCol = await AsyncStorage.getItem(COLORS_KEY);
    colorOverrideState = rawCol ? JSON.parse(rawCol) : {};
  } catch {
    colorOverrideState = {};
  }
  try {
    const rawOrder = await AsyncStorage.getItem(ORDER_KEY);
    const parsedOrder = rawOrder ? JSON.parse(rawOrder) : [];
    orderState = Array.isArray(parsedOrder) ? parsedOrder.filter((id: unknown) => typeof id === 'string') : [];
  } catch {
    orderState = [];
  }
  try {
    const rawDeleted = await AsyncStorage.getItem(DELETED_DEFAULTS_KEY);
    const parsedDeleted = rawDeleted ? JSON.parse(rawDeleted) : [];
    deletedDefaultsState = Array.isArray(parsedDeleted)
      ? parsedDeleted.filter((id: string) => DELETABLE_DEFAULT_IDS.includes(id))
      : [];
  } catch {
    deletedDefaultsState = [];
  }
  try {
    const rawAlertsOff = await AsyncStorage.getItem(DEFAULT_ALERTS_OFF_KEY);
    const parsedAlertsOff = rawAlertsOff ? JSON.parse(rawAlertsOff) : [];
    defaultAlertsOffState = Array.isArray(parsedAlertsOff)
      ? parsedAlertsOff.filter((id: string) => DELETABLE_DEFAULT_IDS.includes(id))
      : [];
  } catch {
    defaultAlertsOffState = [];
  }
  try {
    const rawOcc = await AsyncStorage.getItem(OCCASION_ALERTS_KEY);
    const parsedOcc = rawOcc ? JSON.parse(rawOcc) : null;
    occasionAlertState = parsedOcc && Array.isArray(parsedOcc.offsets) && typeof parsedOcc.time === 'string'
      ? { offsets: parsedOcc.offsets.filter((n: unknown) => typeof n === 'number'), time: parsedOcc.time }
      : { ...DEFAULT_OCCASION_ALERTS };
  } catch {
    occasionAlertState = { ...DEFAULT_OCCASION_ALERTS };
  }
  try {
    const rawCustom = await AsyncStorage.getItem(CUSTOM_KEY);
    const parsed = rawCustom ? JSON.parse(rawCustom) : [];
    // Older caches predate household/outside sharing, server backing, and
    // access levels — normalize legacy shapes (plain id/email arrays) and
    // default the missing fields (local-only calendars were this user's).
    customState = (Array.isArray(parsed) ? parsed : []).map((c: any): CustomCalendar => ({
      ...c,
      sharedWithHousehold: c.sharedWithHousehold ?? false,
      householdAccess: c.householdAccess === 'view' ? 'view' : 'full',
      sharedWith: (c.sharedWith ?? []).map((m: any) => (m && m.userId ? m : { userId: m, access: 'full' })),
      sharedWithOutside: (c.sharedWithOutside ?? []).map((o: any) => (o && (o.email || o.phone) ? o : { email: o, access: 'view' })),
      mine: c.mine ?? true,
      access: c.access === 'view' ? 'view' : 'full',
    }));
  } catch {
    customState = [];
  }
  try {
    const rawDensity = await AsyncStorage.getItem(DENSITY_KEY);
    densityState = DENSITIES.includes(rawDensity as MonthDensity)
      ? (rawDensity as MonthDensity)
      : DEFAULT_DENSITY;
  } catch {
    densityState = DEFAULT_DENSITY;
  }
  try {
    const rawDayView = await AsyncStorage.getItem(DAY_VIEW_KEY);
    dayViewState = DAY_VIEWS.includes(rawDayView as DayViewMode)
      ? (rawDayView as DayViewMode)
      : DEFAULT_DAY_VIEW;
  } catch {
    dayViewState = DEFAULT_DAY_VIEW;
  }
  syncColorOverrides();
  visSubs.forEach((fn) => fn());
  colorSubs.forEach((fn) => fn());
  orderSubs.forEach((fn) => fn());
  customSubs.forEach((fn) => fn());
  deletedSubs.forEach((fn) => fn());
  defaultAlertsSubs.forEach((fn) => fn());
  densitySubs.forEach((fn) => fn());
  dayViewSubs.forEach((fn) => fn());
  occasionAlertSubs.forEach((fn) => fn());
  // The cache painted instantly; now pull the server truth (incl. calendars
  // housemates shared with us) in the background.
  void refreshCustomCalendars();
}

// Persist + broadcast a new custom-calendar list (cache and colour plumbing).
function commitCustom(next: CustomCalendar[]) {
  customState = next;
  AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(next)).catch(() => {});
  syncColorOverrides();
  customSubs.forEach((fn) => fn());
  colorSubs.forEach((fn) => fn());
}

// Replace the cached list with the server's. One-time migration: calendars
// created on this device before server backing exist only in the cache, so
// upload any the server doesn't know about, then mark the device synced.
export async function refreshCustomCalendars(): Promise<void> {
  try {
    const { data } = await customCalendarsApi.list();
    if (!(await AsyncStorage.getItem(CUSTOM_SYNCED_KEY))) {
      const serverKeys = new Set(data.map((r) => r.key));
      for (const c of customState ?? []) {
        if (serverKeys.has(c.id)) continue;
        try {
          const res = await customCalendarsApi.create({
            key: c.id,
            name: c.name,
            color: c.color,
            alertsEnabled: c.alertsEnabled,
            sharedWithHousehold: c.sharedWithHousehold ?? false,
            householdAccess: c.householdAccess ?? 'full',
            sharedWith: c.sharedWith ?? [],
            sharedWithOutside: c.sharedWithOutside ?? [],
            feedUrl: c.feedUrl,
          });
          data.push(res.data);
        } catch {} // leave unsynced; retried next refresh until the flag is set
      }
      AsyncStorage.setItem(CUSTOM_SYNCED_KEY, '1').catch(() => {});
    }
    // One-time: upload device-local holiday calendars as server-backed records
    // so they gain sharing/colour and reach housemates. Dedupe by country.
    // The key of a holiday calendar the FRESH-INSTALL seed just uploaded (vs a
    // real legacy migration) — the one calendar it's safe to auto-region below.
    let seededKey: string | null = null;
    if (!(await AsyncStorage.getItem(HOL_MIGRATED_KEY))) {
      const serverCountries = new Set(
        data.filter((r) => r.holiday?.country).map((r) => r.holiday!.country)
      );
      let visChanged = false;
      for (const h of pendingLocalHolidayCals) {
        if (serverCountries.has(h.country)) continue;
        try {
          const key = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          if (freshHolidaySeed) seededKey = key;
          const res = await customCalendarsApi.create({
            key,
            name: h.name,
            color: h.color,
            alertsEnabled: true,
            sharedWithHousehold: false,
            householdAccess: 'full',
            sharedWith: [],
            sharedWithOutside: [],
            holiday: { country: h.country, selectedRegions: h.selectedRegions, disabledIds: h.disabledIds },
          });
          data.push(res.data);
          serverCountries.add(h.country);
          // Carry the local calendar's hidden state onto the new key.
          if (visState && visState[h.id] === false) {
            visState = { ...visState, [res.data.key]: false };
            visChanged = true;
          }
        } catch {} // leave for the next refresh; guard stays unset
      }
      if (visChanged) AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
      AsyncStorage.setItem(HOL_MIGRATED_KEY, '1').catch(() => {});
      pendingLocalHolidayCals = [];
      if (visChanged) visSubs.forEach((fn) => fn());
    }
    commitCustom(data.map(fromRecord));
    // Fresh install (first run): the seed above added the detected country's
    // holiday calendar bare — now preselect the home province/state when the
    // saved address already makes it derivable (usually the address comes
    // later; the AccountScreen save hook handles that case). Only the calendar
    // the seed itself minted is touched, so no user choice can be overridden.
    // Lazy require: homeRegion pulls in lib/e2ee (native crypto), which this
    // module must not load at import time (it's imported by pure-JS tests).
    if (seededKey) {
      freshHolidaySeed = false;
      const seeded = (customState ?? []).find((c) => c.id === seededKey);
      const { detectHomeRegion } = require('./homeRegion') as typeof import('./homeRegion');
      const home = await detectHomeRegion();
      if (seeded?.holiday && home?.country === seeded.holiday.country && home.region) {
        patchHolidayConfigLocal(seededKey, { selectedRegions: [home.region] });
      }
    }
  } catch {
    // Offline / signed out — keep the cache; the next refresh retries.
  }
}

// ── Holiday-calendar mutations (server-backed via customCalendarsApi) ─────────
// Optimistically patch a holiday calendar's config locally (snappy toggles),
// then persist best-effort; the next refresh reconciles on failure.
function patchHolidayConfigLocal(id: string, patch: Partial<{ selectedRegions: string[]; disabledIds: string[] }>) {
  let updated: CustomCalendar['holiday'];
  const next = (customState ?? []).map((c) => {
    if (c.id !== id || !c.holiday) return c;
    updated = { ...c.holiday, ...patch };
    return { ...c, holiday: updated };
  });
  if (!updated) return;
  commitCustom(next);
  customCalendarsApi.update(id, { holiday: updated }).catch(() => {});
}

async function serverAddHolidayCalendar(country: CountryCode): Promise<string> {
  const key = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const { data } = await customCalendarsApi.create({
    key,
    name: holidayCalendarName(country),
    color: HOLIDAY_CALENDAR_COLORS[country],
    alertsEnabled: true,
    sharedWithHousehold: false,
    householdAccess: 'full',
    sharedWith: [],
    sharedWithOutside: [],
    holiday: { country, selectedRegions: [], disabledIds: [] },
  });
  commitCustom([...(customState ?? []), fromRecord(data)]);
  return data.key;
}

// Auto-select the detected home province/state on holiday calendars of that
// country which have no regional picks yet. Never overrides an explicit choice
// (any non-empty selectedRegions is left alone). Called when the home address
// is saved and from the first-run seed.
export async function autoSelectHolidayRegion(country: CountryCode, region: string): Promise<void> {
  await ensureLoaded();
  for (const c of customState ?? []) {
    if (c.mine && c.holiday?.country === country && c.holiday.selectedRegions.length === 0) {
      patchHolidayConfigLocal(c.id, { selectedRegions: [region] });
    }
  }
}

async function serverRemoveHolidayCalendar(id: string): Promise<void> {
  await customCalendarsApi.remove(id);
  commitCustom((customState ?? []).filter((c) => c.id !== id));
  if (visState && id in visState) {
    const { [id]: _gone, ...rest } = visState;
    visState = rest;
    AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
    visSubs.forEach((fn) => fn());
  }
}

// Calendars whose events must never display alerts (the Edit Calendar "Alerts"
// switch turned off) — custom calendars plus muted defaults. lib/notifications
// consults this before scheduling.
export async function getAlertMutedCalendarIds(): Promise<Set<string>> {
  await ensureLoaded();
  return new Set([
    ...(customState ?? []).filter((c) => !c.alertsEnabled).map((c) => c.id),
    ...(defaultAlertsOffState ?? []),
  ]);
}

// The Occasions calendar's alert config (calendar-level). lib/notifications
// reads this to schedule on-device occasion reminders.
export async function getOccasionAlertPrefs(): Promise<OccasionAlertPrefs> {
  await ensureLoaded();
  return occasionAlertState ?? { ...DEFAULT_OCCASION_ALERTS };
}

// Custom-calendar ids this user can access. Events referencing a custom id
// outside this set belong to a housemate's unshared calendar and must be
// hidden — the server can't filter them (calendarType is client-territory
// post-§9), so lib/calendarData enforces access with this set.
export async function getAccessibleCustomCalendarIds(): Promise<Set<string>> {
  await ensureLoaded();
  return new Set((customState ?? []).map((c) => c.id));
}

// Subscribed (feed-backed) calendars this user can see — mine and shared alike.
// lib/calendarFeeds fetches and expands their ICS client-side; the server never
// holds the events (E2EE).
export async function getSubscribedCalendars(): Promise<CustomCalendar[]> {
  await ensureLoaded();
  return (customState ?? []).filter((c) => !!c.feedUrl);
}

// ── Calendar visibility hook ────────────────────────────────────────────────
export function useCalendarVisibility() {
  const [vis, setVis] = useState<VisMap>(visState ?? defaultVis());
  // This hook instance's subscriber, so mutations made HERE can commit their
  // own screen's update urgently while every other consumer follows in a
  // transition (see broadcast below).
  const subRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const sub = () => setVis({ ...(visState ?? defaultVis()) });
    subRef.current = sub;
    visSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subRef.current = null;
      visSubs.delete(sub);
    };
  }, []);

  // The toggle must FEEL instant: re-render the screen the user is touching
  // first (urgent), then let the other mounted consumers — notably the month
  // grid still mounted beneath the Calendars modal, whose re-render is heavy —
  // follow as an interruptible transition instead of blocking this commit.
  function broadcast() {
    subRef.current?.();
    startTransition(() => {
      visSubs.forEach((fn) => {
        if (fn !== subRef.current) fn();
      });
    });
  }

  function setVisible(id: string, visible: boolean) {
    visState = { ...(visState ?? defaultVis()), [id]: visible };
    AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
    broadcast();
  }
  function setAll(visible: boolean) {
    visState = Object.fromEntries(CALENDARS.map((c) => [c.id, visible]));
    AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
    broadcast();
  }

  return { visibility: vis, setVisible, setAll };
}

// ── Month-grid density hook ─────────────────────────────────────────────────
// The top-right view switcher's current mode, persisted device-local and shared
// live with every mounted consumer (same subscriber pattern as visibility).
export function useMonthDensity() {
  const [density, setDensityState] = useState<MonthDensity>(densityState ?? DEFAULT_DENSITY);

  useEffect(() => {
    const sub = () => setDensityState(densityState ?? DEFAULT_DENSITY);
    densitySubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      densitySubs.delete(sub);
    };
  }, []);

  function setDensity(next: MonthDensity) {
    densityState = next;
    AsyncStorage.setItem(DENSITY_KEY, next).catch(() => {});
    densitySubs.forEach((fn) => fn());
  }

  return { density, setDensity };
}

// ── Day-view mode hook ──────────────────────────────────────────────────────
// The day view's own switcher mode (Single Day / Multi Day / List), persisted
// device-local and shared live with every mounted consumer.
export function useDayViewMode() {
  const [mode, setModeState] = useState<DayViewMode>(dayViewState ?? DEFAULT_DAY_VIEW);

  useEffect(() => {
    const sub = () => setModeState(dayViewState ?? DEFAULT_DAY_VIEW);
    dayViewSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      dayViewSubs.delete(sub);
    };
  }, []);

  function setMode(next: DayViewMode) {
    dayViewState = next;
    AsyncStorage.setItem(DAY_VIEW_KEY, next).catch(() => {});
    dayViewSubs.forEach((fn) => fn());
  }

  return { mode, setMode };
}

// Holiday calendars this user can see (own + shared), to read anywhere (grid,
// day, agenda, search, print). Derived from the server-backed custom-calendar
// list; each device computes the dates via getHolidays.
export async function getHolidayCalendars(): Promise<HolidayCalendar[]> {
  await ensureLoaded();
  return deriveHolidayCals();
}

// ── Holiday calendars hook ──────────────────────────────────────────────────
export function useHolidayCalendars() {
  const [calendars, setCalendars] = useState<HolidayCalendar[]>(deriveHolidayCals());

  useEffect(() => {
    // Holiday calendars live in customState now, so track the custom subs.
    const sub = () => setCalendars(deriveHolidayCals());
    customSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      customSubs.delete(sub);
    };
  }, []);

  // Add a country's holiday calendar (no-op if already added). Returns its id.
  // Server-first (throws offline) like other custom-calendar mutations.
  async function addCountry(country: CountryCode): Promise<string> {
    const existing = deriveHolidayCals().find((c) => c.country === country);
    if (existing) return existing.id;
    return serverAddHolidayCalendar(country);
  }
  async function removeCalendar(id: string) {
    await serverRemoveHolidayCalendar(id);
  }
  function setDisabled(id: string, holidayIds: string[], disabled: boolean) {
    const cal = deriveHolidayCals().find((c) => c.id === id);
    if (!cal) return;
    const set = new Set(cal.disabledIds);
    for (const hid of holidayIds) {
      if (disabled) set.add(hid);
      else set.delete(hid);
    }
    patchHolidayConfigLocal(id, { disabledIds: [...set] });
  }
  // Toggle one holiday within a calendar (enabled ⇄ disabled). For cultural /
  // religious holidays only — national is always on, regional is region-driven.
  function toggle(id: string, holidayId: string) {
    const cal = deriveHolidayCals().find((c) => c.id === id);
    if (!cal) return;
    setDisabled(id, [holidayId], !cal.disabledIds.includes(holidayId));
  }
  // Enable/disable a group of holidays within a calendar at once.
  function setGroup(id: string, holidayIds: string[], on: boolean) {
    setDisabled(id, holidayIds, !on);
  }
  const isEnabled = (id: string, holidayId: string) =>
    !(deriveHolidayCals().find((c) => c.id === id)?.disabledIds.includes(holidayId));

  // Include/exclude a whole province/state's holidays by region name.
  function setRegions(id: string, regionNames: string[], on: boolean) {
    const cal = deriveHolidayCals().find((c) => c.id === id);
    if (!cal) return;
    const set = new Set(cal.selectedRegions);
    for (const name of regionNames) {
      if (on) set.add(name);
      else set.delete(name);
    }
    patchHolidayConfigLocal(id, { selectedRegions: [...set] });
  }
  function toggleRegion(id: string, regionName: string) {
    const cal = deriveHolidayCals().find((c) => c.id === id);
    if (!cal) return;
    setRegions(id, [regionName], !cal.selectedRegions.includes(regionName));
  }
  const isRegionSelected = (id: string, regionName: string) =>
    !!deriveHolidayCals().find((c) => c.id === id)?.selectedRegions.includes(regionName);

  return {
    calendars,
    addCountry,
    removeCalendar,
    toggle,
    setGroup,
    isEnabled,
    setRegions,
    toggleRegion,
    isRegionSelected,
  };
}

// ── Calendar colour hook ────────────────────────────────────────────────────
export function useCalendarColors() {
  const [colors, setColors] = useState<ColorMap>(mergedColors());

  useEffect(() => {
    const sub = () => setColors(mergedColors());
    colorSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      colorSubs.delete(sub);
    };
  }, []);

  function persist() {
    AsyncStorage.setItem(COLORS_KEY, JSON.stringify(colorOverrideState)).catch(() => {});
    syncColorOverrides();
    colorSubs.forEach((fn) => fn());
  }
  function setColor(id: string, color: string) {
    colorOverrideState = { ...colorOverrideState, [id]: color };
    persist();
  }
  function resetColor(id: string) {
    const next = { ...colorOverrideState };
    delete next[id];
    colorOverrideState = next;
    persist();
  }

  return { colors, setColor, resetColor };
}

// ── Calendar order hook ─────────────────────────────────────────────────────
// Stable-sort a list of calendar-like items by the user's saved order: ids the
// user has arranged come first in that sequence, and anything not yet ordered
// (e.g. a newly added calendar) keeps its incoming order after them.
export function sortByCalendarOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (id: string) => (rank.has(id) ? rank.get(id)! : order.length);
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => at(a.item.id) - at(b.item.id) || a.i - b.i)
    .map((x) => x.item);
}

export function useCalendarOrder() {
  const [order, setOrderState] = useState<string[]>(orderState ?? []);

  useEffect(() => {
    const sub = () => setOrderState([...(orderState ?? [])]);
    orderSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      orderSubs.delete(sub);
    };
  }, []);

  // Persist the full ordered id list the caller computed (from the currently
  // displayed calendars), then broadcast so every list re-sorts live.
  function setOrder(ids: string[]) {
    orderState = ids;
    AsyncStorage.setItem(ORDER_KEY, JSON.stringify(ids)).catch(() => {});
    orderSubs.forEach((fn) => fn());
  }

  return { order, setOrder };
}

// ── Custom calendars hook ───────────────────────────────────────────────────
export function useCustomCalendars() {
  const [calendars, setCalendars] = useState<CustomCalendar[]>(customState ?? []);

  useEffect(() => {
    const sub = () => setCalendars([...(customState ?? [])]);
    customSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      customSubs.delete(sub);
    };
  }, []);

  // Mutations are server-first (they throw offline — callers surface the
  // error); local state and the cache follow only after the server accepts.
  async function addCalendar(cal: Omit<CustomCalendar, 'id' | 'mine' | 'access'>): Promise<CustomCalendar> {
    const key = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const { data } = await customCalendarsApi.create({ key, ...cal });
    const created = fromRecord(data);
    commitCustom([...(customState ?? []), created]);
    return created;
  }
  async function updateCalendar(id: string, patch: Partial<Omit<CustomCalendar, 'id' | 'mine' | 'access'>>) {
    const { data } = await customCalendarsApi.update(id, patch);
    commitCustom((customState ?? []).map((c) => (c.id === id ? fromRecord(data) : c)));
  }
  async function removeCalendar(id: string) {
    await customCalendarsApi.remove(id);
    commitCustom((customState ?? []).filter((c) => c.id !== id));
    // Drop its visibility entry so a future calendar can't inherit stale state.
    if (visState && id in visState) {
      const { [id]: _gone, ...rest } = visState;
      visState = rest;
      AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
      visSubs.forEach((fn) => fn());
    }
  }

  return { calendars, addCalendar, updateCalendar, removeCalendar };
}

// ── Deleted default calendars hook ──────────────────────────────────────────
// The built-in household calendars can be deleted from the Calendars view:
// the row disappears and the calendar's events hide (via the visibility map).
// Add Calendar offers "Add back <name> Calendar" to restore. Device-local,
// like the rest of the calendar prefs.
export function useDeletedDefaultCalendars() {
  const [deletedIds, setDeletedIds] = useState<string[]>(deletedDefaultsState ?? []);

  useEffect(() => {
    const sub = () => setDeletedIds([...(deletedDefaultsState ?? [])]);
    deletedSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      deletedSubs.delete(sub);
    };
  }, []);

  function persist(next: string[]) {
    deletedDefaultsState = next;
    AsyncStorage.setItem(DELETED_DEFAULTS_KEY, JSON.stringify(next)).catch(() => {});
    deletedSubs.forEach((fn) => fn());
  }
  function setEventsVisible(id: string, visible: boolean) {
    visState = { ...(visState ?? defaultVis()), [id]: visible };
    AsyncStorage.setItem(VIS_KEY, JSON.stringify(visState)).catch(() => {});
    visSubs.forEach((fn) => fn());
  }
  function deleteDefault(id: string) {
    if (!DELETABLE_DEFAULT_IDS.includes(id)) return;
    if (!(deletedDefaultsState ?? []).includes(id)) persist([...(deletedDefaultsState ?? []), id]);
    setEventsVisible(id, false);
  }
  function restoreDefault(id: string) {
    persist((deletedDefaultsState ?? []).filter((x) => x !== id));
    setEventsVisible(id, true);
  }

  return { deletedIds, deleteDefault, restoreDefault };
}

// ── Default calendar alerts hook ────────────────────────────────────────────
// The built-in calendars' "Event Alerts" switch (Edit Calendar): muted ids are
// merged into getAlertMutedCalendarIds so the reminder scheduler skips them.
export function useDefaultCalendarAlerts() {
  const [mutedIds, setMutedIds] = useState<string[]>(defaultAlertsOffState ?? []);

  useEffect(() => {
    const sub = () => setMutedIds([...(defaultAlertsOffState ?? [])]);
    defaultAlertsSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      defaultAlertsSubs.delete(sub);
    };
  }, []);

  function setAlertsEnabled(id: string, enabled: boolean) {
    const set = new Set(defaultAlertsOffState ?? []);
    if (enabled) set.delete(id);
    else set.add(id);
    defaultAlertsOffState = [...set];
    AsyncStorage.setItem(DEFAULT_ALERTS_OFF_KEY, JSON.stringify(defaultAlertsOffState)).catch(() => {});
    defaultAlertsSubs.forEach((fn) => fn());
  }

  return { mutedIds, setAlertsEnabled };
}

// ── Occasions calendar-level alert prefs hook ───────────────────────────────
export function useOccasionAlertPrefs() {
  const [prefs, setPrefs] = useState<OccasionAlertPrefs>(occasionAlertState ?? { ...DEFAULT_OCCASION_ALERTS });

  useEffect(() => {
    const sub = () => setPrefs({ ...(occasionAlertState ?? { ...DEFAULT_OCCASION_ALERTS }) });
    occasionAlertSubs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      occasionAlertSubs.delete(sub);
    };
  }, []);

  function setOccasionAlertPrefs(next: OccasionAlertPrefs) {
    // Normalise: unique, sorted offsets; keep a valid HH:mm time.
    const offsets = [...new Set(next.offsets.filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(next.time) ? next.time : DEFAULT_OCCASION_ALERTS.time;
    occasionAlertState = { offsets, time };
    AsyncStorage.setItem(OCCASION_ALERTS_KEY, JSON.stringify(occasionAlertState)).catch(() => {});
    occasionAlertSubs.forEach((fn) => fn());
  }

  return { prefs, setOccasionAlertPrefs };
}
