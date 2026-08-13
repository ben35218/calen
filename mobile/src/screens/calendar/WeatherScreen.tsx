import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Text } from '../../components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { loadWeatherForAddress, geocodePlace } from '@household/weather';
import { OutlookWeek, Trip, tripsApi } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { getOwnedAddonIds } from '../../lib/addons';
import {
  WeatherSource, getWeatherSource, setWeatherSource, sourceLabel,
  loadSourceForecast, loadSourceOutlook, LiveLocationError, isMissingHomeAddressError,
} from '../../lib/weatherSource';
import { formatMm } from '../../lib/weatherSummary';
import { Card, Button, BottomSheet, Skeleton } from '../../components/ui';
import type { RootStackParamList } from '../../navigation/types';
import HourlyForecast from '../../components/HourlyForecast';
import SkyBackground from '../../components/SkyBackground';
import WeatherIcon from '../../components/WeatherIcon';
import { weatherCardColors } from '../../lib/weatherTheme';
import { colors, spacing, radius } from '../../theme';

const BLUE = '#0288D1';

// Temperature → bar colour (Apple's cold-cyan → green → yellow → orange → red ramp).
function tempColor(t: number): string {
  if (t <= 0) return '#7FB8E8';
  if (t <= 8) return '#5FC3D8';
  if (t <= 14) return '#8CCB7F';
  if (t <= 19) return '#D9CE58';
  if (t <= 24) return '#EBB63A';
  if (t <= 29) return '#E8853B';
  return '#E25A33';
}

