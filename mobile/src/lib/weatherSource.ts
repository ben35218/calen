// The Weather screen's location source. Three options, configured on the
// screen itself: the device's LIVE location (the default — first open asks for
// the iOS location permission), the household's HOME address, or a CUSTOM
// place the user typed. Live + custom resolve client-direct against keyless
// open-meteo, so neither a GPS fix nor the custom place ever touches our
// server; home reuses lib/weather's E2EE-aware path. Device-local pref, like
// the other calendar prefs.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  geocodePlace, loadWeatherForCoords, loadWeatherForAddress,
  loadOutlook, loadOutlookForCoords,
} from '@household/weather';
import { WeatherData, OutlookWeek, tripsApi } from '../api';
import { loadForecast, loadOutlookWeeks } from './weather';
import { openRecord } from './e2ee';
import { getOwnedAddonIds } from './addons';

export type WeatherSource =
  | { kind: 'live' }
  | { kind: 'home' }
  | { kind: 'custom'; place: string };

const KEY = 'hc_weather_source';
export const DEFAULT_SOURCE: WeatherSource = { kind: 'live' };

export async function getWeatherSource(): Promise<WeatherSource> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.kind === 'home') return { kind: 'home' };
    if (parsed?.kind === 'custom' && typeof parsed.place === 'string' && parsed.place.trim()) {
      return { kind: 'custom', place: parsed.place };
    }
  } catch { /* corrupted pref — fall through to the default */ }
  return DEFAULT_SOURCE;
}

export async function setWeatherSource(source: WeatherSource): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(source)).catch(() => {});
}

// The live path's failure modes the screen tells apart: 'denied' = the user
// refused the permission; 'unavailable' = this build lacks the expo-location
// native module (pre-rebuild dev client).
export class LiveLocationError extends Error {
  constructor(public reason: 'denied' | 'unavailable') {
    super(`live-location-${reason}`);
  }
}

// The home source's "no address saved yet" failure, however it surfaced: the
// client-direct path throws it (lib/weather), the server path returns it as an
// API error body. The Weather screen turns this one failure into the actionable
// "Where's home?" prompt — and suppresses the cards that can't render without a
// location — so it must be recognized identically everywhere.
export function isMissingHomeAddressError(err: unknown): boolean {
  if (err instanceof LiveLocationError) return false;
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown } | null;
  const msg = e?.response?.data?.error ?? e?.message ?? '';
  return /home address/i.test(String(msg));
}

// One GPS fix per minute: the forecast and outlook queries both need coords,
// and a second prompt-and-fix within seconds is pure waste.
let cachedFix: { at: number; p: Promise<{ lat: number; lon: number }> } | null = null;

async function liveCoords(): Promise<{ lat: number; lon: number }> {
  if (cachedFix && Date.now() - cachedFix.at < 60_000) return cachedFix.p;
  const p = (async () => {
    // Lazy require: expo-location is a native module; a dev client built before
    // it was added must degrade to an error card, not crash at import.
    let Location: typeof import('expo-location');
    try {
      Location = require('expo-location');
    } catch {
      throw new LiveLocationError('unavailable');
    }
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') throw new LiveLocationError('denied');
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lon: pos.coords.longitude };
  })();
  cachedFix = { at: Date.now(), p };
  p.catch(() => { cachedFix = null; }); // don't cache failures
  return p;
}

export async function loadSourceForecast(source: WeatherSource): Promise<WeatherData> {
  if (source.kind === 'live') {
    const { lat, lon } = await liveCoords();
    return (await loadWeatherForCoords(lat, lon)) as unknown as WeatherData;
  }
  if (source.kind === 'custom') {
    return (await loadWeatherForAddress(source.place, { geocoder: geocodePlace })) as unknown as WeatherData;
  }
  return loadForecast();
}

export async function loadSourceOutlook(source: WeatherSource): Promise<OutlookWeek[]> {
  if (source.kind === 'live') {
    const { lat, lon } = await liveCoords();
    return (await loadOutlookForCoords(lat, lon)).weeks as unknown as OutlookWeek[];
  }
  if (source.kind === 'custom') {
    return (await loadOutlook(source.place, { geocoder: geocodePlace })).weeks as unknown as OutlookWeek[];
  }
  return loadOutlookWeeks();
}

