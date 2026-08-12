import React, { useEffect, useLayoutEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../../api';
import { BottomSheet, Card, CenteredLoader, HeaderIconButton, SegmentedControl } from '../../components/ui';
import PlannerPane from './PlannerPane';
import GroceryPane from './GroceryPane';
import { GroceryFrequency, iso, periodDaysOf, periodLabel, periodStartOf, relativeDay, scheduleSummary, shoppingDayState, startOfWeek } from './constants';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { RECIPE_ICON } from '../../lib/calendar';
import { useOwnedAddons } from '../../lib/addons';
import AddonLockedView from '../plan/AddonLockedView';
import { colors, spacing } from '../../theme';
import type { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import type { KitchenPane } from '../../navigation/types';

type Nav = NativeStackNavigationProp<KitchenStackParamList>;

// Add-on gate: Meals is a one-time purchase (see billing-plans spec). Gating at
// the home screen covers every entry path — Calendars row, deep links, AI
// navigation, restored nav state — since sub-screens are reached through here.
export default function KitchenScreen() {
  const { isUnlocked, loaded } = useOwnedAddons();
  const accent = useCalendarColors().colors.recipes;
  if (!loaded) return <CenteredLoader color={accent} />;
  if (!isUnlocked('recipes')) return <AddonLockedView addon="recipes" />;
  return <KitchenHome />;
}

function KitchenHome() {
  const [pane, setPane] = useState<KitchenPane>('planner');
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = useNavigation<Nav>();
  const params = useRoute<RouteProp<KitchenStackParamList, 'KitchenHome'>>().params;
  const paneParam = params?.pane;
  const weekStartParam = params?.weekStart;
  const accent = useCalendarColors().colors.recipes;

  // The Planner and Grocery panes share one shopping period (a week — or two,
  // for biweekly shoppers — starting on the grocery shopping day) so flipping
  // between them shows the same span.
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  // configuredDay is null until the household picks a shopping day (no schedule
  // by default). The planner still needs concrete week boundaries, so period
  // math falls back to Saturday — but the summary card reads "Not set".
  const configuredDay = settingsQ.data?.groceryShoppingDay ?? null;
  const groceryDay = configuredDay ?? 6;
  const frequency: GroceryFrequency = settingsQ.data?.groceryFrequency ?? 'weekly';
  const anchor = settingsQ.data?.groceryAnchor ?? null;
  const periodDays = periodDaysOf(frequency);
  const settingsLoaded = !!settingsQ.data;
  // Default: weekly on Saturday (6) until settings load; realigned below.
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), 6));

  // Realign the period once settings load, and again if the schedule changes
  // (the schedule modal only invalidates the settings query). A pending
  // `weekStart` param (from the calendar's grocery icon) takes precedence, so
  // don't clobber it here — its own effect below aligns and clears it.
  // `weekStartParam` is intentionally NOT a dep: this must not re-fire (and snap
  // back to the current period) when the param effect clears the param.
  useEffect(() => {
    if (settingsLoaded && !weekStartParam) setWeekStart(periodStartOf(new Date(), groceryDay, frequency, anchor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, groceryDay, frequency, anchor]);

  // Land on the shopping period containing a requested date (the calendar's
  // grocery icon passes its day). Wait for settings so the period aligns to the
  // real grocery day/frequency, then clear the param so it isn't re-applied.
  useEffect(() => {
    if (weekStartParam && settingsLoaded) {
      setWeekStart(periodStartOf(new Date(`${weekStartParam}T00:00:00`), groceryDay, frequency, anchor));
      navigation.setParams({ weekStart: undefined });
    }
  }, [weekStartParam, settingsLoaded, groceryDay, frequency, anchor, navigation]);

  // The pane is chosen by the `pane` param alone (see types.ts) — never inferred
  // from `scrollToDate`. That separation is what lets the calendar's grocery cart
  // open the shopping list *and* leave a planner highlight waiting: PlannerPane
  // isn't mounted yet, so it consumes the day whenever the user flips over.
  // Clear the param so returning here later doesn't re-apply it.
  useEffect(() => {
    if (paneParam) {
      setPane(paneParam);
      navigation.setParams({ pane: undefined });
    }
  }, [paneParam, navigation]);

  // A single header action. The recipe library used to sit here as a wide
  // "Recipes" text button, which pushed the "Meals" title off centre — every
  // other view in the app centres its title, so the destination moved into the
  // overflow menu with the rest of this screen's entry points.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderIconButton
          icon="ellipsis-horizontal"
          onPress={() => setMenuOpen(true)}
          accessibilityLabel="Meals options"
        />
      ),
    });
  }, [navigation]);

  const endDate = new Date(weekStart);
  endDate.setDate(endDate.getDate() + periodDays - 1);
  // Every period reads as its distance from the one you're in — "This Week",
  // "Next Week", "Three Weeks", "Three Weeks Ago" — so the label answers
  // "where am I?" without the reader parsing dates. The concrete date lives in
  // the caption below, where it belongs to the trip.
  const currentStart = periodStartOf(new Date(), groceryDay, frequency, anchor);
  const md = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dateRange = `${md(weekStart)} – ${md(endDate)}`;
  const weekLabel = periodLabel(weekStart, currentStart);
  const shiftWeek = (dir: number) => setWeekStart((w) => { const n = new Date(w); n.setDate(n.getDate() + dir * periodDays); return n; });

  // The caption is the trip that opens this period, and how far off it is:
  // "Shop Sat, Aug 15 (in 4 days)". The span the period covers is deliberately
  // NOT here — a period starts on its shopping day, so the range only ever
  // restated the trip date and then added an end date nobody shops by. What a
  // shopper needs from this line is when to go, and how soon that is.
  //
  // "Sat, Aug 15" comes from one `toLocaleDateString`, so the comma and the
  // field order follow the reader's locale rather than a hand-joined format.
  // Past tense once the trip has been and gone, which is what lets last
  // period's list explain its own checked boxes.
  const tripState = shoppingDayState(weekStart, periodDays);
  const tripDate = weekStart.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const trip = `${tripState === 'past' ? 'Shopped' : 'Shop'} ${tripDate} (${relativeDay(weekStart)})`;
  // Until a shopping day is configured there is no honest trip to name — the
  // period maths falls back to Saturday, and announcing a day nobody chose
  // would be a lie the setup card above is busy asking them to fix. The range
  // stands in, since the label is relative and carries no date of its own.
  const periodCaption = configuredDay != null ? trip : dateRange;

  return (
    <View style={styles.screen}>
      {/* Unset, the schedule is a real call to action and earns a card — the
          whole screen's period maths hangs off the answer. Once it's configured
          the card would only echo a setting, so it goes; editing it lives in the
          nav bar's options menu with the rest of this screen's configuration. */}
      {configuredDay == null ? (
        <TouchableOpacity activeOpacity={0.85} style={styles.scheduleWrap} onPress={() => navigation.navigate('GrocerySchedule')}>
          <Card style={styles.scheduleCard}>
            <Ionicons name="calendar-outline" size={18} color={accent} />
            <View style={styles.scheduleCardText}>
              <Text style={styles.scheduleCardTitle}>Grocery Shopping Schedule</Text>
              <Text style={styles.scheduleCardSummary}>{scheduleSummary(configuredDay, frequency)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </Card>
        </TouchableOpacity>
      ) : null}
      {/* The period, and nothing else. "This Week" is the fast read; the caption
          beneath carries the facts it stands for — and the reason the caption is
          not a tap target is that it describes what you're looking at rather
          than offering to change something. */}
      <View style={[styles.weekNav, configuredDay != null && styles.weekNavTop]}>
        <TouchableOpacity onPress={() => shiftWeek(-1)} style={styles.navBtn}><Ionicons name="chevron-back" size={22} color="#fff" /></TouchableOpacity>
        {/* The caption is its own element, so VoiceOver reads the dates and the
            trip once — the button announces only what tapping it does. */}
        <TouchableOpacity onPress={() => setWeekStart(currentStart)} accessibilityRole="button" accessibilityLabel={`${weekLabel}. Go to the current period`}>
          <Text style={styles.weekLabel}>{weekLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => shiftWeek(1)} style={styles.navBtn}><Ionicons name="chevron-forward" size={22} color="#fff" /></TouchableOpacity>
      </View>
      {periodCaption ? (
        <Text style={styles.periodDates}>{periodCaption}</Text>
      ) : null}
      <View style={styles.segmentWrap}>
        <SegmentedControl<KitchenPane>
          value={pane}
          onChange={setPane}
          options={[
            { label: 'Meal Planner', value: 'planner' },
            { label: 'Grocery List', value: 'grocery' },
          ]}
        />
      </View>
      <View style={styles.body}>
        {pane === 'grocery'
          ? <GroceryPane weekStart={weekStart} onShowPlanner={() => setPane('planner')} />
          : <PlannerPane weekStart={weekStart} />}
      </View>
      {/* Everything this screen leads to, in one place: the recipe library and
          the two settings. All three used to be scattered — Recipes as a header
          button wide enough to shove the title off centre, the schedule as a
          hero card above the list, the section order as an unlabelled glyph on
          the grocery card. Closing is caller-driven (flip `visible` before
          navigating) so the sheet leaves instantly instead of animating out over
          the pushed screen. */}
      {/* No sheet title: the nav bar behind it already says "Meals", and every
          row states what it is and where it goes. "Meals options" also promised
          settings and then opened with a destination. The `⋯` button keeps that
          wording as its accessibility label, where it describes the control
          rather than the contents. */}
      <BottomSheet visible={menuOpen} onClose={() => setMenuOpen(false)}>
        {/* The destination comes first; the settings are what you reach for
            less often. Each row is announced as one button — without an explicit
            label VoiceOver reads a title and its value as unrelated strings. */}
        <TouchableOpacity
          style={styles.menuRow}
          onPress={() => { setMenuOpen(false); navigation.navigate('Recipes'); }}
          accessibilityRole="button"
          accessibilityLabel="Recipes, your recipe library"
        >
          <MaterialCommunityIcons name={RECIPE_ICON} size={22} color={colors.text} />
          <View style={styles.menuRowText}>
            <Text style={styles.menuLabel}>Recipes</Text>
            <Text style={styles.menuValue}>Your recipe library</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.menuRow}
          onPress={() => { setMenuOpen(false); navigation.navigate('GrocerySchedule'); }}
          accessibilityRole="button"
          accessibilityLabel={`Grocery Shopping Schedule, ${scheduleSummary(configuredDay, frequency)}`}
        >
          <Ionicons name="calendar-outline" size={22} color={colors.text} />
          <View style={styles.menuRowText}>
            <Text style={styles.menuLabel}>Grocery Shopping Schedule</Text>
            <Text style={styles.menuValue}>{scheduleSummary(configuredDay, frequency)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.menuRow}
          onPress={() => { setMenuOpen(false); navigation.navigate('MealPlannerSettings'); }}
          accessibilityRole="button"
          accessibilityLabel="Grocery List Sections, the order Organize walks your store"
        >
          <MaterialCommunityIcons name="sort" size={22} color={colors.text} />
          <View style={styles.menuRowText}>
            {/* Named for the screen it opens, not for what it does — a menu row
                whose words don't match the title it lands on reads as a wrong turn. */}
            <Text style={styles.menuLabel}>Grocery List Sections</Text>
            <Text style={styles.menuValue}>The order Organize walks your store</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scheduleWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  scheduleCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scheduleCardText: { flex: 1 },
  scheduleCardTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  scheduleCardSummary: { fontSize: 13, color: colors.textMuted, marginTop: 1 },
  segmentWrap: { padding: spacing.md, paddingBottom: spacing.sm },
  // The chevrons' own touch padding (navBtn) renders as part of the gap, so
  // only a small top margin is needed to match the stack's vertical rhythm.
  weekNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, marginTop: spacing.sm },
  // With the card gone the week nav is the first thing under the header, so it
  // takes over the top padding the card used to supply.
  weekNavTop: { marginTop: spacing.md },
  navBtn: { padding: spacing.sm },
  weekLabel: { fontSize: 16, fontWeight: '700', color: colors.text },
  // A caption on the period, not a second heading and not a control: centred
  // under the label, muted, and deliberately not tappable.
  periodDates: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: -2 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 14, paddingHorizontal: spacing.xs },
  menuRowText: { flex: 1 },
  menuLabel: { fontSize: 16, color: colors.text },
  // Each row states its current value, so the menu answers "when do I shop?"
  // without the user having to open the screen behind it.
  menuValue: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  body: { flex: 1 },
});
