import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, FlatList, TouchableOpacity, useWindowDimensions, Animated, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CalendarData, CalendarOccasion, Chore, Task } from '../../api';
import { loadCalendarData } from '../../lib/calendarData';
import { loadPassiveForecast } from '../../lib/weatherSource';
import WeatherIcon from '../../components/WeatherIcon';
import { useAuth } from '../../store/auth';
import { weekBars, WeekBar, CALENDAR_COLORS, eventColor, ymd, recipeIconTarget, RecipeCell } from '../../lib/calendar';
import { occasionIcon, occasionFocusFrom } from '../../lib/occasions';
import { getHolidays } from '../../lib/holidays';
import { useCalendarVisibility, useHolidayCalendars, holidayEnabledIds, useCalendarColors, useMonthDensity, MonthDensity } from '../../lib/calendarPrefs';
import { mdiName } from '../../lib/recurrence';
import { resolveTaskIcon } from '../../lib/maintenanceCategories';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';
import AssistantButton from '../../components/AssistantButton';
import InvitationsButton from '../../components/InvitationsButton';
import AnchoredMenu, { AnchoredMenuItem } from '../../components/AnchoredMenu';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { useCallEventStatus } from '../../lib/callStatus';
import { useE2eeLocked } from '../../hooks/useE2eeLocked';
import { TodayHandle } from './todayHandle';
import CalendarListView from './CalendarListView';

// The three grid densities (the fourth mode, 'list', is a separate layer).
type GridDensity = Exclude<MonthDensity, 'list'>;

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'CalendarHome'>;

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Solid backing for the floating button clusters (one solid background per group).
const PILL_BG = colors.surface;
const BTN_FG = '#fff';
const TOP_BAR_ROW = 52; // button-row height below the status bar
const HEADER_MONTH_H = 40; // sticky "Month Year" row in the fixed header

// Layout metrics. Week rows are sized to their content, clamped to [MIN,MAX].
const WEEKDAY_ROW_H = 26;
const DAY_NUM_H = 26;     // centered date number
const BAR_H = 17;         // one spanning-bar lane
const CHIP_H1 = 20;       // one-line chip slot (incl. margin)
const CHIP_H2 = 34;       // two-line chip slot (incl. margin)
const CHIP_H3 = 48;       // three-line chip slot (title + start time; incl. margin)
const MORE_H = 14;        // "+N more"
const ICON_ROW_H = 22;    // task/chore/recipe/grocery icon row
const VPAD = 8;
const MIN_WEEK = 96;
const MAX_WEEK = 210;
const CHIP_MAX = 3;

// ── Density-specific metrics ──
// Compact: uniform short rows (day number + a row of dots), whole month fits.
const COMPACT_ROW_H = 26;   // day-number row
const DOT_ROW_H = 14;       // the dots strip below the number
const COMPACT_WEEK = COMPACT_ROW_H + DOT_ROW_H + VPAD;
const DOT_MAX = 4;
// Stacked: colored bars only (no text). Single-day items stack as thin bars
// below the day number; multi-day spans use the overlaid week bars.
const STACK_BAR_H = 9;      // one stacked single-day bar (incl. margin)
const STACK_MAX = 5;
const MIN_STACK_WEEK = 60;

// A shorter-than-default (500ms) hold to trigger create/edit long-presses.
const LONG_PRESS_MS = 200;

const HOLIDAY_COLOR = CALENDAR_COLORS['canadian-holidays'];
const BIRTHDAY_COLOR = CALENDAR_COLORS.birthdays;

const pad = (n: number) => String(n).padStart(2, '0');
// Date-only / all-day records are stored at noon UTC, so read in UTC.
const ld = (s: string) => new Date(s).toISOString().slice(0, 10);
// Timed events are real instants → read in the device's local zone.
const eventLd = (e: { allDay?: boolean }, iso: string) => (e.allDay ? ld(iso) : ymd(new Date(iso)));
// Compact start-time label for chips: on-the-hour drops the minutes ("9:00 AM" → "9AM").
const chipTimeLabel = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(/\s+/g, '');

// Whether this app launch already auto-opened an in-progress trip (module-level
// so returning to the calendar later in the session doesn't re-hijack it).
let autoOpenedTrip = false;

type Chip = { key: string; label: string; color: string; time?: string; eventId?: string; cancelled?: boolean; reschedulePending?: boolean };
type CellContent = { chips: Chip[]; tasks: Task[]; chores: Chore[]; recipes: RecipeCell[]; grocery: boolean; occasions: CalendarOccasion[] };
type RenderCell = { date: string; day: number; isToday: boolean; content: CellContent };
// The 7-day forecast strip's slice through one week (see the weather lane below).
type WeekWeather = { startCol: number; endCol: number; days: { col: number; code: number; tempMax: number }[] };
type RenderWeek = { key: string; cells: RenderCell[]; bars: WeekBar[]; weather: WeekWeather | null; height: number; headerH: number; monthLabel: string };

