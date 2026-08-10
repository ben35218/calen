import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, useWindowDimensions, Animated, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CalendarData, CalendarEvent, CalendarOccasion, Chore, Task } from '../../api';
import { expandCalendarRange, loadCalendarWindowSources } from '../../lib/calendarData';
import {
  MonthWindow, YearMonth, initialWindow, extendPast, extendFuture, ensureCovers,
  monthsIn, monthRange, ymKey, mergeCalendarChunks,
} from '../../lib/calendarWindow';
import { monthBlockWeeks, clipBars, weekLayout, type WeekCoreMetrics } from '../../lib/monthGrid';
import { MonthJumpHeaderButton } from './MonthJumpSheet';
import { loadPassiveForecast } from '../../lib/weatherSource';
import WeatherIcon from '../../components/WeatherIcon';
import { useAuth } from '../../store/auth';
import { weekBars, WeekBar, CALENDAR_COLORS, eventColor, ymd, recipeIconTarget, RecipeCell, GROCERY_ICON, RECIPE_ICON } from '../../lib/calendar';
import { occasionIcon, occasionFocusFrom } from '../../lib/occasions';
import { getHolidays } from '../../lib/holidays';
import { useCalendarVisibility, useHolidayCalendars, holidayEnabledIds, useCalendarColors, useMonthDensity, MonthDensity } from '../../lib/calendarPrefs';
import { mdiName } from '../../lib/recurrence';
import { tintedChip } from '../../lib/color';
import { resolveTaskIcon } from '../../lib/maintenanceCategories';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';
import { Skeleton } from '../../components/ui';
import AssistantButton from '../../components/AssistantButton';
import { ASSISTANT_NAME } from '../../config';
import { useInvitationsCount } from '../../hooks/useInvitationsCount';
import AnchoredMenu, { AnchoredMenuItem } from '../../components/AnchoredMenu';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { useCallEventStatus } from '../../lib/callStatus';
import { useE2eeLocked } from '../../hooks/useE2eeLocked';
import { TodayHandle } from './todayHandle';
import CalendarListView from './CalendarListView';
import {
  CHROME_ZOOM, CONTENT_ZOOM, isMonthZoomed, monthDepth, openDayView, resetMonthDepth, settleMonth,
  useReduceMotion, zoomRange,
} from './dayTransition';

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
const MONTH_LABEL_H = 16; // the "Aug" marker above the 1st (month-start rows only)
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

// Chip sizing, shared by the grid's week-height math and WeekRow's rendering.
// Titles longer than charsPerLine wrap to a second line (capped at 2 lines);
// total chip rows add one for a start time (capped at 3).
const titleLines = (charsPerLine: number, label: string) => (label.trim().length > charsPerLine ? 2 : 1);
const chipRows = (charsPerLine: number, chip: Chip) => Math.min(3, titleLines(charsPerLine, chip.label) + (chip.time ? 1 : 0));
const chipHeight = (rows: number) => (rows >= 3 ? CHIP_H3 : rows === 2 ? CHIP_H2 : CHIP_H1);

// Whether this app launch already auto-opened an in-progress trip (module-level
// so returning to the calendar later in the session doesn't re-hijack it).
let autoOpenedTrip = false;

type Chip = { key: string; label: string; color: string; time?: string; eventId?: string; cancelled?: boolean; reschedulePending?: boolean };
type CellContent = { chips: Chip[]; tasks: Task[]; chores: Chore[]; recipes: RecipeCell[]; grocery: boolean; occasions: CalendarOccasion[] };
// `outside` = a day of the neighbouring month inside a boundary week. It renders
// as a blank spacer (no number, nothing tappable) — that blankness is what
// separates one month block from the next. See lib/monthGrid.
type RenderCell = { date: string; day: number; isToday: boolean; outside: boolean; content: CellContent };
// The 7-day forecast strip's slice through one week (see the weather lane below).
type WeekWeather = { startCol: number; endCol: number; days: { col: number; code: number; tempMax: number }[] };
type RenderWeek = {
  key: string; ym: YearMonth; cells: RenderCell[]; bars: WeekBar[]; weather: WeekWeather | null;
  height: number; headerH: number; monthLabel: string;
  // The block's first row: carries the month abbreviation over the 1st (at
  // firstCol) and the primary-tinted rule marking the month boundary.
  isMonthStart: boolean; abbrev: string; firstCol: number;
};

// One week's density-independent half: what every density draws, plus the
// per-column measurements weekLayout turns into a height (see the cache below).
type WeekCore = {
  cells: RenderCell[];
  bars: WeekBar[];
  wxDays: { col: number; code: number; tempMax: number }[];
  metrics: WeekCoreMetrics;
};

const EMPTY_CONTENT: CellContent = { chips: [], tasks: [], chores: [], recipes: [], grocery: false, occasions: [] };

// The grid's layout constants, handed to the pure weekLayout pass.
const WEEK_LAYOUT = {
  dayNumH: DAY_NUM_H,
  monthLabelH: MONTH_LABEL_H,
  barH: BAR_H,
  vpad: VPAD,
  compactWeek: COMPACT_WEEK,
  stackBarH: STACK_BAR_H,
  minStackWeek: MIN_STACK_WEEK,
  minWeek: MIN_WEEK,
  maxWeek: MAX_WEEK,
};

