import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { WeatherData } from '../../../api';
import { loadCalendarData } from '../../../lib/calendarData';
import { loadPassiveForecast } from '../../../lib/weatherSource';
import { itemsForDate, ymd } from '../../../lib/calendar';
import { getHolidays } from '../../../lib/holidays';
import { useCalendarVisibility, useHolidayCalendars, holidayEnabledIds, useCalendarColors } from '../../../lib/calendarPrefs';
import { useCallEventStatus } from '../../../lib/callStatus';
import WeatherIcon from '../../../components/WeatherIcon';
import { EmptyState } from '../../../components/ui';
import { colors, spacing } from '../../../theme';
import { TodayHandle } from '../todayHandle';
import { DayNav, openAllDayItem } from './dayNav';
import { AllDayItem, TimedBlock, addDays, dayHeaderLabel, diffDays, normalizeDay, timeLabel } from './dayViewLayout';

const EXTEND_DAYS = 28;
const INITIAL_SPAN_DAYS = 8 * 7;

type AgendaRow =
  | { type: 'allday'; item: AllDayItem }
  | { type: 'timed'; block: TimedBlock };

type DaySection = {
  date: string;
  title: string;
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
  const scrollTop = useCallback(() => {
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
    for (let i = 0; i <= days; i++) {
      const d = addDays(window.start, i);
      const { allDay, timed } = normalizeDay(itemsForDate(calQ.data, d), holidaysByDate[d] ?? [], d, calColors, status);
      if (!allDay.length && !timed.length) continue;
      const rows: AgendaRow[] = [
        ...allDay.map((item): AgendaRow => ({ type: 'allday', item })),
        ...timed.sort((a, b) => a.startMin - b.startMin).map((block): AgendaRow => ({ type: 'timed', block })),
      ];
      const wx = (weatherOn && weatherQ.data?.forecast?.find((f) => f.date === d)) || null;
      out.push({ date: d, title: dayHeaderLabel(d), wx, data: rows });
    }
    return out;
  }, [calQ.data, window, holidaysByDate, calColors, callStatus, weatherOn, weatherQ.data]);

  // "Load earlier" prepends 4 weeks, then restores the previously-first day so
  // the list doesn't visually jump. This is the one scrollToLocation into
  // possibly-unrendered content, so a failure jumps near the estimate and
  // retries once (see onScrollToIndexFailed).
  const restoreDate = useRef<string | null>(null);
  const retrySection = useRef<number | null>(null);
  const scrollToSection = useCallback((sectionIndex: number, animated: boolean) => {
    retrySection.current = sectionIndex;
    try {
      listRef.current?.scrollToLocation({ sectionIndex, itemIndex: 0, animated, viewOffset: 0 });
    } catch {}
  }, []);
  const loadEarlier = useCallback(() => {
    restoreDate.current = sections[0]?.date ?? window.start;
    setWindow((w) => ({ ...w, start: addDays(w.start, -EXTEND_DAYS) }));
  }, [sections, window.start]);
  useEffect(() => {
    if (!restoreDate.current || !sections.length) return;
    const d = restoreDate.current;
    restoreDate.current = null;
    const idx = sections.findIndex((s) => s.date >= d);
    if (idx > 0) scrollToSection(idx, false);
  }, [sections, scrollToSection]);
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const idx = retrySection.current;
      retrySection.current = null;
      (listRef.current as any)?.getScrollResponder()?.scrollTo({ y: info.index * info.averageItemLength, animated: false });
      if (idx != null) {
        setTimeout(() => {
          try {
            listRef.current?.scrollToLocation({ sectionIndex: idx, itemIndex: 0, animated: false, viewOffset: 0 });
          } catch {}
        }, 120);
      }
    },
    []
  );

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
            {it.muted ? (
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
          <View style={[styles.colorBar, { backgroundColor: b.color }]} />
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

  const renderHeader = useCallback(
    ({ section }: { section: DaySection }) => (
      <View style={styles.header}>
        <Text style={[styles.headerText, section.date === todayStr && styles.headerToday]}>{section.title}</Text>
        {section.wx ? (
          <View style={styles.headerWx}>
            <WeatherIcon code={section.wx.weatherCode} size={16} />
            <Text style={styles.headerWxText}>
              {Math.round(section.wx.tempMax)}°/{Math.round(section.wx.tempMin)}°
            </Text>
          </View>
        ) : null}
      </View>
    ),
    [todayStr]
  );

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
      onScrollToIndexFailed={onScrollToIndexFailed}
      refreshControl={<RefreshControl refreshing={calQ.isRefetching} onRefresh={calQ.refetch} tintColor={colors.textMuted} />}
      ListHeaderComponent={
        <TouchableOpacity style={styles.earlier} onPress={loadEarlier}>
          <Text style={styles.earlierText}>Load earlier</Text>
        </TouchableOpacity>
      }
      contentContainerStyle={styles.content}
      style={styles.list}
    />
  );
});

export default AgendaView;

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 96 },
  earlier: { alignItems: 'center', paddingVertical: spacing.sm },
  earlierText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
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
