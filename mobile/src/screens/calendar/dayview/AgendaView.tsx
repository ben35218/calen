import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { Text } from '../../../components/Text';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { WeatherData } from '../../../api';
import { loadCalendarData } from '../../../lib/calendarData';
import { loadPassiveForecast } from '../../../lib/weatherSource';
import { itemsForDate, visibleDayItems, ymd } from '../../../lib/calendar';
import { getHolidays } from '../../../lib/holidays';
import { useCalendarVisibility, useHolidayCalendars, holidayEnabledIds, useCalendarColors } from '../../../lib/calendarPrefs';
import { useCallEventStatus } from '../../../lib/callStatus';
import { mdiName } from '../../../lib/recurrence';
import WeatherIcon from '../../../components/WeatherIcon';
import { EmptyState, SkeletonList } from '../../../components/ui';
import { colors, spacing } from '../../../theme';
import { TodayHandle } from '../todayHandle';
import { DayNav, openAllDayItem } from './dayNav';
import { AllDayItem, EVENT_ICON, TimedBlock, addDays, dayHeaderLabel, diffDays, normalizeDay, timeLabel } from './dayViewLayout';

const EXTEND_DAYS = 28;
const INITIAL_SPAN_DAYS = 8 * 7;
// Scrolling within this many px of the top prepends the previous stretch.
const EARLIER_THRESHOLD = 80;

type AgendaRow =
  | { type: 'allday'; item: AllDayItem }
  | { type: 'timed'; block: TimedBlock };

type DaySection = {
  date: string;
  title: string;
  isToday: boolean;
  wx: WeatherData['forecast'][number] | null;
  data: AgendaRow[];
};

