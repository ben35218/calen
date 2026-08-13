import React, { useLayoutEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { Text } from '../../components/Text';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { computeNextDueDate, computeNextDueKm, avgKmPerDay, estimateDateFromKm } from '@household/calendar';
import { tasksApi, historyApi } from '../../api';
import { openRecord, sealUpdate } from '../../lib/e2ee';
import { TASK_ENC } from '../../lib/encSubsets';
import { loadOdometerData } from '../../lib/odometer';
import { Button, Card, Screen, Input, ListRow, DateField, CenteredLoader, BottomSheet, HeaderIconButton, IconAvatar } from '../../components/ui';
import { categoryMeta, resolveTaskIcon } from '../../lib/maintenanceCategories';
import {
  recurrenceLabel,
  formatCalendarDate,
  parseCalendarDate,
} from '../../lib/recurrence';
import { itemTypeConfig } from '../../lib/itemTypes';
import { useCalendarColors } from '../../lib/calendarPrefs';
import {
  promptItemDelete, promptResumeSchedule, resumeState, resumeSubtitle, hasUpcomingOccurrence,
} from '../../lib/repeatingItemScope';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'TaskDetail'>;
type Rt = RouteProp<MaintenanceStackParamList, 'TaskDetail'>;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Countdown label to the due date (no TZ rollover via parseCalendarDate).
// Within a week: "Due today" / "Due in N days" / "N days overdue". Beyond a
// week it breaks into weeks + days: "N weeks, N days until due" / "… overdue".
function dueInLabel(dueDate?: string | null): string {
  if (!dueDate) return 'No due date';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((parseCalendarDate(dueDate).getTime() - today.getTime()) / 86400000);
  const plur = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  if (days === 0) return 'Due today';

  const abs = Math.abs(days);
  if (abs <= 7) {
    return days < 0 ? `${plur(abs, 'day')} overdue` : `Due in ${plur(abs, 'day')}`;
  }
  const weeks = Math.floor(abs / 7);
  const rem = abs - weeks * 7;
  const span = rem ? `${plur(weeks, 'week')}, ${plur(rem, 'day')}` : plur(weeks, 'week');
  return days < 0 ? `${span} overdue` : `${span} until due`;
}

export default function TaskDetailScreen() {
  const navigation = useNavigation<Nav>();
  // `date` = the occurrence tapped through from the calendar; absent when opened
  // from a list or an item, where the whole series is the subject.
  const { id, date } = useRoute<Rt>().params;
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.maintenance;
  const [completeOpen, setCompleteOpen] = useState(false);
  const [form, setForm] = useState({
    completedDate: todayISO(),
    notes: '',
    odometerReading: '',
  });

  const taskQ = useQuery({
    queryKey: ['tasks', id],
    // Decrypt the task and its populated refs (their names are sealed content).
    queryFn: async () => {
      const t = await openRecord('MaintenanceTask', (await tasksApi.get(id)).data);
      if (t.itemId && typeof t.itemId === 'object') t.itemId = await openRecord('Item', t.itemId);
      if (t.categoryId && typeof t.categoryId === 'object') t.categoryId = await openRecord('Category', t.categoryId);
      return t;
    },
  });
  const task = taskQ.data;

  const historyQ = useQuery({
    queryKey: ['tasks', id, 'history'],
    queryFn: async () => (await historyApi.list({ taskId: id })).data,
  });

  const itemId = task?.itemId && typeof task.itemId === 'object' ? task.itemId._id : undefined;
  // Decrypted odometer state (Signal-parity D5): currentKm/kmPerDay are derived
  // on-device from the sealed logs.
  const odoQ = useQuery({
    queryKey: ['odometer', itemId],
    queryFn: () => loadOdometerData(itemId!),
    enabled: !!itemId && !!task?.intervalKm,
  });
  const currentKm = odoQ.data?.currentKm;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['tasks'] });
    // Tasks also surface on the calendar (agenda/day/month/search), which caches
    // under a separate ['calendar'] key — refetch it so edits show without a
    // manual pull-to-refresh.
    qc.invalidateQueries({ queryKey: ['calendar'] });
  };

  const togglePause = useMutation({
    mutationFn: () => (task?.active === false ? tasksApi.resume(id) : tasksApi.pause(id)),
    onSuccess: invalidate,
  });

  // Completion is client-computed now (Signal-parity D4/D5): the next due date
  // (shared computeNextDueDate), the mileage rollover (computeNextDueKm), and
  // the km-based estimate (avgKmPerDay/estimateDateFromKm over the decrypted
  // logs) are all derived here; the server just records what we send, plus the
  // task's re-sealed enc carrying the new nextDueDate.
  const complete = useMutation({
    mutationFn: async () => {
      const t = task!; // decrypted by taskQ
      const completedDate = new Date(form.completedDate);
      const odometerReading = form.odometerReading ? Number(form.odometerReading) : null;

      // Time-based next due date; mileage tasks keep their date unless a new
      // reading yields an estimate (the old server rule, verbatim).
      let nextDueDate: string | null;
      if (!t.intervalKm) {
        const d = t.recurrence?.type !== 'one-time' ? computeNextDueDate(t, completedDate) : null;
        nextDueDate = d ? d.toISOString() : null;
      } else {
        nextDueDate = t.nextDueDate ?? null;
      }

      const payload: Record<string, unknown> = { completedDate: form.completedDate, notes: form.notes };
      if (odometerReading != null) {
        payload.odometerReading = odometerReading;
        if (t.intervalKm) {
          const nextDueKm = computeNextDueKm(t, odometerReading);
          payload.nextDueKm = nextDueKm;
          payload.lastServiceKm = odometerReading;
          const logs = (odoQ.data?.logs ?? []).filter((l) => l.reading != null);
          const kmPerDay = avgKmPerDay([
            ...(logs as Array<{ reading: number; recordedAt: string }>),
            { reading: odometerReading, recordedAt: new Date() },
          ]);
          if (kmPerDay && nextDueKm) {
            const est = estimateDateFromKm(nextDueKm, odometerReading, kmPerDay);
            if (est) nextDueDate = est.toISOString();
          }
        }
      }
      payload.nextDueDate = nextDueDate;

      const sealed = await sealUpdate('MaintenanceTask', id, payload, TASK_ENC({ ...t, nextDueDate }));
      return tasksApi.complete(id, sealed);
    },
    onSuccess: () => {
      setCompleteOpen(false);
      setForm({ completedDate: todayISO(), notes: '', odometerReading: '' });
      invalidate();
      qc.invalidateQueries({ queryKey: ['tasks', id, 'history'] });
    },
  });

  // Puts a skipped-down or ended series back to work from today. Same
  // perform-as-argument shape as delete, so the row keeps a pending state.
  const resume = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: invalidate,
    onError: (e: any) => Alert.alert("Couldn't resume task", e?.response?.data?.error || 'Please try again.'),
  });

  // The chosen action is the mutation's argument, so Delete keeps its pending
  // state whichever scope the user picks — same shape as the event screens.
  const del = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: () => {
      invalidate();
      navigation.goBack();
    },
    onError: (e: any) => Alert.alert("Couldn't delete task", e?.response?.data?.error || 'Delete failed'),
  });

  // A one-time task confirms once; a repeating one offers Apple's "this
  // occurrence" / "all future" choices against the day the user tapped.
  //
  // Only deleting the WHOLE task drops its completion history, so the warning
  // rides with that outcome rather than being stated up front for a scope that
  // leaves the record — and its history — in place.
  const confirmDelete = () => {
    if (!task) return;
    promptItemDelete('task', task, date, (perform) => del.mutate(perform));
  };

  const isPaused = task?.active === false;
  useLayoutEffect(() => {
    // Header shows the view name, not the task name (which is in the body).
    navigation.setOptions({
      title: 'Task',
      headerRight: () => (
        <HeaderIconButton icon="pencil" accessibilityLabel="Edit task" onPress={() => navigation.navigate('TaskForm', { id, date })} />
      ),
    });
  }, [navigation, id]);

  if (taskQ.isLoading || !task) {
    return <CenteredLoader color={accent} />;
  }

  const resumeInfo = resumeState(task);
  // Same rule as the chore detail: show the occurrence the user tapped, "Ended"
  // for a series that has stopped, and the anchor's due-in only otherwise.
  const dueRowTitle = date
    ? dueInLabel(`${date}T12:00:00`)
    : !hasUpcomingOccurrence(task) && resumeInfo.endedOn
      ? `Ended ${formatCalendarDate(resumeInfo.endedOn)}`
      : dueInLabel(task.nextDueDate);

  // Category name from the populated ref, used for the header icon fallback + tint.
  const categoryName =
    task.categoryId && typeof task.categoryId === 'object' ? task.categoryId.name : null;

  const remainingKm =
    task.intervalKm && task.nextDueKm != null && currentKm != null ? task.nextDueKm - currentKm : null;
  const kmColor =
    remainingKm == null ? colors.success : remainingKm <= 0 ? colors.error : remainingKm <= 2000 ? colors.warning : colors.success;

  return (
    <Screen>
      <Card style={[styles.actionCard, { borderColor: accent }]}>
        <View style={styles.actionRow}>
          <TouchableOpacity
            onPress={() => togglePause.mutate()}
            disabled={togglePause.isPending}
            style={[styles.actionHalf, styles.actionHalfPause, { borderRightColor: accent }]}
            activeOpacity={0.8}
            accessibilityLabel={isPaused ? 'Resume task' : 'Pause task'}
          >
            {togglePause.isPending ? (
              <ActivityIndicator color={accent} />
            ) : (
              <>
                <Ionicons name={isPaused ? 'play' : 'pause'} size={22} color={accent} />
                <Text style={[styles.actionLabel, { color: accent }]}>{isPaused ? 'Resume' : 'Pause'}</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setCompleteOpen((o) => !o)}
            style={[styles.actionHalf, { backgroundColor: accent }]}
            activeOpacity={0.8}
            accessibilityLabel="Mark task done"
          >
            <Ionicons name="checkmark" size={24} color="#000" />
            <Text style={[styles.actionLabel, styles.actionLabelDone]}>Done</Text>
          </TouchableOpacity>
        </View>
      </Card>

      <Card style={styles.headerCard}>
        <View style={styles.headerTitleRow}>
          <IconAvatar
            mdiIcon={resolveTaskIcon(task.icon, categoryName)}
            bg={categoryName ? categoryMeta(categoryName).color : accent}
            size={44}
          />
          <Text style={[styles.screenTitle, styles.headerTitleText]}>{task.title}</Text>
        </View>
        {task.description ? <Text style={styles.body}>{task.description}</Text> : null}
      </Card>

      <BottomSheet visible={completeOpen} onClose={() => setCompleteOpen(false)} title="Mark Task Done" avoidKeyboard>
        <DateField
          label="Completion Date"
          value={form.completedDate}
          onChange={(v) => setForm({ ...form, completedDate: v })}
        />
        {task.intervalKm ? (
          <Input
            label="Odometer reading (km)"
            value={form.odometerReading}
            onChangeText={(v) => setForm({ ...form, odometerReading: v })}
            keyboardType="numeric"
          />
        ) : null}
        <Input
          label="Notes"
          value={form.notes}
          onChangeText={(v) => setForm({ ...form, notes: v })}
          multiline
        />
        <Button title="Done" loading={complete.isPending} onPress={() => complete.mutate()} />
      </BottomSheet>

      {remainingKm !== null ? (
        <Card style={[styles.kmCard, { borderColor: kmColor }]}>
          <Ionicons name="speedometer-outline" size={28} color={kmColor} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={[styles.kmTitle, { color: kmColor }]}>
              {remainingKm <= 0
                ? `${Math.abs(remainingKm).toLocaleString()} km overdue`
                : `${remainingKm.toLocaleString()} km remaining`}
            </Text>
            <Text style={styles.kmSub}>
              Due at {task.nextDueKm?.toLocaleString()} km · now {currentKm?.toLocaleString()} km
            </Text>
          </View>
        </Card>
      ) : null}

      <Card style={styles.infoCard}>
        {task.itemId && typeof task.itemId === 'object' ? (
          <ListRow mdiIcon={itemTypeConfig(task.itemId.type).icon} title={task.itemId.name} />
        ) : null}
        <ListRow icon="calendar-outline" title={dueRowTitle} />
        {task.lastCompletedAt ? (
          <ListRow icon="time-outline" title="Last completed" subtitle={formatCalendarDate(task.lastCompletedAt)} />
        ) : null}
        {task.recurrence ? (
          <ListRow icon="repeat-outline" title="Recurrence" subtitle={recurrenceLabel(task.recurrence)} />
        ) : null}
        {task.intervalKm ? (
          <ListRow icon="speedometer-outline" title="Service interval" subtitle={`Every ${task.intervalKm.toLocaleString()} km`} />
        ) : null}
        {/* Only when something is actually holding the series back. The subtitle
            states WHY the task looks the way it does, which is what makes the
            action discoverable at all — see maintenance.md. */}
        {resumeInfo.canResume ? (
          <ListRow
            icon="play-circle-outline"
            title="Resume schedule"
            subtitle={resumeSubtitle(resumeInfo)}
            onPress={() => promptResumeSchedule('task', task, (perform) => resume.mutate(perform))}
          />
        ) : null}
      </Card>

      <Card style={styles.infoCard}>
        {historyQ.data?.length ? (
          historyQ.data.map((h) => (
            <ListRow
              key={h._id}
              icon="checkmark-circle-outline"
              title={formatCalendarDate(h.completedDate)}
              subtitle={[h.performedBy, h.cost ? `$${h.cost}` : '', h.notes].filter(Boolean).join(' · ')}
            />
          ))
        ) : (
          <Text style={styles.muted}>No history yet</Text>
        )}
      </Card>

      <View style={styles.deleteWrap}>
        <Button title="Delete task" variant="danger" loading={del.isPending} onPress={confirmDelete} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerCard: { marginBottom: spacing.md, gap: spacing.sm },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerTitleText: { flex: 1 },
  screenTitle: { fontSize: 24, fontWeight: '700', color: colors.text },
  actionCard: { marginBottom: spacing.md, padding: 0, overflow: 'hidden' },
  actionRow: { flexDirection: 'row' },
  actionHalf: { flex: 1, height: 64, alignItems: 'center', justifyContent: 'center', gap: 4 },
  actionHalfPause: { borderRightWidth: 1 },
  actionLabel: { fontSize: 13, fontWeight: '600' },
  actionLabelDone: { color: '#000' },
  kmCard: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, borderWidth: 1.5 },
  kmTitle: { fontSize: 18, fontWeight: '700' },
  kmSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  infoCard: { padding: 0, paddingVertical: spacing.xs, marginBottom: spacing.md },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  muted: { color: colors.textMuted, padding: spacing.md },
  deleteWrap: { marginTop: spacing.sm, marginBottom: spacing.xl },
});
