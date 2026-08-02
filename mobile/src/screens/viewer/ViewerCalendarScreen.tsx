import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, SectionList, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card, CardRow, EmptyState, Hint, SkeletonList } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { useCustomCalendars, type CustomCalendar } from '../../lib/calendarPrefs';
import { loadCalendarData } from '../../lib/calendarData';
import { ensureSharedCalendarKeys } from '../../lib/calendarKeys';
import { getKeyPair, getResourceKey, currentCalendarKeyVersion } from '../../lib/e2ee';
import { useInvitationsCount } from '../../hooks/useInvitationsCount';
import type { RootStackParamList, ViewerEventSnapshot } from '../../navigation/types';
import { colors, spacing, radius } from '../../theme';

// Free viewer mode's home: the read-only shell a locked (no $4.99 unlock) user
// with shared-calendar access gets instead of the hard paywall (RootNavigator →
// ViewerNavigator). Shows ONLY the calendars shared TO this user (`mine ===
// false`) as an upcoming-events agenda — the viewer's own household lanes stay
// behind the paywall — plus the invitations inbox and the "Unlock Calen"
// upgrade path. See billing-plans.md "Free viewer mode".

type Nav = NativeStackNavigationProp<RootStackParamList, 'ViewerHome'>;

// How far ahead the agenda looks. A broadcast calendar is consumed as "what's
// coming up", not a month grid — eight weeks covers that without paging.
const AGENDA_DAYS = 56;