// List mode: a continuous agenda grouped by day (only days with items),
// sticky day headers with today's in the primary colour, timed events with
// stacked start/end times, and muted circle rows for date-only tasks/chores.
// The window STARTS at the anchor day — the anchor (and so Today, which
// re-anchors) is always the top of the list, never a scroll target into
// unrendered sections (SectionList can't reliably scrollToLocation that far).
// Extends forward on end-reach; earlier days load behind an explicit button.
const AgendaView = forwardRef<TodayHandle, { anchor: string }>(function AgendaView({ anchor }, ref) {
  const navigation = useNavigation<DayNav>();
  const { visibility } = useCalendarVisibility();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { colors: calColors } = useCalendarColors();
  const callStatus = useCallEventStatus();

  const [window, setWindow] = useState(() => ({
    start: anchor,
    end: addDays(anchor, INITIAL_SPAN_DAYS),
  }));

  const listRef = useRef<SectionList<AgendaRow, DaySection>>(null);
  // Armed only once the user drags, so the programmatic scroll-to-top below
  // (anchor reset / Today) — which lands within EARLIER_THRESHOLD — can't itself
  // trigger a prepend before the user has actually scrolled up.
  const userDragging = useRef(false);
  const scrollTop = useCallback(() => {
    userDragging.current = false;
    (listRef.current as any)?.getScrollResponder()?.scrollTo({ y: 0, animated: false });
  }, []);

  // A new anchor (day swipe in a timeline mode, week-strip tap, Today)
  // restarts the window at that day, so it's simply the top of the list.
  const lastAnchor = useRef(anchor);
  useEffect(() => {
    if (lastAnchor.current === anchor) return;
    lastAnchor.current = anchor;
    setWindow({ start: anchor, end: addDays(anchor, INITIAL_SPAN_DAYS) });
    scrollTop();
  }, [anchor, scrollTop]);

  useImperativeHandle(ref, () => ({
    // The host re-anchors to today alongside this call; handle the
    // already-anchored-on-today case (and any prior forward-extension) here.
    scrollToToday: () => {
      const today = ymd(new Date());
      setWindow({ start: today, end: addDays(today, INITIAL_SPAN_DAYS) });
      scrollTop();
    },
  }));

  const range = useMemo(
    () => ({
      from: new Date(window.start + 'T00:00:00').toISOString(),
      to: new Date(window.end + 'T23:59:59').toISOString(),
    }),
    [window]
  );
  const calQ = useQuery({
    queryKey: ['calendar', range.from, range.to],
    // background sync: paint from the replica; the server pull revalidates behind it.
    queryFn: async () => loadCalendarData({ ...range, sync: 'background' }),
    placeholderData: (prev) => prev,
  });
  // The header weather glance follows the Weather calendar's visibility
  // toggle, like every other calendar weather surface.
  const weatherOn = visibility.weather !== false;
  const weatherQ = useQuery({
    queryKey: ['weather', 'current'],
    queryFn: () => loadPassiveForecast(),
    enabled: weatherOn,
  });

  const todayStr = ymd(new Date());
  const visible = useCallback((id: string) => visibility[id] !== false, [visibility]);

  const holidaysByDate = useMemo(() => {
    const from = new Date(window.start + 'T12:00:00');
    const to = new Date(window.end + 'T12:00:00');
    const out: Record<string, { id: string; name: string; color: string }[]> = {};
    for (const cal of holidayCals) {
      if (visibility[cal.id] === false) continue;
      const color = calColors[cal.id] ?? cal.color;
      for (const h of getHolidays(cal.country, from, to, holidayEnabledIds(cal))) {
        (out[h.date] ??= []).push({ id: `${cal.id}-${h.id}`, name: h.name, color });
      }
    }
    return out;
  }, [window, holidayCals, visibility, calColors]);

  const sections: DaySection[] = useMemo(() => {
    if (!calQ.data) return [];
    const status = callStatus;
    const out: DaySection[] = [];
    const days = diffDays(window.start, window.end);
    // Today always gets a section when it falls in the window — even with no
    // items — so the "Today" marker anchors the list, matching the Occasions
    // view. An empty window (no item days at all) drops it so the EmptyState
    // shows through instead.
    let hasItems = false;
    for (let i = 0; i <= days; i++) {
      const d = addDays(window.start, i);
      // Hidden calendars drop out here, so a toggled-off calendar contributes
      // no rows (and no day section of its own) to the agenda.
      const items = visibleDayItems(itemsForDate(calQ.data, d), visible);
      const { allDay, timed } = normalizeDay(items, holidaysByDate[d] ?? [], d, calColors, status);
      const isToday = d === todayStr;
      if (!allDay.length && !timed.length && !isToday) continue;
      if (allDay.length || timed.length) hasItems = true;
      const rows: AgendaRow[] = [
        ...allDay.map((item): AgendaRow => ({ type: 'allday', item })),
        ...timed.sort((a, b) => a.startMin - b.startMin).map((block): AgendaRow => ({ type: 'timed', block })),
      ];
      const wx = (weatherOn && weatherQ.data?.forecast?.find((f) => f.date === d)) || null;
      out.push({ date: d, title: dayHeaderLabel(d), isToday, wx, data: rows });
    }
    return hasItems ? out : [];
  }, [calQ.data, window, holidaysByDate, calColors, callStatus, visible, weatherOn, weatherQ.data, todayStr]);

  // Infinite scroll upward: reaching the top prepends the previous stretch.
  // `maintainVisibleContentPosition` anchors the visible day so the inserted
  // content grows above the viewport without a jump (needs the new
  // architecture, on by default here) — no scroll-restore dance required.
  // `loadingEarlier` guards against re-firing before the window state settles;
  // it clears once `window.start` actually moves.
  const loadingEarlier = useRef(false);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!userDragging.current || loadingEarlier.current) return;
    if (e.nativeEvent.contentOffset.y > EARLIER_THRESHOLD) return;
    loadingEarlier.current = true;
    setEarlierLoading(true);
    setWindow((w) => ({ ...w, start: addDays(w.start, -EXTEND_DAYS) }));
  }, []);
  useEffect(() => {
    loadingEarlier.current = false;
    setEarlierLoading(false);
  }, [window.start]);

  const renderRow = useCallback(
    ({ item, section }: { item: AgendaRow; section: DaySection }) => {
      if (item.type === 'allday') {
        const it = item.item;
        return (
          <TouchableOpacity
            style={[styles.row, it.faded && styles.rowFaded]}
            activeOpacity={0.7}
            onPress={() => openAllDayItem(navigation, it, section.date)}
          >
            {it.icon ? (
              <MaterialCommunityIcons name={mdiName(it.icon) as any} size={22} color={it.color} style={styles.circle} />
            ) : it.muted ? (
              <Ionicons name="ellipse-outline" size={22} color={colors.textMuted} style={styles.circle} />
            ) : (
              <View style={[styles.colorBar, { backgroundColor: it.color }]} />
            )}
            <View style={styles.rowBody}>
              <Text
                style={[styles.rowTitle, it.muted && styles.rowTitleMuted, it.strike && styles.strike]}
                numberOfLines={1}
              >
                {it.title}
              </Text>
            </View>
            <Text style={styles.allDayTime}>all-day</Text>
          </TouchableOpacity>
        );
      }
      const b = item.block;
      return (
        <TouchableOpacity
          style={[styles.row, b.faded && styles.rowFaded]}
          activeOpacity={0.7}
          onPress={() => navigation.navigate('EventDetail', { eventId: b.eventId, date: section.date })}
        >
          <MaterialCommunityIcons name={EVENT_ICON as any} size={22} color={b.color} style={styles.circle} />
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, b.strike && styles.strike]} numberOfLines={1}>{b.title}</Text>
            {b.location ? (
              <View style={styles.locRow}>
                <Ionicons name="navigate-outline" size={12} color={colors.textMuted} />
                <Text style={styles.loc} numberOfLines={1}>{b.location}</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.times}>
            <Text style={styles.timeStart}>{timeLabel(b.startMin)}</Text>
            <Text style={styles.timeEnd}>{timeLabel(b.endMin)}</Text>
          </View>
        </TouchableOpacity>
      );
    },
    [navigation]
  );

  const renderHeader = useCallback(({ section }: { section: DaySection }) => {
    const wx = section.wx ? (
      <View style={styles.headerWx}>
        <WeatherIcon code={section.wx.weatherCode} size={16} />
        <Text style={styles.headerWxText}>
          {Math.round(section.wx.tempMax)}°/{Math.round(section.wx.tempMin)}°
        </Text>
      </View>
    ) : null;
    if (section.isToday) {
      // A "Today" divider marker (accent lines + label) above today's header,
      // mirroring the Occasions view's today marker.
      return (
        <View style={styles.todayHeaderWrap}>
          <View style={styles.todayMarker}>
            <View style={styles.todayLine} />
            <Text style={styles.todayMarkerText}>Today</Text>
            <View style={styles.todayLine} />
          </View>
          <View style={styles.todayHeaderRow}>
            <Text style={[styles.headerText, styles.headerToday]}>{section.title}</Text>
            {wx}
          </View>
        </View>
      );
    }
    return (
      <View style={styles.header}>
        <Text style={styles.headerText}>{section.title}</Text>
        {wx}
      </View>
    );
  }, []);

  if (calQ.data && !sections.length) {
    return (
      <EmptyState
        icon="calendar-outline"
        title="Nothing scheduled"
        message="Events, tasks, and chores in this stretch will show up here."
      />
    );
  }

  return (
    <SectionList
      ref={listRef}
      sections={sections}
      keyExtractor={(row) => (row.type === 'allday' ? `a-${row.item.key}` : `t-${row.block.key}`)}
      renderItem={renderRow}
      renderSectionHeader={renderHeader}
      stickySectionHeadersEnabled
      onEndReachedThreshold={0.6}
      onEndReached={() => setWindow((w) => ({ ...w, end: addDays(w.end, EXTEND_DAYS) }))}
      onScroll={onScroll}
      onScrollBeginDrag={() => { userDragging.current = true; }}
      scrollEventThrottle={16}
      maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      refreshControl={<RefreshControl refreshing={calQ.isRefetching} onRefresh={calQ.refetch} tintColor={colors.textMuted} />}
      ListHeaderComponent={
        <View style={styles.earlier}>{earlierLoading ? <ActivityIndicator color={colors.textMuted} /> : null}</View>
      }
      // First-ever load with an empty replica: calQ.data is still undefined, so
      // sections is [] and the list would paint blank — skeleton rows until the
      // pull lands. Loaded-but-empty returns the EmptyState above instead.
      ListEmptyComponent={!calQ.data ? <SkeletonList /> : null}
      contentContainerStyle={styles.content}
      style={styles.list}
    />
  );
});

export default AgendaView;

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 96 },
  // Fixed height so toggling the spinner never shifts content under
  // maintainVisibleContentPosition.
  earlier: { height: 40, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerText: { fontSize: 17, fontWeight: '700', color: colors.text },
  headerToday: { color: colors.primary },
  todayHeaderWrap: {
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  todayMarker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  todayLine: { flex: 1, height: 1, backgroundColor: colors.primary, opacity: 0.35 },
  todayMarkerText: { fontSize: 11, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.5 },
  todayHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
  },
  headerWx: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerWxText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  rowFaded: { opacity: 0.5 },
  colorBar: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginRight: spacing.sm },
  circle: { marginRight: spacing.sm },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  rowTitleMuted: { color: colors.textMuted, fontWeight: '500' },
  strike: { textDecorationLine: 'line-through' },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  loc: { fontSize: 13, color: colors.textMuted, flexShrink: 1 },
  times: { alignItems: 'flex-end', marginLeft: spacing.sm },
  timeStart: { fontSize: 14, fontWeight: '600', color: colors.text },
  timeEnd: { fontSize: 14, color: colors.textMuted, marginTop: 1 },
  allDayTime: { fontSize: 14, color: colors.textMuted, marginLeft: spacing.sm },
});
