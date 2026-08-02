import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, PanResponder, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { loadCalendarData } from '../../lib/calendarData';
import { buildMonth, itemsForDate, eventColor, ymd, MonthGrid } from '../../lib/calendar';
import { getHolidays } from '../../lib/holidays';
import { useCalendarVisibility, useHolidayCalendars, holidayEnabledIds, useCalendarColors } from '../../lib/calendarPrefs';
import { useCallEventStatus } from '../../lib/callStatus';
import { resolveTaskIcon } from '../../lib/maintenanceCategories';
import { mdiName } from '../../lib/recurrence';
import { occasionIcon, occasionNoun, occasionFocusFrom } from '../../lib/occasions';
import { CardRow, SkeletonList } from '../../components/ui';
import { MonthJumpHeaderButton } from './MonthJumpSheet';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import type { TodayHandle } from './todayHandle';
import type { YearMonth } from '../../lib/calendarWindow';

type Nav = NativeStackNavigationProp<CalendarStackParamList>;

const TOP_BAR_ROW = 52; // matches CalendarScreen's floating button row
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const LONG_PRESS_MS = 200;
const DOT_MAX = 4;
const WEEK_ROW_H = 52; // one week row (must match styles.dayCell height)
// Past these on release, the drag commits to the adjacent month; otherwise it
// springs back to the current month.
const SWIPE_DISTANCE = 0.22; // fraction of the month's height
const SWIPE_VELOCITY = 0.4;

// Colored dots for a day cell, respecting calendar visibility and including
// holidays (which itemsForDate doesn't know about). One dot per source, capped.
function dotColors(
  data: Parameters<typeof itemsForDate>[0],
  dateStr: string,
  visible: (id: string) => boolean,
  calColors: Record<string, string>,
  holidayColors: string[],
): string[] {
  const out = [...holidayColors];
  const d = itemsForDate(data, dateStr);
  d.trips.forEach((t) => visible('trips') && out.push(t.color));
  d.events.forEach((e) => visible(e.calendarType) && out.push(eventColor(e)));
  if (visible('birthdays') && d.occasions.length) out.push(calColors.birthdays);
  if (visible('maintenance') && d.tasks.length) out.push(calColors.maintenance);
  if (visible('chores') && d.chores.length) out.push(calColors.chores);
  if (visible('recipes') && (d.recipes.length || d.grocery)) out.push(calColors.recipes);
  return out.slice(0, DOT_MAX);
}