// Whether this device holds the calendar's current CalendarKey (the owner's
// device wraps it to a new collaborator on their next unlocked session — until
// then the shared events are ciphertext we can't open).
function keysHeld(calId: string): boolean {
  const version = currentCalendarKeyVersion(calId);
  return version > 0 && !!getResourceKey(calId, version);
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function timeLabel(e: ViewerEventSnapshot): string {
  if (e.allDay !== false) return 'All day';
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const start = new Date(e.startDate);
  const end = e.endDate ? new Date(e.endDate) : null;
  return `${fmt(start)}${end ? ` – ${fmt(end)}` : ''}`;
}

export default function ViewerCalendarScreen() {
  const navigation = useNavigation<Nav>();
  const { logout } = useAuth();
  const { calendars } = useCustomCalendars();
  const invCount = useInvitationsCount();
  const e2eeLocked = !getKeyPair();

  // The calendars shared TO this user. Feed/holiday calendars are device-local
  // derivations and can't be outside-shared — filtered for safety.
  const shared = useMemo(
    () => calendars.filter((c) => !c.mine && !c.feedUrl && !c.holiday),
    [calendars],
  );
  const sharedIds = useMemo(() => new Set(shared.map((c) => c.id)), [shared]);

  const agendaQ = useQuery({
    queryKey: ['viewer', 'agenda'],
    queryFn: async () => {
      // Load the member-wrapped CalendarKeys first (no-op once held), so the
      // shared events decrypt into the replica before the read.
      await ensureSharedCalendarKeys().catch(() => {});
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + AGENDA_DAYS * 86400_000);
      const data = await loadCalendarData({
        from: from.toISOString(),
        to: to.toISOString(),
        sync: 'background',
      });
      return data.events ?? [];
    },
    enabled: shared.length > 0,
  });

  // Re-check on every focus: an invitation accepted in the inbox, or the owner
  // finishing the share while we were away, should surface without a restart.
  useFocusEffect(
    useCallback(() => {
      if (shared.length) agendaQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shared.length]),
  );

  // Only the shared calendars' events — the viewer's own household lanes
  // (tasks, chores, own events) stay behind the paywall.
  const events = useMemo(
    () =>
      ((agendaQ.data ?? []) as ViewerEventSnapshot[])
        .filter((e) => e.calendarType && sharedIds.has(e.calendarType))
        .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()),
    [agendaQ.data, sharedIds],
  );

  const sections = useMemo(() => {
    const byDay = new Map<string, ViewerEventSnapshot[]>();
    for (const e of events) {
      const label = dayLabel(e.startDate);
      const arr = byDay.get(label) || [];
      arr.push(e);
      byDay.set(label, arr);
    }
    return [...byDay.entries()].map(([title, data]) => ({ title, data }));
  }, [events]);

  // Calendars whose key hasn't reached this device yet (the owner must open
  // Calen unlocked to wrap it) — surfaced as a waiting note per calendar.
  const waiting = shared.filter((c) => !keysHeld(c.id));

  const openEvent = (e: ViewerEventSnapshot) => {
    const cal = shared.find((c) => c.id === e.calendarType);
    navigation.navigate('ViewerEvent', {
      event: e,
      calendarName: cal?.name ?? 'Calendar',
      accent: cal?.color || colors.primary,
    });
  };

  const header = (
    <View>
      {/* The upgrade path: full Calen stays behind the one-time unlock. */}
      <Card style={styles.unlockCard}>
        <Text style={styles.unlockTitle}>You’re viewing shared calendars</Text>
        <Text style={styles.unlockSub}>
          Unlock Calen to get your own calendar, household sharing, and Calen the AI assistant.
        </Text>
        <Button title="Unlock Calen" onPress={() => navigation.navigate('UnlockPaywall')} />
      </Card>

      <CardRow
        title="Invitations"
        subtitle={invCount > 0 ? `${invCount} waiting for a reply` : 'Calendar shares you’ve been sent'}
        right={invCount > 0 ? <View style={styles.countDot}><Text style={styles.countText}>{invCount}</Text></View> : undefined}
        onPress={() => navigation.navigate('Invitations')}
      />

      {shared.length ? (
        <View style={styles.calendarList}>
          {shared.map((c: CustomCalendar) => (
            <View key={c.id} style={styles.calendarRow}>
              <View style={[styles.dot, { backgroundColor: c.color || colors.primary }]} />
              <Text style={styles.calendarName}>{c.name}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {e2eeLocked && shared.length ? (
        <Hint style={styles.hint}>
          Your data is locked — sign in again (or unlock with Face ID) to read the shared events.
        </Hint>
      ) : null}
      {!e2eeLocked && waiting.length ? (
        <Hint style={styles.hint}>
          {waiting.length === 1
            ? `Events on “${waiting[0].name}” appear once its owner opens Calen and confirms the share.`
            : 'Some events appear once each calendar’s owner opens Calen and confirms the share.'}
        </Hint>
      ) : null}
    </View>
  );

  return (
    <View style={styles.root}>
      <SectionList
        sections={sections}
        keyExtractor={(e) => e._id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={agendaQ.isRefetching} onRefresh={() => agendaQ.refetch()} />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          const cal = shared.find((c) => c.id === item.calendarType);
          return (
            <CardRow
              leading={<View style={[styles.dot, { backgroundColor: cal?.color || colors.primary }]} />}
              title={item.title}
              subtitle={`${timeLabel(item)}${item.location ? ` · ${item.location}` : ''}`}
              onPress={() => openEvent(item)}
            />
          );
        }}
        ListEmptyComponent={
          shared.length && agendaQ.isLoading ? (
            <SkeletonList />
          ) : (
            <EmptyState
              icon="calendar-outline"
              variant="inline"
              title={shared.length ? 'No upcoming events' : 'No shared calendars yet'}
              message={
                shared.length
                  ? 'Nothing on the shared calendars in the next few weeks.'
                  : 'When someone shares a calendar with you, accept the invitation and it appears here.'
              }
            />
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Button title="Sign out" variant="ghost" onPress={() => void logout()} />
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  unlockCard: { gap: spacing.sm, marginBottom: spacing.md },
  unlockTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  unlockSub: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  calendarList: { marginTop: spacing.md, gap: spacing.sm },
  calendarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  calendarName: { fontSize: 14, color: colors.text },
  hint: { marginTop: spacing.md },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  countDot: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  footer: { marginTop: spacing.xl },
});
