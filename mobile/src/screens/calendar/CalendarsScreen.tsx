import React, { useEffect } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { householdApi } from '../../api';
import {
  CALENDARS,
  CalendarDef,
  CustomCalendar,
  useCalendarVisibility,
  useCalendarColors,
  useCustomCalendars,
  useDeletedDefaultCalendars,
  useCalendarOrder,
  sortByCalendarOrder,
  refreshCustomCalendars,
} from '../../lib/calendarPrefs';
import { ADDON_CALENDAR_IDS, useOwnedAddons } from '../../lib/addons';
import { useBilling } from '../../hooks/useBilling';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

// Feature home screen the Open pill on a calendar's row launches —
// mirrors LINK_TARGETS in client/src/views/CalendarsView.vue.
const LINK_TARGETS: Record<string, keyof CalendarStackParamList> = {
  maintenance: 'MaintenanceHome',
  chores: 'ChoresHome',
  recipes: 'KitchenHome',
  trips: 'Trips',
  birthdays: 'Birthdays',
  weather: 'Weather',
};

// Where a custom calendar sorts: Just me (no sharing), Household (everyone),
// or Shared (specific members / outside contacts, incl. calendars shared to us).
function customGroup(cal: CustomCalendar): 'justMe' | 'household' | 'shared' {
  if (cal.sharedWithHousehold) return 'household';
  if (!cal.mine || cal.sharedWith.length > 0 || cal.sharedWithOutside.length > 0) return 'shared';
  return 'justMe';
}

// "Meals, Maintenance, Trips, Occasions & Chores" — the storefront row's subtitle.
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

