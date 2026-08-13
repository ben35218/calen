import React, { useLayoutEffect, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import { Text } from '../../components/Text';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList } from '../../navigation/types';
import { tripsApi, Trip } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import { Card, Badge, SkeletonList, EmptyState, IconAvatar, Hint } from '../../components/ui';
import { tripStatusLabel, tripStatusColor } from '../../lib/tripTypes';
import { formatCalendarDate } from '../../lib/recurrence';
import { useCalendarColors } from '../../lib/calendarPrefs';
import AssistantSwitcher from '../../components/AssistantSwitcher';
import type { AssistantId } from '../chat/assistantTabs';
import { colors, spacing } from '../../theme';

const todayStr = new Date().toISOString().slice(0, 10);

function endStr(t: Trip) {
  const d = t.endDate || t.startDate;
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

function dateSummary(t: Trip) {
  if (t.status === 'considering') {
    const n = t.candidateRanges?.length ?? 0;
    if (!n) return 'No dates chosen yet';
    if (n === 1) return `${formatCalendarDate(t.candidateRanges![0].start)} – ${formatCalendarDate(t.candidateRanges![0].end)}`;
    return `${n} date options`;
  }
  if (t.startDate) {
    const end = t.endDate && t.endDate !== t.startDate ? ` – ${formatCalendarDate(t.endDate)}` : '';
    return `${formatCalendarDate(t.startDate)}${end}`;
  }
  return 'No dates set';
}

// Trips assistant, step 1: keep the user in the Calen view and ask which trip to
// plan (or start a new one). Picking a trip hands off to the trip's assistant
// (TripAssistantScreen) in the same view; "New trip" opens the trip form.
export default function TripPickerScreen({
  onSelectAssistant,
  onPickTrip,
}: {
  onSelectAssistant?: (id: AssistantId) => void;
  onPickTrip: (tripId: string, tripName?: string) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const accent = useCalendarColors().colors.trips;

  const tripsQ = useQuery({
    queryKey: ['trips'],
    queryFn: async () => {
      const rows = await replica.syncedList<Trip>('Trip', async () => (await tripsApi.list()).data);
      return Promise.all(rows.map((t) => openRecord('Trip', t)));
    },
  });

  // No conversation here, so clear any "Clear" button a previous assistant left.
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: undefined });
  }, [navigation]);

  // A single flat list (no status groupings): considering first, then upcoming,
  // then past — each ordered by start date.
  const trips = useMemo(() => {
    const all = tripsQ.data ?? [];
    const considering = all.filter((t) => t.status === 'considering');
    const booked = all.filter((t) => t.status === 'booked');
    const upcoming = booked.filter((t) => !endStr(t) || endStr(t)! >= todayStr);
    const past = all.filter((t) => t.status === 'completed' || (t.status === 'booked' && endStr(t) && endStr(t)! < todayStr));
    const byStart = (a: Trip, b: Trip) => new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime();
    return [
      ...considering,
      ...upcoming.sort(byStart),
      ...past.sort((a, b) => byStart(b, a)),
    ];
  }, [tripsQ.data]);

  const newTripCard = (
    <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('TripForm', {})}>
      <Card style={styles.newCard}>
        <IconAvatar icon="add" bg={accent} size={44} />
        <View style={{ flex: 1 }}>
          <Text style={styles.newTitle}>New trip</Text>
          <Text style={styles.sub}>Start planning a getaway from scratch</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </Card>
    </TouchableOpacity>
  );

  return (
    <View style={styles.screen}>
      <AssistantSwitcher active="trips" onSelectAssistant={onSelectAssistant} />
      {tripsQ.isLoading ? (
        <SkeletonList />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={tripsQ.isRefetching} onRefresh={tripsQ.refetch} />}
        >
          <Hint>Which trip would you like to plan?</Hint>
          {newTripCard}
          {trips.length === 0 ? (
            <EmptyState
              variant="inline"
              icon="briefcase-outline"
              title="No trips yet"
              message="Create a trip above, then I can help you plan it."
              accent={accent}
            />
          ) : (
            trips.map((t) => (
              <TouchableOpacity key={t._id} activeOpacity={0.8} onPress={() => onPickTrip(t._id, t.name)}>
                <Card style={styles.tripCard}>
                  <View style={[styles.bar, { backgroundColor: t.color || accent }]} />
                  <View style={{ flex: 1, paddingLeft: spacing.md }}>
                    <View style={styles.titleRow}>
                      <Text style={styles.name}>{t.name}</Text>
                      <Badge label={tripStatusLabel(t.status)} color={tripStatusColor(t.status)} />
                    </View>
                    {t.destination ? <Text style={styles.sub}>{t.destination}</Text> : null}
                    <Text style={styles.sub}>{dateSummary(t)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                </Card>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  newCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  newTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  tripCard: { flexDirection: 'row', alignItems: 'center', padding: 0, paddingVertical: spacing.md, paddingRight: spacing.md, overflow: 'hidden', marginBottom: spacing.sm },
  bar: { width: 5, alignSelf: 'stretch' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  name: { fontSize: 17, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