function dayHeading(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const today = ymd(new Date());
  const md = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  if (dateStr === today) return `Today · ${md}`;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// The weeks a month actually occupies (its own days only — adjacent-month weeks
// are dropped), so a month's rendered height is exactly weeks × row.
const monthWeeks = (m: MonthGrid) => m.weeks.filter((w) => w.some((c) => c.currentMonth));

// Apple Calendar's "List" month mode: a compact month grid (dots per day) on top,
// and the tapped day's events listed below. Dragging the grid up/down scrolls
// continuously into the adjacent month and snaps to a full month on release; tap
// a day to fill the list. A content layer inside CalendarScreen — the host owns
// the floating chrome, so this draws only the grid + list under it.
const CalendarListView = forwardRef<TodayHandle, {
  active: boolean;
  // Cross-layer month continuity (see CalendarScreen): report the visible
  // month, adopt the shared one each time this layer becomes active.
  getViewedMonth?: () => YearMonth | null;
  onViewedMonth?: (m: YearMonth) => void;
}>(function CalendarListView({ active, getViewedMonth, onViewedMonth }, ref) {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { visibility } = useCalendarVisibility();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { colors: calColors } = useCalendarColors();
  const callStatus = useCallEventStatus();

  const today = ymd(new Date());
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selected, setSelected] = useState(today);

  const visible = (id: string) => visibility[id] !== false;
  const cellSize = (width - spacing.md * 2) / 7;

  // A generous window around the visible month so multi-day spans that start in a
  // neighbouring month (and the prev/next grids' dots) still resolve.
  const range = useMemo(() => {
    const from = new Date(cursor.year, cursor.month - 1, 1);
    const to = new Date(cursor.year, cursor.month + 2, 0);
    return { from: from.toISOString(), to: to.toISOString(), fromDate: from, toDate: to };
  }, [cursor]);

  // background sync: paint instantly from the local replica; the server pull
  // runs behind it and invalidates ['calendar'] only when something changed.
  const calQ = useQuery({
    queryKey: ['calendar', range.from, range.to],
    queryFn: async () => loadCalendarData({ from: range.from, to: range.to, sync: 'background' }),
    placeholderData: (prev) => prev,
  });

  // The three stacked grids of the carousel: previous · current · next.
  const grids = useMemo(
    () => ({
      prev: buildMonth(cursor.year, cursor.month - 1),
      cur: buildMonth(cursor.year, cursor.month),
      next: buildMonth(cursor.year, cursor.month + 1),
    }),
    [cursor],
  );
  const prevH = monthWeeks(grids.prev).length * WEEK_ROW_H;
  const curH = monthWeeks(grids.cur).length * WEEK_ROW_H;

  // Holidays across the whole window, tagged with their calendar colour.
  const holidaysByDate = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const cal of holidayCals) {
      if (visibility[cal.id] === false) continue;
      const color = calColors[cal.id] ?? cal.color;
      for (const h of getHolidays(cal.country, range.fromDate, range.toDate, holidayEnabledIds(cal))) {
        (map[h.date] ??= []).push(color);
      }
    }
    return map;
  }, [range, holidayCals, visibility, calColors]);

  // ── Carousel: the strip is translated so the current month sits at the window
  // top (rest = -prevH). Dragging reveals the adjacent months; releasing snaps. ──
  const translateY = useRef(new Animated.Value(0)).current;
  // Re-centre the strip on the current month whenever it changes (initial mount,
  // a snap commit, Today). useLayoutEffect so the swap is seamless (no flash).
  useLayoutEffect(() => {
    translateY.setValue(-prevH);
  }, [cursor, prevH, translateY]);

  const shiftMonth = (delta: number) =>
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const settle = (toValue: number, after?: () => void) =>
    Animated.timing(translateY, { toValue, duration: 200, useNativeDriver: false }).start(
      ({ finished }) => finished && after?.(),
    );

  // Heights the pan callbacks need, kept in a ref so the responder (created once)
  // always reads the live month geometry.
  const geom = useRef({ prevH, curH });
  geom.current = { prevH, curH };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
      onPanResponderMove: (_, g) => {
        const { prevH: p, curH: c } = geom.current;
        // Clamp so the drag can't pull past a single adjacent month.
        translateY.setValue(Math.max(-(p + c), Math.min(0, -p + g.dy)));
      },
      onPanResponderRelease: (_, g) => {
        const { prevH: p, curH: c } = geom.current;
        const up = g.dy < 0 && (-g.dy > c * SWIPE_DISTANCE || g.vy < -SWIPE_VELOCITY);
        const down = g.dy > 0 && (g.dy > c * SWIPE_DISTANCE || g.vy > SWIPE_VELOCITY);
        if (up) settle(-(p + c), () => shiftMonth(1));
        else if (down) settle(0, () => shiftMonth(-1));
        else settle(-p);
      },
      onPanResponderTerminate: () => settle(-geom.current.prevH),
    }),
  ).current;

  const goToday = () => {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setSelected(ymd(now));
  };

  useImperativeHandle(ref, () => ({ scrollToToday: goToday }));

  // Report the visible month to the host while active, for cross-layer
  // month continuity with the grid family.
  useEffect(() => {
    if (active) onViewedMonth?.(cursor);
  }, [active, cursor, onViewedMonth]);

  // This layer stays mounted across view-switcher changes. Each time List
  // becomes active it adopts the shared viewed month — so switching views
  // keeps the month in both directions — selecting today when that month is
  // today's (the pre-continuity behavior), else the month's 1st so the day
  // list below reflects the visible month.
  useEffect(() => {
    if (!active) return;
    const now = new Date();
    const target = getViewedMonth?.() ?? { year: now.getFullYear(), month: now.getMonth() };
    const isNowMonth = target.year === now.getFullYear() && target.month === now.getMonth();
    setCursor((c) => (c.year === target.year && c.month === target.month ? c : { year: target.year, month: target.month }));
    setSelected(isNowMonth ? ymd(now) : ymd(new Date(target.year, target.month, 1)));
  }, [active, getViewedMonth]);

  // ── The selected day's items ──
  const day = useMemo(() => itemsForDate(calQ.data, selected), [calQ.data, selected]);
  const holidaysForSelected = useMemo(() => {
    const d = new Date(selected + 'T12:00:00');
    const out: { id: string; name: string; color: string }[] = [];
    for (const cal of holidayCals) {
      if (visibility[cal.id] === false) continue;
      const color = calColors[cal.id] ?? cal.color;
      for (const h of getHolidays(cal.country, d, d, holidayEnabledIds(cal))) {
        if (h.date === selected) out.push({ id: `${cal.id}-${h.id}`, name: h.name, color });
      }
    }
    return out;
  }, [selected, holidayCals, visibility, calColors]);

  const eventTime = (allDay?: boolean, iso?: string) =>
    allDay || !iso
      ? 'All day'
      : new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });

  const listEmpty =
    !day.events.length && !day.tasks.length && !day.chores.length && !day.recipes.length &&
    !day.trips.length && !day.occasions.length && !day.grocery && !holidaysForSelected.length;

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  // One month's weeks (its own days only; adjacent-month cells are blanked).
  const renderGrid = (m: MonthGrid) => (
    <View>
      {monthWeeks(m).map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map((cell) => {
            if (!cell.currentMonth) {
              return <View key={cell.date} style={[styles.dayCell, { width: cellSize }]} />;
            }
            const dots = dotColors(calQ.data, cell.date, visible, calColors, holidaysByDate[cell.date] ?? []);
            const isSel = cell.date === selected;
            return (
              <TouchableOpacity
                key={cell.date}
                style={[styles.dayCell, { width: cellSize }]}
                activeOpacity={0.6}
                onPress={() => setSelected(cell.date)}
                onLongPress={() => nav.navigate('EventForm', { date: cell.date })}
                delayLongPress={LONG_PRESS_MS}
              >
                <View
                  style={[
                    styles.dayNumWrap,
                    cell.isToday && styles.todayWrap,
                    isSel && !cell.isToday && styles.selectedWrap,
                  ]}
                >
                  <Text style={[styles.dayNum, cell.isToday && styles.todayNum]}>{cell.day}</Text>
                </View>
                <View style={styles.dotRow}>
                  {dots.map((c, i) => (
                    <View key={i} style={[styles.dot, { backgroundColor: c }]} />
                  ))}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.screen}>
      {/* Header: month label + weekday row, drawn under the host's button row.
          The label is the same month/year jump-sheet button as the grid layers;
          a pick teleports the carousel to that month (the tapped-day selection
          stays put, matching a swipe between months). */}
      <View style={{ height: insets.top + TOP_BAR_ROW }} />
      <View style={styles.monthHeader}>
        <MonthJumpHeaderButton label={monthLabel} current={cursor} onSelect={setCursor} />
      </View>
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((d, i) => (
          <View key={i} style={[styles.weekdayCell, { width: cellSize }]}>
            <Text style={styles.weekdayText}>{d}</Text>
          </View>
        ))}
      </View>

      {/* Month carousel: a prev·current·next strip clipped to the current month's
          height. Drag pages continuously; release snaps to a full month. */}
      <View style={[styles.gridWindow, { height: curH }]} {...pan.panHandlers}>
        <Animated.View style={{ transform: [{ translateY }] }}>
          {renderGrid(grids.prev)}
          {renderGrid(grids.cur)}
          {renderGrid(grids.next)}
        </Animated.View>
      </View>

      <View style={styles.listDivider} />
      <Text style={styles.dayHeading}>{dayHeading(selected).toUpperCase()}</Text>

      {/* The selected day's events. */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: insets.bottom + 96 }}
      >
        {/* First-ever load (no replica yet): skeleton rows, not a premature
            "Nothing scheduled." that flips to content when the sync lands. */}
        {calQ.isLoading && listEmpty ? <SkeletonList count={3} /> : null}
        {!calQ.isLoading && listEmpty ? <Text style={styles.empty}>Nothing scheduled.</Text> : null}

        {day.trips.map((t) => (
          <ListItem key={`trip-${t.id}`} icon="bag-suitcase" color={t.color} title={t.name} subtitle="Trip" onPress={() => nav.navigate('TripDetail', { id: t.id })} />
        ))}
        {holidaysForSelected.map((h) => (
          <ListItem key={`hol-${h.id}`} icon="flag-variant" color={h.color} title={h.name} subtitle="Holiday" />
        ))}
        {day.occasions.map((o) => (
          <ListItem key={`occ-${o.id}`} icon={occasionIcon(o.kind)} color={calColors.birthdays} title={o.name} subtitle={occasionNoun(o)} onPress={() => nav.navigate('Birthdays', { focus: occasionFocusFrom(o) })} />
        ))}
        {day.events.map((e) => {
          const faded = Boolean(e.cancelled) || callStatus.isCancelled(e._id, selected) || callStatus.isReschedulePending(e._id, selected);
          const strike = Boolean(e.cancelled) || callStatus.isCancelled(e._id, selected);
          return (
            <ListItem
              key={e._id}
              icon="calendar"
              color={eventColor(e)}
              title={e.title}
              subtitle={[eventTime(e.allDay, e.startDate), e.location].filter(Boolean).join(' · ')}
              faded={faded}
              strike={strike}
              onPress={() => nav.navigate('EventDetail', { eventId: e._id, date: selected })}
            />
          );
        })}
        {day.tasks.map((t) => (
          <ListItem key={t._id} icon={resolveTaskIcon(t.icon, typeof t.categoryId === 'object' ? t.categoryId?.name : null)} color={calColors.maintenance} title={t.title} subtitle="Maintenance task" onPress={() => nav.navigate('TaskDetail', { id: t._id })} />
        ))}
        {day.chores.map((c) => (
          <ListItem key={c._id} icon={mdiName(c.icon)} color={calColors.chores} title={c.title} subtitle="Chore" onPress={() => nav.navigate('ChoreDetail', { id: c._id })} />
        ))}
        {day.recipes.map((r, i) => (
          <ListItem key={`recipe-${i}`} icon="silverware-fork-knife" color={calColors.recipes} title={r.title} subtitle="Meal" onPress={() => (r.recipeId ? nav.navigate('RecipeDetail', { id: r.recipeId }) : nav.navigate('KitchenHome'))} />
        ))}
        {day.grocery ? (
          <ListItem icon="cart" color={calColors.recipes} title="Grocery shopping" subtitle="Shopping day" onPress={() => nav.navigate('KitchenHome', { pane: 'grocery' })} />
        ) : null}
      </ScrollView>

      {/* Black backdrop under the host's top button row. */}
      <View style={[styles.topBackdrop, { height: insets.top + TOP_BAR_ROW }]} />
    </View>
  );
});