// Calendars grouped by who can see them. Rows are single-purpose: tapping a
// row toggles that calendar's visibility (persisted to AsyncStorage; drives
// the calendar grid + events list), and navigation lives in the explicit
// trailing control — an accent "Open" pill for feature-backed calendars, an
// info button (edit form / holidays editor) for the rest. Built-ins delete
// from Edit Calendar; Add Calendar (the header +) restores them. Locked
// add-on calendars collapse into the permanent storefront row closing
// HOUSEHOLD (it stays once everything is owned — stable entry point).
export default function CalendarsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const { visibility, setVisible } = useCalendarVisibility();
  const { colors: calColors } = useCalendarColors();
  const { calendars: customCalendars } = useCustomCalendars();
  const { deletedIds } = useDeletedDefaultCalendars();
  const { order } = useCalendarOrder();
  const { isUnlocked } = useOwnedAddons();
  // The billing query refreshes the owned-add-on cache used by isUnlocked.
  useBilling();
  // Pick up calendars a housemate shared since the last background refresh.
  useEffect(() => {
    void refreshCustomCalendars();
  }, []);

  // Honour the display order set in Colours & Order (per-group, so the
  // sharing tiers stay intact while calendars sort within them).
  // Locked add-on calendars leave the HOUSEHOLD group and are named on the
  // storefront row below it instead.
  const defaults = sortByCalendarOrder(
    CALENDARS.filter((c) => !deletedIds.includes(c.id) && isUnlocked(c.id)),
    order
  );
  // Locked add-ons in the store's canonical order (matches the AddOns screen).
  const lockedAddons = ADDON_CALENDAR_IDS.filter((id) => !isUnlocked(id))
    .map((id) => CALENDARS.find((c) => c.id === id))
    .filter((c): c is CalendarDef => !!c);
  const inGroups = (...gs: ('justMe' | 'household' | 'shared')[]) =>
    sortByCalendarOrder(customCalendars.filter((c) => gs.includes(customGroup(c))), order);

  // In a single-member household the Just me / Household split carries no
  // information — everything IS the household — so JUST ME merges into
  // HOUSEHOLD for display. The data stays unshared: when a second member
  // joins, unshared calendars move to a now-meaningful JUST ME group instead
  // of being silently exposed. Unknown member count (first load) keeps the
  // split, the safe reading.
  const membersQ = useQuery({
    queryKey: ['household', 'memberCount'],
    queryFn: async () => (await householdApi.get()).data.members?.length ?? 1,
    staleTime: 5 * 60_000,
  });
  const solo = membersQ.data === 1;

  // Holiday calendars are custom records now, so they sort by who can see them
  // alongside subscriptions and hand-made calendars. HOUSEHOLD leads: it holds
  // the built-ins and is where most interaction happens (most-used content
  // first beats the mine→ours narrative on a scrolling list).
  const groups: { label: string; defaults: CalendarDef[]; custom: CustomCalendar[] }[] = [
    { label: 'HOUSEHOLD', defaults, custom: solo ? inGroups('household', 'justMe') : inGroups('household') },
    { label: 'JUST ME', defaults: [], custom: solo ? [] : inGroups('justMe') },
    { label: 'SHARED', defaults: [], custom: inGroups('shared') },
  ];

  // The storefront row names every add-on calendar (the full catalog, in store
  // order) with no price — the store screen does the selling. Once everything
  // is owned the subtitle flips to the "All add-ons added" status line.
  const allAddonNames = ADDON_CALENDAR_IDS
    .map((id) => CALENDARS.find((c) => c.id === id)?.name)
    .filter((n): n is string => !!n);

  // The tappable toggle body of a row: a leading Apple-style on/off circle + name
  // (+subtitle). The whole area flips visibility; dimming signals "hidden by
  // choice". The circle carries the calendar's colour (dimmed when hidden), so
  // no separate accent bar is needed.
  const toggleArea = (
    id: string,
    name: string,
    tint: string,
    on: boolean,
    subtitle?: string | null
  ) => (
    <TouchableOpacity
      style={styles.toggleArea}
      activeOpacity={0.7}
      onPress={() => setVisible(id, !on)}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${name} calendar`}
      accessibilityHint={on ? 'Hides its events on the calendar' : 'Shows its events on the calendar'}
    >
      {/* Apple-style on/off control: a filled check-circle when the calendar is
          shown, an empty circle when hidden — tinted with the calendar's colour. */}
      <Ionicons
        name={on ? 'checkmark-circle' : 'ellipse-outline'}
        size={24}
        color={tint}
        style={!on && styles.circleOff}
      />
      <View style={styles.nameWrap}>
        <Text style={[styles.name, !on && styles.nameOff]}>{name}</Text>
        {subtitle ? <Text style={styles.nameSub}>{subtitle}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  // Every row carries the edit (info) button — the one consistent path to a
  // calendar's colour/alerts/delete. Feature-backed calendars additionally get
  // the Open pill to their home screen, so neither destination is buried.
  const renderDefault = (cal: CalendarDef) => {
    const on = visibility[cal.id] !== false;
    const link = LINK_TARGETS[cal.id];
    const tint = calColors[cal.id] ?? cal.color;
    return (
      <View key={cal.id} style={styles.row}>
        {toggleArea(cal.id, cal.name, tint, on)}
        {link ? (
          <TouchableOpacity
            style={[styles.openPill, { borderColor: tint }]}
            activeOpacity={0.7}
            onPress={() => nav.navigate(link as any)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${cal.name}`}
          >
            <Text style={[styles.openPillText, { color: tint }]}>Open</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.infoBtn}
          activeOpacity={0.7}
          onPress={() => nav.navigate('AddCalendar', { calendarId: cal.id })}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${cal.name} calendar`}
        >
          <Ionicons name="information-circle-outline" size={22} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  };

  // Custom rows share the default rows' anatomy: the edit (info) button opens
  // the Edit Calendar form, and holiday calendars — whose "feature home" is
  // their holidays editor (which days show) — additionally get the Open pill.
  // The subtitle names the kind and — in the SHARED group, where rows would
  // otherwise be unexplained — the sharing direction ("Shared by you · N" /
  // "Shared with you"). Household-wide calendars skip the direction; their
  // group says it.
  const renderCustom = (cal: CustomCalendar) => {
    const on = visibility[cal.id] !== false;
    const isHoliday = !!cal.holiday;
    const kind = isHoliday ? 'Holidays' : cal.feedUrl ? 'Subscription' : null;
    const sharedCount = cal.sharedWith.length + cal.sharedWithOutside.length;
    const direction = !cal.mine
      ? 'Shared with you'
      : !cal.sharedWithHousehold && sharedCount > 0
      ? `Shared by you · ${sharedCount} ${sharedCount === 1 ? 'contact' : 'contacts'}`
      : null;
    const subtitle = [kind, direction].filter(Boolean).join(' · ') || null;
    return (
      <View key={cal.id} style={styles.row}>
        {toggleArea(cal.id, cal.name, cal.color, on, subtitle)}
        {isHoliday ? (
          <TouchableOpacity
            style={[styles.openPill, { borderColor: cal.color }]}
            activeOpacity={0.7}
            onPress={() => nav.navigate('Holidays', { calendarId: cal.id })}
            accessibilityRole="button"
            accessibilityLabel={`Open ${cal.name}`}
          >
            <Text style={[styles.openPillText, { color: cal.color }]}>Open</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.infoBtn}
          activeOpacity={0.7}
          onPress={() => nav.navigate('AddCalendar', { calendarId: cal.id })}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${cal.name} calendar`}
        >
          <Ionicons name="information-circle-outline" size={22} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {groups
        // HOUSEHOLD always renders — it hosts the permanent storefront row,
        // even if every household calendar is deleted/locked.
        .filter((g) => g.defaults.length + g.custom.length > 0 || g.label === 'HOUSEHOLD')
        .map((group) => (
          <View key={group.label} style={styles.group}>
            <Text style={styles.groupLabel}>{group.label}</Text>
            {group.defaults.map(renderDefault)}
            {group.custom.map(renderCustom)}

            {/* The permanent Add-ons entry: the group's closing row, where
                locked calendars would otherwise sit. Full saturation —
                purchasable, not disabled; the store screen does the selling.
                It stays once everything is owned (subtitle flips to status)
                so the entry point keeps its learned location and future
                add-ons surface here without a new affordance. */}
            {group.label === 'HOUSEHOLD' ? (
              <TouchableOpacity
                style={styles.storeRow}
                activeOpacity={0.7}
                onPress={() => nav.navigate('AddOns' as any)}
                accessibilityRole="button"
                accessibilityLabel="Add-ons"
                accessibilityHint="Opens the add-ons store"
              >
                <Ionicons name="storefront-outline" size={22} color={colors.primary} />
                <View style={styles.nameWrap}>
                  <Text style={styles.storeTitle}>Add-ons</Text>
                  <Text style={styles.nameSub}>
                    {lockedAddons.length === 0 ? 'All add-ons added' : listNames(allAddonNames)}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        ))}

      <View style={styles.manageCard}>
        <TouchableOpacity
          style={styles.manageRow}
          activeOpacity={0.7}
          onPress={() => nav.navigate('CalendarColors')}
        >
          <Ionicons name="options-outline" size={20} color={colors.primary} />
          <Text style={styles.manageText}>Calendar colours & order</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <View style={styles.manageDivider} />
        <TouchableOpacity
          style={styles.manageRow}
          activeOpacity={0.7}
          onPress={() => nav.navigate('PrintCalendar')}
        >
          <Ionicons name="print-outline" size={20} color={colors.primary} />
          <Text style={styles.manageText}>Print</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  group: { marginBottom: spacing.lg },
  groupLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 1, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  toggleArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8 },
  circleOff: { opacity: 0.35 },
  name: { fontSize: 16, color: colors.text },
  nameWrap: { flex: 1 },
  nameSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  nameOff: { opacity: 0.4 },
  openPill: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5 },
  openPillText: { fontSize: 13, fontWeight: '600' },
  infoBtn: { padding: 6 },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.md, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm },
  storeTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  manageCard: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  manageRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: spacing.md },
  manageText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  manageDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.md },
});
