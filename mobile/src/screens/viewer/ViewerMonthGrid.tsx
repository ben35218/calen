import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView,
  useWindowDimensions, NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CalendarData, CalendarEvent } from '../../api';
import { expandCalendarRange, type CalendarWindowSources } from '../../lib/calendarData';
import {
  MonthWindow, YearMonth, initialWindow, extendPast, extendFuture, ensureCovers,
  monthsIn, monthRange, ymKey, mergeCalendarChunks,
} from '../../lib/calendarWindow';
import { weekBars, WeekBar, ymd } from '../../lib/calendar';
import type { CustomCalendar } from '../../lib/calendarPrefs';
import { MonthJumpHeaderButton } from '../calendar/MonthJumpSheet';
import { BottomSheet, CardRow, Skeleton } from '../../components/ui';
import type { TodayHandle } from '../calendar/todayHandle';
import type { ViewerEventSnapshot } from '../../navigation/types';
import { calendarColor, eventSpan, eventsOnDate, snapshotOf } from './shared';
import { colors, spacing } from '../../theme';

// Free viewer mode's month grid — the shell's default layer (billing-plans.md
// → "Free viewer mode"). Deliberately a READ-ONLY cousin of the unlocked app's
// Details density (CalendarScreen's CalendarGrid), not a reuse of it: a viewer
// has no create/edit long-presses, no weather lane, and no chores / tasks /
// meals / trips / occasions / holidays — only events on calendars shared TO
// them. Everything else stays behind the paywall.
//
// What it does share with the unlocked grid is the unbounded month window
// (lib/calendarWindow): it opens on today's week, grows at either edge as the
// user scrolls, and the sticky month label's jump sheet teleports anywhere.

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Layout metrics — mirrors the unlocked grid's Details density so the two
// surfaces read identically.
// The month/year jump label lives IN the host's button row (leading edge), so
// the header is two rows, not three — the calendar gets that row back.
const TOP_BAR_ROW = 52;   // host button-row height below the status bar
const WEEKDAY_ROW_H = 26;
const DAY_NUM_H = 26;
const BAR_H = 17;         // one multi-day spanning-bar lane
const CHIP_H1 = 20;       // one-line chip slot (incl. margin)
const CHIP_H2 = 34;       // two-line chip slot
const CHIP_H3 = 48;       // title + start time
const MORE_H = 14;        // "+N more"
const VPAD = 8;
const MIN_WEEK = 96;
const MAX_WEEK = 210;
const CHIP_MAX = 3;

const pad = (n: number) => String(n).padStart(2, '0');

// Compact start-time label for chips: on-the-hour drops the minutes.
const chipTimeLabel = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(/\s+/g, '');

// Chip sizing, shared by the week-height math and the row rendering.
const titleLines = (charsPerLine: number, label: string) => (label.trim().length > charsPerLine ? 2 : 1);
const chipRows = (charsPerLine: number, chip: Chip) => Math.min(3, titleLines(charsPerLine, chip.label) + (chip.time ? 1 : 0));
const chipHeight = (rows: number) => (rows >= 3 ? CHIP_H3 : rows === 2 ? CHIP_H2 : CHIP_H1);

// The grid answers "Today" like every calendar layer, and additionally takes a
// month teleport — the host hands one over when a month is picked from the
// LIST layer's jump sheet and falls outside the agenda's window.
export type ViewerGridHandle = TodayHandle & { jumpTo: (m: YearMonth) => void };

type Chip = { key: string; label: string; color: string; time?: string; eventId: string; cancelled?: boolean };
type RenderCell = { date: string; day: number; isToday: boolean; chips: Chip[]; extra: number };
type RenderWeek = { key: string; cells: RenderCell[]; bars: WeekBar[]; height: number; headerH: number; monthLabel: string };

