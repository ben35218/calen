import React, { useLayoutEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tripsApi, Trip } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import { Card, Badge, RoundIconButton, SectionHeader, SkeletonList, EmptyState } from '../../components/ui';
import { tripStatusLabel, tripStatusColor } from '../../lib/tripTypes';
import { formatCalendarDate } from '../../lib/recurrence';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { useOwnedAddons } from '../../lib/addons';
import AddonLockedView from '../plan/AddonLockedView';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<TripsStackParamList, 'Trips'>;

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

// Add-on gate: Trips is a one-time purchase (see billing-plans spec). Gating at
// the home screen covers every entry path — Calendars row, deep links, AI
// navigation, restored nav state.
export default function TripsScreen() {
  const { isUnlocked, loaded } = useOwnedAddons();
  // Same skeleton the trips query shows, so an unlocked user sees one steady
  // skeleton from mount to content instead of a spinner → skeleton flip.
  if (!loaded) return <SkeletonList />;
  if (!isUnlocked('trips')) return <AddonLockedView addon="trips" />;
  return <TripsHome />;
}

function TripsHome() {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.trips;

  const tripsQ = useQuery({
    queryKey: ['trips'],
    // Offline-first (Phase 4b): sync the replica, fall back to cache offline,
    // then decrypt content over the plaintext rows.
    queryFn: async () => {
      const rows = await replica.syncedList<Trip>('Trip', async () => (await tripsApi.list()).data);
      return Promise.all(rows.map((t) => openRecord('Trip', t)));
    },
  });

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <RoundIconButton icon="add" onPress={() => navigation.navigate('TripForm', {})} bg={accent} />
      ),
    });
  }, [navigation, accent]);

  const groups = useMemo(() => {
    const trips = tripsQ.data ?? [];
    const considering = trips.filter((t) => t.status === 'considering');
    const booked = trips.filter((t) => t.status === 'booked');
    const upcoming = booked.filter((t) => !endStr(t) || endStr(t)! >= todayStr);
    const past = trips.filter((t) => t.status === 'completed' || (t.status === 'booked' && endStr(t) && endStr(t)! < todayStr));
    const byStart = (a: Trip, b: Trip) => new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime();
    return [
      { label: 'Considering', items: considering },
      { label: 'Upcoming', items: upcoming.sort(byStart) },
      { label: 'Past', items: past.sort((a, b) => byStart(b, a)) },
    ].filter((g) => g.items.length > 0);
  }, [tripsQ.data]);

  if (tripsQ.isLoading) {
    return <SkeletonList />;
  }

  return (
    <View style={styles.screen}>
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={tripsQ.isRefetching} onRefresh={tripsQ.refetch} />}
      >
        {groups.length === 0 ? (
          <EmptyState
            variant="inline"
            icon="briefcase-outline"
            title="No trips yet"
            message="Add a trip to plan bookings and split expenses with everyone coming along."
            actionLabel="Add Trip"
            onAction={() => navigation.navigate('TripForm', {})}
            accent={accent}
          />
        ) : (
          groups.map((g) => (
            <View key={g.label} style={styles.group}>
              <SectionHeader>{g.label}</SectionHeader>
              {g.items.map((t) => (
                <TouchableOpacity key={t._id} activeOpacity={0.8} onPress={() => navigation.navigate('TripDetail', { id: t._id })}>
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
                  </Card>
                </TouchableOpacity>
              ))}
            </View>
          ))
        )}
      </KeyboardAwareScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  group: { marginBottom: spacing.lg },
  tripCard: { flexDirection: 'row', padding: 0, paddingVertical: spacing.md, paddingRight: spacing.md, overflow: 'hidden', marginBottom: spacing.sm },
  bar: { width: 5, alignSelf: 'stretch' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  name: { fontSize: 17, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
