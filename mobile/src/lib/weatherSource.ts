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
import { WeatherData, OutlookWeek } from '../api';
import { loadForecast, loadOutlookWeeks } from './weather';

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

// The hero eyebrow label ("MY LOCATION" / "HOME" / the custom place's leading
// segment — "Banff" out of "Banff, AB, Canada").
export function sourceLabel(source: WeatherSource): string {
  if (source.kind === 'live') return 'My Location';
  if (source.kind === 'custom') return source.place.split(',')[0].trim() || source.place;
  return 'Home';
}