// The scrolling month grid plus its fixed header rows (sticky Month Year +
// weekday labels). A content layer inside CalendarScreen's view toggle: the
// host owns all floating chrome (avatar, pills) and crossfades this layer
// against the agenda, so the header's top row is just empty space under the
// host's buttons.
// Memoized: the host CalendarScreen re-renders on unrelated state changes (e.g.
// opening the view-switcher menu). Without memo, every such render re-renders
// the whole month grid subtree, starving the menu's open/close animation frames.
const CalendarGrid = React.memo(forwardRef<TodayHandle, {
  density: GridDensity;
  // Cross-layer month continuity (see the host): report the visible month,
  // adopt the shared one when this layer becomes the active one again.
  active: boolean;
  getViewedMonth: () => YearMonth | null;
  onViewedMonth: (m: YearMonth) => void;
}>(function CalendarGrid({ density, active, getViewedMonth, onViewedMonth }, ref) {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { visibility } = useCalendarVisibility();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { colors: calColors } = useCalendarColors();
  // Events an AI call has resolved → dimmed (cancelled also struck through).
  const callStatus = useCallEventStatus();

  const cellSize = (width - spacing.md * 2) / 7;
  const headerH = insets.top + TOP_BAR_ROW + HEADER_MONTH_H + WEEKDAY_ROW_H;
  const topPad = headerH + 8;
  // Approx. characters that fit on one chip line.
  const charsPerLine = Math.max(4, Math.floor((cellSize - 8) / 6.5));
  const listRef = useRef<FlatList<RenderWeek>>(null);

  // The unbounded month window: opens small (last month → a season ahead) and
  // only ever grows — scrolling near either edge extends it, and the header's
  // month/year sheet grows it to cover a jump target. No hard stop.
  const [win, setWin] = useState<MonthWindow>(() => initialWindow(new Date()));
  const range = useMemo(() => {
    const first = new Date(win.start.year, win.start.month, 1);
    const last = new Date(win.end.year, win.end.month + 1, 0);
    return { fromDate: first, toDate: last };
  }, [win]);

  // The window's weeks, month block by month block (lib/monthGrid): each month
  // renders its own Sunday-first grid and blanks the neighbouring month's days,
  // so a boundary week appears in BOTH blocks — the layout Apple Calendar uses,
  // and what puts real whitespace between months instead of running them
  // together. `curIdx`/`initialScrollIndex` are seeded from the built rows below.
  const blocks = useMemo(() => monthBlockWeeks(win), [win]);

  // background sync: paint instantly from the local replica; the server pull
  // runs behind it and invalidates ['calendar'] only when something changed.
  // The load is split so the window can grow for free: one range-INDEPENDENT
  // sources query (the replica read) is the only async state.
  const srcQ = useQuery({
    queryKey: ['calendar', 'sources'],
    queryFn: async () => loadCalendarWindowSources({ sync: 'background' }),
  });

  // Month expansions are DERIVED data — computed synchronously from the
  // sources and memoized per month, never fetched through query state. Saving
  // an event refetches the sources and this recomputes in ONE pass with ONE
  // re-render (the previous frame stays up until then) — the edit just
  // appears in its cells, no per-month churn and no skeleton flash. Growing
  // the window only expands the added months (cache hits for the rest); the
  // cache resets when the sources object changes.
  const months = useMemo(() => monthsIn(win), [win]);
  const monthCache = useRef<{ src: unknown; map: Map<string, CalendarData> }>({ src: null, map: new Map() });
  const data = useMemo(() => {
    const src = srcQ.data;
    if (!src) return undefined;
    const cache = monthCache.current;
    if (cache.src !== src) {
      cache.src = src;
      cache.map.clear();
    }
    const datas = months.map((m) => {
      const key = ymKey(m);
      const hit = cache.map.get(key);
      if (hit) return hit;
      const r = monthRange(m);
      const d = expandCalendarRange(src, r.from, r.to);
      cache.map.set(key, d);
      return d;
    });
    return mergeCalendarChunks(datas);
  }, [srcQ.data, months]);

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
    if (autoOpenedTrip || !data) return;
    autoOpenedTrip = true;
    if (!navigation.isFocused()) return;
    const today = ymd(new Date());
    const current = (data.trips ?? []).find(
      (t) => t.status !== 'considering' && (t.ranges ?? []).some((r) => ld(r.start) <= today && today <= ld(r.end)),
    );
    if (current) navigation.navigate('TripDetail', { id: current.id });
  }, [data, navigation]);

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
    if (!data) return undefined;
    return {
      ...data,
      trips: visible('trips') ? data.trips : [],
      events: (data.events ?? []).filter((e) => visible(e.calendarType)),
    };
  }, [data, visibility]);

  // Per-week caches, in two layers. Growing the window (edge scroll or a
  // month/year jump) gives the derived data/holidaysByDate objects new
  // identities, but the content of already-built weeks is unchanged — so
  // validity keys on the underlying INPUTS, and unchanged weeks are reused by
  // object identity (which also lets the memoized WeekRow rows bail out of
  // re-rendering).
  //
  // `cores` holds the DENSITY-INDEPENDENT half: the cells' content and the
  // week's spanning bars, which are identical in all three densities and are
  // the expensive half (weekBars scans every event and trip, per row). `rows`
  // holds the finished RenderWeek per density (keyed `<density>:<week>`), whose
  // only extra work is the arithmetic in weekLayout. Density is therefore NOT
  // in the signature: switching Compact/Stacked/Details re-runs no expansion
  // and no event scan, and switching back is a straight cache hit. Both maps
  // flush together when the data signature changes.
  const weekRowCache = useRef<{ sig: unknown[]; cores: Map<string, WeekCore>; rows: Map<string, RenderWeek> }>(
    { sig: [], cores: new Map(), rows: new Map() },
  );
  const { weeks, offsets, todayWeekOffset, todayIndex } = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const sig: unknown[] = [srcQ.data, holidayCals, visibility, calColors, callStatus, forecastByDate, charsPerLine, todayStr];
    const cache = weekRowCache.current;
    if (cache.sig.length !== sig.length || sig.some((v, i) => v !== cache.sig[i])) {
      cache.sig = sig;
      cache.cores.clear();
      cache.rows.clear();
    }

    // Bucket every dated item once, so each cell is an O(1) lookup instead of
    // a scan over each collection — this is what keeps a rebuild linear in
    // days (not days × items) as the window grows without bound.
    const chipEventsByDate = new Map<string, CalendarEvent[]>();
    const occasionsByDate = new Map<string, CalendarOccasion[]>();
    const tasksByDate = new Map<string, Task[]>();
    const choresByDate = new Map<string, Chore[]>();
    const recipesByDate = new Map<string, RecipeCell[]>();
    const groceryDates = new Set<string>();
    const bucket = <T,>(map: Map<string, T[]>, key: string, row: T) => {
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    };
    if (data) {
      for (const e of data.events ?? []) {
        if (!visible(e.calendarType)) continue;
        const start = eventLd(e, e.startDate);
        const end = e.endDate ? eventLd(e, e.endDate) : start;
        // Multi-day events render as the overlaid week bars, not cell chips.
        if (start === end) bucket(chipEventsByDate, start, e);
      }
      if (visible('birthdays')) for (const o of data.occasions ?? []) bucket(occasionsByDate, ld(o.date), o);
      if (visible('maintenance')) for (const t of data.tasks ?? []) if (t.nextDueDate) bucket(tasksByDate, ld(t.nextDueDate), t);
      if (visible('chores')) for (const c of data.chores ?? []) if (c.nextDueDate) bucket(choresByDate, ld(c.nextDueDate), c);
      if (visible('recipes')) {
        for (const r of data.recipes ?? []) {
          bucket(recipesByDate, ld(r.scheduledDate), {
            recipeId: typeof r.recipeId === 'object' ? r.recipeId?._id : (r.recipeId as string | undefined),
          });
        }
        for (const g of data.groceryShopping ?? []) groceryDates.add(g.date);
      }
    }

    const content = (dateStr: string): CellContent => {
      // Holidays are computed on-device from prefs, so they render the moment
      // the grid mounts — never held back waiting on the synced data below.
      const chips: Chip[] = [];
      for (const h of holidaysByDate[dateStr] ?? []) chips.push({ key: `hol-${h.id}`, label: h.name, color: h.color });
      for (const e of chipEventsByDate.get(dateStr) ?? []) {
        const time = e.allDay ? undefined : chipTimeLabel(e.startDate);
        chips.push({
          key: `e-${e._id}`, label: e.title, color: eventColor(e), time, eventId: e._id,
          cancelled: Boolean(e.cancelled) || callStatus.isCancelled(e._id, dateStr),
          reschedulePending: callStatus.isReschedulePending(e._id, dateStr),
        });
      }
      return {
        chips,
        tasks: tasksByDate.get(dateStr) ?? [],
        chores: choresByDate.get(dateStr) ?? [],
        recipes: recipesByDate.get(dateStr) ?? [],
        grocery: groceryDates.has(dateStr),
        // Occasions render as icons (below), not event-style chips.
        occasions: occasionsByDate.get(dateStr) ?? [],
      };
    };

    const cellItemsHeight = (c: CellContent): number => {
      const chipsH = c.chips
        .slice(0, CHIP_MAX)
        .reduce((s, chip) => s + chipHeight(chipRows(charsPerLine, chip)), 0);
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
    for (const blk of blocks) {
      const rowKey = `${density}:${blk.key}`;
      const hit = cache.rows.get(rowKey);
      if (hit) {
        weeksR.push(hit);
        continue;
      }

      // ── The density-independent core (built once per week, shared by all
      // three densities). This is the expensive half; the density switch below
      // never re-enters it.
      let core = cache.cores.get(blk.key);
      if (!core) {
        // Only this block's own days carry content; the neighbouring month's
        // days in a boundary week are blank spacers (and belong to the OTHER
        // block's copy of this week, where they are the ones that render).
        const cells: RenderCell[] = blk.dates.map((dateStr, col) => {
          const outside = col < blk.firstCol || col > blk.lastCol;
          return {
            date: dateStr,
            day: blk.days[col],
            isToday: !outside && dateStr === todayStr,
            outside,
            content: outside ? EMPTY_CONTENT : content(dateStr),
          };
        });
        // Spans are laid out across the whole week (so lanes agree between the
        // two copies of a boundary week) and then clipped to this block's
        // columns — a trip crossing the boundary draws as two clipped bars.
        const bars = clipBars(weekBars(visData, blk.dates), blk.firstCol, blk.lastCol);
        // The forecast strip's slice through this week (contiguous by
        // construction — the forecast is a run of consecutive days).
        const wxDays = cells.flatMap((c, col) => {
          const wx = c.outside ? undefined : forecastByDate[c.date];
          return wx ? [{ col, code: wx.code, tempMax: wx.tempMax }] : [];
        });
        // Per-column measurements the layout pass needs: how many bar lanes
        // actually cover the column, and how tall its items stack in each of
        // the two text densities.
        const lanes = cells.map((_, col) =>
          bars.reduce((max, b) => (col >= b.startCol && col <= b.endCol ? Math.max(max, b.lane + 1) : max), 0),
        );
        core = {
          cells,
          bars,
          wxDays,
          metrics: {
            isMonthStart: blk.isMonthStart,
            hasWeather: wxDays.length > 0,
            lanes,
            itemsH: cells.map((c) => cellItemsHeight(c.content)),
            stackN: cells.map((c) => stackBarCount(c.content)),
          },
        };
        cache.cores.set(blk.key, core);
      }

      // ── The density layer: pure arithmetic over the core.
      const lay = weekLayout(density, core.metrics, WEEK_LAYOUT);
      const weather: WeekWeather | null =
        lay.weather && core.wxDays.length
          ? { startCol: core.wxDays[0].col, endCol: core.wxDays[core.wxDays.length - 1].col, days: core.wxDays }
          : null;
      const row: RenderWeek = {
        key: blk.key, ym: blk.ym, cells: core.cells, bars: core.bars, weather,
        height: lay.height, headerH: lay.headerH,
        monthLabel: blk.monthLabel, isMonthStart: blk.isMonthStart, abbrev: blk.abbrev, firstCol: blk.firstCol,
      };
      cache.rows.set(rowKey, row);
      weeksR.push(row);
    }

    const offs: number[] = [];
    let acc = 0;
    for (const w of weeksR) { offs.push(acc); acc += w.height; }

    // Today's row is the one where today is one of the block's OWN days — a
    // boundary week's other copy holds the same date as a blank spacer.
    const tIdx = weeksR.findIndex((w) => w.cells.some((c) => c.isToday));
    const twOff = tIdx >= 0 ? offs[tIdx] : 0;

    return { weeks: weeksR, offsets: offs, todayWeekOffset: twOff, todayIndex: Math.max(0, tIdx) };
  }, [srcQ.data, holidayCals, data, visData, holidaysByDate, visibility, blocks, charsPerLine, calColors, callStatus, density, forecastByDate]);

  // The row the grid opens on (today's), captured once — the list's
  // initialScrollIndex must not change identity as the window grows.
  const initialIdxRef = useRef(-1);
  if (initialIdxRef.current < 0) initialIdxRef.current = todayIndex;
  // Which row sits under the sticky header. Seeded from today's row so the
  // first frame's label matches where initialScrollIndex puts the grid.
  const [curIdx, setCurIdx] = useState(() => todayIndex);

  // Place today's week at the top of the viewport, just below the sticky header.
  const goToday = (animated = true) =>
    listRef.current?.scrollToOffset({
      offset: Math.max(0, topPad + todayWeekOffset - headerH),
      animated,
    });

  // Whether the grid is still anchored to today (see the re-snap effect below).
  const pinnedToToday = useRef(true);
  const unpin = useCallback(() => { pinnedToToday.current = false; }, []);

  // Tapping Today re-pins as well as scrolls, so a repaint landing right after
  // the tap can't slide today back off the top.
  useImperativeHandle(ref, () => ({
    scrollToToday: (animated = true) => {
      pinnedToToday.current = true;
      goToday(animated);
    },
  }));

  // The grid OPENS ON TODAY and STAYS on today until the user moves it — as if
  // they had tapped Today the moment it appeared. initialScrollIndex only
  // positions the first frame, using pre-data week heights (all MIN_WEEK), and
  // a cold launch resolves its inputs in stages *after* that frame: the prefs
  // read (visibility, colours, the fresh-install holiday-calendar seed), the
  // replica/inline sync, refreshCustomCalendars' ['calendar'] invalidation, the
  // owned-add-on cache, the weather strip. Every one of those re-measures the
  // week rows, so today's week slides down offsets that a single snap on the
  // first `data` frame has already used and thrown away — which is why a
  // freshly registered account (nothing cached, so ALL of it lands late) opened
  // on the window's first month instead of today. Re-snap on every offset
  // change until the user takes the grid somewhere themselves.
  useEffect(() => {
    if (pinnedToToday.current) goToday(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayWeekOffset, topPad, headerH]);

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

  // ── Unbounded scroll: nearing either edge grows the window. One extension
  // per edge at a time — the guard ref resets only when that edge actually
  // moves, so a burst of onStart/EndReached callbacks can't stack extensions.
  // Upward growth is anchored by maintainVisibleContentPosition (below): the
  // prepended weeks extend the content above the viewport without a jump.
  const extendingPast = useRef(false);
  const extendingFuture = useRef(false);
  useEffect(() => { extendingPast.current = false; }, [win.start.year, win.start.month]);
  useEffect(() => { extendingFuture.current = false; }, [win.end.year, win.end.month]);
  const onStartReached = () => {
    if (extendingPast.current) return;
    extendingPast.current = true;
    setWin((w) => extendPast(w));
  };
  const onEndReached = () => {
    if (extendingFuture.current) return;
    extendingFuture.current = true;
    setWin((w) => extendFuture(w));
  };

  // ── Month/year quick jump (the header label's sheet). Grow the window to
  // cover the target if needed, then snap (no animation — it's a teleport) to
  // the first week whose majority (Wednesday) falls in that month. The effect
  // keys on jumpSeq so an in-window jump fires even though weeks didn't change.
  // The sheet's open/close state lives in MonthJumpHeaderButton (below), NOT
  // here — flipping it here would re-render this whole grid subtree before the
  // sheet could mount, making the sheet slow to open.
  const pendingJump = useRef<YearMonth | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const jumpTo = useCallback((target: YearMonth) => {
    // A deliberate destination — stop re-anchoring to today (see the pin above).
    unpin();
    pendingJump.current = target;
    setWin((w) => ensureCovers(w, target));
    setJumpSeq((s) => s + 1);
  }, [unpin]);
  useEffect(() => {
    const t = pendingJump.current;
    if (!t) return;
    // The block's first row — months own their rows now, so this is exact
    // (it used to guess the month from the week's Wednesday).
    const idx = weeks.findIndex((w) => w.ym.year === t.year && w.ym.month === t.month);
    if (idx < 0) return;
    pendingJump.current = null;
    setCurIdx(idx);
    listRef.current?.scrollToOffset({ offset: Math.max(0, topPad + offsets[idx] - headerH), animated: false });
  }, [jumpSeq, weeks, offsets]);

  // The month under the sticky header right now, for the sheet's highlight —
  // the row's own block month, not an inference from its middle day.
  const curYm: YearMonth = useMemo(() => {
    const ym = weeks[curIdx]?.ym;
    if (ym) return ym;
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, [weeks, curIdx]);

  // Cross-layer month continuity: report the month under the sticky header so
  // the List layer can adopt it, and adopt the shared month when this layer
  // becomes the active one again (a teleport; no-op if already showing it).
  const curYmRef = useRef(curYm);
  curYmRef.current = curYm;
  useEffect(() => { onViewedMonth(curYm); }, [curYm, onViewedMonth]);
  useEffect(() => {
    if (!active) return;
    const m = getViewedMonth();
    if (m && (m.year !== curYmRef.current.year || m.month !== curYmRef.current.month)) jumpTo(m);
  }, [active, getViewedMonth, jumpTo]);

  // First-ever load only (empty replica, the initial sync still running):
  // cached launches paint real data instantly and never show placeholders.
  const showSkeleton = !data;

  const renderWeek = ({ item }: { item: RenderWeek }) => (
    <WeekRow
      week={item}
      density={density}
      cellSize={cellSize}
      charsPerLine={charsPerLine}
      showSkeleton={showSkeleton}
      calColors={calColors}
    />
  );

  return (
    <View style={styles.screen}>
      <FlatList
        ref={listRef}
        data={weeks}
        keyExtractor={(w) => w.key}
        renderItem={renderWeek}
        initialScrollIndex={initialIdxRef.current}
        getItemLayout={(_, index) => ({ length: weeks[index].height, offset: offsets[index], index })}
        contentContainerStyle={[styles.content, { paddingTop: topPad }]}
        onScrollToIndexFailed={() => {}}
        onScroll={onScroll}
        scrollEventThrottle={16}
        // The user's own drag is what releases the today anchor — a
        // programmatic scroll (the snap itself, an edge extension) must not.
        onScrollBeginDrag={unpin}
        // The last word on "the rows just re-measured": week heights settle a
        // beat after the data that caused them, and the offsets effect can run
        // before the list has laid the new heights out.
        onContentSizeChange={() => { if (pinnedToToday.current) goToday(false); }}
        onStartReached={onStartReached}
        onStartReachedThreshold={0.5}
        onEndReached={onEndReached}
        onEndReachedThreshold={2}
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      />

      {/* ── Fixed 3-row header: (host button row) · sticky Month Year · weekday labels ── */}
      <View style={[styles.topBar, { height: headerH, paddingTop: insets.top }]}>
        {/* Row 1 — empty space under the host's avatar + action buttons */}
        <View style={{ height: TOP_BAR_ROW }} />

        {/* Row 2 — current month, updated as the user scrolls. Tapping it opens
            the month/year jump sheet (the fast-travel counterpart to scrolling). */}
        <View style={[styles.headerMonthRow, { height: HEADER_MONTH_H }]}>
          <MonthJumpHeaderButton label={weeks[curIdx]?.monthLabel} current={curYm} onSelect={jumpTo} />
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

// One week row of the month grid — module-level and memoized, so a grid
// re-render only re-renders rows whose RenderWeek object actually changed (the
// week cache above keeps unchanged rows' identity stable across window growth
// for exactly this reason). Keeping this as an inline closure re-rendered every
// mounted row on every grid render — the bulk of the jump sheet's open/close lag.
const WeekRow = React.memo(function WeekRow({
  week,
  density,
  cellSize,
  charsPerLine,
  showSkeleton,
  calColors,
}: {
  week: RenderWeek;
  density: GridDensity;
  cellSize: number;
  charsPerLine: number;
  showSkeleton: boolean;
  calColors: Record<string, string>;
}) {
  const navigation = useNavigation<Nav>();
  // The weather lane (when this week holds forecast days) sits above the
  // event-bar lanes: every cell's content shifts down by one lane so the
  // rows stay aligned across the week.
  const weatherPad = week.weather ? BAR_H : 0;
  return (
    <View style={[styles.weekRow, week.isMonthStart && styles.monthStartRow, { height: week.height }]}>
      {week.cells.map((cell, col) => {
        // A neighbouring month's day inside a boundary week: blank, inert. The
        // gap it leaves is the separation between one month block and the next.
        if (cell.outside) {
          return <View key={cell.date} style={[styles.dayCell, { width: cellSize, height: week.height }]} />;
        }
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
            style={[styles.dayCell, week.isMonthStart && styles.monthStartCell, { width: cellSize, height: week.height }]}
            activeOpacity={0.7}
            onPress={() => openDayView(navigation, cell.date)}
            // Short-press an (empty part of a) day to start a new event on it.
            onLongPress={() => navigation.navigate('EventForm', { date: cell.date })}
            delayLongPress={LONG_PRESS_MS}
          >
            <View style={[styles.dayHeader, { height: week.headerH }]}>
              {/* The month marker, on the 1st only — the abbreviated month name
                  above the day number. The slot is reserved in every cell of
                  the row so all the numbers stay on one line. */}
              {week.isMonthStart ? (
                <View style={styles.monthLabelSlot}>
                  {col === week.firstCol ? <Text style={styles.monthAbbrev}>{week.abbrev}</Text> : null}
                </View>
              ) : null}
              <View style={[styles.dayNumWrap, cell.isToday && styles.todayWrap]}>
                <Text style={[styles.dayNum, cell.isToday && styles.todayNum]}>{cell.day}</Text>
              </View>
            </View>

            {density === 'compact' ? (
              <View style={styles.dotRow}>
                {dots.slice(0, DOT_MAX).map((color, i) => (
                  <View key={i} style={[styles.dot, { backgroundColor: color }]} />
                ))}
                {showSkeleton && !dots.length ? <CellSkeleton date={cell.date} density={density} /> : null}
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
                  {showSkeleton && !stackItems.length ? <CellSkeleton date={cell.date} density={density} /> : null}
                </View>
              </>
            ) : (
            <>
            {/* reserved space for the spanning bars overlaid on this cell */}
            <View style={{ height: weatherPad + cellLanes * BAR_H }} />

            <View style={styles.cellItems}>
              {/* Event chips open that event; holiday/birthday chips fall back to
                  the day view (they have no detail screen). */}
              {c.chips.slice(0, CHIP_MAX).map((chip) => {
                // Apple's tinted styling: a translucent wash of the calendar's
                // colour behind the calendar's colour as text (lightened to
                // clear the contrast floor — see lib/color).
                const tint = tintedChip(chip.color);
                return (
                <TouchableOpacity
                  key={chip.key}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    { backgroundColor: tint.fill, height: chipHeight(chipRows(charsPerLine, chip)) - 2 },
                    // A resolved call fades the chip; a confirmed cancellation
                    // also strikes the title (see chipText below).
                    chip.cancelled ? styles.chipCancelled : chip.reschedulePending ? styles.chipRescheduled : null,
                  ]}
                  onPress={() =>
                    chip.eventId
                      ? navigation.navigate('EventDetail', { eventId: chip.eventId, date: cell.date })
                      : openDayView(navigation, cell.date)
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
                  <Text style={[styles.chipText, { color: tint.label }, chip.cancelled && styles.chipTextCancelled]} numberOfLines={titleLines(charsPerLine, chip.label)} ellipsizeMode="clip">{chip.label}</Text>
                  {/* numberOfLines={1} keeps the time on one line; ellipsizeMode "clip"
                      cuts off overflow (e.g. "10:30A") with no "…" and no wrapped "M". */}
                  {chip.time ? <Text style={[styles.chipTime, { color: tint.time }]} numberOfLines={1} ellipsizeMode="clip">{chip.time}</Text> : null}
                </TouchableOpacity>
                );
              })}
              {c.chips.length > CHIP_MAX ? <Text style={styles.moreText}>+{c.chips.length - CHIP_MAX} more</Text> : null}
              {showSkeleton && !c.chips.length ? <CellSkeleton date={cell.date} density={density} /> : null}

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
                        ? navigation.navigate('TaskDetail', { id: c.tasks[0]._id, date: cell.date })
                        : openDayView(navigation, cell.date)
                    }
                    // Long-press edits the single task; several stacked → day view to pick one.
                    onLongPress={() =>
                      c.tasks.length === 1
                        ? navigation.navigate('TaskForm', { id: c.tasks[0]._id, date: cell.date })
                        : openDayView(navigation, cell.date)
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
                    onPress={() => navigation.navigate('ChoreDetail', { id: ch._id, date: cell.date })}
                    onLongPress={() => navigation.navigate('ChoreForm', { id: ch._id, date: cell.date })}
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
                      else openDayView(navigation, t.params.date);
                    }}
                    // Long-press edits the single scheduled recipe; several → day view to pick one.
                    onLongPress={() => {
                      const id = c.recipes.length === 1 ? c.recipes[0].recipeId : undefined;
                      if (id) navigation.navigate('RecipeForm', { id });
                      else openDayView(navigation, cell.date);
                    }}
                    delayLongPress={LONG_PRESS_MS}
                  >
                    <IconChip count={c.recipes.length} icon={RECIPE_ICON} color={calColors.recipes} />
                  </TouchableOpacity>
                ) : null}
                {c.grocery ? (
                  <TouchableOpacity
                    hitSlop={6}
                    // Opens the shopping list for that day's period, and leaves
                    // the day itself queued for the Planner pane — flipping over
                    // to it lands on the shopping day, highlighted.
                    onPress={() => navigation.navigate('KitchenHome', { pane: 'grocery', weekStart: cell.date, scrollToDate: cell.date })}
                  >
                    <MaterialCommunityIcons name={GROCERY_ICON as any} size={16} color={calColors.recipes} />
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
            openDayView(navigation, week.cells[col].date);
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
            openDayView(navigation, week.cells[col].date);
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
});

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
  // When the assistant pushed this calendar on top of itself (a nav chip), the
  // Calen FAB's slot shows a "‹ Calen" return pill instead — the chat is one
  // tap (or a swipe-back) away, returning where the user launched from.
  const route = useRoute<RouteProp<CalendarStackParamList, 'CalendarHome'>>();
  const fromAssistant = route.params?.fromAssistant ?? false;
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

  // The month on screen in whichever layer is active — a ref, not state (it
  // moves at scroll frequency and must not re-render the host). Each layer
  // reports its visible month here and adopts it when it becomes active, so
  // switching views keeps the viewed month in both directions.
  const viewedMonth = useRef<YearMonth | null>(null);
  const onViewedMonth = useCallback((m: YearMonth) => { viewedMonth.current = m; }, []);
  const getViewedMonth = useCallback(() => viewedMonth.current, []);

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

  // ── The month ⇄ day zoom (see dayTransition) ──
  // Opening a day sends this whole surface away — content and TOP pills only.
  // The bottom pill and the FAB are left out on purpose: the day view draws
  // them at the same coordinates, so leaving both copies still reads as one
  // set of buttons that never moved.
  const reduced = useReduceMotion();
  // A FRESH month instance is never a return trip — the day view is pushed on
  // top of this one, so coming back never remounts it. Anything left over is a
  // navigator rebuild (sign-out, lock) that would otherwise mount the month
  // invisible.
  useEffect(() => resetMonthDepth(), []);
  useFocusEffect(
    useCallback(() => {
      // Regaining focus while zoomed away means the day view just went — resume
      // the same move backwards. (Focus after any other screen leaves depth at
      // 0, so this is a no-op there.)
      if (isMonthZoomed()) settleMonth();
    }, []),
  );
  const zoomAway = {
    opacity: monthDepth.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [
      { scale: monthDepth.interpolate({ inputRange: [0, 1], outputRange: zoomRange(1, CONTENT_ZOOM, reduced) }) },
    ],
  };
  const chromeZoomAway = {
    opacity: monthDepth.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [
      { scale: monthDepth.interpolate({ inputRange: [0, 1], outputRange: zoomRange(1, CHROME_ZOOM, reduced) }) },
    ],
  };

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
        // Defer the switch a frame: batched with the menu's dismissal, the
        // popover couldn't commit its close until the grid's re-render for the
        // new density had finished, so the menu visibly hung. This way the
        // close paints first and the layer catches up behind it — the same
        // rule the month/year jump sheet follows.
        onPress: () => requestAnimationFrame(() => setDensity(m.key)),
      })),
    [density],
  );
  const activeIcon = DENSITY_META.find((m) => m.key === density)?.icon ?? 'view-stream-outline';

  const initial = user?.firstName?.charAt(0).toUpperCase() ?? '?';
  // The avatar is the badge anchor for everything that resolves inside Profile.
  // Two badges share it with a precedence rule — security beats inbox: encrypted
  // data locked on this device shows the red "!", otherwise a pending count for
  // the Invitations inbox (which lives in Profile; the same count badges its row
  // there, so the trail continues after the tap).
  const dataLocked = useE2eeLocked();
  const invCount = useInvitationsCount();

  return (
    <View style={styles.screen}>
      <Animated.View style={[StyleSheet.absoluteFill, zoomAway]}>
        <Animated.View style={[StyleSheet.absoluteFill, gridLayer]} pointerEvents={isList ? 'none' : 'auto'}>
          <CalendarGrid
            ref={gridRef}
            density={gridDensity}
            active={!isList}
            getViewedMonth={getViewedMonth}
            onViewedMonth={onViewedMonth}
          />
        </Animated.View>
        {listMounted ? (
          <Animated.View style={[StyleSheet.absoluteFill, listLayer]} pointerEvents={isList ? 'auto' : 'none'}>
            <CalendarListView
              ref={listRef}
              active={isList}
              getViewedMonth={getViewedMonth}
              onViewedMonth={onViewedMonth}
            />
          </Animated.View>
        ) : null}
      </Animated.View>

      {/* ── Top row: avatar + view-switcher/search/add (shared by both layers) ── */}
      <Animated.View
        style={[styles.topChrome, chromeZoomAway, { paddingTop: insets.top, height: insets.top + TOP_BAR_ROW }]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          style={styles.avatar}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('ProfileHome')}
          accessibilityLabel={
            dataLocked
              ? 'Profile — encrypted data locked, action needed'
              : invCount > 0
                ? `Profile — ${invCount} invitation${invCount === 1 ? '' : 's'} to review`
                : 'Profile'
          }
        >
          <Text style={styles.avatarText}>{initial}</Text>
          {dataLocked ? (
            <View style={styles.lockBadge}>
              <Text style={styles.lockBadgeText}>!</Text>
            </View>
          ) : invCount > 0 ? (
            <View style={styles.lockBadge}>
              <Text style={styles.lockBadgeText}>{invCount > 9 ? '9+' : invCount}</Text>
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
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={() => {
              // In List mode a day is always selected, so the new event starts
              // on the day the user is looking at; the grid family has no
              // selected day, so the form defaults to today.
              const date = isList ? listRef.current?.getSelectedDate?.() : null;
              navigation.navigate('EventForm', date ? { date } : {});
            }}
          >
            <Ionicons name="add" size={26} color={BTN_FG} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <AnchoredMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + TOP_BAR_ROW}
        items={menuItems}
      />

      {/* ── Bottom-left: Today | Calendars (labelled — Calendars is a primary
          destination, and a calendar glyph inside a calendar app is ambiguous).
          Not part of the zoom: the day view draws this same pill in this same
          place, so it stays put while everything around it moves. ── */}
      <View style={[styles.pill, styles.bottomLeft, { bottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={styles.todayBtn}
          // Today OPENS today — the day view, in whichever day mode was last
          // used. It also re-centres the layer underneath first, so coming back
          // out lands on today rather than wherever the user had scrolled to.
          onPress={() => {
            (isList ? listRef : gridRef).current?.scrollToToday(false);
            openDayView(navigation, ymd(new Date()));
          }}
          accessibilityLabel="Today"
        >
          <Text style={styles.todayText}>Today</Text>
        </TouchableOpacity>
        <View style={styles.pillDivider} />
        <TouchableOpacity style={styles.todayBtn} onPress={() => navigation.navigate('Calendars')}>
          <Text style={styles.todayText}>Calendars</Text>
        </TouchableOpacity>
      </View>

      {/* ── Bottom-right: the standalone Calen FAB — the screen's one primary
          action. When the assistant pushed this calendar (fromAssistant), the
          slot becomes the "‹ Calen" return pill back into the live chat. ── */}
      {fromAssistant ? (
        <TouchableOpacity
          style={[styles.backPill, styles.bottomRight, { bottom: insets.bottom + 16 }]}
          activeOpacity={0.8}
          onPress={() => navigation.goBack()}
          accessibilityLabel={`Back to ${ASSISTANT_NAME}`}
        >
          <Ionicons name="chevron-back" size={22} color={BTN_FG} />
          <Text style={styles.backPillText}>{ASSISTANT_NAME}</Text>
        </TouchableOpacity>
      ) : aiEnabled ? (
        <AssistantButton
          style={[styles.bottomRight, { bottom: insets.bottom + 16 }]}
          onPress={() => navigation.navigate('Assistant', { initial: 'calendar' })}
        />
      ) : null}
    </View>
  );
}

// Placeholder chips for the first-ever load: the grid chrome, day numbers, and
// holiday chips are already real, so each cell only shims where its event data
// will land — shaped per density (chips / thin bars / dots). Deterministic per
// date so the pattern is stable across renders, with some cells left empty the
// way a real month is.
function CellSkeleton({ date, density }: { date: string; density: GridDensity }) {
  const seed = (Number(date.slice(8, 10)) * 5 + Number(date.slice(5, 7))) % 7;
  const count = seed < 3 ? 1 : seed < 5 ? 2 : 0;
  if (!count) return null;
  if (density === 'compact') {
    return (
      <>
        {Array.from({ length: count }).map((_, i) => (
          <Skeleton key={i} width={6} height={6} radius={3} />
        ))}
      </>
    );
  }
  const widths = ['85%', '60%'] as const;
  const height = density === 'stacked' ? STACK_BAR_H - 3 : CHIP_H1 - 4;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          width={widths[i]}
          height={height}
          radius={density === 'stacked' ? 2 : 4}
          style={{ marginBottom: density === 'stacked' ? 2 : 4, marginHorizontal: 1 }}
        />
      ))}
    </>
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
  content: { paddingHorizontal: spacing.md, paddingBottom: 96 },
  weekdayRow: { flexDirection: 'row' },
  weekdayCell: { alignItems: 'center', paddingVertical: 4 },
  weekdayText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  weekRow: { flexDirection: 'row', position: 'relative', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  // The month boundary reads as an ordinary week rule, but only over the days
  // the month actually owns: the row-wide border comes off, and each own-month
  // cell draws the same hairline itself, so no line hangs over the blank cells
  // that lead into the 1st.
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
  // Chip title/time colours are per-chip (the calendar's tint, see lib/color);
  // these carry only the metrics, with a safe default colour.
  chipText: { fontSize: 12, lineHeight: 13, color: colors.text, fontWeight: '600' },
  chipTextCancelled: { textDecorationLine: 'line-through' },
  chipTime: { fontSize: 10, lineHeight: 12, color: colors.textMuted, fontWeight: '600', marginTop: 1 },
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
  // Return-to-assistant pill shown in the Calen FAB's slot when the calendar
  // was pushed on top of the assistant by a nav chip (fromAssistant).
  backPill: {
    flexDirection: 'row', alignItems: 'center', height: 44, borderRadius: 22,
    backgroundColor: PILL_BG, paddingLeft: 6, paddingRight: 16,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  backPillText: { color: BTN_FG, fontSize: 16, fontWeight: '700', marginLeft: 2 },
  // Red overlay, top-right of the avatar: "!" when encrypted data is locked,
  // else the pending Invitations count (security wins — never both).
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
  pillDivider: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: colors.border },
  todayBtn: { paddingHorizontal: 16, paddingVertical: 6 },
  todayText: { color: BTN_FG, fontSize: 17, fontWeight: '700' },
});
