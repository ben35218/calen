// One-sentence summary of the same ~24h window the day card's hourly strip
// shows: today's remaining hours + tomorrow's up to the current hour, or a
// future calendar day's full 24 hours. Mirrors the window logic in
// components/HourlyForecast so the sentence and the strip never disagree.

import { WeatherHour } from '../api';
import { skyKind } from './weatherTheme';
import { zonedParts } from './tz';

export interface SummaryDay {
  date: string;
  hours?: WeatherHour[];
}

// The hours the strip renders, in chronological order (sun markers excluded).
function windowHours(days: SummaryDay[], tz?: string): WeatherHour[] {
  const { dateStr: todayStr, minutes } = zonedParts(new Date(), tz);
  const nowHour = Math.floor(minutes / 60);
  const todayIdx = days.findIndex((d) => d.date === todayStr);
  const day = todayIdx >= 0 ? days[todayIdx] : days[0];
  if (!day?.hours?.length) return [];
  if (todayIdx < 0) return day.hours; // future day: its full 24 hours
  const next = days[todayIdx + 1];
  return [
    ...day.hours.filter((h) => h.hour >= nowHour),
    ...(next?.hours ?? []).filter((h) => h.hour < nowHour),
  ];
}

// '2026-07-14T16:00' → '4PM'
function hourLabel(iso: string): string {
  const h = parseInt(iso.slice(11, 13), 10);
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}AM` : `${h - 12}PM`;
}

const wet = (h: WeatherHour) => {
  const k = skyKind(h.weatherCode);
  return k === 'rain' || k === 'snow' || k === 'storm';
};

const CONDITION: Record<ReturnType<typeof skyKind>, string> = {
  clear: 'Clear skies',
  clouds: 'Cloudy',
  fog: 'Foggy',
  rain: 'Rain',
  snow: 'Snow',
  storm: 'Storms',
};

// null when there's nothing to summarize (no hourly data for the window).
export function summarizeNext24h(days: SummaryDay[], tz?: string): string | null {
  const hours = windowHours(days, tz);
  if (!hours.length) return null;

  const temps = hours.map((h) => Math.round(h.temperature));
  const hi = Math.max(...temps);
  const lo = Math.min(...temps);
  const tempPart = hi === lo ? `around ${hi}°` : `${lo}–${hi}°`;

  const startKind = skyKind(hours[0].weatherCode);
  const firstWet = hours.find(wet);

  // Wet later but not right now → call out when it arrives.
  if (firstWet && !wet(hours[0])) {
    const kind = skyKind(firstWet.weatherCode);
    const noun = kind === 'snow' ? 'snow' : kind === 'storm' ? 'storms' : 'rain';
    const prob = firstWet.precipProbability > 0 ? ` (${firstWet.precipProbability}%)` : '';
    return `${CONDITION[startKind]} now, with ${noun} likely around ${hourLabel(firstWet.time)}${prob}; temps ${tempPart} over the next 24 hours.`;
  }

  // Wet from the outset → note when it clears, if it does.
  if (firstWet) {
    const dryAfter = hours.find((h, i) => i > 0 && !wet(h));
    const clearing = dryAfter ? `, easing by ${hourLabel(dryAfter.time)}` : '';
    return `${CONDITION[startKind]} over the next 24 hours${clearing}; temps ${tempPart}.`;
  }

  // Dry throughout.
  return `${CONDITION[startKind]} over the next 24 hours; temps ${tempPart}.`;
}

// Rain/snow amount for display: sub-millimetre amounts keep one decimal
// ("0.4"), everything else rounds whole ("3"); trims float noise either way.
// Returns null under 0.1 mm — not worth a label.
export function formatMm(mm: number | null | undefined): string | null {
  if (mm == null || mm < 0.1) return null;
  return mm < 1 ? mm.toFixed(1) : String(Math.round(mm));
}
