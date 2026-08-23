import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import type { KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';
import { useQuery } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackHeaderItem } from '@react-navigation/native-stack';
import { loadWeatherForAddress, loadDailyClimate, buildTripWeather, geocodePlace } from '@household/weather';
import { tripsApi, Trip, TripItem } from '../../api';
import { Card, Divider, Hint, RoundIconButton, SectionHeader, SkeletonDetail, glassHeaderItems } from '../../components/ui';
import { vividOnDark } from '../../lib/color';
import WeatherIcon from '../../components/WeatherIcon';
import { weatherCardColors } from '../../lib/weatherTheme';
import HourlyForecast from '../../components/HourlyForecast';
import { tripTypeMeta } from '../../lib/tripTypes';
import { outfitSuggestion } from '../../lib/outfit';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { zonedParts, zonedTimeLabel } from '../../lib/tz';
import TripTimeline from '../../components/TripTimeline';
import AssistantButton from '../../components/AssistantButton';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { fetchTripDetail } from '../../lib/tripData';
import { lodgingCoveringDate, lodgingCheckins, lodgingCheckouts } from '../../lib/tripLodging';
import { useHorizontalSwipe } from '../../lib/useHorizontalSwipe';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<TripsStackParamList, 'TripDetail'>;
type Rt = RouteProp<TripsStackParamList, 'TripDetail'>;

