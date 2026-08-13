import React, { useLayoutEffect } from 'react';
import {
  FlatList,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { Text } from '../../components/Text';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { choresApi, contactsApi, Chore, Contact } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import { useAuth } from '../../store/auth';
import { CenteredLoader, RoundIconButton, SkeletonList, EmptyState, IconAvatar, CardRow, Fab } from '../../components/ui';
import { useOwnedAddons } from '../../lib/addons';
import AddonLockedView from '../plan/AddonLockedView';
import CalenChatIcon from '../../components/CalenChatIcon';
import { recurrenceLabel, mdiName } from '../../lib/recurrence';
import { collapseScopedRecords, hasUpcomingOccurrence } from '../../lib/repeatingItemScope';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'ChoresHome'>;

// Mirrors client/src/views/ChoresDashboardView.vue — a dedicated chores list,
// separate from the maintenance (items) flow.
//
// Free add-on gate: Chores is included with the app but OPT-IN (see
// billing-plans spec) — until the household adds it from the Add-ons screen,
// every entry path lands on the locked view.
export default function ChoresScreen() {
  const { isUnlocked, loaded } = useOwnedAddons();
  const accent = useCalendarColors().colors.chores;
  if (!loaded) return <CenteredLoader color={accent} />;
  if (!isUnlocked('chores')) return <AddonLockedView addon="chores" />;
  return <ChoresHome />;
}

function ChoresHome() {
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const accent = useCalendarColors().colors.chores;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <RoundIconButton icon="add" onPress={() => navigation.navigate('AddChore')} bg={accent} />
      ),
    });
  }, [navigation, accent]);

  const choresQ = useQuery({
    queryKey: ['chores', 'list'],
    // Offline-first (Phase 4b): sync the replica, fall back to cache offline,
    // then decrypt content over the plaintext rows.
    queryFn: async () => {
      const rows = await replica.syncedList<Chore>('Chore', async () => (await choresApi.list()).data);
      return Promise.all(rows.map((c) => openRecord('Chore', c)));
    },
  });

  // `assignedTo` on an opaque-store chore is just a Contact id, so resolve the
  // display name against the decrypted contacts list rather than a populated doc.
  const contactsQ = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const rows = await replica.syncedList<Contact>('Contact', async () => (await contactsApi.list()).data);
      return Promise.all(rows.map((p) => openRecord('Contact', p)));
    },
  });

  const contactsById = React.useMemo(() => {
    const m = new Map<string, Contact>();
    for (const p of contactsQ.data ?? []) m.set(String(p._id), p);
    return m;
  }, [contactsQ.data]);

  const assigneeName = (chore: Chore): string => {
    const a = chore.assignedTo;
    const contactId = !a ? null : typeof a === 'string' ? a : a._id;
    const contact = contactId ? contactsById.get(String(contactId)) : null;
    if (!contact) return 'Unassigned';
    if (user && contact.accountId && String(contact.accountId) === String(user._id)) return 'You';
    return contact.name || 'Unassigned';
  };

  if (choresQ.isLoading) {
    return <SkeletonList />;
  }

  // One card per chore: a detached one-off copy ("Save for This Chore Only")
  // and a forked-away predecessor ("Save for Future Chores") are scoping
  // records for a chore already on the list, not chores of their own.
  //
  // A chore ended by "Delete All Future Chores" keeps its record — the days
  // already behind it still render on the calendar — but to the user it is
  // DELETED, so it leaves this list entirely rather than lingering in an
  // "ended" group demanding a second delete. Its past calendar days stay its
  // route to the detail page (Resume schedule, or a full delete from the
  // series' first day) — see maintenance.md.
  const active = collapseScopedRecords(choresQ.data ?? []).filter((c) => hasUpcomingOccurrence(c));

  const choreRow = (chore: Chore) => (
    <CardRow
      key={chore._id}
      onPress={() => navigation.navigate('ChoreDetail', { id: chore._id })}
      leading={<IconAvatar mdiIcon={mdiName(chore.icon)} size={40} bg={accent} />}
      title={chore.title}
      subtitle={
        <>
          <Ionicons name="person-outline" size={13} color={colors.textMuted} />
          <Text style={styles.sub}>{assigneeName(chore)}</Text>
          {chore.recurrence ? (
            <>
              <Ionicons name="repeat" size={13} color={colors.textMuted} style={{ marginLeft: 8 }} />
              <Text style={styles.sub}>{recurrenceLabel(chore.recurrence)}</Text>
            </>
          ) : null}
        </>
      }
    />
  );

  // Opens the Chores assistant (a resizable form sheet). Shown on both the empty
  // and populated states, matching how item detail opens the maintenance chat.
  const assistantFab = (
    <Fab bg={accent} onPress={() => navigation.navigate('Assistant', { initial: 'chores' })}>
      <CalenChatIcon size={26} color="#fff" />
    </Fab>
  );

  // An ended chore is deliberately indistinct from a deleted one here, so the
  // all-ended state IS the empty state.
  if (!active.length) {
    return (
      <>
        <EmptyState
          mdiIcon="broom"
          title="No chores yet"
          message="Add a chore to start tracking it on your calendar."
          actionLabel="Add Chore"
          onAction={() => navigation.navigate('AddChore')}
          accent={accent}
        />
        {assistantFab}
      </>
    );
  }

  return (
    <>
      <FlatList
        style={styles.screen}
        data={active}
        keyExtractor={(c) => c._id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={choresQ.isRefetching} onRefresh={choresQ.refetch} />}
        renderItem={({ item: chore }) => choreRow(chore)}
      />
      {assistantFab}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.md },
  sub: { fontSize: 13, color: colors.textMuted },
});
