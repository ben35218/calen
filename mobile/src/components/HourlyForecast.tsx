import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { WeatherHour } from '../api';
import WeatherIcon from './WeatherIcon';
import { zonedParts } from '../lib/tz';
import { formatMm } from '../lib/weatherSummary';
import { spacing } from '../theme';

// The slice of a forecast day this strip needs (WeatherData.forecast entries).
export interface ForecastDay {
  date: string;
  sunrise?: string;
  sunset?: string;
  hours?: WeatherHour[];
}

type StripItem =
  | { kind: 'hour'; time: string; h: WeatherHour; night: boolean }
  | { kind: 'sun'; time: string; event: 'Sunrise' | 'Sunset' };

const GOLD = '#F4C542';

function hourLabel(h: number): string {
  if (h === 0) return '12AM';
  if (h < 12) return `${h}AM`;
  if (h === 12) return '12PM';
  return `${h - 12}PM`;
}

// '2026-07-11T21:04' → '9:04PM'
function sunLabel(iso: string): string {
  const hh = parseInt(iso.slice(11, 13), 10);
  const mm = iso.slice(14, 16);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${mm}${hh < 12 ? 'AM' : 'PM'}`;
}

// Apple-style 24h strip: today's remaining hours + tomorrow's up to the same
// hour, with Sunrise/Sunset entries inserted chronologically. `days` is the
// forecast array starting at the day to show; a non-today first day (e.g. a
// future calendar day) shows that day's full 24 hours instead.
export default function HourlyForecast({ days, tz }: { days: ForecastDay[]; tz?: string }) {
  // "Now" in `tz` when given (forecast hours are location-local, e.g. a trip
  // destination); otherwise the device clock.
  const { dateStr: todayStr, minutes } = zonedParts(new Date(), tz);
  const nowHour = Math.floor(minutes / 60);

  const todayIdx = days.findIndex((d) => d.date === todayStr);
  const day = todayIdx >= 0 ? days[todayIdx] : days[0];
  const next = todayIdx >= 0 ? days[todayIdx + 1] : undefined;
  const isToday = day?.date === todayStr;
  if (!day?.hours?.length) return null;

  // An hour is night if it falls before its own day's sunrise or after sunset
  // (ISO strings share the date prefix, so string comparison is chronological).
  const isNight = (d: ForecastDay, iso: string) =>
    Boolean((d.sunrise && iso < d.sunrise) || (d.sunset && iso > d.sunset));

  const items: StripItem[] = [];
  const pushHours = (d: ForecastDay, keep: (h: WeatherHour) => boolean) => {
    (d.hours ?? []).filter(keep).forEach((h) => items.push({ kind: 'hour', time: h.time, h, night: isNight(d, h.time) }));
  };

  if (isToday) {
    pushHours(day, (h) => h.hour >= nowHour);
    if (next) pushHours(next, (h) => h.hour < nowHour);
  } else {
    // Not today (e.g. a future calendar day): the full 24 hours of that day.
    pushHours(day, () => true);
  }

  // Sunrise/sunset markers that land inside the window shown above.
  const first = items[0]?.time;
  const last = items[items.length - 1]?.time;
  for (const d of [day, next]) {
    if (d?.sunrise && d.sunrise >= first && d.sunrise <= last) items.push({ kind: 'sun', time: d.sunrise, event: 'Sunrise' });
    if (d?.sunset && d.sunset >= first && d.sunset <= last) items.push({ kind: 'sun', time: d.sunset, event: 'Sunset' });
  }
  items.sort((a, b) => (a.time < b.time ? -1 : 1));

  if (!items.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
      {items.map((item) =>
        item.kind === 'sun' ? (
          <View key={item.time + item.event} style={styles.slot}>
            <Text style={styles.label}>{sunLabel(item.time)}</Text>
            <MaterialCommunityIcons
              name={item.event === 'Sunrise' ? 'weather-sunset-up' : 'weather-sunset-down'}
              size={24}
              color={GOLD}
              style={styles.icon}
            />
            <Text style={styles.temp}>{item.event}</Text>
          </View>
        ) : (
          <View key={item.time} style={styles.slot}>
            <Text style={styles.label}>
              {isToday && item.h.hour === nowHour && item.time.slice(0, 10) === todayStr ? 'Now' : hourLabel(item.h.hour)}
            </Text>
            <WeatherIcon code={item.h.weatherCode} night={item.night} size={24} style={styles.icon} />
            <Text style={styles.temp}>{Math.round(item.h.temperature)}°</Text>
            {item.h.precipProbability > 0 ? <Text style={styles.prob}>{item.h.precipProbability}%</Text> : null}
            {formatMm(item.h.precipitation) ? <Text style={styles.mm}>{formatMm(item.h.precipitation)}mm</Text> : null}
          </View>
        ),
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { gap: spacing.md, paddingVertical: spacing.xs },
  slot: { minWidth: 56, alignItems: 'center' },
  label: { fontSize: 15, fontWeight: '600', color: '#fff' },
  icon: { marginVertical: 14 },
  temp: { fontSize: 17, fontWeight: '600', color: '#fff' },
  prob: { fontSize: 11, color: '#CFE8FF', marginTop: 2 },
  mm: { fontSize: 10, color: '#9BD1FF', marginTop: 1 },
});