const ViewerMonthGrid = forwardRef<ViewerGridHandle, {
  // The replica read, loaded once by the host and shared with the agenda layer
  // (undefined until it lands — the grid paints its chrome meanwhile).
  sources: CalendarWindowSources | undefined;
  // The calendars shared TO this user; the grid draws nothing else.
  calendars: CustomCalendar[];
  onOpenEvent: (e: ViewerEventSnapshot, calendarId?: string) => void;
  // Reported on every scroll so the host can seed Print with the month on screen.
  onViewedMonth?: (m: YearMonth) => void;
  // Room the host's floating chrome needs at the bottom (upgrade banner + Today).
  bottomPad: number;
}>(function ViewerMonthGrid({ sources, calendars, onOpenEvent, onViewedMonth, bottomPad }, ref) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const cellSize = (width - spacing.md * 2) / 7;
  const headerH = insets.top + TOP_BAR_ROW + WEEKDAY_ROW_H;
  const topPad = headerH + 8;
  const charsPerLine = Math.max(4, Math.floor((cellSize - 8) / 6.5));
  const listRef = useRef<FlatList<RenderWeek>>(null);

  const sharedIds = useMemo(() => new Set(calendars.map((c) => c.id)), [calendars]);

  // The unbounded month window: opens small and only ever grows.
  const [win, setWin] = useState<MonthWindow>(() => initialWindow(new Date()));
  const range = useMemo(() => ({
    fromDate: new Date(win.start.year, win.start.month, 1),
    toDate: new Date(win.end.year, win.end.month + 1, 0),
  }), [win]);

  // Continuous Sunday-first week grid spanning the whole window.
  const grid = useMemo(() => {
    const gridStart = new Date(range.fromDate);
    gridStart.setDate(1 - range.fromDate.getDay());
    return { gridStart, rangeEnd: range.toDate };
  }, [range]);

  const initialWeekIndex = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((+today - +grid.gridStart) / 86400000);
    return Math.max(0, Math.floor(days / 7));
  }, [grid]);

  const [curIdx, setCurIdx] = useState(initialWeekIndex);
  const [daySheet, setDaySheet] = useState<string | null>(null);

  // Month expansions are DERIVED data — computed synchronously from the shared
  // sources and memoized per month, so growing the window only expands the
  // months that were added (same doctrine as the unlocked grid).
  const months = useMemo(() => monthsIn(win), [win]);
  const monthCache = useRef<{ src: unknown; map: Map<string, CalendarData> }>({ src: null, map: new Map() });
  const data = useMemo(() => {
    if (!sources) return undefined;
    const cache = monthCache.current;
    if (cache.src !== sources) {
      cache.src = sources;
      cache.map.clear();
    }
    return mergeCalendarChunks(months.map((m) => {
      const key = ymKey(m);
      const hit = cache.map.get(key);
      if (hit) return hit;
      const r = monthRange(m);
      const d = expandCalendarRange(sources, r.from, r.to);
      cache.map.set(key, d);
      return d;
    }));
  }, [sources, months]);

  // The shell's whole visible world: events on calendars shared TO this user.
  // The viewer's own household lanes (their events, chores, tasks, meals,
  // trips) are dropped here — those stay behind the paywall.
  const events = useMemo(
    () => (data?.events ?? []).filter((e) => e.calendarType && sharedIds.has(e.calendarType)),
    [data, sharedIds],
  );
  // weekBars() reads a CalendarData — hand it the filtered events and no trips.
  const barData = useMemo(() => ({ events, trips: [] } as unknown as CalendarData), [events]);

  // Per-week row cache: window growth gives `events` a new identity but leaves
  // already-built weeks' content unchanged, so validity keys on the inputs and
  // unchanged rows keep their object identity (letting memoized rows bail out).
  const weekRowCache = useRef<{ sig: unknown[]; map: Map<string, RenderWeek> }>({ sig: [], map: new Map() });
  const { weeks, offsets, todayWeekOffset } = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const sig: unknown[] = [events, calendars, charsPerLine, todayStr];
    const cache = weekRowCache.current;
    if (cache.sig.length !== sig.length || sig.some((v, i) => v !== cache.sig[i])) {
      cache.sig = sig;
      cache.map.clear();
    }

    // Bucket single-day events once so each cell is an O(1) lookup — what keeps
    // a rebuild linear in days as the window grows. Multi-day events render as
    // the overlaid week bars instead.
    const byDate = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const { start, end } = eventSpan(e);
      if (start !== end) continue;
      const list = byDate.get(start);
      if (list) list.push(e);
      else byDate.set(start, [e]);
    }

    const chipsFor = (dateStr: string): Chip[] =>
      (byDate.get(dateStr) ?? []).map((e) => ({
        key: `e-${e._id}`,
        label: e.title,
        color: calendarColor(calendars, e.calendarType),
        time: e.allDay ? undefined : chipTimeLabel(e.startDate),
        eventId: e._id,
        cancelled: Boolean(e.cancelled),
      }));

    const weeksR: RenderWeek[] = [];
    const cursor = new Date(grid.gridStart);
    while (cursor <= grid.rangeEnd) {
      const wkKey = ymd(cursor);
      const hit = cache.map.get(wkKey);
      if (hit) {
        weeksR.push(hit);
        cursor.setDate(cursor.getDate() + 7);
        continue;
      }
      const cells: RenderCell[] = [];
      let monthLabel = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(cursor);
        d.setDate(cursor.getDate() + i);
        const dateStr = ymd(d);
        // A week spans at most two months; its Wednesday falls in the majority one.
        if (i === 3) monthLabel = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        const chips = chipsFor(dateStr);
        cells.push({
          date: dateStr,
          day: d.getDate(),
          isToday: dateStr === todayStr,
          chips: chips.slice(0, CHIP_MAX),
          extra: Math.max(0, chips.length - CHIP_MAX),
        });
      }
      const bars = weekBars(barData, cells.map((c) => c.date));
      const headerH = DAY_NUM_H;
      const lanesAt = (col: number) =>
        bars.reduce((max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max), 0);
      // Size the week by its single tallest cell (its own bar lanes plus its own
      // chips) — taking the week-wide max of each separately over-allocates.
      const maxCell = Math.max(0, ...cells.map((c, col) => {
        const chipsH = c.chips.reduce((s, chip) => s + chipHeight(chipRows(charsPerLine, chip)), 0);
        return lanesAt(col) * BAR_H + chipsH + (c.extra ? MORE_H : 0);
      }));
      const height = Math.min(MAX_WEEK, Math.max(MIN_WEEK, headerH + maxCell + VPAD));
      const row: RenderWeek = { key: wkKey, cells, bars, height, headerH, monthLabel };
      cache.map.set(wkKey, row);
      weeksR.push(row);
      cursor.setDate(cursor.getDate() + 7);
    }

    const offs: number[] = [];
    let acc = 0;
    for (const w of weeksR) { offs.push(acc); acc += w.height; }
    const tIdx = weeksR.findIndex((w) => w.cells.some((c) => c.date === todayStr));
    return { weeks: weeksR, offsets: offs, todayWeekOffset: tIdx >= 0 ? offs[tIdx] : 0 };
  }, [events, calendars, barData, grid, charsPerLine]);

  // Place today's week at the top of the viewport, just below the sticky header.
  const goToday = (animated = true) =>
    listRef.current?.scrollToOffset({ offset: Math.max(0, topPad + todayWeekOffset - headerH), animated });

  // initialScrollIndex positions the list on pre-data week heights; once the
  // real events land the earlier weeks grow, so snap back with final offsets.
  const snapped = useRef(false);
  useEffect(() => {
    if (snapped.current || !data) return;
    snapped.current = true;
    goToday(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, todayWeekOffset]);

  // Which week sits at the top of the viewport (drives the sticky month label).
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    let idx = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] <= y + 1) idx = i;
      else break;
    }
    if (idx !== curIdx) setCurIdx(idx);
  };

  // Unbounded scroll: nearing either edge grows the window. One extension per
  // edge at a time — the guard resets only when that edge actually moves.
  const extendingPast = useRef(false);
  const extendingFuture = useRef(false);
  useEffect(() => { extendingPast.current = false; }, [win.start.year, win.start.month]);
  useEffect(() => { extendingFuture.current = false; }, [win.end.year, win.end.month]);

  // Month/year quick jump: grow the window to cover the target, then teleport
  // to the first week whose majority (Wednesday) falls in that month.
  const pendingJump = useRef<YearMonth | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const jumpTo = useCallback((target: YearMonth) => {
    pendingJump.current = target;
    setWin((w) => ensureCovers(w, target));
    setJumpSeq((s) => s + 1);
  }, []);
  useEffect(() => {
    const t = pendingJump.current;
    if (!t) return;
    const prefix = `${t.year}-${pad(t.month + 1)}`;
    const idx = weeks.findIndex((w) => w.cells[3].date.startsWith(prefix));
    if (idx < 0) return;
    pendingJump.current = null;
    setCurIdx(idx);
    listRef.current?.scrollToOffset({ offset: Math.max(0, topPad + offsets[idx] - headerH), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq, weeks, offsets]);

  useImperativeHandle(ref, () => ({
    scrollToToday: (animated = true) => goToday(animated),
    jumpTo,
  }));

  // The month under the sticky header right now (the jump sheet's highlight,
  // and what the host seeds Print with).
  const curYm: YearMonth = useMemo(() => {
    const wed = weeks[curIdx]?.cells[3]?.date;
    const d = wed ? new Date(wed + 'T12:00:00') : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [weeks, curIdx]);
  useEffect(() => { onViewedMonth?.(curYm); }, [curYm, onViewedMonth]);

  const openEvent = useCallback((e: CalendarEvent) => {
    setDaySheet(null);
    onOpenEvent(snapshotOf(e), e.calendarType);
  }, [onOpenEvent]);
  const openEventId = useCallback((id: string) => {
    const e = events.find((ev) => ev._id === id);
    if (e) openEvent(e);
  }, [events, openEvent]);

  // First-ever load only (empty replica, initial sync still running).
  const showSkeleton = !data;
  const sheetEvents = daySheet ? eventsOnDate(events, daySheet) : [];

  return (
    <View style={styles.screen}>
      <FlatList
        ref={listRef}
        data={weeks}
        keyExtractor={(w) => w.key}
        renderItem={({ item }) => (
          <WeekRow
            week={item}
            cellSize={cellSize}
            charsPerLine={charsPerLine}
            showSkeleton={showSkeleton}
            onPressChip={openEventId}
            onPressDay={setDaySheet}
          />
        )}
        initialScrollIndex={initialWeekIndex}
        getItemLayout={(_, index) => ({ length: weeks[index].height, offset: offsets[index], index })}
        contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}
        onScrollToIndexFailed={() => {}}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onStartReached={() => {
          if (extendingPast.current) return;
          extendingPast.current = true;
          setWin((w) => extendPast(w));
        }}
        onStartReachedThreshold={0.5}
        onEndReached={() => {
          if (extendingFuture.current) return;
          extendingFuture.current = true;
          setWin((w) => extendFuture(w));
        }}
        onEndReachedThreshold={2}
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      />

      {/* ── Fixed 2-row header: the button row (carrying the sticky "Month Year"
          jump label on its leading edge, under the host's right-hand chrome) ·
          weekday labels ── */}
      <View style={[styles.topBar, { height: headerH, paddingTop: insets.top }]}>
        <View style={[styles.headerMonthRow, { height: TOP_BAR_ROW }]}>
          <MonthJumpHeaderButton label={weeks[curIdx]?.monthLabel} current={curYm} onSelect={jumpTo} />
        </View>
        <View style={[styles.weekdayRow, { height: WEEKDAY_ROW_H }]}>
          {WEEKDAYS.map((d, i) => (
            <View key={i} style={[styles.weekdayCell, { width: cellSize }]}>
              <Text style={styles.weekdayText}>{d}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* A day's full list — the cap of three chips per cell means tapping the
          day is the only way to reach the rest. */}
      <BottomSheet
        visible={daySheet !== null}
        onClose={() => setDaySheet(null)}
        title={daySheet ? new Date(daySheet + 'T12:00:00').toLocaleDateString(undefined, {
          weekday: 'long', month: 'long', day: 'numeric',
        }) : undefined}
      >
        <ScrollView style={styles.sheetList}>
          {sheetEvents.map((e) => {
            const color = calendarColor(calendars, e.calendarType);
            return (
              <CardRow
                key={e._id}
                leading={<View style={[styles.sheetDot, { backgroundColor: color }]} />}
                title={e.title}
                subtitle={[
                  e.allDay ? 'All day' : chipTimeLabel(e.startDate),
                  e.location,
                ].filter(Boolean).join(' · ')}
                onPress={() => openEvent(e)}
              />
            );
          })}
        </ScrollView>
      </BottomSheet>
    </View>
  );
});

export default React.memo(ViewerMonthGrid);

// One week row — module-level and memoized so a grid re-render only re-renders
// the rows whose RenderWeek object actually changed.
const WeekRow = React.memo(function WeekRow({
  week, cellSize, charsPerLine, showSkeleton, onPressChip, onPressDay,
}: {
  week: RenderWeek;
  cellSize: number;
  charsPerLine: number;
  showSkeleton: boolean;
  onPressChip: (eventId: string) => void;
  onPressDay: (date: string) => void;
}) {
  return (
    <View style={[styles.weekRow, { height: week.height }]}>
      {week.cells.map((cell, col) => {
        // Reserve only the bar lanes that actually cover this cell.
        const cellLanes = week.bars.reduce(
          (max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max),
          0,
        );
        const hasItems = cell.chips.length > 0 || cellLanes > 0;
        return (
          <TouchableOpacity
            key={cell.date}
            style={[styles.dayCell, { width: cellSize, height: week.height }]}
            activeOpacity={hasItems ? 0.7 : 1}
            // Read-only: a day opens its list, never a create form. An empty
            // day has nothing to open.
            onPress={() => hasItems && onPressDay(cell.date)}
          >
            <View style={[styles.dayHeader, { height: week.headerH }]}>
              <View style={[styles.dayNumWrap, cell.isToday && styles.todayWrap]}>
                <Text style={[styles.dayNum, cell.isToday && styles.todayNum]}>{cell.day}</Text>
              </View>
            </View>

            {/* reserved space for the spanning bars overlaid on this cell */}
            <View style={{ height: cellLanes * BAR_H }} />

            <View style={styles.cellItems}>
              {cell.chips.map((chip) => (
                <TouchableOpacity
                  key={chip.key}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    { backgroundColor: chip.color, height: chipHeight(chipRows(charsPerLine, chip)) - 2 },
                    chip.cancelled ? styles.chipCancelled : null,
                  ]}
                  onPress={() => onPressChip(chip.eventId)}
                >
                  <Text
                    style={[styles.chipText, chip.cancelled && styles.chipTextCancelled]}
                    numberOfLines={titleLines(charsPerLine, chip.label)}
                    ellipsizeMode="clip"
                  >
                    {chip.label}
                  </Text>
                  {chip.time ? (
                    <Text style={styles.chipTime} numberOfLines={1} ellipsizeMode="clip">{chip.time}</Text>
                  ) : null}
                </TouchableOpacity>
              ))}
              {cell.extra ? <Text style={styles.moreText}>+{cell.extra} more</Text> : null}
              {showSkeleton && !cell.chips.length ? <CellSkeleton date={cell.date} /> : null}
            </View>
          </TouchableOpacity>
        );
      })}

      {/* Multi-day events: one labelled bar spanning its columns. */}
      {week.bars.map((bar) => (
        <TouchableOpacity
          key={bar.key}
          activeOpacity={0.7}
          onPress={() => bar.eventId && onPressChip(bar.eventId)}
          style={[
            styles.spanBar,
            {
              backgroundColor: bar.color,
              left: bar.startCol * cellSize + 1,
              width: (bar.endCol - bar.startCol + 1) * cellSize - 3,
              top: week.headerH + bar.lane * BAR_H,
            },
          ]}
        >
          <Text style={styles.spanBarText} numberOfLines={1} ellipsizeMode="clip">{bar.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
});

// Placeholder chips for the first-ever load: the grid chrome and day numbers
// are already real, so each cell only shims where its events will land.
function CellSkeleton({ date }: { date: string }) {
  const seed = (Number(date.slice(8, 10)) * 5 + Number(date.slice(5, 7))) % 7;
  const count = seed < 3 ? 1 : seed < 5 ? 2 : 0;
  const widths = ['85%', '60%'] as const;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} width={widths[i]} height={CHIP_H1 - 4} radius={4} style={styles.skeletonChip} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  // Black, matching the unlocked app's calendar surface (CalendarScreen).
  screen: { flex: 1, backgroundColor: '#000' },
  content: { paddingHorizontal: spacing.md },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    paddingHorizontal: spacing.md, backgroundColor: '#000',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  headerMonthRow: { justifyContent: 'center' },
  weekdayRow: { flexDirection: 'row' },
  weekdayCell: { alignItems: 'center', paddingVertical: 4 },
  weekdayText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  weekRow: {
    flexDirection: 'row', position: 'relative',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  dayCell: { paddingTop: 2, paddingHorizontal: 2, overflow: 'hidden' },
  dayHeader: { alignItems: 'center', justifyContent: 'flex-start' },
  dayNumWrap: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  todayWrap: { backgroundColor: colors.primary },
  dayNum: { fontSize: 15, color: colors.text, fontWeight: '600' },
  todayNum: { color: '#fff', fontWeight: '700' },
  cellItems: { flex: 1 },
  chip: { borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginBottom: 2, justifyContent: 'center', overflow: 'hidden' },
  chipCancelled: { opacity: 0.45 },
  chipText: { fontSize: 12, lineHeight: 13, color: '#fff', fontWeight: '600' },
  chipTextCancelled: { textDecorationLine: 'line-through' },
  chipTime: { fontSize: 10, lineHeight: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '600', marginTop: 1 },
  moreText: { fontSize: 11, fontWeight: '600', color: colors.textMuted, paddingLeft: 2 },
  skeletonChip: { marginBottom: 4, marginHorizontal: 1 },
  spanBar: { position: 'absolute', height: BAR_H - 2, borderRadius: 3, justifyContent: 'center', paddingHorizontal: 4 },
  spanBarText: { fontSize: 12, lineHeight: 13, color: '#fff', fontWeight: '600' },
  sheetList: { maxHeight: 360 },
  sheetDot: { width: 12, height: 12, borderRadius: 6 },
});
