import React, { useLayoutEffect, useMemo } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tripsApi, Trip } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import { Card, headerAddOptions, SectionHeader, SkeletonList, EmptyState } from '../../components/ui';
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
    navigation.setOptions(headerAddOptions(accent, () => navigation.navigate('TripForm', {}), 'Add trip'));
  }, [navigation, accent]);

  const groups = useMemo(() => {
    const trips = tripsQ.data ?? [];
    // Purely date-derived: a trip whose last day has passed is Past; everything
    // else — including a trip with no dates yet — is Upcoming.
    const upcoming = trips.filter((t) => !endStr(t) || endStr(t)! >= todayStr);
    const past = trips.filter((t) => endStr(t) && endStr(t)! < todayStr);
    const byStart = (a: Trip, b: Trip) => new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime();
    return [
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
                // Row anatomy matches the Calendars screen: the body opens the
                // thing (the trip's itinerary), and the trailing ⓘ edits the
                // record's own details — so the trip view never has to carry an
                // Edit action for the container the user just came from.
                <Card key={t._id} style={styles.tripCard}>
                  <TouchableOpacity
                    style={styles.tripMain}
                    activeOpacity={0.8}
                    onPress={() => navigation.navigate('TripDetail', { id: t._id })}
                    accessibilityRole="button"
                    accessibilityLabel={t.name}
                    accessibilityHint="Opens the trip's itinerary"
                  >
                    <View style={[styles.bar, { backgroundColor: accent }]} />
                    <View style={{ flex: 1, paddingLeft: spacing.md }}>
                      <View style={styles.titleRow}>
                        <Text style={styles.name}>{t.name}</Text>
                      </View>
                      {t.destination ? <Text style={styles.sub}>{t.destination}</Text> : null}
                      <Text style={styles.sub}>{dateSummary(t)}</Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.infoBtn}
                    activeOpacity={0.7}
                    hitSlop={8}
                    onPress={() => navigation.navigate('TripForm', { id: t._id })}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${t.name}`}
                  >
                    <Ionicons name="information-circle-outline" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                </Card>
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
  tripCard: { flexDirection: 'row', alignItems: 'center', padding: 0, overflow: 'hidden', marginBottom: spacing.sm },
  tripMain: { flex: 1, flexDirection: 'row', paddingVertical: spacing.md },
  infoBtn: { padding: 6, paddingRight: spacing.md },
  bar: { width: 5, alignSelf: 'stretch' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  name: { fontSize: 17, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