const todayStr = new Date().toISOString().slice(0, 10);
// Last date the 7-day destination forecast can cover (today + 6).
const forecastHorizon = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

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
  const { id, date: focusDate, focus } = useRoute<Rt>().params;
  const [dayIndex, setDayIndex] = useState<number | null>(null); // null = grid view
  const [expandedType, setExpandedType] = useState<string | null>(null); // budget category drill-down
  const [showUncosted, setShowUncosted] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false); // overview weather card, collapsed by default

  // The shared decrypting fetcher (lib/tripData): everything this screen shows —
  // the trip name in the header, each booking's title and location on the day
  // timeline — is sealed content, so the fetched row has to be opened before it
  // can be rendered.
  const tripQ = useQuery({ queryKey: ['trips', id], queryFn: () => fetchTripDetail(id) });
  const budgetQ = useQuery({ queryKey: ['trips', id, 'budget'], queryFn: async () => (await tripsApi.budget(id)).data });
  // GET /trips/:id returns { trip, items, isOwner }; flatten into a single Trip-with-items.
  const data = tripQ.data;
  const trip = data ? { ...data.trip, items: data.items } : undefined;
  const tz = trip?.destinationTz || '';

  const dayList = useMemo(() => {
    if (!trip) return [];
    let start = trip.startDate;
    let end = trip.endDate || trip.startDate;
    if (!start && trip.items?.length) {
      const ds = trip.items.map((i) => new Date(i.start).getTime());
      start = new Date(Math.min(...ds)).toISOString();
      end = new Date(Math.max(...trip.items.map((i) => new Date(i.end || i.start).getTime()))).toISOString();
    }
    if (!start) return [];
    return eachDay(start.slice(0, 10), (end || start).slice(0, 10));
  }, [trip]);

  // A month-grid tap on a trip bar carries the tapped day, so the screen lands
  // straight on that day's itinerary. Seeded once per param value (the day list
  // arrives with the trip query), so the back-to-overview chevron sticks; a
  // date outside the trip's range just leaves the overview up.
  const focusConsumedRef = useRef<string | null>(null);
  // The day that must open at the TOP of its scroll rather than at its first
  // booking — the entry came from a weather surface (`focus: 'weather'`), so
  // what was tapped was that day's forecast segment and the forecast card is
  // the first thing on the day. Held by DATE and seeded at mount, straight off
  // the route param: an index seeded from the focus effect loses a race the
  // moment the trip query answers from cache (both effects then run in the
  // mount commit, and the clearing one below still sees `dayIndex === null`
  // and wipes the hold before the day is even on screen).
  const topDateRef = useRef<string | null>(focus === 'weather' && focusDate ? focusDate : null);
  useEffect(() => {
    if (!focusDate || focusDate === focusConsumedRef.current || !dayList.length) return;
    focusConsumedRef.current = focusDate;
    const i = dayList.indexOf(focusDate);
    if (i >= 0) {
      setDayIndex(i);
      // Re-entry with fresh params (a second weather tap on this same screen).
      if (focus === 'weather') topDateRef.current = focusDate;
    }
  }, [focusDate, focus, dayList]);
  // Once the reader pages off that day, the hold is spent — every day after it
  // (including coming back) anchors on its itinerary like any other. Comparing
  // dates, not indexes, so the null day (the overview, before the seed lands)
  // can never read as "paged away".
  useEffect(() => {
    const cur = dayIndex != null ? dayList[dayIndex] : null;
    if (topDateRef.current && cur && cur !== topDateRef.current) topDateRef.current = null;
  }, [dayIndex, dayList]);

  // Destination weather, fetched client-direct from open-meteo (keyless) like
  // home weather in §9.1 P5b — the destination never touches our server.
  const destination = trip?.destination;
  const tripFrom = dayList[0];
  const tripTo = dayList[dayList.length - 1];

  // The day itinerary's grid is a full 24 hours tall, so a day would otherwise
  // open at midnight. The timeline reports where the day should sit (its first
  // booking, the now-line on today, else 8 AM) and the wrapper reports where the
  // grid starts in this scroll view; whichever lands second does the jump.
  const dayScrollRef = useRef<KeyboardAwareScrollViewRef>(null);
  const timelineYRef = useRef<number | null>(null);
  const pendingOffset = useRef<number | null>(null);
  const dayScrolledByHand = useRef(false);
  // Re-applied while the anchor still holds — not consumed on the first try.
  // The cards above the grid settle late (the forecast card arrives with its
  // query, the hourly strip with its image), and each of those moves the grid
  // down: an anchor computed against the earlier measurement lands too far and
  // clips the top of the first booking. So the wrapper re-reports its position
  // whenever it moves, and the day re-anchors — until the reader scrolls, at
  // which point the position is theirs and we never touch it again.
  const applyDayScroll = () => {
    if (dayScrolledByHand.current) return;
    // A weather entry owns this day's position, and holds it ACTIVELY: the
    // forecast card arrives with its query and pushes everything under it, so
    // "leave the scroll alone" isn't enough — each re-report re-asserts the top
    // until the reader takes the position for themselves.
    const cur = dayIndex != null ? dayList[dayIndex] : null;
    if (topDateRef.current && cur && topDateRef.current === cur) {
      requestAnimationFrame(() => dayScrollRef.current?.scrollTo({ y: 0, animated: false }));
      return;
    }
    if (timelineYRef.current == null || pendingOffset.current == null) return;
    const y = Math.max(0, timelineYRef.current + pendingOffset.current);
    requestAnimationFrame(() => dayScrollRef.current?.scrollTo({ y, animated: false }));
  };

  // Swipe left → next day, right → previous day, clamped to the trip's range.
  // Called unconditionally (hooks rule); only wired into the day-itinerary view.
  const daySwipe = useHorizontalSwipe({
    onSwipeLeft: () => setDayIndex((i) => Math.min((i ?? 0) + 1, dayList.length - 1)),
    onSwipeRight: () => setDayIndex((i) => Math.max((i ?? 0) - 1, 0)),
  });
  // 7-day forecast for the destination — feeds the day itinerary view and the
  // overview weather card. Only fetched when the trip's dates can actually
  // intersect the forecast window (today..today+6): a far-future or finished
  // trip can't use a forecast, so it doesn't ask for one.
  const forecastQ = useQuery({
    queryKey: ['tripWeather', destination],
    queryFn: () => loadWeatherForAddress(destination!, { geocoder: geocodePlace }),
    enabled: !!destination && !!tripFrom && tripFrom <= forecastHorizon && tripTo >= todayStr,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  // Historic per-day averages for the trip dates (past 3 years) — the fallback
  // for days the forecast can't reach. Skipped when the whole trip fits inside
  // the forecast window: every day gets a real forecast, no averages needed.
  const climateQ = useQuery({
    queryKey: ['tripClimate', destination, tripFrom, tripTo],
    queryFn: () => loadDailyClimate(destination!, tripFrom, tripTo, { geocoder: geocodePlace }),
    enabled: !!destination && !!tripFrom && !(tripFrom >= todayStr && tripTo <= forecastHorizon),
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
  // Overview weather rows: one per trip day, the real forecast winning any date
  // it covers, the 3-year average standing in elsewhere — each row tagged with
  // its source so an average is never dressed as a forecast. Renders
  // progressively: whichever query lands first paints, the other upgrades rows
  // in place.
  const tripWeather = useMemo(
    () => buildTripWeather({ forecast: forecastQ.data?.forecast, climateDays: climateQ.data?.days, dates: dayList }),
    [forecastQ.data, climateQ.data, dayList],
  );
  const hasForecastRows = tripWeather.some((r) => r.source === 'forecast');
  const hasTypicalRows = tripWeather.some((r) => r.source === 'typical');
  // A forecast for an imminent trip is packing-actionable, so the card opens
  // itself once when one arrives; far-future averages stay folded. Closing it
  // by hand sticks — the effect only fires when `hasForecastRows` flips on.
  useEffect(() => {
    if (hasForecastRows) setWeatherOpen(true);
  }, [hasForecastRows]);

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
    lodgingCoveringDate(trip?.items ?? [], dateStr, tz).length > 0;

  useLayoutEffect(() => {
    const targetDate = dayIndex != null ? dayList[dayIndex] : (dayList[0] ?? undefined);
    navigation.setOptions({
      headerStyle: { backgroundColor: colors.background },
      headerShadowVisible: false,
      headerTintColor: '#fff',
      title: trip?.name || 'Trip',
      headerLeft: dayIndex != null
        ? () => (
            <TouchableOpacity onPress={() => setDayIndex(null)} style={styles.headerBtn} hitSlop={8}>
              <Ionicons name="chevron-back" size={26} color="#fff" />
            </TouchableOpacity>
          )
        : undefined,
      // The trip view's header holds one action, the add-booking disc: editing
      // the trip's own details is the ⓘ on its row in the trips list (the
      // calendars-screen pattern), so this screen is purely the itinerary.
      headerRight: () => (
        <RoundIconButton
          icon="add"
          onPress={() => navigation.navigate('TripItemForm', { tripId: id, date: targetDate })}
          bg={accent}
        />
      ),
      // Under glass the add is a prominent accent-filled "+" native bar-button
      // item (same rule as headerAddOptions); the custom headerRight above
      // backs Android/pre-26.
      ...(glassHeaderItems
        ? {
            unstable_headerRightItems: (): NativeStackHeaderItem[] => [
              {
                type: 'button',
                label: 'Add',
                icon: { type: 'sfSymbol', name: 'plus' },
                variant: 'prominent',
                tintColor: vividOnDark(accent),
                accessibilityLabel: 'Add booking',
                onPress: () => navigation.navigate('TripItemForm', { tripId: id, date: targetDate }),
              },
            ],
          }
        : null),
    });
  }, [navigation, id, trip?.name, dayIndex, dayList]);

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
    const lodgingForDay = lodgingCoveringDate(allItems, selectedDate, tz);
    const lodgingNote = (h: TripItem) => {
      const ci = zonedParts(h.start, tz).dateStr;
      const co = zonedParts(h.end || h.start, tz).dateStr;
      // An all-day hotel has no check-in/out clock to name — the day alone.
      if (selectedDate === ci) return h.allDay ? 'Check in' : `Check in ${zonedTimeLabel(h.start, tz)}`;
      if (selectedDate === co) return h.allDay ? 'Check out' : `Check out ${zonedTimeLabel(h.end || h.start, tz)}`;
      return 'Overnight';
    };
    // All-day (non-hotel) bookings covering this day: they have no hour to sit
    // at on the grid, so they ride above it as banner rows, the way the
    // night's lodging does. Hotels stay out — the lodging banner is theirs.
    const allDayForDay = allItems.filter((it) => {
      if (it.type === 'hotel' || !it.allDay) return false;
      const from = zonedParts(it.start, tz).dateStr;
      const to = zonedParts(it.end || it.start, tz).dateStr;
      return selectedDate >= from && selectedDate <= to;
    });
    // Non-hotel TIMED bookings that land on this day (drives the timeline vs
    // empty state) — all-day ones are the banner strip's, not the grid's.
    const timedItems = allItems.filter((it) => {
      if (it.type === 'hotel' || it.allDay) return false;
      const d = it.details as any;
      if ((it.type === 'flight' || it.type === 'transit') && (d?.departureTz || d?.arrivalTz)) {
        if (zonedParts(it.start, d.departureTz).dateStr === selectedDate) return true;
        if (it.end && zonedParts(it.end, d.arrivalTz).dateStr === selectedDate) return true;
        return false;
      }
      return zonedParts(it.start, tz).dateStr === selectedDate;
    });
    // A check-in/check-out block or an all-day banner means the day isn't empty either.
    const dayIsEmpty =
      timedItems.length === 0 &&
      allDayForDay.length === 0 &&
      lodgingCheckins(allItems, selectedDate, tz).length === 0 &&
      lodgingCheckouts(allItems, selectedDate, tz).length === 0;
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
        <KeyboardAwareScrollView
          ref={dayScrollRef}
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          // The first drag hands the position to the reader for this day.
          onScrollBeginDrag={() => { dayScrolledByHand.current = true; }}
        >
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
          {/* The night's lodging is a booking like any other on this day, so it
              answers the grid's gestures: tap to read it, hold to edit. The
              pencil stays as the visible edit affordance. */}
          {lodgingForDay.map((h) => (
            <TouchableOpacity
              key={`lodge-${h._id}`}
              style={styles.lodgeBanner}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('TripItemDetail', { tripId: id, itemId: h._id, date: selectedDate })}
              onLongPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: h._id, date: selectedDate })}
            >
              <MaterialCommunityIcons name="bed" size={18} color="#6A1B9A" />
              <Text style={styles.lodgeTitle}>{h.title}</Text>
              <Text style={styles.lodgeNote}>{lodgingNote(h)}</Text>
              <TouchableOpacity onPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: h._id, date: selectedDate })}>
                <Ionicons name="pencil" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
          {/* All-day bookings ride above the grid as the lodging does — same
              banner, same gestures (tap to read, hold to edit) — because a
              date-only booking has no hour for the grid to draw. */}
          {allDayForDay.map((b) => (
            <TouchableOpacity
              key={`allday-${b._id}`}
              style={styles.lodgeBanner}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('TripItemDetail', { tripId: id, itemId: b._id, date: selectedDate })}
              onLongPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: b._id, date: selectedDate })}
            >
              <MaterialCommunityIcons name={tripTypeMeta(b.type).icon as any} size={18} color={tripTypeMeta(b.type).color} />
              <Text style={styles.lodgeTitle}>{b.title?.trim() || tripTypeMeta(b.type).label}</Text>
              <Text style={styles.lodgeNote}>All day</Text>
              <TouchableOpacity onPress={() => navigation.navigate('TripItemForm', { tripId: id, itemId: b._id, date: selectedDate })}>
                <Ionicons name="pencil" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
          {/* The grid is always there, booked or not: an empty day is the one
              you most need to press-and-hold on to add the first thing to it. */}
          {dayIsEmpty ? (
            <Hint>Nothing booked this day — press and hold a time to add a booking.</Hint>
          ) : null}
          <View onLayout={(e) => { timelineYRef.current = e.nativeEvent.layout.y; applyDayScroll(); }}>
            <TripTimeline
              items={trip.items ?? []}
              selectedDate={selectedDate}
              tz={tz}
              accent={accent}
              onOpenItem={(itemId) => navigation.navigate('TripItemDetail', { tripId: id, itemId, date: selectedDate })}
              onEditItem={(itemId) => navigation.navigate('TripItemForm', { tripId: id, itemId, date: selectedDate })}
              onCreateAt={(prefill) => navigation.navigate('TripItemForm', { tripId: id, date: selectedDate, prefill })}
              // Reported once per day — a new day is a new anchor, and gets to
              // place itself even if the reader scrolled the previous one.
              onInitialScroll={(y) => {
                pendingOffset.current = y;
                dayScrolledByHand.current = false;
                applyDayScroll();
              }}
            />
          </View>
        </KeyboardAwareScrollView>
        {aiEnabled && (
          <AssistantButton
            style={styles.assistantFab}
            onPress={() => navigation.navigate('TripAssistant', { tripId: id, tripName: trip?.name })}
          />
        )}
      </View>
    );
  }

  // ── Grid (calendar) view ──
  return (
    <View style={styles.screen}>
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {/* Destination weather: the real forecast for trip days inside the
            7-day window, 3-year averages for the rest (buildTripWeather's
            forecast-wins merge). An average never wears a condition icon —
            only a forecast asserts one. */}
        {tripWeather.length ? (
          <Card style={styles.weatherCard}>
            <TouchableOpacity style={styles.weatherHeader} onPress={() => setWeatherOpen((v) => !v)} activeOpacity={0.7}>
              <Ionicons name="partly-sunny" size={16} color="rgba(255,255,255,0.8)" />
              <Text style={styles.weatherHeaderText}>
                {hasForecastRows ? 'WEATHER' : 'TYPICAL WEATHER'} · {trip.destination?.toUpperCase()}
              </Text>
              <Ionicons name={weatherOpen ? 'chevron-up' : 'chevron-down'} size={16} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
            {weatherOpen && !hasForecastRows ? (
              <Text style={styles.weatherCaption}>Averages for these dates over the past 3 years</Text>
            ) : null}
            {weatherOpen && hasForecastRows && !hasTypicalRows ? (
              <Text style={styles.weatherCaption}>Forecast for your trip dates</Text>
            ) : null}
            {weatherOpen && tripWeather.map((row, idx) => {
              const prev = idx > 0 ? tripWeather[idx - 1] : null;
              // A mixed card labels each source segment, so the line between
              // prediction and average is never implicit.
              const eyebrow = hasForecastRows && hasTypicalRows && (!prev || prev.source !== row.source)
                ? (row.source === 'forecast' ? 'FORECAST' : 'TYPICAL · 3-YEAR AVERAGE')
                : null;
              const dateLabel = new Date(row.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
              return (
                <View key={row.date}>
                  {eyebrow ? <Text style={styles.weatherEyebrow}>{eyebrow}</Text> : null}
                  {row.source === 'forecast' ? (
                    <View style={styles.climateRow}>
                      <Text style={styles.climateDate}>{dateLabel}</Text>
                      <View style={styles.climateTemp}>
                        <WeatherIcon code={row.day.weatherCode} size={18} />
                        <Text style={styles.climateHigh}>{Math.round(row.day.tempMax)}°</Text>
                        <Text style={styles.climateLow}>/ {Math.round(row.day.tempMin)}°</Text>
                      </View>
                      <View style={styles.climatePrecip}>
                        <MaterialCommunityIcons
                          name="water"
                          size={14}
                          color={row.day.precipProbability >= 50 ? '#9BD1FF' : row.day.precipProbability >= 20 ? '#CFE8FF' : 'rgba(255,255,255,0.5)'}
                        />
                        <Text style={styles.climatePrecipText}>{row.day.precipProbability > 0 ? `${row.day.precipProbability}%` : '—'}</Text>
                      </View>
                    </View>
                  ) : (
                    <View style={styles.climateRow}>
                      <Text style={styles.climateDate}>{dateLabel}</Text>
                      <View style={styles.climateTemp}>
                        <MaterialCommunityIcons name="thermometer-high" size={14} color="#EF6C00" />
                        <Text style={styles.climateHigh}>{row.climate.avgTempMax != null ? `${row.climate.avgTempMax}°` : '—'}</Text>
                        <Text style={styles.climateLow}>/ {row.climate.avgTempMin != null ? `${row.climate.avgTempMin}°` : '—'}</Text>
                      </View>
                      <View style={styles.climatePrecip}>
                        <MaterialCommunityIcons
                          name="water"
                          size={14}
                          color={(row.climate.avgPrecip ?? 0) > 5 ? '#9BD1FF' : (row.climate.avgPrecip ?? 0) > 1 ? '#CFE8FF' : 'rgba(255,255,255,0.5)'}
                        />
                        <Text style={styles.climatePrecipText}>{row.climate.avgPrecip != null ? `${row.climate.avgPrecip} mm` : '—'}</Text>
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
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
        <AssistantButton
          style={styles.assistantFab}
          onPress={() => navigation.navigate('TripAssistant', { tripId: id, tripName: trip?.name })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: 96 },
  // Same corner the accent-filled Fab held (ui.tsx `fab` geometry); the disc
  // itself is now the calendar's AssistantButton, which brings its own size.
  assistantFab: { position: 'absolute', right: spacing.lg, bottom: spacing.lg },
  headerBtn: { paddingHorizontal: 5 },
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
  weatherEyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: 'rgba(255,255,255,0.65)', marginTop: spacing.sm, marginBottom: 2 },
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
