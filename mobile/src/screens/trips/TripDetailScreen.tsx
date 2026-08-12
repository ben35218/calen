import React, { useLayoutEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { loadWeatherForAddress, loadDailyClimate, geocodePlace } from '@household/weather';
import { tripsApi, Trip, TripItem, TripStatus } from '../../api';
import { Card, Badge, Divider, RoundIconButton, SectionHeader, SkeletonDetail, Fab } from '../../components/ui';
import WeatherIcon from '../../components/WeatherIcon';
import { weatherCardColors } from '../../lib/weatherTheme';
import HourlyForecast from '../../components/HourlyForecast';
import { tripTypeMeta, tripStatusLabel, tripStatusColor } from '../../lib/tripTypes';
import { outfitSuggestion } from '../../lib/outfit';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { zonedParts, zonedTimeLabel } from '../../lib/tz';
import TripTimeline from '../../components/TripTimeline';
import CalenChatIcon from '../../components/CalenChatIcon';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { openRecord, sealUpdate, getHDK, loadResourceKeys, currentResourceKeyVersion, sealForResource } from '../../lib/e2ee';
import { useHorizontalSwipe } from '../../lib/useHorizontalSwipe';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<TripsStackParamList, 'TripDetail'>;
type Rt = RouteProp<TripsStackParamList, 'TripDetail'>;

const todayStr = new Date().toISOString().slice(0, 10);

function eachDay(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const d = new Date(startISO + 'T12:00:00');
  const end = new Date(endISO + 'T12:00:00');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export default function TripDetailScreen() {
  const navigation = useNavigation<Nav>();
  const aiEnabled = useAiEnabled();
  const accent = useCalendarColors().colors.trips;
  const { id } = useRoute<Rt>().params;
  const qc = useQueryClient();
  const [dayIndex, setDayIndex] = useState<number | null>(null); // null = grid view
  const [expandedType, setExpandedType] = useState<string | null>(null); // budget category drill-down
  const [showUncosted, setShowUncosted] = useState(false);
  const [climateOpen, setClimateOpen] = useState(false); // typical-weather card, collapsed by default

  const tripQ = useQuery({ queryKey: ['trips', id], queryFn: async () => (await tripsApi.get(id)).data });
  const budgetQ = useQuery({ queryKey: ['trips', id, 'budget'], queryFn: async () => (await tripsApi.budget(id)).data });
  // GET /trips/:id returns { trip, items, isOwner }; flatten into a single Trip-with-items.
  const data = tripQ.data as unknown as { trip: Trip; items: TripItem[]; isOwner?: boolean } | undefined;
  const trip = data ? { ...data.trip, items: data.items } : undefined;
  const tz = trip?.destinationTz || '';

  // Status-only update. The seal rebuilds the enc blob from the fields we pass, so
  // re-seal the current decrypted content (name/destination/notes) or the trip
  // would lose it. Signal-parity D2: a shared trip re-seals under its TripKey.
  const statusMut = useMutation({
    mutationFn: async (status: TripStatus) => {
      const dec: any = data ? await openRecord('Trip', data.trip as any) : {};
      const content = { name: dec.name, destination: dec.destination, notes: dec.notes };
      const shared = ((data?.trip?.sharedWithOutside?.length ?? 0) > 0) || ((data?.trip?.collaborators?.length ?? 0) > 0);
      if (shared && getHDK()) {
        await loadResourceKeys('trip', id).catch(() => {});
        if (currentResourceKeyVersion(id) > 0) {
          const sealed = await sealForResource('trip', 'Trip', id, id, content);
          if (sealed) return tripsApi.update(id, { status, ...sealed });
        }
      }
      return tripsApi.update(id, await sealUpdate('Trip', id, { status }, content));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trips'] }),
    onError: (e: any) => {
      Alert.alert('Could not update status', e?.response?.data?.error || e?.message || 'Please try again.');
    },
  });

  const changeStatus = () => {
    const options: TripStatus[] = ['considering', 'booked', 'completed'];
    Alert.alert('Trip status', undefined, [
      ...options.map((s) => ({
        text: trip?.status === s ? `${tripStatusLabel(s)} ✓` : tripStatusLabel(s),
        onPress: () => { if (s !== trip?.status) statusMut.mutate(s); },
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const dayList = useMemo(() => {
    if (!trip) return [];
    let start = trip.startDate;
    let end = trip.endDate || trip.startDate;
    if (!start && trip.candidateRanges?.length) {
      start = trip.candidateRanges[0].start;
      end = trip.candidateRanges[0].end;
    }
    if (!start && trip.items?.length) {
      const ds = trip.items.map((i) => new Date(i.start).getTime());
      start = new Date(Math.min(...ds)).toISOString();
      end = new Date(Math.max(...trip.items.map((i) => new Date(i.end || i.start).getTime()))).toISOString();
    }
    if (!start) return [];
    return eachDay(start.slice(0, 10), (end || start).slice(0, 10));
  }, [trip]);

  // Destination weather, fetched client-direct from open-meteo (keyless) like
  // home weather in §9.1 P5b — the destination never touches our server.
  const destination = trip?.destination;
  const tripFrom = dayList[0];
  const tripTo = dayList[dayList.length - 1];

  // Swipe left → next day, right → previous day, clamped to the trip's range.
  // Called unconditionally (hooks rule); only wired into the day-itinerary view.
  const daySwipe = useHorizontalSwipe({
    onSwipeLeft: () => setDayIndex((i) => Math.min((i ?? 0) + 1, dayList.length - 1)),
    onSwipeRight: () => setDayIndex((i) => Math.max((i ?? 0) - 1, 0)),
  });
  // 7-day forecast for the destination — feeds the day itinerary view when the
  // day is close enough to have a forecast.
  const forecastQ = useQuery({
    queryKey: ['tripWeather', destination],
    queryFn: () => loadWeatherForAddress(destination!, { geocoder: geocodePlace }),
    enabled: !!destination,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  // Historic per-day averages for the trip dates (past 3 years).
  const climateQ = useQuery({
    queryKey: ['tripClimate', destination, tripFrom, tripTo],
    queryFn: () => loadDailyClimate(destination!, tripFrom, tripTo, { geocoder: geocodePlace }),
    enabled: !!destination && !!tripFrom,
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  // Bookings whose dates all fall outside the trip's day window.
  const outOfRangeItems = useMemo(() => {
    if (!trip?.items?.length || !dayList.length) return [];
    const inWindow = new Set(dayList);
    return trip.items
      .filter((it) => {
        let dates: string[];
        if (it.type === 'hotel') {
          const ci = zonedParts(it.start, tz).dateStr;
          const co = zonedParts(it.end || it.start, tz).dateStr;
          dates = eachDay(ci, co);
        } else {
          const d = it.details as any;
          if ((it.type === 'flight' || it.type === 'transit') && (d?.departureTz || d?.arrivalTz)) {
            dates = [zonedParts(it.start, d.departureTz || tz).dateStr];
            if (it.end) dates.push(zonedParts(it.end, d.arrivalTz || tz).dateStr);
          } else {
            dates = [zonedParts(it.start, tz).dateStr];
            if (it.end) dates.push(zonedParts(it.end, tz).dateStr);
          }
        }
        return dates.length > 0 && !dates.some((d) => inWindow.has(d));
      })
      .map((it) => {
        const d = it.details as any;
        const itemTz = (it.type === 'flight' || it.type === 'transit') && d?.departureTz ? d.departureTz : tz;
        const { dateStr } = zonedParts(it.start, itemTz);
        const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        return { item: it, label: `${dateLabel} · ${zonedTimeLabel(it.start, itemTz)}` };
      })
      .sort((a, b) => a.item.start.localeCompare(b.item.start));
  }, [trip, dayList, tz]);

  // Distinct non-hotel booking types touching a date — journey legs (flight/transit)
  // count on both their departure and arrival local dates.
  const markerTypesForDate = (dateStr: string): string[] => {
    const seen: string[] = [];
    for (const it of trip?.items ?? []) {
      if (it.type === 'hotel') continue;
      const d = it.details as any;
      let touches = false;
      if ((it.type === 'flight' || it.type === 'transit') && (d?.departureTz || d?.arrivalTz)) {
        if (zonedParts(it.start, d.departureTz).dateStr === dateStr) touches = true;
        if (it.end && zonedParts(it.end, d.arrivalTz).dateStr === dateStr) touches = true;
      } else {
        touches = zonedParts(it.start, tz).dateStr === dateStr;
      }
      if (touches && !seen.includes(it.type)) seen.push(it.type);
    }
    return seen.slice(0, 4);
  };

  // A hotel covers every night from check-in through check-out date.
  const hasLodgingForDate = (dateStr: string): boolean =>
    (trip?.items ?? []).some((it) => {
      if (it.type !== 'hotel') return false;
      const ci = zonedParts(it.start, tz).dateStr;
      const co = zonedParts(it.end || it.start, tz).dateStr;
      return dateStr >= ci && dateStr <= co;
    });

  useLayoutEffect(() => {
    const targetDate = dayIndex != null ? dayList[dayIndex] : (dayList[0] ?? undefined);
    navigation.setOptions({
      headerStyle: { backgroundColor: colors.background },
      headerShadowVisible: false,
      headerTintColor: '#fff',
      title: trip?.name || 'Trip',
      headerTitle: dayIndex == null
        ? () => (
            <View style={styles.headerTitleRow}>
              <View style={styles.titleSide}>
                {trip ? (
                  <TouchableOpacity onPress={changeStatus} hitSlop={8} disabled={statusMut.isPending}>
                    <Badge label={tripStatusLabel(trip.status)} color={tripStatusColor(trip.status)} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <View style={styles.titleGroup}>
                {/* Invisible spacer mirrors the pencil's width+gap so the title
                    text stays centered within the group (pencil doesn't shift it). */}
                <View style={styles.pencilSpacer} />
                <Text style={styles.headerTitleText} numberOfLines={1}>{trip?.name || 'Trip'}</Text>
                <TouchableOpacity style={styles.pencilBtn} onPress={() => navigation.navigate('TripForm', { id })} hitSlop={8}>
                  <Ionicons name="pencil" size={17} color="#fff" />
                </TouchableOpacity>
              </View>
              <View style={styles.titleSide} />
            </View>
          )
        : undefined,
      headerLeft: dayIndex != null
        ? () => (
            <TouchableOpacity onPress={() => setDayIndex(null)} style={styles.headerBtn} hitSlop={8}>
              <Ionicons name="chevron-back" size={26} color="#fff" />
            </TouchableOpacity>
          )
        : undefined,
      headerRight: () => (
        <RoundIconButton
          icon="add"
          onPress={() => navigation.navigate('TripItemForm', { tripId: id, date: targetDate })}
          bg={accent}
        />
      ),
    });
  }, [navigation, id, trip?.name, trip?.status, dayIndex, dayList]);

  if (tripQ.isLoading || !trip) {
    return (
      <View style={styles.screen}>
        <SkeletonDetail />
      </View>
    );
  }

  const selectedDate = dayIndex != null ? dayList[dayIndex] : null;

  // ── Day itinerary view ──
  if (selectedDate) {
    const allItems = trip.items ?? [];
    // Hotels covering the selected night (check-in date through check-out date).
    const lodgingForDay = allItems.filter((it) => {
      if (it.type !== 'hotel') return false;
      const ci = zonedParts(it.start, tz).dateStr;
      const co = zonedParts(it.end || it.start, tz).dateStr;
      return selectedDate >= ci && selectedDate <= co;
    });
    const lodgingNote = (h: TripItem) => {
      const ci = zonedParts(h.start, tz).dateStr;
      const co = zonedParts(h.end || h.start, tz).dateStr;
      if (selectedDate === ci) return `Check in ${zonedTimeLabel(h.start, tz)}`;
      if (selectedDate === co) return `Check out ${zonedTimeLabel(h.end || h.start, tz)}`;
      return 'Overnight';
    };
    // Non-hotel bookings that land on this day (drives the timeline vs empty state).
    const timedItems = allItems.filter((it) => {
      if (it.type === 'hotel') return false;
      const d = it.details as any;
      if ((it.type === 'flight' || it.type === 'transit') && (d?.departureTz || d?.arrivalTz)) {
        if (zonedParts(it.start, d.departureTz).dateStr === selectedDate) return true;
        if (it.end && zonedParts(it.end, d.arrivalTz).dateStr === selectedDate) return true;
        return false;
      }
      return zonedParts(it.start, tz).dateStr === selectedDate;
    });
    return (
      <View style={styles.screen} {...daySwipe}>
        <View style={styles.dayNav}>
          <TouchableOpacity disabled={dayIndex === 0} onPress={() => setDayIndex((i) => (i ?? 0) - 1)}>
            <Ionicons name="chevron-back" size={24} color={dayIndex === 0 ? colors.border : accent} />
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.dayWeekday}>{new Date(selectedDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' })}</Text>
            <Text style={styles.dayLabel}>{new Date(selectedDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</Text>
            <Text style={styles.dayCount}>Day {(dayIndex ?? 0) + 1} of {dayList.length}</Text>
          </View>
          <TouchableOpacity disabled={dayIndex === dayList.length - 1} onPress={() => setDayIndex((i) => (i ?? 0) + 1)}>
            <Ionicons name="chevron-forward" size={24} color={dayIndex === dayList.length - 1 ? colors.border : accent} />
          </TouchableOpacity>
        </View>
        <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {(() => {
            // Destination forecast for this day, when it's within the 7-day window.
            const fc = forecastQ.data?.forecast ?? [];
            const i = fc.findIndex((d) => d.date === selectedDate);
            if (i < 0) return null;
            const wd = fc[i];
            // Card fill tracks the day's conditions (daytime tint — day forecast).
            const wdColors = weatherCardColors(wd.weatherCode, false);
            return (
              <Card style={[styles.weatherCard, { backgroundColor: wdColors.bg, borderColor: wdColors.border }]}>
                <View style={styles.weatherRow}>
                  <WeatherIcon code={wd.weatherCode} size={36} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.weatherTemp}>{Math.round(wd.tempMax)}° / {Math.round(wd.tempMin)}°</Text>
                    <Text style={styles.weatherDesc}>{wd.description}</Text>
                  </View>
                  {wd.precipProbability > 0 ? <Text style={styles.weatherSub}>{wd.precipProbability}% rain</Text> : null}
                </View>
                <View style={styles.outfitRow}>
                  <MaterialCommunityIcons name="tshirt-crew" size={15} color="rgba(255,255,255,0.85)" />
                  <Text style={styles.outfitText}>{outfitSuggestion(wd)}</Text>
                </View>
                {wd.hours?.length ? (
                  <>
                    <View style={styles.weatherDivider} />
                    <HourlyForecast days={fc.slice(i)} tz={tz || undefined} />
                  </>
                ) : null}
              </Card>
            );
          })()}
          {lodgingForDay.map((h) => (
            <View key={`lodge-${h._id}`} style={styles.lodgeBanner}>
              <MaterialCommunityIcons name="bed" size={18} color="#6A1B9A" />
              <Text style={styles.lodgeTitle}>{h.title}</Text>
              <Text style={styles.lodgeNote}>{lodgingNote(h)}</Text>
              <TouchableOpacity onPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: h._id, date: selectedDate })}>
                <Ionicons name="pencil" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
          {timedItems.length === 0 ? (
            lodgingForDay.length === 0 ? <Text style={styles.empty}>Nothing booked this day.</Text> : null
          ) : (
            <TripTimeline
              items={trip.items ?? []}
              selectedDate={selectedDate}
              tz={tz}
              onEditItem={(itemId) => navigation.navigate('TripItemForm', { tripId: id, itemId, date: selectedDate })}
            />
          )}
        </KeyboardAwareScrollView>
        {aiEnabled && (
          <Fab bg={accent} onPress={() => navigation.navigate('TripAssistant', { tripId: id, tripName: trip?.name })}>
            <CalenChatIcon size={26} color="#fff" />
          </Fab>
        )}
      </View>
    );
  }

  // ── Grid (calendar) view ──
  return (
    <View style={styles.screen}>
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {/* Typical weather: 3-year historical averages for the trip dates. */}
        {climateQ.data?.days?.some((cd) => cd.avgTempMax != null) ? (
          <Card style={styles.weatherCard}>
            <TouchableOpacity style={styles.weatherHeader} onPress={() => setClimateOpen((v) => !v)} activeOpacity={0.7}>
              <Ionicons name="partly-sunny" size={16} color="rgba(255,255,255,0.8)" />
              <Text style={styles.weatherHeaderText}>TYPICAL WEATHER · {trip.destination?.toUpperCase()}</Text>
              <Ionicons name={climateOpen ? 'chevron-up' : 'chevron-down'} size={16} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
            {climateOpen ? <Text style={styles.weatherCaption}>Averages for these dates over the past 3 years</Text> : null}
            {climateOpen && climateQ.data.days.map((cd) => (
              <View key={cd.date} style={styles.climateRow}>
                <Text style={styles.climateDate}>
                  {new Date(cd.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </Text>
                <View style={styles.climateTemp}>
                  <MaterialCommunityIcons name="thermometer-high" size={14} color="#EF6C00" />
                  <Text style={styles.climateHigh}>{cd.avgTempMax != null ? `${cd.avgTempMax}°` : '—'}</Text>
                  <Text style={styles.climateLow}>/ {cd.avgTempMin != null ? `${cd.avgTempMin}°` : '—'}</Text>
                </View>
                <View style={styles.climatePrecip}>
                  <MaterialCommunityIcons
                    name="water"
                    size={14}
                    color={(cd.avgPrecip ?? 0) > 5 ? '#9BD1FF' : (cd.avgPrecip ?? 0) > 1 ? '#CFE8FF' : 'rgba(255,255,255,0.5)'}
                  />
                  <Text style={styles.climatePrecipText}>{cd.avgPrecip != null ? `${cd.avgPrecip} mm` : '—'}</Text>
                </View>
              </View>
            ))}
          </Card>
        ) : null}

        {trip.status === 'considering' && trip.candidateRanges?.length ? (
          <View style={styles.optionsWrap}>
            <SectionHeader>Date options</SectionHeader>
            {trip.candidateRanges.map((r, i) => (
              <Card key={i} style={styles.optionCard}>
                <Text style={styles.optionTitle}>{r.label || `Option ${i + 1}`}</Text>
                <Text style={styles.itemSub}>{r.start.slice(0, 10)} – {r.end.slice(0, 10)}</Text>
              </Card>
            ))}
          </View>
        ) : null}

        {dayList.length ? (
          <>
            <SectionHeader>{dayList.length}-day trip — tap a day</SectionHeader>
            <View style={styles.daysGrid}>
              {dayList.map((dateStr, idx) => {
                const d = new Date(dateStr + 'T12:00:00');
                const types = markerTypesForDate(dateStr);
                const hasLodging = hasLodgingForDate(dateStr);
                return (
                  <TouchableOpacity key={dateStr} style={[styles.dayCell, dateStr === todayStr && { borderColor: accent, borderWidth: 2 }]} onPress={() => setDayIndex(idx)}>
                    <Text style={[styles.dcIndex, { color: accent }]}>Day {idx + 1}</Text>
                    <Text style={styles.dcWeekday}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</Text>
                    <Text style={styles.dcDayNum}>{d.getDate()}</Text>
                    <Text style={styles.dcMonth}>{d.toLocaleDateString(undefined, { month: 'short' })}</Text>
                    <View style={styles.dcMarkers}>
                      {hasLodging ? (
                        <MaterialCommunityIcons name={tripTypeMeta('hotel').icon as any} size={12} color={tripTypeMeta('hotel').color} />
                      ) : null}
                      {types.map((t) => (
                        <MaterialCommunityIcons key={t} name={tripTypeMeta(t).icon as any} size={12} color={tripTypeMeta(t).color} />
                      ))}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        ) : null}

        {/* Budget */}
        {budgetQ.data && (budgetQ.data.costedCount || budgetQ.data.budget != null) ? (
          <Card style={styles.budgetCard}>
            <View style={styles.budgetHeader}>
              <Ionicons name="wallet-outline" size={18} color={accent} />
              <Text style={styles.budgetTitle}>Your budget</Text>
              <Text style={styles.budgetTotal}>
                {budgetQ.data.baseCurrency} {Math.round(budgetQ.data.total)}
                {budgetQ.data.budget != null ? ` / ${Math.round(budgetQ.data.budget)}` : ''}
              </Text>
            </View>
            {(() => {
              const uncosted = (trip.items ?? []).filter((it) => (it.myData?.cost ?? it.cost) == null);
              if (!uncosted.length) return null;
              return (
                <View style={styles.uncostedWrap}>
                  <TouchableOpacity style={styles.uncostedToggle} onPress={() => setShowUncosted((v) => !v)}>
                    <Ionicons name="alert-circle-outline" size={14} color="#B26A00" />
                    <Text style={styles.uncostedToggleText}>
                      {uncosted.length} booking{uncosted.length > 1 ? 's have' : ' has'} no cost set
                    </Text>
                    <Ionicons name={showUncosted ? 'chevron-up' : 'chevron-down'} size={14} color="#B26A00" />
                  </TouchableOpacity>
                  {showUncosted && uncosted.map((it) => (
                    <TouchableOpacity
                      key={it._id}
                      style={styles.uncostedRow}
                      onPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: it._id })}
                    >
                      <MaterialCommunityIcons name={tripTypeMeta(it.type).icon as any} size={14} color={tripTypeMeta(it.type).color} />
                      <Text style={styles.uncostedRowTitle} numberOfLines={1}>{it.title}</Text>
                      <Ionicons name="pencil" size={14} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))}
                </View>
              );
            })()}
            {budgetQ.data.byType.length ? <Divider /> : null}
            {budgetQ.data.byType.map((b) => {
              const expanded = expandedType === b.type;
              const typeItems = expanded
                ? (trip.items ?? [])
                    .filter((it) => it.type === b.type)
                    .sort((x, y) => x.start.localeCompare(y.start))
                : [];
              return (
                <View key={b.type}>
                  <TouchableOpacity style={styles.btRow} onPress={() => setExpandedType(expanded ? null : b.type)}>
                    <MaterialCommunityIcons name={tripTypeMeta(b.type).icon as any} size={14} color={tripTypeMeta(b.type).color} />
                    <Text style={styles.btLabel}>{tripTypeMeta(b.type).label}</Text>
                    <Text style={styles.btAmount}>{budgetQ.data!.baseCurrency} {Math.round(b.amount)}</Text>
                    <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
                  </TouchableOpacity>
                  {typeItems.map((it) => {
                    const cost = it.myData?.cost ?? it.cost;
                    const dateStr = zonedParts(it.start, tz).dateStr;
                    return (
                      <TouchableOpacity
                        key={it._id}
                        style={styles.btItemRow}
                        onPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: it._id })}
                      >
                        <Text style={styles.btItemTitle} numberOfLines={1}>{it.title}</Text>
                        <Text style={styles.btItemDate}>
                          {new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </Text>
                        <Text style={styles.btItemCost}>
                          {cost != null ? `${it.currency || budgetQ.data!.baseCurrency} ${Math.round(cost)}` : '—'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
            <TouchableOpacity style={styles.settleLink} onPress={() => navigation.navigate('TripSettle', { id })}>
              <Text style={[styles.settleText, { color: accent }]}>Settle up</Text>
              <Ionicons name="chevron-forward" size={16} color={accent} />
            </TouchableOpacity>
          </Card>
        ) : null}

        {outOfRangeItems.length > 0 ? (
          <View style={styles.oorWrap}>
            <Text style={styles.oorLabel}>Outside your trip dates</Text>
            <Text style={styles.oorSubtitle}>
              {outOfRangeItems.length === 1 ? 'This booking falls' : 'These bookings fall'} outside{' '}
              {dayList.length ? `${new Date(dayList[0] + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(dayList[dayList.length - 1] + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'the trip dates'}.
              {' '}Edit a booking or adjust the trip dates.
            </Text>
            {outOfRangeItems.map(({ item, label }) => (
              <TouchableOpacity
                key={item._id}
                style={styles.oorCard}
                onPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: item._id })}
              >
                <View style={[styles.oorBar, { backgroundColor: tripTypeMeta(item.type).color }]} />
                <MaterialCommunityIcons name={tripTypeMeta(item.type).icon as any} size={16} color={tripTypeMeta(item.type).color} />
                <View style={styles.oorInfo}>
                  <Text style={styles.oorTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.oorDate}>{label}</Text>
                </View>
                <Ionicons name="pencil" size={15} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {trip.notes ? (
          <View style={styles.notesWrap}>
            <SectionHeader>Notes</SectionHeader>
            <Text style={styles.notes}>{trip.notes}</Text>
          </View>
        ) : null}
      </KeyboardAwareScrollView>
      {aiEnabled && (
        <Fab bg={accent} onPress={() => navigation.navigate('TripAssistant', { tripId: id, tripName: trip?.name })}>
          <CalenChatIcon size={26} color="#fff" />
        </Fab>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: 96 },
  headerBtn: { paddingHorizontal: 5 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  headerTitleText: { color: '#fff', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  // Status badge sits left; an equal-width empty slot on the right keeps the
  // title group centered in the header.
  titleSide: { minWidth: 49, alignItems: 'flex-start' },
  // Title + pencil, tight together. The left spacer matches the pencil's
  // width+gap so the title text itself stays centered within the group.
  titleGroup: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  pencilSpacer: { width: 23 },
  pencilBtn: { marginLeft: 6 },
  optionsWrap: { marginBottom: spacing.md },
  optionCard: { marginBottom: spacing.sm },
  optionTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  daysGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  dayCell: { width: 84, padding: spacing.sm, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  dayCellToday: { borderWidth: 2 },
  dcIndex: { fontSize: 11, fontWeight: '700' },
  dcWeekday: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  dcDayNum: { fontSize: 22, fontWeight: '700', color: colors.text },
  dcMonth: { fontSize: 12, color: colors.textMuted },
  dcMarkers: { flexDirection: 'row', gap: 2, marginTop: 4, minHeight: 14 },
  dayNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md },
  dayWeekday: { fontSize: 12, color: colors.textMuted, textTransform: 'uppercase', fontWeight: '600' },
  dayLabel: { fontSize: 17, fontWeight: '700', color: colors.text },
  dayCount: { fontSize: 12, color: colors.textMuted },
  backToCal: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  backToCalText: { fontSize: 13, fontWeight: '600' },
  lodgeBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: '#6A1B9A14', borderRadius: 10, padding: spacing.sm, marginBottom: spacing.sm },
  lodgeTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  lodgeNote: { flex: 1, fontSize: 13, color: colors.textMuted },
  itemCard: { marginBottom: spacing.sm },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  itemTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.text },
  itemTime: { fontSize: 13, color: colors.text, marginTop: 4, fontWeight: '500' },
  itemSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  // Weather cards: solid sky blue matching the weather screens.
  weatherCard: { marginBottom: spacing.md, backgroundColor: '#5089D2', borderColor: 'rgba(255,255,255,0.22)' },
  weatherRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  weatherTemp: { fontSize: 18, fontWeight: '700', color: '#fff' },
  weatherDesc: { fontSize: 13, color: 'rgba(255,255,255,0.85)' },
  weatherSub: { fontSize: 13, color: '#CFE8FF', fontWeight: '600' },
  weatherDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.25)', marginVertical: spacing.sm },
  outfitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: spacing.sm },
  outfitText: { flex: 1, fontSize: 13, color: 'rgba(255,255,255,0.9)', lineHeight: 18 },
  weatherHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  weatherHeaderText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: 'rgba(255,255,255,0.8)', flex: 1 },
  weatherCaption: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2, marginBottom: spacing.xs },
  climateRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.25)' },
  climateDate: { flex: 1, fontSize: 13, color: '#fff' },
  climateTemp: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  climateHigh: { fontSize: 13, fontWeight: '600', color: '#fff' },
  climateLow: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  climatePrecip: { flexDirection: 'row', alignItems: 'center', gap: 3, width: 76, justifyContent: 'flex-end' },
  climatePrecipText: { fontSize: 12, color: '#fff' },
  budgetCard: { marginBottom: spacing.md },
  budgetHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  budgetTitle: { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 },
  budgetTotal: { fontSize: 14, fontWeight: '600', color: colors.text },
  uncostedWrap: { marginTop: spacing.sm },
  uncostedToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  uncostedToggleText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#B26A00' },
  uncostedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5, paddingLeft: 4, borderRadius: 6 },
  uncostedRowTitle: { flex: 1, fontSize: 13, color: colors.text },
  btRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  btLabel: { flex: 1, fontSize: 14, color: colors.text },
  btAmount: { fontSize: 14, color: colors.textMuted },
  btItemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5, paddingLeft: 22 },
  btItemTitle: { flex: 1, fontSize: 13, color: colors.text },
  btItemDate: { fontSize: 12, color: colors.textMuted },
  btItemCost: { fontSize: 13, color: colors.textMuted, minWidth: 60, textAlign: 'right' },
  settleLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  settleText: { fontWeight: '700', fontSize: 13, textTransform: 'uppercase' },
  oorWrap: { marginBottom: spacing.md },
  oorLabel: { fontSize: 13, fontWeight: '700', color: '#C62828', textTransform: 'uppercase', marginBottom: 4 },
  oorSubtitle: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm },
  oorCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surface, borderRadius: 10, padding: spacing.sm, marginBottom: 6, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  oorBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  oorInfo: { flex: 1, paddingLeft: 4 },
  oorTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  oorDate: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  notesWrap: { marginTop: spacing.sm },
  notes: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl },
});
