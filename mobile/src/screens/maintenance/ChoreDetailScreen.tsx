import React, { useLayoutEffect } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { choresApi, peopleApi } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { useAuth } from '../../store/auth';
import { Button, Card, Screen, ListRow, CenteredLoader, IconAvatar, ScreenTitle, HeaderIconButton, InfoCard } from '../../components/ui';
import { recurrenceLabel, dueInLabel, mdiName, formatCalendarDate } from '../../lib/recurrence';
import {
  promptItemDelete, promptResumeSchedule, resumeState, resumeSubtitle, hasUpcomingOccurrence,
} from '../../lib/repeatingItemScope';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'ChoreDetail'>;
type Rt = RouteProp<MaintenanceStackParamList, 'ChoreDetail'>;

export default function ChoreDetailScreen() {
  const navigation = useNavigation<Nav>();
  // `date` = the occurrence tapped through from the calendar; absent when opened
  // from the chores list, where the whole series is the subject.
  const { id, date } = useRoute<Rt>().params;
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.chores;
  const { user } = useAuth();

  const choreQ = useQuery({
    queryKey: ['chores', id],
    queryFn: async () => openRecord('Chore', (await choresApi.get(id)).data),
  });
  const chore = choreQ.data;

  // `assignedTo` is a Person id in the opaque store, so resolve the name against
  // the decrypted people list rather than a populated doc.
  const peopleQ = useQuery({
    queryKey: ['people'],
    queryFn: async () => Promise.all((await peopleApi.list()).data.map((p) => openRecord('Person', p))),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['chores'] });
    // Chores also render on the calendar, which caches under ['calendar'].
    qc.invalidateQueries({ queryKey: ['calendar'] });
  };

  // The chosen action is the mutation's argument, so Delete keeps its pending
  // state whichever scope the user picks — same shape as the event screens.
  const del = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: () => {
      invalidate();
      navigation.goBack();
    },
    onError: (e: any) => Alert.alert("Couldn't delete chore", e?.response?.data?.error || 'Delete failed'),
  });

  // Puts a skipped-down or ended series back to work from today. Same
  // perform-as-argument shape as delete, so the row keeps a pending state.
  const resume = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: invalidate,
    onError: (e: any) => Alert.alert("Couldn't resume chore", e?.response?.data?.error || 'Please try again.'),
  });

  // A one-time chore confirms once; a repeating one offers Apple's "this
  // occurrence" / "all future" choices against the day the user tapped.
  const confirmDelete = () => {
    if (!chore) return;
    promptItemDelete('chore', chore, date, (perform) => del.mutate(perform));
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderIconButton icon="pencil" accessibilityLabel="Edit chore" onPress={() => navigation.navigate('ChoreForm', { id, date })} />
      ),
    });
  }, [navigation, id, date, chore?.title]);

  if (choreQ.isLoading || !chore) {
    return <CenteredLoader color={accent} />;
  }

  const resumeInfo = resumeState(chore);
  // What the date row says. An ENDED series has no next due date, so reading the
  // anchor would report it as long overdue ("7 months overdue") when it simply
  // stopped. Keyed on having no occurrence left rather than on `until` merely
  // being set — a series ending next month hasn't ended yet.
  const dueRowTitle = date
    ? dueInLabel(`${date}T12:00:00`)
    : !hasUpcomingOccurrence(chore) && resumeInfo.endedOn
      ? `Ended ${formatCalendarDate(resumeInfo.endedOn)}`
      : dueInLabel(chore.nextDueDate);

  const a = chore.assignedTo;
  const assigneeId = !a ? null : typeof a === 'string' ? a : a._id;
  const assigneePerson = assigneeId
    ? (peopleQ.data ?? []).find((p) => String(p._id) === String(assigneeId))
    : null;
  const assignee = assigneePerson
    ? user && assigneePerson.accountId && String(assigneePerson.accountId) === String(user._id)
      ? 'You'
      : assigneePerson.name
    : null;
  const instructions = chore.instructions || chore.description || '';

  return (
    <Screen>
      <View style={styles.titleRow}>
        <IconAvatar mdiIcon={mdiName(chore.icon)} size={48} radius={12} bg={accent} />
        <View style={{ flex: 1 }}>
          <ScreenTitle>{chore.title}</ScreenTitle>
        </View>
      </View>

      <InfoCard style={styles.infoCard}>
        <ListRow icon="person-outline" title={assignee || 'Unassigned'} />
        {/* The occurrence the user opened, not the series anchor — reading
            nextDueDate straight would date every occurrence of a repeating
            chore with the first one. */}
        <ListRow icon="calendar-outline" title={dueRowTitle} />
        {chore.recurrence ? (
          <ListRow icon="repeat-outline" title={recurrenceLabel(chore.recurrence)} />
        ) : null}
        {/* Only when something is actually holding the series back. The subtitle
            states WHY the chore looks the way it does, which is what makes the
            action discoverable at all — see maintenance.md. */}
        {resumeInfo.canResume ? (
          <ListRow
            icon="play-circle-outline"
            title="Resume schedule"
            subtitle={resumeSubtitle(resumeInfo)}
            onPress={() => promptResumeSchedule('chore', chore, (perform) => resume.mutate(perform))}
          />
        ) : null}
      </InfoCard>

      {instructions ? (
        <Card style={styles.textCard}>
          <Text style={styles.overline}>Instructions</Text>
          <Text style={styles.body}>{instructions}</Text>
        </Card>
      ) : null}

      <View style={styles.deleteWrap}>
        <Button title="Delete chore" variant="danger" loading={del.isPending} onPress={confirmDelete} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  infoCard: { marginBottom: spacing.md },
  textCard: { marginBottom: spacing.md },
  deleteWrap: { marginTop: spacing.sm, marginBottom: spacing.xl },
  overline: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 4 },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
});