// Forecast for PASSIVE surfaces (the calendar day view, the assistant's
// weather context): honors the Weather screen's chosen source, but never
// prompts — a location permission ask belongs to the Weather screen, not a
// calendar page. Live is used only when the permission is already granted;
// otherwise (or when the live fetch fails) it falls back to the home address.
// Throws only when no source can produce a forecast — callers render nothing.
export async function loadPassiveForecast(): Promise<WeatherData> {
  const source = await getWeatherSource();
  if (source.kind === 'custom') return loadSourceForecast(source);
  if (source.kind === 'live') {
    try {
      const Location: typeof import('expo-location') = require('expo-location');
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') return await loadSourceForecast(source);
    } catch { /* module unavailable or fix failed — fall back to home */ }
  }
  return loadForecast();
}

// ── Trip-aware calendar forecast ────────────────────────────────────────────
// On the calendar, a day inside a booked trip's dates shows the WEATHER AT THE
// TRIP'S DESTINATION — you won't be home that day — while every other day
// keeps the chosen source. The Weather screen's source pref is untouched: the
// override is per-day and derived, never written.

export type TripWeatherSpan = { tripId: string; destination: string; from: string; to: string };

// Pure: overlay destination days onto the base forecast. A date inside a
// span takes the destination forecast's day for that same date, tagged with
// the place's leading segment ("Tokyo" out of "Tokyo, Japan"); the first
// matching span wins a date, and a destination day that doesn't exist (fetch
// failed, date past its window) leaves the base day in place.
export function applyTripForecast(
  base: WeatherData,
  spans: TripWeatherSpan[],
  destForecasts: Record<string, WeatherData | null>,
): WeatherData {
  if (!spans.length) return base;
  const forecast = base.forecast.map((day) => {
    const span = spans.find((s) => s.from <= day.date && day.date <= s.to);
    const destDay = span
      ? destForecasts[span.destination]?.forecast.find((d) => d.date === day.date)
      : undefined;
    if (!span || !destDay) return day;
    // tripId rides along so a surface can open the trip the day belongs to.
    return { ...destDay, place: span.destination.split(',')[0].trim() || span.destination, tripId: span.tripId };
  });
  return { ...base, forecast };
}

// Trips with a destination and a full date range — the only trips that can
// claim calendar days. Silent [] when the trips add-on is locked or the
// list/decrypt fails: trip weather is an overlay, never a blocker.
async function datedTripSpans(): Promise<TripWeatherSpan[]> {
  try {
    if (!(await getOwnedAddonIds()).has('trips')) return [];
    const rows = await Promise.all((await tripsApi.list()).data.map((t) => openRecord('Trip', t)));
    return rows
      .filter((t) => t.destination && t.startDate && t.endDate)
      .map((t) => ({
        tripId: String(t._id),
        destination: String(t.destination),
        from: String(t.startDate).slice(0, 10),
        to: String(t.endDate).slice(0, 10),
      }));
  } catch {
    return [];
  }
}

// The calendar surfaces' forecast (month-grid strip, day-view rail, agenda
// glance): loadPassiveForecast, with trip days swapped for the destination's
// weather. Destinations resolve client-direct against keyless open-meteo like
// the trip detail screen — never through our server.
export async function loadCalendarForecast(): Promise<WeatherData> {
  const base = await loadPassiveForecast();
  const dates = base.forecast.map((d) => d.date);
  if (!dates.length) return base;
  const spans = (await datedTripSpans()).filter(
    (s) => s.from <= dates[dates.length - 1] && s.to >= dates[0],
  );
  if (!spans.length) return base;
  const destinations = [...new Set(spans.map((s) => s.destination))];
  const fetched = await Promise.all(destinations.map((d) =>
    loadWeatherForAddress(d, { geocoder: geocodePlace })
      .then((w) => [d, w as unknown as WeatherData] as const)
      .catch(() => [d, null] as const),
  ));
  return applyTripForecast(base, spans, Object.fromEntries(fetched));
}

// The hero eyebrow label ("MY LOCATION" / "HOME" / the custom place's leading
// segment — "Banff" out of "Banff, AB, Canada").
export function sourceLabel(source: WeatherSource): string {
  if (source.kind === 'live') return 'My Location';
  if (source.kind === 'custom') return source.place.split(',')[0].trim() || source.place;
  return 'Home';
}