function weekRange(start: string, end: string) {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  const sM = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (s.getMonth() === e.getMonth()) return `${sM}–${e.getDate()}`;
  return `${sM}–${e.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// Mirrors client/src/views/WeatherView.vue + WeatherWidget: current conditions,
// a 7-day forecast strip, and the 90-day seasonal outlook grouped by month.
export default function WeatherScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Where this screen's weather comes from: live device location (default —
  // the first open triggers the iOS permission ask), the home address, or a
  // custom place. Chosen from the sheet behind the hero's location chip.
  const [source, setSource] = useState<WeatherSource | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const closePicker = () => setPickerOpen(false);
  // Re-read on every focus, not just mount: the "Another location" search is a
  // pushed screen that persists the pick itself, and coming back here is when
  // its choice has to take effect.
  useFocusEffect(React.useCallback(() => { getWeatherSource().then(setSource); }, []));
  const pickSource = (s: WeatherSource) => {
    setSource(s);
    closePicker();
    void setWeatherSource(s);
  };
  // "Another location" → the pushed search screen. Close the sheet first
  // (caller-driven = instant teardown) so the push isn't eaten by its Modal.
  const openCustomSearch = () => {
    closePicker();
    nav.navigate('WeatherLocationSearch');
  };

  const sourceKey = !source ? 'pending' : source.kind === 'custom' ? `custom:${source.place}` : source.kind;
  const weatherQ = useQuery({
    queryKey: ['weather', 'screen', sourceKey],
    enabled: !!source,
    queryFn: () => loadSourceForecast(source!),
  });
  const outlookQ = useQuery({
    queryKey: ['weather', 'outlook', sourceKey],
    enabled: !!source,
    queryFn: () => loadSourceOutlook(source!),
  });

  // Travel-aware: a booked trip whose dates span today puts a destination
  // forecast card under the home forecast. Fetched client-direct from
  // open-meteo like the trip detail screen — the destination never touches
  // our server. Silent (no card) when there is no active trip, the trips
  // add-on is locked, or the lookup fails.
  const activeTripQ = useQuery({
    queryKey: ['weather', 'activeTrip'],
    queryFn: async (): Promise<Trip | null> => {
      if (!(await getOwnedAddonIds()).has('trips')) return null;
      const now = new Date().toISOString().slice(0, 10);
      const rows = await Promise.all((await tripsApi.list()).data.map((t) => openRecord('Trip', t)));
      return rows.find((t) =>
        t.status === 'booked' && t.destination && t.startDate && t.endDate &&
        String(t.startDate).slice(0, 10) <= now && now <= String(t.endDate).slice(0, 10),
      ) ?? null;
    },
  });
  const trip = activeTripQ.data;
  const tripWeatherQ = useQuery({
    queryKey: ['weather', 'trip', trip?.destination],
    enabled: !!trip?.destination,
    queryFn: () => loadWeatherForAddress(trip!.destination!, { geocoder: geocodePlace }),
  });

  const monthGroups = React.useMemo(() => {
    const groups: { label: string; weeks: OutlookWeek[] }[] = [];
    (outlookQ.data ?? []).forEach((wk) => {
      const label = new Date(wk.startDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      let g = groups.find((x) => x.label === label);
      if (!g) { g = { label, weeks: [] }; groups.push(g); }
      g.weeks.push(wk);
    });
    return groups;
  }, [outlookQ.data]);

  const w = weatherQ.data;
  // The home source with nothing saved yet: the screen becomes the "Where's
  // home?" prompt alone — the outlook (and anything else needing a location)
  // would only stack its own failure under a card already asking for the fix.
  const needsHomeAddress = weatherQ.isError && isMissingHomeAddressError(weatherQ.error);
  // Solid card fill/border tracks the current conditions so the panels read as
  // part of the same sky as the gradient behind them.
  const cardTheme = weatherCardColors(w?.current?.weatherCode);
  const solidCard = { backgroundColor: cardTheme.bg, borderColor: cardTheme.border };
  const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
  const hourlyDay = w?.forecast?.find((d) => d.date === todayStr) ?? w?.forecast?.[0];

  // Week-wide temp bounds: each day's range bar is positioned inside this span.
  const weekMin = w?.forecast?.length ? Math.min(...w.forecast.map((d) => d.tempMin)) : 0;
  const weekMax = w?.forecast?.length ? Math.max(...w.forecast.map((d) => d.tempMax)) : 1;
  const weekSpan = Math.max(weekMax - weekMin, 1);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - weekMin) / weekSpan) * 100));

  return (
    <View style={styles.screen}>
      <SkyBackground weatherCode={w?.current?.weatherCode} />
      {/* Header is transparent — content clears the status bar AND the nav-bar
          band (44pt): the location chip must sit below the native bar, whose
          hit-testing would otherwise swallow its taps. */}
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + 52 }]}>
      {/* The location chip — tap to switch between live / home / custom.
          Rendered above the branches so a broken source can still be changed. */}
      {source ? (
        <TouchableOpacity style={styles.sourceChip} onPress={() => setPickerOpen(true)} activeOpacity={0.7}>
          <Ionicons
            name={source.kind === 'live' ? 'navigate' : source.kind === 'home' ? 'home' : 'search'}
            size={12}
            color="rgba(255,255,255,0.85)"
          />
          <Text style={styles.heroEyebrow}>{sourceLabel(source).toUpperCase()}</Text>
          <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
      ) : null}
      {!source || weatherQ.isLoading ? (
        <WeatherSkeleton />
      ) : weatherQ.isError || !w ? (
        weatherQ.error instanceof LiveLocationError ? (
          // The live source couldn't produce a fix — explain and offer a way
          // out rather than a dead screen.
          <Card style={styles.card}>
            <Text style={styles.emptyTitle}>Can't use your location</Text>
            <Text style={styles.muted}>
              {weatherQ.error.reason === 'denied'
                ? 'Location access is off for Calen. Allow it in Settings, or use your home address instead.'
                : 'This build doesn’t include location support yet — reinstall the app, or use your home address instead.'}
            </Text>
            {weatherQ.error.reason === 'denied' ? (
              <View style={styles.emptyBtn}>
                <Button title="Open Settings" onPress={() => Linking.openSettings()} />
              </View>
            ) : null}
            <View style={styles.emptyBtn}>
              <Button title="Use home address" variant="ghost" onPress={() => pickSource({ kind: 'home' })} />
            </View>
          </Card>
        ) : needsHomeAddress ? (
          // Missing address is actionable — jump straight to the Account field
          // (`promptField` highlights it) — while other failures (offline,
          // provider down) just state themselves.
          <Card style={styles.card}>
            <Text style={styles.emptyTitle}>Where's home?</Text>
            <Text style={styles.muted}>
              Add your home address and this screen fills with your local forecast — plus weather on
              the calendar and mowing-day suggestions.
            </Text>
            <View style={styles.emptyBtn}>
              <Button title="Set home address" onPress={() => nav.navigate('Account', { promptField: 'homeAddress' })} />
            </View>
          </Card>
        ) : (
          <Card style={styles.card}><Text style={styles.muted}>Couldn't load the weather — check your connection and try again.</Text></Card>
        )
      ) : (
        <>
          {/* Apple Weather-style hero over the sky — no card. */}
          <View style={styles.hero}>
            {/* Invisible left ° mirrors the real one so the digits themselves stay centered. */}
            <View style={styles.heroTempRow}>
              <Text style={[styles.heroDeg, styles.heroDegHidden]}>°</Text>
              <Text style={styles.heroTemp}>{Math.round(w.current.temperature)}</Text>
              <Text style={styles.heroDeg}>°</Text>
            </View>
            <Text style={styles.heroDesc}>{w.current.description}</Text>
            {hourlyDay ? (
              <Text style={styles.heroHiLo}>H:{Math.round(hourlyDay.tempMax)}°  L:{Math.round(hourlyDay.tempMin)}°</Text>
            ) : null}
            <Text style={styles.heroMeta}>
              Humidity {w.current.humidity}% · Wind {Math.round(w.current.windSpeed)} {w.units.wind}
              {formatMm(w.current.precipitation) ? ` · Rain ${formatMm(w.current.precipitation)} ${w.units.precipitation}` : ''}
            </Text>
          </View>

          {hourlyDay?.hours?.length ? (
            <Card style={[styles.card, solidCard]}>
              <HourlyForecast days={w.forecast} />
            </Card>
          ) : null}

          <Card style={[styles.card, solidCard]}>
            <View style={styles.weekHeader}>
              <MaterialCommunityIcons name="calendar-month-outline" size={14} color="rgba(255,255,255,0.7)" />
              <Text style={styles.weekHeaderText}>7-DAY FORECAST</Text>
            </View>
            {w.forecast.map((day, i) => (
              <View key={day.date} style={[styles.dayRow, i > 0 && styles.dayRowBorder]}>
                <Text style={styles.dayName}>
                  {day.date === todayStr ? 'Today' : new Date(day.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })}
                </Text>
                <View style={styles.dayIconWrap}>
                  <WeatherIcon code={day.weatherCode} size={22} />
                  {day.precipProbability > 10 ? (
                    <Text style={styles.dayPrecip}>
                      {day.precipProbability}%{formatMm(day.precipSum) ? ` · ${formatMm(day.precipSum)}mm` : ''}
                    </Text>
                  ) : formatMm(day.precipSum) ? (
                    <Text style={styles.dayPrecip}>{formatMm(day.precipSum)}mm</Text>
                  ) : null}
                </View>
                <Text style={styles.dayLow}>{Math.round(day.tempMin)}°</Text>
                <View style={styles.tempTrack}>
                  <View
                    style={[
                      styles.tempFill,
                      {
                        left: `${pct(day.tempMin)}%`,
                        width: `${Math.max(pct(day.tempMax) - pct(day.tempMin), 4)}%`,
                        experimental_backgroundImage: `linear-gradient(90deg, ${tempColor(day.tempMin)}, ${tempColor(day.tempMax)})`,
                      },
                    ]}
                  />
                  {day.date === todayStr ? (
                    <View style={[styles.nowDot, { left: `${pct(w.current.temperature)}%` }]} />
                  ) : null}
                </View>
                <Text style={styles.dayHigh}>{Math.round(day.tempMax)}°</Text>
              </View>
            ))}
          </Card>
        </>
      )}

      {/* Destination forecast while a booked trip is underway. */}
      {trip && tripWeatherQ.data?.current ? (() => {
        const tw = tripWeatherQ.data;
        const endStr = String(trip.endDate).slice(0, 10);
        const tripDays = tw.forecast.filter((d) => d.date >= todayStr && d.date <= endStr).slice(0, 5);
        return (
          <Card style={[styles.card, solidCard]}>
            <View style={styles.weekHeader}>
              <MaterialCommunityIcons name="airplane" size={14} color="rgba(255,255,255,0.7)" />
              <Text style={styles.weekHeaderText}>ON YOUR TRIP — {trip.destination!.toUpperCase()}</Text>
            </View>
            <View style={styles.tripNowRow}>
              <WeatherIcon code={tw.current!.weatherCode} size={34} />
              <View style={styles.tripNowText}>
                <Text style={styles.tripNowTemp}>{Math.round(tw.current!.temperature)}°</Text>
                <Text style={styles.tripNowDesc}>{tw.current!.description}</Text>
              </View>
            </View>
            {tripDays.map((day, i) => (
              <View key={day.date} style={[styles.dayRow, i === 0 && styles.dayRowBorder]}>
                <Text style={styles.dayName}>
                  {day.date === todayStr ? 'Today' : new Date(day.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })}
                </Text>
                <View style={styles.dayIconWrap}>
                  <WeatherIcon code={day.weatherCode} size={22} />
                  {day.precipProbability > 10 ? <Text style={styles.dayPrecip}>{day.precipProbability}%</Text> : null}
                </View>
                <View style={styles.tripDaySpacer} />
                <Text style={styles.dayLow}>{Math.round(day.tempMin)}°</Text>
                <Text style={styles.dayHigh}>{Math.round(day.tempMax)}°</Text>
              </View>
            ))}
          </Card>
        );
      })() : null}

      {needsHomeAddress ? null : (
      <Card style={[styles.card, solidCard]}>
        <Text style={styles.outlookTitle}>90-Day Seasonal Outlook</Text>
        <View style={styles.outlookDivider} />
        {outlookQ.isLoading ? (
          // SkeletonRows' staggered-line shape, re-filled by hand: its stock
          // grey vanishes against the translucent card, so these lines carry
          // the screen's white instead.
          <View style={styles.skelOutlook}>
            {(['90%', '72%', '82%', '64%'] as const).map((wdt) => (
              <Skeleton key={wdt} width={wdt} style={styles.skelBlock} />
            ))}
          </View>
        ) : outlookQ.isError ? (
          <Text style={styles.outlookError}>Could not load seasonal outlook.</Text>
        ) : (
          monthGroups.map((group) => (
            <View key={group.label}>
              <Text style={styles.monthHeading}>{group.label.toUpperCase()}</Text>
              {group.weeks.map((wk) => (
                <View key={wk.startDate} style={styles.weekRow}>
                  <Text style={styles.weekDates}>{weekRange(wk.startDate, wk.endDate)}</Text>
                  <View style={styles.weekTemp}>
                    <MaterialCommunityIcons name="thermometer-high" size={14} color="#EF6C00" />
                    <Text style={styles.weekTempHigh}>{wk.avgTempMax}°</Text>
                    <Text style={styles.weekTempLow}>/ {wk.avgTempMin}°</Text>
                  </View>
                  <View style={styles.weekPrecip}>
                    <MaterialCommunityIcons name="water" size={14} color={wk.totalPrecip > 20 ? '#9BD1FF' : wk.totalPrecip > 5 ? '#CFE8FF' : 'rgba(255,255,255,0.5)'} />
                    <Text style={styles.weekPrecipText}>{wk.totalPrecip} mm</Text>
                  </View>
                  <Text style={styles.rainDays}>{wk.rainyDays}/7</Text>
                </View>
              ))}
            </View>
          ))
        )}
      </Card>
      )}
      </ScrollView>

      {/* Source picker: live location / home address / a typed place. */}
      {/* Source picker. The first two rows commit in place; "Another location"
          leaves the sheet for a pushed search screen — a text field cannot
          live in a bottom sheet (the sheet rides the keyboard, so suggestions
          under the field render behind the keys). Sheet closes caller-driven
          (instant teardown), so the push isn't swallowed by a dying Modal. */}
      <BottomSheet visible={pickerOpen} onClose={closePicker} title="Weather location">
        <TouchableOpacity style={styles.sourceRow} activeOpacity={0.7} onPress={() => pickSource({ kind: 'live' })}>
          <Ionicons name="navigate" size={20} color={BLUE} />
          <View style={styles.sourceRowText}>
            <Text style={styles.sourceRowTitle}>My location</Text>
            <Text style={styles.sourceRowSub}>Follows you — uses this device's location</Text>
          </View>
          {source?.kind === 'live' ? <Ionicons name="checkmark" size={20} color={BLUE} /> : null}
        </TouchableOpacity>
        <TouchableOpacity style={styles.sourceRow} activeOpacity={0.7} onPress={() => pickSource({ kind: 'home' })}>
          <Ionicons name="home" size={20} color={BLUE} />
          <View style={styles.sourceRowText}>
            <Text style={styles.sourceRowTitle}>Home</Text>
            <Text style={styles.sourceRowSub}>Your household's home address</Text>
          </View>
          {source?.kind === 'home' ? <Ionicons name="checkmark" size={20} color={BLUE} /> : null}
        </TouchableOpacity>
        <TouchableOpacity style={styles.sourceRow} activeOpacity={0.7} onPress={openCustomSearch}>
          <Ionicons name="search" size={20} color={BLUE} />
          <View style={styles.sourceRowText}>
            <Text style={styles.sourceRowTitle}>Another location</Text>
            <Text style={styles.sourceRowSub}>
              {source?.kind === 'custom' ? source.place : 'Search for a city or place'}
            </Text>
          </View>
          {source?.kind === 'custom' ? <Ionicons name="checkmark" size={20} color={BLUE} /> : null}
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </BottomSheet>
    </View>
  );
}

// Shimmering placeholders shaped like the loaded screen — the hero temp
// readout, the hourly-strip card, and the 7-day card — so the first load (and
// every source switch) keeps its layout instead of collapsing to a lone
// spinner. Built from the shared Skeleton pulse, but the default grey block
// disappears against the sky gradient, so every block here carries the same
// translucent white the real cards' hairlines use.
function WeatherSkeleton() {
  return (
    <>
      <View style={styles.hero}>
        <Skeleton width={128} height={84} radius={radius.md} style={styles.skelBlock} />
        <Skeleton width={140} height={16} style={[styles.skelBlock, styles.skelGap]} />
        <Skeleton width={210} height={12} style={[styles.skelBlock, styles.skelGap]} />
      </View>
      <Skeleton width={'100%'} height={112} radius={radius.lg} style={[styles.skelBlock, styles.skelHourly]} />
      <Card style={styles.card}>
        <Skeleton width={110} height={12} style={styles.skelBlock} />
        {(['92%', '76%', '86%', '70%', '88%', '74%', '82%'] as const).map((wdt, i) => (
          <Skeleton key={i} width={wdt} style={[styles.skelBlock, styles.skelDayRow]} />
        ))}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { padding: spacing.md },
  // Translucent panels so the sky gradient shows through (Apple Weather style).
  card: { marginBottom: spacing.md, backgroundColor: 'rgba(10,22,40,0.45)', borderColor: 'rgba(255,255,255,0.14)' },
  muted: { color: colors.textMuted, fontSize: 13, paddingVertical: spacing.sm },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 2 },
  emptyBtn: { marginTop: spacing.sm },
  // The tappable location chip above the hero.
  sourceChip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: spacing.sm },
  // Source picker sheet rows.
  sourceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm },
  sourceRowText: { flex: 1, minWidth: 0 },
  sourceRowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  sourceRowSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  // Hero: current conditions floating over the sky, Apple Weather style.
  hero: { alignItems: 'center', paddingTop: spacing.md, paddingBottom: spacing.lg },
  heroEyebrow: { fontSize: 13, fontWeight: '600', letterSpacing: 1.5, color: 'rgba(255,255,255,0.85)', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 6 },
  heroTempRow: { flexDirection: 'row', marginVertical: -4 },
  heroTemp: { fontSize: 84, fontWeight: '200', color: '#fff', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 8 },
  heroDeg: { fontSize: 84, fontWeight: '200', color: '#fff', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 8 },
  heroDegHidden: { opacity: 0 },
  heroDesc: { fontSize: 18, fontWeight: '600', color: '#CFE8FF', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 6 },
  heroHiLo: { fontSize: 16, fontWeight: '600', color: '#fff', marginTop: 2, textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 6 },
  heroMeta: { fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: spacing.sm, textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 6 },
  // Apple-style 10-day list: day / icon / low / range bar / high.
  weekHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.xs },
  weekHeaderText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: 'rgba(255,255,255,0.7)' },
  dayRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  dayRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.25)' },
  dayName: { width: 62, fontSize: 17, fontWeight: '600', color: '#fff' },
  dayIconWrap: { width: 40, alignItems: 'center' },
  dayPrecip: { fontSize: 10, fontWeight: '600', color: '#9BD1FF', marginTop: 1 },
  dayLow: { width: 40, textAlign: 'right', fontSize: 17, fontWeight: '600', color: 'rgba(255,255,255,0.55)' },
  dayHigh: { width: 40, textAlign: 'right', fontSize: 17, fontWeight: '600', color: '#fff' },
  tempTrack: { flex: 1, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(0,0,0,0.22)', marginHorizontal: 10 },
  tempFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 2.5 },
  nowDot: { position: 'absolute', top: -1.5, width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff', borderWidth: 1.5, borderColor: 'rgba(0,0,0,0.35)', marginLeft: -4 },
  // Trip destination card (travel-aware weather).
  tripNowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  tripNowText: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  tripNowTemp: { fontSize: 28, fontWeight: '300', color: '#fff' },
  tripNowDesc: { fontSize: 14, fontWeight: '600', color: '#CFE8FF' },
  tripDaySpacer: { flex: 1 },
  outlookTitle: { fontSize: 15, fontWeight: '700', color: '#fff', marginBottom: spacing.sm },
  outlookDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.25)' },
  outlookError: { color: '#fff', fontSize: 13, paddingVertical: spacing.sm },
  monthHeading: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: '#fff', backgroundColor: 'rgba(255,255,255,0.10)', paddingVertical: 6, paddingHorizontal: 4, marginTop: spacing.sm },
  weekRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.25)' },
  weekDates: { width: 90, fontSize: 13, color: '#fff' },
  weekTemp: { flexDirection: 'row', alignItems: 'center', gap: 3, flex: 1, justifyContent: 'flex-end' },
  weekTempHigh: { fontSize: 13, fontWeight: '600', color: '#fff' },
  weekTempLow: { fontSize: 13, color: '#fff' },
  weekPrecip: { flexDirection: 'row', alignItems: 'center', gap: 3, width: 72, justifyContent: 'flex-end' },
  weekPrecipText: { fontSize: 12, color: '#fff' },
  rainDays: { width: 40, textAlign: 'right', fontSize: 12, color: '#fff' },
  // Skeleton blocks over the sky: same translucent white as the day-row hairlines.
  skelBlock: { backgroundColor: 'rgba(255,255,255,0.25)' },
  skelGap: { marginTop: spacing.sm },
  skelHourly: { marginBottom: spacing.md },
  skelDayRow: { marginTop: spacing.md },
  skelOutlook: { gap: 12, paddingVertical: spacing.md },
});
