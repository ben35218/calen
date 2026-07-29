import React, { useLayoutEffect } from 'react';
import {
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { choresApi, peopleApi, Chore, Person } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import { useAuth } from '../../store/auth';
import { CenteredLoader, RoundIconButton, SkeletonList, EmptyState, IconAvatar, CardRow, Fab } from '../../components/ui';
import { useOwnedAddons } from '../../lib/addons';
import AddonLockedView from '../plan/AddonLockedView';
import CalenChatIcon from '../../components/CalenChatIcon';
import { recurrenceLabel, mdiName } from '../../lib/recurrence';
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

  // `assignedTo` on an opaque-store chore is just a Person id, so resolve the
  // display name against the decrypted people list rather than a populated doc.
  const peopleQ = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const rows = await replica.syncedList<Person>('Person', async () => (await peopleApi.list()).data);
      return Promise.all(rows.map((p) => openRecord('Person', p)));
    },
  });

  const peopleById = React.useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of peopleQ.data ?? []) m.set(String(p._id), p);
    return m;
  }, [peopleQ.data]);

  const assigneeName = (chore: Chore): string => {
    const a = chore.assignedTo;
    const personId = !a ? null : typeof a === 'string' ? a : a._id;
    const person = personId ? peopleById.get(String(personId)) : null;
    if (!person) return 'Unassigned';
    if (user && person.accountId && String(person.accountId) === String(user._id)) return 'You';
    return person.name || 'Unassigned';
  };

  if (choresQ.isLoading) {
    return <SkeletonList />;
  }

  const chores = choresQ.data ?? [];

  // Opens the Chores assistant (a resizable form sheet). Shown on both the empty
  // and populated states, matching how item detail opens the maintenance chat.
  const assistantFab = (
    <Fab bg={accent} onPress={() => navigation.navigate('Assistant', { initial: 'chores' })}>
      <CalenChatIcon size={26} color="#fff" />
    </Fab>
  );

  if (!chores.length) {
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
        data={chores}
        keyExtractor={(c) => c._id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={choresQ.isRefetching} onRefresh={choresQ.refetch} />}
        renderItem={({ item: chore }) => (
          <CardRow
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
        )}
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