// 2 past months + current + 9 future, matching the web's initView window.
function monthWindow(): { year: number; month: number }[] {
  const base = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(base.getFullYear(), base.getMonth() + (i - 2), 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
}

// The scrolling month grid plus its fixed header rows (sticky Month Year +
// weekday labels). A content layer inside CalendarScreen's view toggle: the
// host owns all floating chrome (avatar, pills) and crossfades this layer
// against the agenda, so the header's top row is just empty space under the
// host's buttons.
// Memoized: the host CalendarScreen re-renders on unrelated state changes (e.g.
// opening the view-switcher menu). Without memo, every such render re-renders
// the whole month grid subtree, starving the menu's open/close animation frames.
const CalendarGrid = React.memo(forwardRef<TodayHandle, { density: GridDensity }>(function CalendarGrid({ density }, ref) {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { visibility } = useCalendarVisibility();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { colors: calColors } = useCalendarColors();
  // Events an AI call has resolved → dimmed (cancelled also struck through).
  const { cancelledIds, reschedulePendingIds } = useCallEventStatus();

  const cellSize = (width - spacing.md * 2) / 7;
  const headerH = insets.top + TOP_BAR_ROW + HEADER_MONTH_H + WEEKDAY_ROW_H;
  const topPad = headerH + 8;
  // Approx. characters that fit on one chip line; titles longer than this wrap
  // to a second line (titles are capped at 2 lines).
  const charsPerLine = Math.max(4, Math.floor((cellSize - 8) / 6.5));
  const titleLines = (label: string) => (label.trim().length > charsPerLine ? 2 : 1);
  // Total chip rows: title lines plus one row for a start time (capped at 3).
  const chipRows = (chip: Chip) => Math.min(3, titleLines(chip.label) + (chip.time ? 1 : 0));
  const chipHeight = (rows: number) => (rows >= 3 ? CHIP_H3 : rows === 2 ? CHIP_H2 : CHIP_H1);
  const listRef = useRef<FlatList<RenderWeek>>(null);

  const win = useMemo(monthWindow, []);
  const range = useMemo(() => {
    const first = new Date(win[0].year, win[0].month, 1);
    const last = new Date(win[win.length - 1].year, win[win.length - 1].month + 1, 0);
    return { from: first.toISOString(), to: last.toISOString(), fromDate: first, toDate: last };
  }, [win]);

  // Continuous (Sunday-first) week grid spanning the whole window: gridStart is
  // the Sunday on/before the first day, rangeEnd the last day of the last month.
  const grid = useMemo(() => {
    const first = new Date(win[0].year, win[0].month, 1);
    const gridStart = new Date(first);
    gridStart.setDate(1 - first.getDay());
    const rangeEnd = new Date(win[win.length - 1].year, win[win.length - 1].month + 1, 0);
    return { gridStart, rangeEnd };
  }, [win]);

  // Open on the week that contains today. Round the day count first so a DST
  // hour shift between gridStart and today can't tip the floor across a week.
  const initialWeekIndex = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((+today - +grid.gridStart) / 86400000);
    return Math.max(0, Math.floor(days / 7));
  }, [grid]);

  const [curIdx, setCurIdx] = useState(initialWeekIndex);

  const calQ = useQuery({
    queryKey: ['calendar', range.from, range.to],
    queryFn: async () => loadCalendarData({ from: range.from, to: range.to }),
  });

  // The Weather calendar's toggle drives a 7-day forecast strip in the grid
  // (a translucent lane above the event bars). Passive source resolution
  // (live / home / custom) — never prompts; failure just means no strip.
  const weatherOn = visibility.weather !== false;
  const weatherQ = useQuery({
    queryKey: ['weather', 'current'],
    queryFn: () => loadPassiveForecast(),
    enabled: weatherOn,
  });
  const forecastByDate = useMemo(() => {
    const map: Record<string, { code: number; tempMax: number }> = {};
    if (weatherOn) {
      for (const d of weatherQ.data?.forecast ?? []) {
        map[d.date] = { code: d.weatherCode, tempMax: d.tempMax };
      }
    }
    return map;
  }, [weatherOn, weatherQ.data]);

  // While on a trip, land on its detail screen instead of the grid (once per
  // launch, and only if the user hasn't already navigated somewhere else).
  // TripDetail is pushed over this screen, so its back button pops to the calendar.
  useEffect(() => {
    if (autoOpenedTrip || !calQ.data) return;
    autoOpenedTrip = true;
    if (!navigation.isFocused()) return;
    const today = ymd(new Date());
    const current = (calQ.data.trips ?? []).find(
      (t) => t.status !== 'considering' && (t.ranges ?? []).some((r) => ld(r.start) <= today && today <= ld(r.end)),
    );
    if (current) navigation.navigate('TripDetail', { id: current.id });
  }, [calQ.data, navigation]);

  // Holidays from every visible per-country calendar, each tagged with its own
  // colour so a day can carry (say) Canadian and US holidays side by side.
  const holidaysByDate = useMemo(() => {
    const map: Record<string, { id: string; name: string; color: string }[]> = {};
    for (const cal of holidayCals) {
      if (visibility[cal.id] === false) continue;
      const color = calColors[cal.id] ?? cal.color;
      for (const h of getHolidays(cal.country, range.fromDate, range.toDate, holidayEnabledIds(cal))) {
        (map[h.date] ??= []).push({ id: `${cal.id}-${h.id}`, name: h.name, color });
      }
    }
    return map;
  }, [range, holidayCals, visibility, calColors]);

  const visible = (id: string) => visibility[id] !== false;

  const visData: CalendarData | undefined = useMemo(() => {
    if (!calQ.data) return undefined;
    return {
      ...calQ.data,
      trips: visible('trips') ? calQ.data.trips : [],
      events: (calQ.data.events ?? []).filter((e) => visible(e.calendarType)),
    };
  }, [calQ.data, visibility]);

  const { weeks, offsets, todayWeekOffset } = useMemo(() => {
    const data = calQ.data;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const content = (dateStr: string): CellContent => {
      if (!data) return { chips: [], tasks: [], chores: [], recipes: [], grocery: false, occasions: [] };
      const chips: Chip[] = [];
      for (const h of holidaysByDate[dateStr] ?? []) chips.push({ key: `hol-${h.id}`, label: h.name, color: h.color });
      // Occasions render as icons (below), not event-style chips.
      const occasions = visible('birthdays') ? (data.occasions ?? []).filter((o) => ld(o.date) === dateStr) : [];
      for (const e of data.events ?? []) {
        if (!visible(e.calendarType)) continue;
        const start = eventLd(e, e.startDate);
        const end = e.endDate ? eventLd(e, e.endDate) : start;
        if (start === end && start === dateStr) {
          const time = e.allDay ? undefined : chipTimeLabel(e.startDate);
          chips.push({
            key: `e-${e._id}`, label: e.title, color: eventColor(e), time, eventId: e._id,
            cancelled: Boolean(e.cancelled) || cancelledIds.has(e._id),
            reschedulePending: reschedulePendingIds.has(e._id),
          });
        }
      }
      const tasks = visible('maintenance') ? (data.tasks ?? []).filter((t) => t.nextDueDate && ld(t.nextDueDate) === dateStr) : [];
      const chores = visible('chores') ? (data.chores ?? []).filter((c) => c.nextDueDate && ld(c.nextDueDate) === dateStr) : [];
      const recipes = visible('recipes')
        ? (data.recipes ?? [])
            .filter((r) => ld(r.scheduledDate) === dateStr)
            .map((r) => ({ recipeId: typeof r.recipeId === 'object' ? r.recipeId?._id : (r.recipeId as string | undefined) }))
        : [];
      const grocery = visible('recipes') ? (data.groceryShopping ?? []).some((g) => g.date === dateStr) : false;
      return { chips, tasks, chores, recipes, grocery, occasions };
    };

    const cellItemsHeight = (c: CellContent): number => {
      const chipsH = c.chips
        .slice(0, CHIP_MAX)
        .reduce((s, chip) => s + chipHeight(chipRows(chip)), 0);
      const hasIcons = c.tasks.length > 0 || c.chores.length > 0 || c.recipes.length > 0 || c.grocery || c.occasions.length > 0;
      return chipsH + (c.chips.length > CHIP_MAX ? MORE_H : 0) + (hasIcons ? ICON_ROW_H : 0);
    };

    // Stacked: every single-day item is one thin bar (chips + a bar per icon
    // group); multi-day spans are the overlaid week bars (counted separately).
    const stackBarCount = (c: CellContent): number =>
      Math.min(
        STACK_MAX,
        c.chips.length + (c.tasks.length ? 1 : 0) + (c.chores.length ? 1 : 0) + (c.recipes.length ? 1 : 0) + (c.grocery ? 1 : 0) + (c.occasions.length ? 1 : 0),
      );

    const weeksR: RenderWeek[] = [];
    const cursor = new Date(grid.gridStart);
    while (cursor <= grid.rangeEnd) {
      const cells: RenderCell[] = [];
      let monthLabel = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(cursor);
        d.setDate(cursor.getDate() + i);
        const dateStr = ymd(d);
        // A week spans at most two months; its Wednesday (index 3) always falls
        // in the majority month, so use it for the sticky-header label.
        if (i === 3) monthLabel = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        cells.push({
          date: dateStr,
          day: d.getDate(),
          isToday: dateStr === todayStr,
          content: content(dateStr),
        });
      }
      const weekDates = cells.map((c) => c.date);
      const bars = weekBars(visData, weekDates);
      // The forecast strip's slice through this week (contiguous by
      // construction — the forecast is a run of consecutive days). Compact
      // hides all spans, the weather lane included.
      const wxDays = cells
        .flatMap((c, col) => {
          const wx = forecastByDate[c.date];
          return wx ? [{ col, code: wx.code, tempMax: wx.tempMax }] : [];
        });
      const weather: WeekWeather | null =
        density !== 'compact' && wxDays.length
          ? { startCol: wxDays[0].col, endCol: wxDays[wxDays.length - 1].col, days: wxDays }
          : null;
      const weatherPad = weather ? BAR_H : 0;
      const headerH = DAY_NUM_H;
      // How many bar lanes actually cover a given column (0 if none).
      const lanesAt = (col: number) =>
        bars.reduce((max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max), 0);
      // Size the week by its single tallest cell: that cell's own bar lanes
      // plus its own items. Adding the week-wide max of each separately would
      // over-allocate when the deepest bar and the tallest item stack live in
      // different cells, leaving a spurious gap above the next week.
      let height: number;
      if (density === 'compact') {
        // Uniform short rows — no spans, just the dots strip.
        height = COMPACT_WEEK;
      } else if (density === 'stacked') {
        const maxCell = Math.max(0, ...cells.map((c, col) => lanesAt(col) * BAR_H + stackBarCount(c.content) * STACK_BAR_H));
        height = Math.min(MAX_WEEK, Math.max(MIN_STACK_WEEK, headerH + weatherPad + maxCell + VPAD));
      } else {
        const maxCell = Math.max(0, ...cells.map((c, col) => lanesAt(col) * BAR_H + cellItemsHeight(c.content)));
        height = Math.min(MAX_WEEK, Math.max(MIN_WEEK, headerH + weatherPad + maxCell + VPAD));
      }
      weeksR.push({ key: weekDates[0], cells, bars, weather, height, headerH, monthLabel });
      cursor.setDate(cursor.getDate() + 7);
    }

    const offs: number[] = [];
    let acc = 0;
    for (const w of weeksR) { offs.push(acc); acc += w.height; }

    const tIdx = weeksR.findIndex((w) => w.cells.some((c) => c.date === todayStr));
    const twOff = tIdx >= 0 ? offs[tIdx] : 0;

    return { weeks: weeksR, offsets: offs, todayWeekOffset: twOff };
  }, [calQ.data, visData, holidaysByDate, visibility, grid, charsPerLine, calColors, cancelledIds, reschedulePendingIds, density, forecastByDate]);

  // Place today's week at the top of the viewport, just below the sticky header.
  const goToday = (animated = true) =>
    listRef.current?.scrollToOffset({
      offset: Math.max(0, topPad + todayWeekOffset - headerH),
      animated,
    });

  useImperativeHandle(ref, () => ({ scrollToToday: (animated = true) => goToday(animated) }));

  // initialScrollIndex positions the list using pre-data week heights (all
  // MIN_WEEK); once real data lands the earlier weeks grow and today's week
  // shifts down, so snap back to it with the final offsets.
  const snappedToToday = useRef(false);
  useEffect(() => {
    if (snappedToToday.current || !calQ.data) return;
    snappedToToday.current = true;
    goToday(false);
  }, [calQ.data, todayWeekOffset]);

  // Track which week sits at the top of the viewport so the sticky header can
  // show that week's "Month Year" label. offsets[i] is week i's top within the content.
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    let idx = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] <= y + 1) idx = i;
      else break;
    }
    if (idx !== curIdx) setCurIdx(idx);
  };

  const renderWeek = ({ item: week }: { item: RenderWeek }) => {
    // The weather lane (when this week holds forecast days) sits above the
    // event-bar lanes: every cell's content shifts down by one lane so the
    // rows stay aligned across the week.
    const weatherPad = week.weather ? BAR_H : 0;
    return (
    <View style={[styles.weekRow, { height: week.height }]}>
      {week.cells.map((cell, col) => {
        const c = cell.content;
        // Reserve only the bar lanes that actually cover this cell, so days
        // without a spanning event don't inherit blank space from days that do.
        const cellLanes = week.bars.reduce(
          (max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max),
          0,
        );

        // Compact: one colored dot per source — spans covering this day plus
        // each single-day item — capped so a busy day stays tidy.
        const dots: string[] = [];
        if (density === 'compact') {
          for (const b of week.bars) if (col >= b.startCol && col <= b.endCol) dots.push(b.color);
          for (const chip of c.chips) dots.push(chip.color);
          if (c.tasks.length) dots.push(calColors.maintenance);
          if (c.chores.length) dots.push(calColors.chores);
          if (c.recipes.length || c.grocery) dots.push(calColors.recipes);
          if (c.occasions.length) dots.push(calColors.birthdays);
        }

        // Stacked: each single-day item is a thin colored bar (no text). Event
        // bars stay tappable; the rest fall through to the cell's day view.
        const stackItems: { color: string; eventId?: string; cancelled?: boolean; reschedulePending?: boolean }[] =
          density === 'stacked'
            ? [
                ...c.chips.map((chip) => ({ color: chip.color, eventId: chip.eventId, cancelled: chip.cancelled, reschedulePending: chip.reschedulePending })),
                ...(c.tasks.length ? [{ color: calColors.maintenance }] : []),
                ...(c.chores.length ? [{ color: calColors.chores }] : []),
                ...(c.recipes.length ? [{ color: calColors.recipes }] : []),
                ...(c.grocery ? [{ color: calColors.recipes }] : []),
                ...(c.occasions.length ? [{ color: calColors.birthdays }] : []),
              ].slice(0, STACK_MAX)
            : [];

        return (
          <TouchableOpacity
            key={cell.date}
            style={[styles.dayCell, { width: cellSize, height: week.height }]}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('CalendarDay', { date: cell.date })}
            // Short-press an (empty part of a) day to start a new event on it.
            onLongPress={() => navigation.navigate('EventForm', { date: cell.date })}
            delayLongPress={LONG_PRESS_MS}
          >
            <View style={[styles.dayHeader, { height: week.headerH }]}>
              <View style={[styles.dayNumWrap, cell.isToday && styles.todayWrap]}>
                <Text style={[styles.dayNum, cell.isToday && styles.todayNum]}>{cell.day}</Text>
              </View>
            </View>

            {density === 'compact' ? (
              <View style={styles.dotRow}>
                {dots.slice(0, DOT_MAX).map((color, i) => (
                  <View key={i} style={[styles.dot, { backgroundColor: color }]} />
                ))}
              </View>
            ) : density === 'stacked' ? (
              <>
                {/* reserved space for the spanning bars overlaid on this cell */}
                <View style={{ height: weatherPad + cellLanes * BAR_H }} />
                <View style={styles.cellItems}>
                  {stackItems.map((it, i) => {
                    const barStyle = [
                      styles.stackBar,
                      { backgroundColor: it.color },
                      it.cancelled ? styles.chipCancelled : it.reschedulePending ? styles.chipRescheduled : null,
                    ];
                    return it.eventId ? (
                      <TouchableOpacity
                        key={i}
                        activeOpacity={0.7}
                        style={barStyle}
                        onPress={() => navigation.navigate('EventDetail', { eventId: it.eventId!, date: cell.date })}
                        onLongPress={() => navigation.navigate('EventForm', { eventId: it.eventId!, date: cell.date })}
                        delayLongPress={LONG_PRESS_MS}
                      />
                    ) : (
                      <View key={i} style={barStyle} />
                    );
                  })}
                </View>
              </>
            ) : (
            <>
            {/* reserved space for the spanning bars overlaid on this cell */}
            <View style={{ height: weatherPad + cellLanes * BAR_H }} />

            <View style={styles.cellItems}>
              {/* Event chips open that event; holiday/birthday chips fall back to
                  the day view (they have no detail screen). */}
              {c.chips.slice(0, CHIP_MAX).map((chip) => (
                <TouchableOpacity
                  key={chip.key}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    { backgroundColor: chip.color, height: chipHeight(chipRows(chip)) - 2 },
                    // A resolved call fades the chip; a confirmed cancellation
                    // also strikes the title (see chipText below).
                    chip.cancelled ? styles.chipCancelled : chip.reschedulePending ? styles.chipRescheduled : null,
                  ]}
                  onPress={() =>
                    chip.eventId
                      ? navigation.navigate('EventDetail', { eventId: chip.eventId, date: cell.date })
                      : navigation.navigate('CalendarDay', { date: cell.date })
                  }
                  // Long-press jumps straight to the edit form. Holiday/birthday
                  // chips have no eventId (nothing to edit) → start a new event on the day.
                  onLongPress={() =>
                    chip.eventId
                      ? navigation.navigate('EventForm', { eventId: chip.eventId, date: cell.date })
                      : navigation.navigate('EventForm', { date: cell.date })
                  }
                  delayLongPress={LONG_PRESS_MS}
                >
                  <Text style={[styles.chipText, chip.cancelled && styles.chipTextCancelled]} numberOfLines={titleLines(chip.label)} ellipsizeMode="clip">{chip.label}</Text>
                  {/* numberOfLines={1} keeps the time on one line; ellipsizeMode "clip"
                      cuts off overflow (e.g. "10:30A") with no "…" and no wrapped "M". */}
                  {chip.time ? <Text style={styles.chipTime} numberOfLines={1} ellipsizeMode="clip">{chip.time}</Text> : null}
                </TouchableOpacity>
              ))}
              {c.chips.length > CHIP_MAX ? <Text style={styles.moreText}>+{c.chips.length - CHIP_MAX} more</Text> : null}

              {/* Each icon opens its own item view; a task/recipe icon aggregates
                  multiple items, so it opens the item when it's the only one and
                  falls back to the day/kitchen view when there are several. */}
              <View style={styles.iconRow}>
                {c.occasions.slice(0, 3).map((o) => (
                  <TouchableOpacity
                    key={`occ-${o.id}`}
                    hitSlop={6}
                    onPress={() => navigation.navigate('Birthdays', { focus: occasionFocusFrom(o) })}
                    accessibilityLabel={`${o.name} — ${o.kind}`}
                  >
                    <MaterialCommunityIcons name={occasionIcon(o.kind) as any} size={16} color={calColors.birthdays} />
                  </TouchableOpacity>
                ))}
                {c.tasks.length > 0 ? (
                  <TouchableOpacity
                    hitSlop={6}
                    onPress={() =>
                      c.tasks.length === 1
                        ? navigation.navigate('TaskDetail', { id: c.tasks[0]._id })
                        : navigation.navigate('CalendarDay', { date: cell.date })
                    }
                    // Long-press edits the single task; several stacked → day view to pick one.
                    onLongPress={() =>
                      c.tasks.length === 1
                        ? navigation.navigate('TaskForm', { id: c.tasks[0]._id })
                        : navigation.navigate('CalendarDay', { date: cell.date })
                    }
                    delayLongPress={LONG_PRESS_MS}
                  >
                    <IconChip
                      count={c.tasks.length}
                      icon={
                        c.tasks.length === 1
                          ? resolveTaskIcon(c.tasks[0].icon, typeof c.tasks[0].categoryId === 'object' ? c.tasks[0].categoryId?.name : null)
                          : 'wrench'
                      }
                      color={calColors.maintenance}
                    />
                  </TouchableOpacity>
                ) : null}
                {c.chores.slice(0, 3).map((ch) => (
                  <TouchableOpacity
                    key={`ch-${ch._id}`}
                    hitSlop={6}
                    onPress={() => navigation.navigate('ChoreDetail', { id: ch._id })}
                    onLongPress={() => navigation.navigate('ChoreForm', { id: ch._id })}
                    delayLongPress={LONG_PRESS_MS}
                  >
                    <MaterialCommunityIcons name={mdiName(ch.icon) as any} size={16} color={calColors.chores} />
                  </TouchableOpacity>
                ))}
                {c.recipes.length > 0 ? (
                  <TouchableOpacity
                    hitSlop={6}
                    onPress={() => {
                      const t = recipeIconTarget(c.recipes, cell.date);
                      if (t.screen === 'RecipeDetail') navigation.navigate('RecipeDetail', t.params);
                      else navigation.navigate('CalendarDay', t.params);
                    }}
                    // Long-press edits the single scheduled recipe; several → day view to pick one.
                    onLongPress={() => {
                      const id = c.recipes.length === 1 ? c.recipes[0].recipeId : undefined;
                      if (id) navigation.navigate('RecipeForm', { id });
                      else navigation.navigate('CalendarDay', { date: cell.date });
                    }}
                    delayLongPress={LONG_PRESS_MS}
                  >
                    <IconChip count={c.recipes.length} icon="silverware-fork-knife" color={calColors.recipes} />
                  </TouchableOpacity>
                ) : null}
                {c.grocery ? (
                  <TouchableOpacity hitSlop={6} onPress={() => navigation.navigate('KitchenHome', { pane: 'grocery', weekStart: cell.date })}>
                    <MaterialCommunityIcons name="cart" size={16} color={calColors.recipes} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            </>
            )}
          </TouchableOpacity>
        );
      })}

      {/* 7-day forecast strip (the Weather calendar's toggle): one translucent
          lane above the event bars, a per-day segment of condition icon + high
          temp. Tapping it opens the Weather screen. */}
      {week.weather ? (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => navigation.navigate('Weather')}
          style={[
            styles.weatherStrip,
            {
              backgroundColor: (calColors.weather ?? '#0288D1') + '26',
              left: week.weather.startCol * cellSize + 1,
              width: (week.weather.endCol - week.weather.startCol + 1) * cellSize - 3,
              top: week.headerH,
            },
          ]}
        >
          {week.weather.days.map((d) => (
            <View key={d.col} style={styles.weatherSeg}>
              <WeatherIcon code={d.code} size={11} />
              <Text style={styles.weatherSegTemp} numberOfLines={1}>{Math.round(d.tempMax)}°</Text>
            </View>
          ))}
        </TouchableOpacity>
      ) : null}

      {/* Spanning bars: hidden in Compact (dots only); text-labelled only in
          Details (Stacked shows unlabelled bars). */}
      {density !== 'compact' && week.bars.map((bar) => (
        <TouchableOpacity
          key={bar.key}
          activeOpacity={0.7}
          onPress={(e) => {
            if (bar.tripId) { navigation.navigate('TripDetail', { id: bar.tripId }); return; }
            // A multi-day event bar opens the event itself; the tapped column
            // seeds the day the Edit form returns to.
            if (bar.eventId) {
              const offset = Math.floor(e.nativeEvent.locationX / cellSize);
              const col = Math.min(bar.endCol, bar.startCol + Math.max(0, offset));
              navigation.navigate('EventDetail', { eventId: bar.eventId, date: week.cells[col].date });
              return;
            }
            const offset = Math.floor(e.nativeEvent.locationX / cellSize);
            const col = Math.min(bar.endCol, bar.startCol + Math.max(0, offset));
            navigation.navigate('CalendarDay', { date: week.cells[col].date });
          }}
          // Long-press a spanning bar to edit the event/trip it represents.
          onLongPress={(e) => {
            if (bar.tripId) { navigation.navigate('TripForm', { id: bar.tripId }); return; }
            if (bar.eventId) {
              const offset = Math.floor(e.nativeEvent.locationX / cellSize);
              const col = Math.min(bar.endCol, bar.startCol + Math.max(0, offset));
              navigation.navigate('EventForm', { eventId: bar.eventId, date: week.cells[col].date });
              return;
            }
            const offset = Math.floor(e.nativeEvent.locationX / cellSize);
            const col = Math.min(bar.endCol, bar.startCol + Math.max(0, offset));
            navigation.navigate('CalendarDay', { date: week.cells[col].date });
          }}
          delayLongPress={LONG_PRESS_MS}
          style={[
            styles.spanBar,
            {
              backgroundColor: bar.color,
              left: bar.startCol * cellSize + 1,
              width: (bar.endCol - bar.startCol + 1) * cellSize - 3,
              top: week.headerH + weatherPad + bar.lane * BAR_H,
            },
          ]}
        >
          {density === 'details' ? (
            <Text style={styles.spanBarText} numberOfLines={1} ellipsizeMode="clip">{bar.label}</Text>
          ) : null}
        </TouchableOpacity>
      ))}
    </View>
    );
  };

  return (
    <View style={styles.screen}>
      {calQ.isLoading ? <ActivityIndicator color={colors.primary} style={[styles.loader, { top: topPad }]} /> : null}
      <FlatList
        ref={listRef}
        data={weeks}
        keyExtractor={(w) => w.key}
        renderItem={renderWeek}
        initialScrollIndex={initialWeekIndex}
        getItemLayout={(_, index) => ({ length: weeks[index].height, offset: offsets[index], index })}
        contentContainerStyle={[styles.content, { paddingTop: topPad }]}
        onScrollToIndexFailed={() => {}}
        onScroll={onScroll}
        scrollEventThrottle={16}
      />

      {/* ── Fixed 3-row header: (host button row) · sticky Month Year · weekday labels ── */}
      <View style={[styles.topBar, { height: headerH, paddingTop: insets.top }]}>
        {/* Row 1 — empty space under the host's avatar + action buttons */}
        <View style={{ height: TOP_BAR_ROW }} />

        {/* Row 2 — current month, updated as the user scrolls */}
        <View style={[styles.headerMonthRow, { height: HEADER_MONTH_H }]}>
          <Text style={styles.monthLabel}>{weeks[curIdx]?.monthLabel}</Text>
        </View>

        {/* Row 3 — weekday labels */}
        <View style={[styles.weekdayRow, { height: WEEKDAY_ROW_H }]}>
          {WEEKDAYS.map((d, i) => (
            <View key={i} style={[styles.weekdayCell, { width: cellSize }]}>
              <Text style={styles.weekdayText}>{d}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}));

// The view-switcher modes, in menu order (List sits apart, below a divider —
// mirroring Apple Calendar). Each maps to a glyph shown both in the popover and
// on the switcher button itself (the button reflects the active mode).
const DENSITY_META: { key: MonthDensity; label: string; icon: string; dividerBefore?: boolean }[] = [
  { key: 'compact', label: 'Compact', icon: 'dots-horizontal' },
  { key: 'stacked', label: 'Stacked', icon: 'view-agenda-outline' },
  { key: 'details', label: 'Details', icon: 'view-stream-outline' },
  { key: 'list', label: 'List', icon: 'format-list-bulleted', dividerBefore: true },
];

// Hosts the month grid (Compact/Stacked/Details) and the List view as two
// always-black layers under shared floating chrome. The view switcher is a mode
// toggle, not navigation: both layers stay mounted (List lazily, after first
// use) and crossfade in place with a slight zoom, so the chrome never moves.
export default function CalendarScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const aiEnabled = useAiEnabled();
  const { user } = useAuth();
  const { density, setDensity } = useMonthDensity();

  const isList = density === 'list';
  // The grid layer needs a concrete density even while List is showing over it;
  // remember the last grid density so returning to the grid keeps the choice.
  const gridDensityRef = useRef<GridDensity>('details');
  if (density !== 'list') gridDensityRef.current = density;
  const gridDensity = gridDensityRef.current;

  const [menuOpen, setMenuOpen] = useState(false);
  const [listMounted, setListMounted] = useState(false);
  const progress = useRef(new Animated.Value(0)).current; // 0 = grid, 1 = list
  const gridRef = useRef<TodayHandle>(null);
  const listRef = useRef<TodayHandle>(null);

  // Crossfade whenever we cross into/out of List (button taps and the async
  // initial load of a stored List preference alike).
  useEffect(() => {
    if (isList) setListMounted(true);
    Animated.timing(progress, {
      toValue: isList ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [isList, progress]);

  const gridLayer = {
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }],
  };
  const listLayer = {
    opacity: progress,
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
  };

  const menuItems: AnchoredMenuItem[] = useMemo(
    () =>
      DENSITY_META.map((m) => ({
        key: m.key,
        label: m.label,
        active: density === m.key,
        dividerBefore: m.dividerBefore,
        icon: <MaterialCommunityIcons name={m.icon as any} size={20} color={colors.text} />,
        onPress: () => setDensity(m.key),
      })),
    [density],
  );
  const activeIcon = DENSITY_META.find((m) => m.key === density)?.icon ?? 'view-stream-outline';

  const initial = user?.firstName?.charAt(0).toUpperCase() ?? '?';
  // Encrypted data locked on this device → badge the profile button so it's
  // obvious there's something to resolve (unlock) in Profile.
  const dataLocked = useE2eeLocked();

  return (
    <View style={styles.screen}>
      <Animated.View style={[StyleSheet.absoluteFill, gridLayer]} pointerEvents={isList ? 'none' : 'auto'}>
        <CalendarGrid ref={gridRef} density={gridDensity} />
      </Animated.View>
      {listMounted ? (
        <Animated.View style={[StyleSheet.absoluteFill, listLayer]} pointerEvents={isList ? 'auto' : 'none'}>
          <CalendarListView ref={listRef} active={isList} />
        </Animated.View>
      ) : null}

      {/* ── Top row: avatar + view-switcher/search/add (shared by both layers) ── */}
      <View
        style={[styles.topChrome, { paddingTop: insets.top, height: insets.top + TOP_BAR_ROW }]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          style={styles.avatar}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('ProfileHome')}
          accessibilityLabel={dataLocked ? 'Profile — encrypted data locked, action needed' : 'Profile'}
        >
          <Text style={styles.avatarText}>{initial}</Text>
          {dataLocked ? (
            <View style={styles.lockBadge}>
              <Text style={styles.lockBadgeText}>!</Text>
            </View>
          ) : null}
        </TouchableOpacity>
        <View style={styles.pill}>
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={() => setMenuOpen(true)}
            accessibilityLabel="Change calendar view"
          >
            <MaterialCommunityIcons name={activeIcon as any} size={22} color={BTN_FG} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.pillBtn} onPress={() => navigation.navigate('CalendarSearch')}>
            <Ionicons name="search" size={20} color={BTN_FG} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.pillBtn} onPress={() => navigation.navigate('EventForm', {})}>
            <Ionicons name="add" size={26} color={BTN_FG} />
          </TouchableOpacity>
        </View>
      </View>

      <AnchoredMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + TOP_BAR_ROW}
        items={menuItems}
      />

      {/* ── Bottom-left: Today ───────────────────────────────────────────────── */}
      <View style={[styles.pill, styles.bottomLeft, { bottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={styles.todayBtn}
          onPress={() => (isList ? listRef : gridRef).current?.scrollToToday(true)}
        >
          <Text style={styles.todayText}>Today</Text>
        </TouchableOpacity>
      </View>

      {/* ── Bottom-right: Calendars + Invitations + Assistant ─────────────────── */}
      <View style={[styles.pill, styles.bottomRight, { bottom: insets.bottom + 16 }]}>
        <TouchableOpacity style={styles.bottomPillBtn} onPress={() => navigation.navigate('Calendars')}>
          <Ionicons name="calendar-outline" size={22} color={BTN_FG} />
        </TouchableOpacity>
        <InvitationsButton onPress={() => navigation.navigate('Invitations')} />
        {aiEnabled && (
          <AssistantButton onPress={() => navigation.navigate('Assistant', { initial: 'calendar' })} />
        )}
      </View>
    </View>
  );
}

// A small icon with a count (e.g. 2 maintenance tasks).
function IconChip({ count, icon, color }: { count: number; icon: string; color: string }) {
  return (
    <View style={styles.iconChip}>
      <MaterialCommunityIcons name={icon as any} size={16} color={color} />
      {count > 1 ? <Text style={[styles.iconCount, { color }]}>{count}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  loader: { position: 'absolute', alignSelf: 'center', zIndex: 1 },
  content: { paddingHorizontal: spacing.md, paddingBottom: 96 },
  monthLabel: { fontSize: 20, fontWeight: '700', color: colors.text },
  weekdayRow: { flexDirection: 'row' },
  weekdayCell: { alignItems: 'center', paddingVertical: 4 },
  weekdayText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  weekRow: { flexDirection: 'row', position: 'relative', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  dayCell: { paddingTop: 2, paddingHorizontal: 2, overflow: 'hidden' },
  dayHeader: { alignItems: 'center', justifyContent: 'flex-start' },
  dayNumWrap: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  todayWrap: { backgroundColor: colors.primary },
  dayNum: { fontSize: 15, color: colors.text, fontWeight: '600' },
  todayNum: { color: '#fff', fontWeight: '700' },
  spanBar: { position: 'absolute', height: BAR_H - 2, borderRadius: 3, justifyContent: 'center', paddingHorizontal: 4 },
  spanBarText: { fontSize: 12, lineHeight: 13, color: '#fff', fontWeight: '600' },
  // The 7-day forecast lane: translucent weather tint, one segment per day.
  weatherStrip: { position: 'absolute', height: BAR_H - 2, borderRadius: 3, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  weatherSeg: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  weatherSegTemp: { fontSize: 9, fontWeight: '600', color: colors.text },
  cellItems: { flex: 1 },
  chip: { borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginBottom: 2, justifyContent: 'center', overflow: 'hidden' },
  // Compact-mode dots + stacked-mode thin bars.
  dotRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 3, height: DOT_ROW_H, paddingHorizontal: 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  stackBar: { height: STACK_BAR_H - 3, borderRadius: 2, marginBottom: 2, marginHorizontal: 1 },
  chipCancelled: { opacity: 0.45 },
  chipRescheduled: { opacity: 0.6 },
  chipText: { fontSize: 12, lineHeight: 13, color: '#fff', fontWeight: '600' },
  chipTextCancelled: { textDecorationLine: 'line-through' },
  chipTime: { fontSize: 10, lineHeight: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '600', marginTop: 1 },
  moreText: { fontSize: 11, fontWeight: '600', color: colors.textMuted, paddingLeft: 2 },
  iconRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 3, marginBottom: 2 },
  iconChip: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  iconCount: { fontSize: 11, fontWeight: '700' },

  // ── Top bar + floating buttons ──
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    paddingHorizontal: spacing.md, backgroundColor: '#000',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  topChrome: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  headerMonthRow: { justifyContent: 'center' },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: PILL_BG,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  avatarText: { color: BTN_FG, fontSize: 18, fontWeight: '700' },
  // Red "!" overlay, top-right of the avatar, when encrypted data is locked.
  lockBadge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.error, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.background, paddingHorizontal: 3,
  },
  lockBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', lineHeight: 13 },
  pill: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: PILL_BG, borderRadius: 999,
    paddingHorizontal: 6, paddingVertical: 4,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  bottomLeft: { position: 'absolute', left: spacing.md, zIndex: 10 },
  bottomRight: { position: 'absolute', right: spacing.md, zIndex: 10 },
  pillBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  bottomPillBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  todayBtn: { paddingHorizontal: 22, paddingVertical: 6 },
  todayText: { color: BTN_FG, fontSize: 17, fontWeight: '700' },
});