// Memoized so an unrelated host re-render (e.g. opening the view-switcher menu)
// doesn't re-render the whole agenda subtree and stutter the menu animation.
export default React.memo(CalendarListView);

// A compact card row for the selected-day list — tighter vertical padding and
// spacing than the default CardRow, with a leading calendar-colour accent bar.
function ListItem({ icon, color, title, subtitle, onPress, faded, strike }: { icon: string; color: string; title: string; subtitle?: string; onPress?: () => void; faded?: boolean; strike?: boolean }) {
  return (
    <CardRow
      onPress={onPress}
      leading={<MaterialCommunityIcons name={icon as any} size={18} color={color} />}
      title={title}
      titleStyle={strike ? { textDecorationLine: 'line-through' } : undefined}
      subtitle={subtitle}
      style={[styles.compactRow, { borderLeftColor: color, borderLeftWidth: 4 }, faded && { opacity: 0.55 }]}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  monthHeader: { paddingHorizontal: spacing.md, height: 40, justifyContent: 'center' },
  weekdayRow: { flexDirection: 'row', paddingHorizontal: spacing.md },
  weekdayCell: { alignItems: 'center', paddingVertical: 4 },
  weekdayText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  gridWindow: { overflow: 'hidden' },
  weekRow: { flexDirection: 'row', paddingHorizontal: spacing.md },
  dayCell: { alignItems: 'center', paddingVertical: 4, height: WEEK_ROW_H },
  dayNumWrap: { minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  todayWrap: { backgroundColor: colors.primary },
  selectedWrap: { backgroundColor: colors.surface },
  dayNum: { fontSize: 15, color: colors.text, fontWeight: '600' },
  todayNum: { color: '#fff', fontWeight: '700' },
  dotRow: { flexDirection: 'row', gap: 3, marginTop: 3, height: 8, alignItems: 'center' },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  listDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginTop: spacing.sm },
  dayHeading: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm },
  list: { flex: 1 },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl },
  // Compact override for CardRow's Card: minimal vertical padding (text sits
  // close to the card border), tighter icon gap, and a slim gap between cards.
  compactRow: { paddingVertical: spacing.xs, gap: spacing.sm, marginBottom: spacing.xs },
  topBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 10 },
});
