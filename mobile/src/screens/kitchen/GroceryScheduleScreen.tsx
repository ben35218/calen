import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { settingsApi } from '../../api';
import { Card, SectionHeader, Skeleton } from '../../components/ui';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, spacing } from '../../theme';
import { DAY_NAMES_FULL, GroceryFrequency, iso, startOfWeek } from './constants';

// Grocery schedule configuration, reached from the Meals view's schedule card
// and the planner's shopping-day badge. Each tap applies immediately.
//
// The biweekly anchor (a known shopping date) fixes which alternating week is
// the shopping week; switching frequency or day re-anchors to the current week,
// and the "Next shopping day" rows let the user flip to the opposite week.
export default function GroceryScheduleScreen() {
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  // null until the user picks a day — no day is pre-selected on a fresh account.
  const configuredDay = settingsQ.data?.groceryShoppingDay ?? null;
  const groceryDay = configuredDay ?? 6;  // fallback for biweekly candidate math
  const frequency: GroceryFrequency = settingsQ.data?.groceryFrequency ?? 'weekly';
  const anchor = settingsQ.data?.groceryAnchor ?? null;

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => settingsApi.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      // Shopping-day markers on the calendar views come from the same setting.
      qc.invalidateQueries({ queryKey: ['calendar'] });
      // The server sizes these ranges from the cadence, so refetch even when
      // the period start (the query key) is unchanged.
      qc.invalidateQueries({ queryKey: ['grocery-list'] });
      qc.invalidateQueries({ queryKey: ['recipe-schedule'] });
    },
  });
  const pending = update.isPending;
  // The row whose tap started the save — it carries the accent spinner while
  // the others dim, so the brief no-tap window reads as saving, not a dead UI.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // Anchor to the week containing today so the current week stays a shopping
  // week when the cadence or day changes.
  const anchorForToday = (day: number) => iso(startOfWeek(new Date(), day));

  const setFrequency = (f: GroceryFrequency) => {
    if (f === frequency || pending) return;
    update.mutate(f === 'biweekly'
      ? { groceryFrequency: f, groceryAnchor: anchorForToday(groceryDay) }
      : { groceryFrequency: f });
  };
  const setDay = (day: number) => {
    if (day === configuredDay || pending) return;
    update.mutate(frequency === 'biweekly'
      ? { groceryShoppingDay: day, groceryAnchor: anchorForToday(day) }
      : { groceryShoppingDay: day });
  };

  // The two possible upcoming shopping days under a biweekly cadence: the next
  // occurrence of the weekday, and the one a week later.
  const next = new Date();
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + ((groceryDay - next.getDay() + 7) % 7));
  const candidates = [next, new Date(next.getTime() + 7 * 86400000)];
  const isShoppingWeek = (d: Date) => {
    if (!anchor) return iso(d) === iso(candidates[0]);
    const a = startOfWeek(new Date(`${anchor}T00:00:00`), groceryDay);
    const weeks = Math.round((startOfWeek(d, groceryDay).getTime() - a.getTime()) / 604800000);
    return ((weeks % 2) + 2) % 2 === 0;
  };
  const dateLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  const checkRow = (label: string, selected: boolean, onPress: () => void, first: boolean, key?: string) => {
    const k = key ?? label;
    // A tap on the current value is a no-op (the setters bail), so a stale
    // pendingKey never shows a spinner — it only reads while `pending` is true.
    return (
      <TouchableOpacity
        key={k}
        style={[styles.row, !first && styles.rowBorder, pending && k !== pendingKey && styles.rowDimmed]}
        onPress={() => { setPendingKey(k); onPress(); }}
        disabled={pending}
      >
        <Text style={[styles.rowLabel, selected && { color: accent, fontWeight: '700' }]}>{label}</Text>
        {pending && k === pendingKey ? (
          <ActivityIndicator size="small" color={accent} />
        ) : selected ? (
          <Ionicons name="checkmark" size={20} color={accent} />
        ) : null}
      </TouchableOpacity>
    );
  };

  if (settingsQ.isLoading) {
    return <ScheduleSkeleton />;
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>The meal planner and grocery list cover one shopping trip at a time.</Text>

      <SectionHeader style={[styles.groupHeader, { color: accent }]}>How often</SectionHeader>
      <Card style={styles.card}>
        {checkRow('Every week', frequency === 'weekly', () => setFrequency('weekly'), true)}
        {checkRow('Every 2 weeks', frequency === 'biweekly', () => setFrequency('biweekly'), false)}
      </Card>

      <SectionHeader style={[styles.groupHeader, { color: accent }]}>Shopping day</SectionHeader>
      <Card style={styles.card}>
        {DAY_NAMES_FULL.map((d, i) => checkRow(d, configuredDay === i, () => setDay(i), i === 0, d))}
      </Card>

      {frequency === 'biweekly' ? (
        <>
          <SectionHeader style={[styles.groupHeader, { color: accent }]}>Next shopping day</SectionHeader>
          <Card style={styles.card}>
            {candidates.map((d, i) =>
              checkRow(dateLabel(d), isShoppingWeek(d), () => update.mutate({ groceryAnchor: iso(d) }), i === 0, iso(d))
            )}
          </Card>
        </>
      ) : null}
    </ScrollView>
  );
}

// The screen's fixed shape while settings load: hint line, then the grouped
// cards (cadence / day / anchor) each as an eyebrow plus a few check rows.
function ScheduleSkeleton() {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Skeleton width={'78%'} height={13} style={styles.hintSkel} />
      {[2, 4, 2].map((rows, g) => (
        <View key={g}>
          <Skeleton width={72} height={12} style={styles.groupHeader} />
          <Card style={styles.card}>
            {Array.from({ length: rows }).map((_, i) => (
              <View key={i} style={[styles.row, i > 0 && styles.rowBorder]}>
                <Skeleton width={i % 2 ? '34%' : '46%'} height={15} />
              </View>
            ))}
          </Card>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  hint: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm },
  groupHeader: { marginTop: spacing.md, marginBottom: spacing.xs },
  card: { paddingVertical: 0 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  // Fade the untouched rows while a save is in flight — the tapped one keeps
  // full strength and carries the spinner.
  rowDimmed: { opacity: 0.4 },
  rowLabel: { fontSize: 15, color: colors.text },
  hintSkel: { marginBottom: spacing.sm },
});
