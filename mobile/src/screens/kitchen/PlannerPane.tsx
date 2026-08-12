import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipeScheduleApi, settingsApi } from '../../api';
import { loadPlannerMeals, scheduleRecipeId, PlannerMeal } from '../../lib/mealSchedule';
import { Card, Skeleton, SwipeableRow } from '../../components/ui';
import { RECIPE_ICON } from '../../lib/calendar';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, radius, spacing } from '../../theme';
import { GroceryFrequency, dayStart, iso, periodDaysOf, shoppingDayState } from './constants';

type Nav = NativeStackNavigationProp<KitchenStackParamList, 'KitchenHome'>;

// The week's meal schedule (weekStart comes from KitchenScreen so the Grocery
// pane shows the same week). The grocery list itself lives in GroceryPane.
export default function PlannerPane({ weekStart }: { weekStart: Date }) {
  const navigation = useNavigation<Nav>();
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;
  // Set after scheduling a freshly-created recipe, or when a recipe's "Next
  // scheduled" date is tapped: scroll to reveal its day and highlight it.
  const routeParams = useRoute<RouteProp<KitchenStackParamList, 'KitchenHome'>>().params;
  const scrollToDate = routeParams?.scrollToDate;
  const scrollRef = useRef<ScrollView>(null);
  // Keyed by the day's *index* in the period, not its date: when the period
  // shifts, a day whose card happens to lay out at the same height fires no new
  // onLayout, so a date-keyed map would come back empty for the new week.
  const dayOffsets = useRef<Record<number, number>>({});
  const [focusDate, setFocusDate] = useState<string | null>(null);

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const frequency: GroceryFrequency = settingsQ.data?.groceryFrequency ?? 'weekly';
  const periodDays = periodDaysOf(frequency);

  const start = iso(weekStart);
  const endDate = new Date(weekStart);
  endDate.setDate(endDate.getDate() + periodDays - 1);
  const end = iso(endDate);

  // periodDays is in the key so the range refetches when the cadence changes.
  // The window filter + the recipe-title join live in lib/mealSchedule: the
  // record store is content-blind, so neither a date range nor a populated
  // `recipeId` can come back from the server.
  const schedulesQ = useQuery({
    queryKey: ['recipe-schedule', start, periodDays],
    queryFn: () => loadPlannerMeals(start, end),
  });

  // `dayStart` normalises to local midnight before `iso` reads the UTC date —
  // see constants.ts. Which shopping day this period's is comes from the same
  // shared helper the Grocery pane names its trip with; a marker that has been
  // and gone says so rather than posing as the trip ahead.
  const today = iso(dayStart(new Date()));
  const shoppingState = shoppingDayState(weekStart, periodDays);
  const shoppingAhead = shoppingState === 'next' || shoppingState === 'today';

  const days = Array.from({ length: periodDays }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const dateStr = iso(d);
    return {
      // "Sat, Aug 29" — one `toLocaleDateString`, so the comma and the field
      // order follow the reader's locale (matching the period caption's trip
      // date, which is the same day when it's the shopping card).
      date: dateStr,
      label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      isToday: dateStr === today,
      // Only the period's first day is a shopping day (a biweekly period spans
      // two occurrences of the weekday, but only the first gets shopped).
      isGroceryDay: i === 0,
      schedules: (schedulesQ.data ?? []).filter((s) => s.day === dateStr),
    };
  });

  // A period change is a fresh context — drop the previous focus highlight so
  // paging back to a week later in the session doesn't re-light an old day.
  useEffect(() => { setFocusDate(null); }, [start]);

  // Reveal the requested day, highlight it, then clear the param so returning
  // here later doesn't re-scroll. The delay lets the refreshed schedule (a
  // just-added meal row) finish laying out before we read the day's offset.
  // A date outside the shown period is left alone: KitchenScreen is still
  // realigning the period around it (`weekStart` param), and this effect re-runs
  // — and re-checks — once `start` lands on the right one.
  const focusIndex = scrollToDate ? days.findIndex((d) => d.date === scrollToDate) : -1;
  useEffect(() => {
    if (!scrollToDate || focusIndex < 0) return;
    const t = setTimeout(() => {
      const y = dayOffsets.current[focusIndex];
      if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true });
      setFocusDate(scrollToDate);
      navigation.setParams({ scrollToDate: undefined });
    }, 250);
    return () => clearTimeout(t);
  }, [scrollToDate, focusIndex, schedulesQ.data, navigation]);

  const remove = useMutation({
    mutationFn: (id: string) => recipeScheduleApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recipe-schedule', start] });
      qc.invalidateQueries({ queryKey: ['grocery-list', start] });
    },
  });

  // Swiping a meal open reveals Remove; the native confirm is what actually
  // commits it. Worded "remove from the plan", not "delete" — the recipe itself
  // stays in the library (that deletion lives on RecipesScreen).
  const confirmRemove = (s: PlannerMeal) =>
    Alert.alert('Remove meal?', `"${s.title}" will be taken off this day's plan. The recipe stays in your library.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => remove.mutate(s._id) },
    ]);

  if (schedulesQ.isLoading) {
    return <PlannerSkeleton />;
  }

  return (
    <ScrollView ref={scrollRef} style={styles.pane} contentContainerStyle={styles.content}>
      {days.map((day, i) => (
        <TouchableOpacity
          key={day.date}
          activeOpacity={0.85}
          onLayout={(e) => { dayOffsets.current[i] = e.nativeEvent.layout.y; }}
          onPress={() => navigation.navigate('AddMeal', { date: day.date })}
        >
          <Card
            style={[
              styles.dayCard,
              day.isToday && styles.todayCard,
              // The trip you're preparing for gets a standing highlight. Listed
              // before the focus highlight so a deep-linked day still wins the
              // border — that one is transient and answers "the day you tapped".
              day.isGroceryDay && shoppingAhead
                && [styles.nextShopCard, { borderColor: accent, backgroundColor: `${accent}0F` }],
              day.date === focusDate && [styles.focusCard, { borderColor: accent, backgroundColor: `${accent}1A` }],
            ]}
          >
            <View style={styles.dayHeader}>
              <Text style={styles.dayName}>{day.label}</Text>
              <View style={styles.dayHeaderRight}>
                {day.isGroceryDay ? (
                  // Plain text, not a link: editing the schedule lives in the
                  // Meals options menu now, with the rest of the configuration.
                  <Text
                    style={[
                      styles.grocDayText,
                      shoppingState === 'past' ? styles.grocDayPast : { color: accent },
                    ]}
                  >
                    {shoppingState === 'past' ? 'Shopped' : shoppingAhead ? 'Next Shopping Day' : 'Shopping Day'}
                  </Text>
                ) : null}
                {day.isToday ? <Text style={styles.todayLabel}>Today</Text> : null}
              </View>
            </View>
            {day.schedules.map((s) => (
              <SwipeableRow
                key={s._id}
                label="Remove"
                accessibilityLabel={`Remove ${s.title} from ${day.label}`}
                actionStyle={styles.schedSwipeAction}
                onDelete={() => confirmRemove(s)}
              >
                <TouchableOpacity style={styles.schedRow} onPress={() => navigation.navigate('RecipeDetail', { id: scheduleRecipeId(s) })}>
                  {/* The calendar's meal glyph, so a planned meal looks the same
                      here as it does on the month grid and in the day view. */}
                  <MaterialCommunityIcons name={RECIPE_ICON as any} size={16} color="#fff" style={styles.schedIcon} />
                  {/* The planned flavor variation is part of what's being cooked. */}
                  <Text style={styles.schedTitle}>{s.variation ? `${s.title} — ${s.variation}` : s.title}</Text>
                </TouchableOpacity>
              </SwipeableRow>
            ))}
            <TouchableOpacity style={styles.addRow} onPress={() => navigation.navigate('AddMeal', { date: day.date })}>
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.addText}>Add recipe</Text>
            </TouchableOpacity>
          </Card>
        </TouchableOpacity>
      ))}

    </ScrollView>
  );
}

// Placeholder day cards for the first schedule load — the kitchen's version of
// the calendar's loading cells. Each card mirrors the real day layout (header
// line, a couple of meal rows with their leading glyph disc, the add row) so
// the week settles into the same shape it shimmers in. Meal-row counts vary per
// card the way a real week does.
function PlannerSkeleton() {
  const mealCounts = [2, 1, 2, 1];
  return (
    <ScrollView style={styles.pane} contentContainerStyle={styles.content}>
      {mealCounts.map((meals, i) => (
        <Card key={i} style={styles.dayCard}>
          <View style={styles.dayHeader}>
            <Skeleton width={'38%'} height={14} />
          </View>
          {Array.from({ length: meals }).map((_, j) => (
            <View key={j} style={styles.schedRow}>
              <Skeleton width={16} height={16} radius={8} />
              <Skeleton width={j % 2 ? '48%' : '62%'} height={14} style={styles.skelRowLine} />
            </View>
          ))}
          <View style={styles.addRow}>
            <Skeleton width={16} height={16} radius={8} />
            <Skeleton width={72} height={13} />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  dayCard: { marginBottom: spacing.sm },
  todayCard: { borderColor: colors.primary },
  // The arrived-here day, same treatment the Occasions timeline gives a
  // tapped-from-calendar row: a thicker ring plus a faint wash, both in the
  // section accent (applied inline — the accent is a user-overridable prefs
  // value, not a constant).
  focusCard: { borderWidth: 2 },
  // Lighter than the focus ring on purpose: this one is always on screen while
  // the trip is ahead, so it marks without shouting over the day's meals.
  nextShopCard: { borderWidth: 1.5 },
  dayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  dayHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayName: { fontSize: 14, fontWeight: '700', color: colors.text },
  grocDayText: { fontSize: 12, fontWeight: '600' },
  // A trip already taken is a fact about the past, not a thing to act on.
  grocDayPast: { color: colors.textMuted, fontWeight: '500' },
  todayLabel: { fontSize: 12, fontWeight: '700', color: colors.primary },
  // Top-aligned so a long title can wrap to more lines while the meal glyph
  // stays on the first one (the nudge centres the 16px glyph in that line).
  schedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 6 },
  schedIcon: { marginTop: 1.5 },
  schedTitle: { flex: 1, fontSize: 14, lineHeight: 19, color: colors.text },
  // The meal row sits inside the day card, so both of the revealed Remove's
  // edges are interior — round them equally rather than matching a card corner.
  schedSwipeAction: { borderRadius: radius.sm },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 },
  addText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  // Centres the shimmer line against the glyph disc the way schedTitle's
  // lineHeight centres real text against the 16px icon.
  skelRowLine: { marginTop: 1 },
});
