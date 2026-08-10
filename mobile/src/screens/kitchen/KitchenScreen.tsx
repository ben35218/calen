import React, { useEffect, useLayoutEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../../api';
import { Card, CenteredLoader, SegmentedControl } from '../../components/ui';
import PlannerPane from './PlannerPane';
import GroceryPane from './GroceryPane';
import { GroceryFrequency, iso, periodDaysOf, periodStartOf, scheduleSummary, startOfWeek } from './constants';
import { useCalendarColors } from '../../lib/calendarPrefs';
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

  // The recipe library entry point lives in the header's top-right corner.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity style={styles.recipesBtn} onPress={() => navigation.navigate('Recipes')}>
          <Text style={styles.recipesBtnText}>Recipes</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const endDate = new Date(weekStart);
  endDate.setDate(endDate.getDate() + periodDays - 1);
  // The current and next periods read as words; anything further shows dates.
  const currentStart = periodStartOf(new Date(), groceryDay, frequency, anchor);
  const nextStart = new Date(currentStart);
  nextStart.setDate(nextStart.getDate() + periodDays);
  const onCurrent = iso(weekStart) === iso(currentStart);
  const weekLabel = onCurrent ? 'This Week'
    : iso(weekStart) === iso(nextStart) ? 'Next Week'
    : `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const shiftWeek = (dir: number) => setWeekStart((w) => { const n = new Date(w); n.setDate(n.getDate() + dir * periodDays); return n; });

  return (
    <View style={styles.screen}>
      <TouchableOpacity activeOpacity={0.85} style={styles.scheduleWrap} onPress={() => navigation.navigate('GrocerySchedule')}>
        <Card style={styles.scheduleCard}>
          <Ionicons name="calendar-outline" size={18} color={accent} />
          <View style={styles.scheduleCardText}>
            <Text style={styles.scheduleCardTitle}>Grocery Schedule</Text>
            <Text style={styles.scheduleCardSummary}>{scheduleSummary(configuredDay, frequency)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Card>
      </TouchableOpacity>
      <View style={styles.weekNav}>
        <TouchableOpacity onPress={() => shiftWeek(-1)} style={styles.navBtn}><Ionicons name="chevron-back" size={22} color="#fff" /></TouchableOpacity>
        <TouchableOpacity onPress={() => setWeekStart(currentStart)}>
          <Text style={styles.weekLabel}>{weekLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => shiftWeek(1)} style={styles.navBtn}><Ionicons name="chevron-forward" size={22} color="#fff" /></TouchableOpacity>
      </View>
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
  // Transparent text-only header button, white like the rest of the header
  // chrome. No glyph: the word carries it, and a book icon beside "Recipes"
  // only repeats the label.
  recipesBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  recipesBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  // The chevrons' own touch padding (navBtn) renders as part of the gap, so
  // only a small top margin is needed to match the stack's vertical rhythm.
  weekNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, marginTop: spacing.sm },
  navBtn: { padding: spacing.sm },
  weekLabel: { fontSize: 16, fontWeight: '700', color: colors.text },
  body: { flex: 1 },
});
