import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Dimensions } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { loadCalendarData } from '../../../lib/calendarData';
import { loadPassiveForecast } from '../../../lib/weatherSource';
import { itemsForDate, ymd } from '../../../lib/calendar';
import { getHolidays } from '../../../lib/holidays';
import { useCalendarVisibility, useHolidayCalendars, holidayEnabledIds, useCalendarColors } from '../../../lib/calendarPrefs';
import { useCallEventStatus } from '../../../lib/callStatus';
import { useHorizontalSwipe } from '../../../lib/useHorizontalSwipe';
import { colors, spacing } from '../../../theme';
import { TodayHandle } from '../todayHandle';
import WeekStrip from './WeekStrip';
import AllDayRow from './AllDayRow';
import TimelineGrid from './TimelineGrid';
import { DayLayout, GUTTER, RailMark, addDays, colHeaderLabel, normalizeDay, packLanes, railMarks, singleDayTitle } from './dayViewLayout';

const SCREEN_W = Dimensions.get('window').width;

// Fetch a tight window around the anchor so the aggregate is cheap (carried
// over from the old day screen).
function windowFor(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00');
  const from = new Date(d);
  from.setDate(from.getDate() - 7);
  const to = new Date(d);
  to.setDate(to.getDate() + 7);
  return { from: from.toISOString(), to: to.toISOString() };
}

// The hour-grid day view (Apple's Single Day / Multi Day): week strip, date
// header(s), all-day lane, and the scrollable grid. Single and Multi are the
// same component — `dayCount` just widens the window — so the grid's scroll
// offset survives the mode switch. Horizontal swipes page by the visible day
// count; only the pane below the week strip slides.
const TimelineView = forwardRef<
  TodayHandle,
  {
    anchor: string;
    dayCount: 1 | 2;
    onChangeAnchor: (date: string) => void;
  }
>(function TimelineView({ anchor, dayCount, onChangeAnchor }, ref) {
  const { visibility } = useCalendarVisibility();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { colors: calColors } = useCalendarColors();
  const { cancelledIds, reschedulePendingIds } = useCallEventStatus();

  const gridRef = useRef<TodayHandle>(null);
  useImperativeHandle(ref, () => ({
    scrollToToday: (animated = true) => gridRef.current?.scrollToToday(animated),
  }));

  const dates = useMemo(
    () => (dayCount === 2 ? [anchor, addDays(anchor, 1)] : [anchor]),
    [anchor, dayCount]
  );
  const todayStr = ymd(new Date());
  const todayCol = dates.indexOf(todayStr);

  const range = useMemo(() => windowFor(anchor), [anchor]);
  const calQ = useQuery({
    queryKey: ['calendar', range.from, range.to],
    queryFn: async () => loadCalendarData(range),
    // Keep the previous window on screen while the next loads, so day swipes
    // aren't interrupted by a spinner.
    placeholderData: (prev) => prev,
  });

  // The hourly weather rail follows the Weather calendar's visibility toggle
  // (same gate as the month grid's forecast strip) and the passive forecast
  // source — never prompts for location from here.
  const weatherOn = visibility.weather !== false;
  const weatherQ = useQuery({
    queryKey: ['weather', 'current'],
    queryFn: () => loadPassiveForecast(),
    enabled: weatherOn,
  });
  const wxByDate: RailMark[][] = useMemo(
    () =>
      dates.map((d) =>
        weatherOn ? railMarks(weatherQ.data?.forecast?.find((f) => f.date === d)?.hours) : []
      ),
    [dates, weatherOn, weatherQ.data]
  );

  const holidaysByDate = useMemo(() => {
    const from = new Date(dates[0] + 'T12:00:00');
    const to = new Date(dates[dates.length - 1] + 'T12:00:00');
    const out: Record<string, { id: string; name: string; color: string }[]> = {};
    for (const d of dates) out[d] = [];
    for (const cal of holidayCals) {
      if (visibility[cal.id] === false) continue;
      const color = calColors[cal.id] ?? cal.color;
      for (const h of getHolidays(cal.country, from, to, holidayEnabledIds(cal))) {
        if (out[h.date]) out[h.date].push({ id: `${cal.id}-${h.id}`, name: h.name, color });
      }
    }
    return out;
  }, [dates, holidayCals, visibility, calColors]);

  const layouts: DayLayout[] = useMemo(() => {
    const status = { cancelledIds, reschedulePendingIds };
    return dates.map((d) => {
      const { allDay, timed } = normalizeDay(itemsForDate(calQ.data, d), holidaysByDate[d] ?? [], d, calColors, status);
      return { allDay, blocks: packLanes(timed) };
    });
  }, [dates, calQ.data, holidaysByDate, calColors, cancelledIds, reschedulePendingIds]);

  // Directional slide between day windows, ported from the old day screen:
  // slide out in the swipe direction, swap the anchor, slide back in.
  const tx = useRef(new Animated.Value(0)).current;
  const animating = useRef(false);
  const shiftDays = useCallback(
    (delta: number) => {
      if (animating.current) return;
      animating.current = true;
      const out = delta > 0 ? -SCREEN_W : SCREEN_W;
      Animated.timing(tx, { toValue: out, duration: 160, useNativeDriver: true }).start(() => {
        onChangeAnchor(addDays(anchor, delta));
        tx.setValue(-out);
        Animated.timing(tx, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
          animating.current = false;
        });
      });
    },
    [tx, anchor, onChangeAnchor]
  );
  const swipe = useHorizontalSwipe({
    onSwipeLeft: () => shiftDays(dayCount),
    onSwipeRight: () => shiftDays(-dayCount),
  });

  return (
    <View style={styles.view}>
      <WeekStrip anchor={anchor} dayCount={dayCount} onSelectDate={onChangeAnchor} />
      <Animated.View style={[styles.pane, { transform: [{ translateX: tx }] }]} {...swipe}>
        {dayCount === 1 ? (
          <View style={styles.titleRow}>
            <Text style={[styles.title, anchor === todayStr && styles.titleToday]}>{singleDayTitle(anchor)}</Text>
          </View>
        ) : (
          <View style={styles.colHeads}>
            <View style={{ width: GUTTER }} />
            {dates.map((d) => (
              <Text key={d} style={[styles.colHead, d === todayStr && styles.titleToday]}>
                {colHeaderLabel(d)}
              </Text>
            ))}
          </View>
        )}
        <AllDayRow days={dates.map((d, i) => ({ date: d, items: layouts[i].allDay }))} />
        <TimelineGrid
          ref={gridRef}
          dates={dates}
          blocksByDate={layouts.map((l) => l.blocks)}
          wxByDate={wxByDate}
          todayCol={todayCol >= 0 ? todayCol : null}
          dataReady={calQ.data !== undefined}
        />
      </Animated.View>
    </View>
  );
});

export default TimelineView;

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: colors.background },
  pane: { flex: 1, backgroundColor: colors.background },
  titleRow: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 16, fontWeight: '700', color: colors.text },
  titleToday: { color: colors.primary },
  colHeads: {
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  colHead: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '700', color: colors.text },
});
