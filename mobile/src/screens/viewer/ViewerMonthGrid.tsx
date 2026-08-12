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
import { monthBlockWeeks, clipBars } from '../../lib/monthGrid';
import { weekBars, WeekBar } from '../../lib/calendar';
import { tintedChip } from '../../lib/color';
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
const MONTH_LABEL_H = 16; // the "Aug" marker above the 1st (month-start rows only)
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
// `outside` = a day of the neighbouring month inside a boundary week — a blank
// spacer, the whitespace that separates one month block from the next.
type RenderCell = { date: string; day: number; isToday: boolean; outside: boolean; chips: Chip[]; extra: number };
type RenderWeek = {
  key: string; ym: YearMonth; cells: RenderCell[]; bars: WeekBar[]; height: number; headerH: number;
  monthLabel: string; isMonthStart: boolean; abbrev: string; firstCol: number;
};

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

  // The window's weeks, month block by month block (lib/monthGrid) — each month
  // renders its own Sunday-first grid and blanks the neighbouring month's days,
  // exactly as the unlocked grid does, so the two surfaces still read alike.
  const blocks = useMemo(() => monthBlockWeeks(win), [win]);

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
  const { weeks, offsets, todayWeekOffset, todayIndex } = useMemo(() => {
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
    for (const blk of blocks) {
      const hit = cache.map.get(blk.key);
      if (hit) {
        weeksR.push(hit);
        continue;
      }
      // Only this block's own days carry chips; the neighbouring month's days
      // in a boundary week render blank (they belong to the other block's copy).
      const cells: RenderCell[] = blk.dates.map((dateStr, col) => {
        const outside = col < blk.firstCol || col > blk.lastCol;
        const chips = outside ? [] : chipsFor(dateStr);
        return {
          date: dateStr,
          day: blk.days[col],
          isToday: !outside && dateStr === todayStr,
          outside,
          chips: chips.slice(0, CHIP_MAX),
          extra: Math.max(0, chips.length - CHIP_MAX),
        };
      });
      // Spans are laid out across the whole week (so lanes agree between the two
      // copies of a boundary week), then clipped to this block's columns.
      const bars = clipBars(weekBars(barData, blk.dates), blk.firstCol, blk.lastCol);
      // A month's first row reserves a line above the day numbers for the month
      // abbreviation, across the whole row so the numbers stay aligned.
      const headerH = DAY_NUM_H + (blk.isMonthStart ? MONTH_LABEL_H : 0);
      const lanesAt = (col: number) =>
        bars.reduce((max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max), 0);
      // Size the week by its single tallest cell (its own bar lanes plus its own
      // chips) — taking the week-wide max of each separately over-allocates.
      const maxCell = Math.max(0, ...cells.map((c, col) => {
        const chipsH = c.chips.reduce((s, chip) => s + chipHeight(chipRows(charsPerLine, chip)), 0);
        return lanesAt(col) * BAR_H + chipsH + (c.extra ? MORE_H : 0);
      }));
      const height = Math.min(MAX_WEEK, Math.max(MIN_WEEK, headerH + maxCell + VPAD));
      const row: RenderWeek = {
        key: blk.key, ym: blk.ym, cells, bars, height, headerH,
        monthLabel: blk.monthLabel, isMonthStart: blk.isMonthStart, abbrev: blk.abbrev, firstCol: blk.firstCol,
      };
      cache.map.set(blk.key, row);
      weeksR.push(row);
    }

    const offs: number[] = [];
    let acc = 0;
    for (const w of weeksR) { offs.push(acc); acc += w.height; }
    // Today's row is the one where today is one of the block's OWN days.
    const tIdx = weeksR.findIndex((w) => w.cells.some((c) => c.isToday));
    return {
      weeks: weeksR,
      offsets: offs,
      todayWeekOffset: tIdx >= 0 ? offs[tIdx] : 0,
      todayIndex: Math.max(0, tIdx),
    };
  }, [events, calendars, barData, blocks, charsPerLine]);

  // The row the grid opens on (today's), captured once — initialScrollIndex
  // must not change as the window grows.
  const initialIdxRef = useRef(-1);
  if (initialIdxRef.current < 0) initialIdxRef.current = todayIndex;
  // Which row sits under the sticky header, seeded from today's row.
  const [curIdx, setCurIdx] = useState(() => todayIndex);

  // Place today's week at the top of the viewport, just below the sticky header.
  const goToday = (animated = true) =>
    listRef.current?.scrollToOffset({ offset: Math.max(0, topPad + todayWeekOffset - headerH), animated });

  // Opens on today and STAYS on today until the viewer moves it themselves —
  // the same anchor rule (and the same reason) as the unlocked grid: a cold
  // launch's inputs land in stages after initialScrollIndex has positioned the
  // first frame, and each stage re-measures the week rows out from under a
  // one-shot snap. See CalendarScreen's pin for the full account.
  const pinnedToToday = useRef(true);
  const unpin = useCallback(() => { pinnedToToday.current = false; }, []);
  useEffect(() => {
    if (pinnedToToday.current) goToday(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayWeekOffset, topPad, headerH]);

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
  // to the first row of that month's block.
  const pendingJump = useRef<YearMonth | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const jumpTo = useCallback((target: YearMonth) => {
    unpin(); // a deliberate destination — release the today anchor
    pendingJump.current = target;
    setWin((w) => ensureCovers(w, target));
    setJumpSeq((s) => s + 1);
  }, [unpin]);
  useEffect(() => {
    const t = pendingJump.current;
    if (!t) return;
    const idx = weeks.findIndex((w) => w.ym.year === t.year && w.ym.month === t.month);
    if (idx < 0) return;
    pendingJump.current = null;
    setCurIdx(idx);
    listRef.current?.scrollToOffset({ offset: Math.max(0, topPad + offsets[idx] - headerH), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq, weeks, offsets]);

  useImperativeHandle(ref, () => ({
    // Tapping Today re-pins as well as scrolls.
    scrollToToday: (animated = true) => {
      pinnedToToday.current = true;
      goToday(animated);
    },
    jumpTo,
  }));

  // The month under the sticky header right now (the jump sheet's highlight,
  // and what the host seeds Print with).
  const curYm: YearMonth = useMemo(() => {
    const ym = weeks[curIdx]?.ym;
    if (ym) return ym;
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
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
        initialScrollIndex={initialIdxRef.current}
        getItemLayout={(_, index) => ({ length: weeks[index].height, offset: offsets[index], index })}
        contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}
        onScrollToIndexFailed={() => {}}
        onScroll={onScroll}
        scrollEventThrottle={16}
        // Only the viewer's own drag releases the anchor — not a programmatic
        // scroll — and a re-measure while still pinned re-snaps to today.
        onScrollBeginDrag={unpin}
        onContentSizeChange={() => { if (pinnedToToday.current) goToday(false); }}
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
    <View style={[styles.weekRow, week.isMonthStart && styles.monthStartRow, { height: week.height }]}>
      {week.cells.map((cell, col) => {
        // A neighbouring month's day inside a boundary week: blank and inert.
        if (cell.outside) {
          return <View key={cell.date} style={[styles.dayCell, { width: cellSize, height: week.height }]} />;
        }
        // Reserve only the bar lanes that actually cover this cell.
        const cellLanes = week.bars.reduce(
          (max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max),
          0,
        );
        const hasItems = cell.chips.length > 0 || cellLanes > 0;
        return (
          <TouchableOpacity
            key={cell.date}
            style={[styles.dayCell, week.isMonthStart && styles.monthStartCell, { width: cellSize, height: week.height }]}
            activeOpacity={hasItems ? 0.7 : 1}
            // Read-only: a day opens its list, never a create form. An empty
            // day has nothing to open.
            onPress={() => hasItems && onPressDay(cell.date)}
          >
            <View style={[styles.dayHeader, { height: week.headerH }]}>
              {/* The month marker, on the 1st only. The slot is reserved in every
                  cell of the row so all the day numbers stay on one line. */}
              {week.isMonthStart ? (
                <View style={styles.monthLabelSlot}>
                  {col === week.firstCol ? <Text style={styles.monthAbbrev}>{week.abbrev}</Text> : null}
                </View>
              ) : null}
              <View style={[styles.dayNumWrap, cell.isToday && styles.todayWrap]}>
                <Text style={[styles.dayNum, cell.isToday && styles.todayNum]}>{cell.day}</Text>
              </View>
            </View>

            {/* reserved space for the spanning bars overlaid on this cell */}
            <View style={{ height: cellLanes * BAR_H }} />

            <View style={styles.cellItems}>
              {cell.chips.map((chip) => {
                // Same tinted chip as the owner's Details grid (see lib/color).
                const tint = tintedChip(chip.color);
                return (
                <TouchableOpacity
                  key={chip.key}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    { backgroundColor: tint.fill, height: chipHeight(chipRows(charsPerLine, chip)) - 2 },
                    chip.cancelled ? styles.chipCancelled : null,
                  ]}
                  onPress={() => onPressChip(chip.eventId)}
                >
                  <Text
                    style={[styles.chipText, { color: tint.label }, chip.cancelled && styles.chipTextCancelled]}
                    numberOfLines={titleLines(charsPerLine, chip.label)}
                    ellipsizeMode="clip"
                  >
                    {chip.label}
                  </Text>
                  {chip.time ? (
                    <Text style={[styles.chipTime, { color: tint.time }]} numberOfLines={1} ellipsizeMode="clip">{chip.time}</Text>
                  ) : null}
                </TouchableOpacity>
                );
              })}
              {/* The week-height math reserves exactly one line (MORE_H), so the
                  label must never wrap — on narrow cells it shrinks to fit instead. */}
              {cell.extra ? <Text style={styles.moreText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>+{cell.extra} more</Text> : null}
              {showSkeleton && !cell.chips.length ? <CellSkeleton date={cell.date} /> : null}
            </View>
          </TouchableOpacity>
        );
      })}

      {/* Multi-day events: one labelled bar spanning its columns, in the same
          tinted treatment as the single-day chips — the solid left edge is what
          marks a span as multi-day. */}
      {week.bars.map((bar) => {
        const tint = tintedChip(bar.color);
        return (
        <TouchableOpacity
          key={bar.key}
          activeOpacity={0.7}
          onPress={() => bar.eventId && onPressChip(bar.eventId)}
          style={[
            styles.spanBar,
            {
              backgroundColor: tint.fill,
              borderLeftColor: bar.color,
              left: bar.startCol * cellSize + 1,
              width: (bar.endCol - bar.startCol + 1) * cellSize - 3,
              top: week.headerH + bar.lane * BAR_H,
            },
          ]}
        >
          <Text style={[styles.spanBarText, { color: tint.label }]} numberOfLines={1} ellipsizeMode="clip">{bar.label}</Text>
        </TouchableOpacity>
        );
      })}
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
  // The month boundary reads as an ordinary week rule, drawn only over the days
  // the month owns (the blank cells leading into the 1st get no line) — same
  // rule as the unlocked grid.
  monthStartRow: { borderTopWidth: 0 },
  monthStartCell: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  dayCell: { paddingTop: 2, paddingHorizontal: 2, overflow: 'hidden' },
  dayHeader: { alignItems: 'center', justifyContent: 'flex-start' },
  monthLabelSlot: { height: MONTH_LABEL_H, justifyContent: 'center' },
  monthAbbrev: { fontSize: 12, lineHeight: 14, fontWeight: '700', color: colors.primary },
  dayNumWrap: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  todayWrap: { backgroundColor: colors.primary },
  dayNum: { fontSize: 15, color: colors.text, fontWeight: '600' },
  todayNum: { color: '#fff', fontWeight: '700' },
  cellItems: { flex: 1 },
  chip: { borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginBottom: 2, justifyContent: 'center', overflow: 'hidden' },
  chipCancelled: { opacity: 0.45 },
  // Title/time colours come per-chip from the calendar's tint (lib/color);
  // these carry only the metrics, with a safe default colour.
  chipText: { fontSize: 12, lineHeight: 13, color: colors.text, fontWeight: '600' },
  chipTextCancelled: { textDecorationLine: 'line-through' },
  chipTime: { fontSize: 10, lineHeight: 12, color: colors.textMuted, fontWeight: '600', marginTop: 1 },
  moreText: { fontSize: 11, fontWeight: '600', color: colors.textMuted, paddingLeft: 2 },
  skeletonChip: { marginBottom: 4, marginHorizontal: 1 },
  spanBar: { position: 'absolute', height: BAR_H - 2, borderRadius: 3, borderLeftWidth: 3, overflow: 'hidden', justifyContent: 'center', paddingHorizontal: 4 },
  spanBarText: { fontSize: 12, lineHeight: 13, fontWeight: '600' },
  sheetList: { maxHeight: 360 },
  sheetDot: { width: 12, height: 12, borderRadius: 6 },
});
