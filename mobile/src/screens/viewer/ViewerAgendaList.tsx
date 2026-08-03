import React, { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, SectionList, RefreshControl, type ViewToken } from 'react-native';
import { CardRow, EmptyState, SkeletonList } from '../../components/ui';
import type { CalendarEvent } from '../../api';
import type { CustomCalendar } from '../../lib/calendarPrefs';
import type { YearMonth } from '../../lib/calendarWindow';
import type { TodayHandle } from '../calendar/todayHandle';
import type { ViewerEventSnapshot } from '../../navigation/types';
import { ymd } from '../../lib/calendar';
import { calendarColor, eventDate, snapshotOf } from './shared';
import { colors, spacing } from '../../theme';

// Free viewer mode's list layer — the upcoming-events agenda the shell used to
// be, now one of two views behind the shell's view menu (billing-plans.md →
// "Free viewer mode"). Day-grouped, read-only, shared calendars only, and
// anchored by the same "Today" marker as the app's own agenda (the day
// screen's List mode — see dayview/AgendaView).

type Section = { date: string; title: string; isToday: boolean; data: CalendarEvent[] };

// Beyond "Today", the agenda answers a month pick from the shared header
// button — reporting false when that month lies outside its rolling window, so
// the host can hand the jump to the grid instead.
export type ViewerAgendaHandle = TodayHandle & { scrollToMonth: (m: YearMonth) => boolean };

// "Monday – Aug 3", matching AgendaView's day headers.
function dayHeading(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} – ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function timeLabel(e: CalendarEvent): string {
  if (e.allDay !== false) return 'All day';
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const start = new Date(e.startDate);
  const end = e.endDate ? new Date(e.endDate) : null;
  return `${fmt(start)}${end ? ` – ${fmt(end)}` : ''}`;
}

const ViewerAgendaList = forwardRef<ViewerAgendaHandle, {
  // Already filtered to the shared calendars and sorted by start.
  events: CalendarEvent[];
  calendars: CustomCalendar[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenEvent: (e: ViewerEventSnapshot, calendarId?: string) => void;
  // The shell's shared-calendar list + waiting/locked hints.
  header: React.ReactNode;
  // Reported as the list scrolls, so the shared header button labels itself
  // with the month actually on screen.
  onViewedMonth?: (m: YearMonth) => void;
  // Room the host's floating chrome needs at either end.
  topPad: number;
  bottomPad: number;
}>(function ViewerAgendaList(
  { events, calendars, loading, refreshing, onRefresh, onOpenEvent, header, onViewedMonth, topPad, bottomPad },
  ref,
) {
  const listRef = useRef<SectionList<CalendarEvent>>(null);

  const sections: Section[] = useMemo(() => {
    const todayStr = ymd(new Date());
    const byDay = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const day = eventDate(e, e.startDate);
      const arr = byDay.get(day) || [];
      arr.push(e);
      byDay.set(day, arr);
    }
    // Today always gets a section when there's anything to show at all, so the
    // marker anchors the list even on a quiet day (same rule as AgendaView).
    if (byDay.size && !byDay.has(todayStr)) byDay.set(todayStr, []);
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, data]) => ({ date, title: dayHeading(date), isToday: date === todayStr, data }));
  }, [events]);

  // Jump to today's marker, or to a picked month when the agenda's rolling
  // window covers it. `itemIndex: 0` addresses a section's HEADER, so an empty
  // today section is still a valid target.
  const scrollTo = (sectionIndex: number, animated: boolean) =>
    listRef.current?.scrollToLocation({ sectionIndex, itemIndex: 0, viewPosition: 0, animated });
  useImperativeHandle(ref, () => ({
    scrollToToday: (animated = true) => {
      if (!sections.length) return;
      scrollTo(Math.max(0, sections.findIndex((s) => s.isToday)), animated);
    },
    scrollToMonth: (m: YearMonth) => {
      const prefix = `${m.year}-${String(m.month + 1).padStart(2, '0')}`;
      const idx = sections.findIndex((s) => s.date.startsWith(prefix));
      if (idx < 0) return false;
      scrollTo(idx, false);
      return true;
    },
  }));

  // The month under the top of the viewport. The callback identity must never
  // change (RN forbids swapping onViewableItemsChanged mid-flight), so it reads
  // the live prop through a ref and only fires when the month actually turns.
  const viewedCb = useRef(onViewedMonth);
  viewedCb.current = onViewedMonth;
  const lastMonth = useRef('');
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const date = (viewableItems.find((t) => (t.section as Section | undefined)?.date)?.section as Section | undefined)?.date;
    if (!date) return;
    const key = date.slice(0, 7);
    if (key === lastMonth.current) return;
    lastMonth.current = key;
    const [year, month] = key.split('-').map(Number);
    viewedCb.current?.({ year, month: month - 1 });
  }).current;

  return (
    <View style={styles.root}>
      <SectionList
        ref={listRef}
        sections={sections}
        keyExtractor={(e) => e._id}
        contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}
        ListHeaderComponent={<>{header}</>}
        onScrollToIndexFailed={() => {}}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderSectionHeader={({ section }) =>
          // Today gets the app's agenda marker — accent rules either side of a
          // "Today" label, with the day header tinted below it.
          section.isToday ? (
            <View style={styles.todayHeaderWrap}>
              <View style={styles.todayMarker}>
                <View style={styles.todayLine} />
                <Text style={styles.todayMarkerText}>Today</Text>
                <View style={styles.todayLine} />
              </View>
              <View style={styles.todayHeaderRow}>
                <Text style={[styles.headerText, styles.headerToday]}>{section.title}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.header}>
              <Text style={styles.headerText}>{section.title}</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <CardRow
            leading={<View style={[styles.dot, { backgroundColor: calendarColor(calendars, item.calendarType) }]} />}
            title={item.title}
            subtitle={`${timeLabel(item)}${item.location ? ` · ${item.location}` : ''}`}
            onPress={() => onOpenEvent(snapshotOf(item), item.calendarType)}
          />
        )}
        ListEmptyComponent={
          calendars.length && loading ? (
            <SkeletonList />
          ) : (
            <EmptyState
              icon="calendar-outline"
              variant="inline"
              title={calendars.length ? 'No upcoming events' : 'No shared calendars yet'}
              message={
                calendars.length
                  ? 'Nothing on the shared calendars in the next few weeks.'
                  : 'When someone shares a calendar with you, it appears here automatically.'
              }
            />
          )
        }
      />
    </View>
  );
});

export default React.memo(ViewerAgendaList);

const styles = StyleSheet.create({
  // Black, matching the grid layer and the unlocked app's calendar surface.
  root: { flex: 1, backgroundColor: '#000' },
  content: { paddingHorizontal: spacing.lg },
  // Day headers mirror the app's agenda (dayview/AgendaView) — opaque so they
  // stay legible while stuck, on this layer's black instead of the app surface.
  header: {
    backgroundColor: '#000',
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerText: { fontSize: 17, fontWeight: '700', color: colors.text },
  headerToday: { color: colors.primary },
  todayHeaderWrap: {
    backgroundColor: '#000',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  todayMarker: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm },
  todayLine: { flex: 1, height: 1, backgroundColor: colors.primary, opacity: 0.35 },
  todayMarkerText: {
    fontSize: 11, fontWeight: '700', color: colors.primary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  todayHeaderRow: { paddingTop: spacing.xs, paddingBottom: spacing.xs },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
