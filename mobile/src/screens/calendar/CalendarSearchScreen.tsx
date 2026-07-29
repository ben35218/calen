import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TextInput, FlatList, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { loadCalendarData } from '../../lib/calendarData';
import { getHolidays } from '../../lib/holidays';
import { useHolidayCalendars, holidayEnabledIds, useCalendarColors } from '../../lib/calendarPrefs';
import { eventColor, ymd } from '../../lib/calendar';
import { mdiName } from '../../lib/recurrence';
import { resolveTaskIcon } from '../../lib/maintenanceCategories';
import { occasionTitle, occasionNoun, occasionIcon } from '../../lib/occasions';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'CalendarSearch'>;

type Result = { key: string; title: string; subtitle: string; color: string; icon: string; date: string; nav: () => void };

// Date-only / all-day records are stored at noon UTC → read in UTC.
const ld = (s: string) => new Date(s).toISOString().slice(0, 10);
// Timed events are real instants → read in the device's local zone.
const eventLd = (e: { allDay?: boolean }, iso: string) => (e.allDay ? ld(iso) : ymd(new Date(iso)));
const dateLabel = (s: string) => new Date(s + (s.length === 10 ? 'T12:00:00' : '')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// Searches every calendar item by title (events, tasks, chores, meals, trips,
// birthdays, holidays) and jumps to its detail.
export default function CalendarSearchScreen() {
  const nav = useNavigation<Nav>();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { colors: calColors } = useCalendarColors();
  const [query, setQuery] = useState('');

  const range = useMemo(() => {
    const now = new Date();
    const from = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    const to = new Date(now.getFullYear() + 5, now.getMonth(), now.getDate());
    return { from, to };
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['calendar', 'events-list'],
    // background sync: search over the replica; the server pull revalidates behind it.
    queryFn: async () =>
      loadCalendarData({ from: range.from.toISOString(), to: range.to.toISOString(), sync: 'background' }),
  });

  const all = useMemo<Result[]>(() => {
    if (!data) return [];
    const out: Result[] = [];
    for (const e of data.events ?? []) {
      out.push({ key: `e-${e._id}`, title: e.title, subtitle: 'Event', color: eventColor(e), icon: 'calendar', date: eventLd(e, e.startDate), nav: () => nav.navigate('EventDetail', { eventId: e._id }) });
    }
    for (const t of data.tasks ?? []) {
      if (!t.nextDueDate) continue;
      out.push({ key: `t-${t._id}`, title: t.title, subtitle: 'Maintenance task', color: calColors.maintenance, icon: resolveTaskIcon(t.icon, typeof t.categoryId === 'object' ? t.categoryId?.name : null), date: ld(t.nextDueDate), nav: () => nav.navigate('TaskDetail', { id: t._id }) });
    }
    for (const c of data.chores ?? []) {
      out.push({ key: `c-${c._id}`, title: c.title, subtitle: 'Chore', color: calColors.chores, icon: mdiName(c.icon), date: c.nextDueDate ? ld(c.nextDueDate) : '', nav: () => nav.navigate('ChoreDetail', { id: c._id }) });
    }
    for (const r of data.recipes ?? []) {
      const title = typeof r.recipeId === 'object' ? r.recipeId?.title || 'Recipe' : 'Recipe';
      const rid = typeof r.recipeId === 'object' ? r.recipeId?._id : (r.recipeId as string | undefined);
      out.push({ key: `r-${r._id ?? rid}-${r.scheduledDate}`, title, subtitle: 'Meal', color: calColors.recipes, icon: 'silverware-fork-knife', date: ld(r.scheduledDate), nav: () => (rid ? nav.navigate('RecipeDetail', { id: rid }) : nav.navigate('KitchenHome')) });
    }
    for (const t of data.trips ?? []) {
      const start = t.ranges?.[0]?.start;
      out.push({ key: `trip-${t.id}`, title: t.name, subtitle: 'Trip', color: t.color || calColors.trips, icon: 'bag-suitcase', date: start ? ld(start) : '', nav: () => nav.navigate('TripDetail', { id: t.id }) });
    }
    for (const o of data.occasions ?? []) {
      out.push({ key: `occ-${o.id}`, title: occasionTitle(o), subtitle: occasionNoun(o), color: calColors.birthdays, icon: occasionIcon(o.kind), date: ld(o.date), nav: () => nav.navigate('CalendarDay', { date: ld(o.date) }) });
    }
    for (const cal of holidayCals) {
      const color = calColors[cal.id] ?? cal.color;
      for (const h of getHolidays(cal.country, range.from, range.to, holidayEnabledIds(cal))) {
        out.push({ key: `hol-${cal.id}-${h.id}-${h.date}`, title: h.name, subtitle: 'Holiday', color, icon: 'flag-variant', date: h.date, nav: () => nav.navigate('CalendarDay', { date: h.date }) });
      }
    }
    return out;
  }, [data, holidayCals, range, nav, calColors]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return all
      .filter((r) => r.title.toLowerCase().includes(q))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [all, query]);

  return (
    <View style={styles.screen}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.input}
          placeholder="Search calendar…"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(r) => r.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={item.nav}>
              <MaterialCommunityIcons name={item.icon as any} size={22} color={item.color} style={{ marginRight: spacing.md }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.sub}>{[item.subtitle, item.date ? dateLabel(item.date) : null].filter(Boolean).join(' · ')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>{query.trim() ? 'No matching items.' : 'Type to search your calendar.'}</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.surface, margin: spacing.md, paddingHorizontal: spacing.md,
    borderRadius: 12, borderWidth: 1, borderColor: colors.border,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 16, color: colors.text },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, marginBottom: spacing.sm },
  title: { fontSize: 15, fontWeight: '600', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl },
});
