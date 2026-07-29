import React from 'react';
import { View, Text, StyleSheet, Alert, Linking, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { calendarApi, callsApi } from '../../api';
import { Screen, ScreenTitle, SectionTitle, CardRow, Button, Badge, CenteredLoader, FormError } from '../../components/ui';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { formatDisplay } from '../../lib/phone';
import { DNC_CAPTURED_NOTICE } from '../../lib/callBlock';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'Interaction'>;
type Rt = RouteProp<CalendarStackParamList, 'Interaction'>;

const TERMINAL = ['ended', 'failed'];

// Screens that render the event we're about to delete — returning to any of them
// after a delete lands on a dead view (a 404 "Could not load this event").
const EVENT_SCREENS = new Set(['EventDetail', 'EventAction', 'EventForm']);

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  ringing: 'Ringing',
  'in-progress': 'On the call',
  forwarding: 'On the call',
  ended: 'Ended',
  failed: 'Failed',
};

// Vapi endedReason codes → something a person would say.
function endedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    'customer-ended-call': 'The business hung up first',
    'assistant-ended-call': 'Calen ended the call',
    'assistant-said-end-call-phrase': 'Calen ended the call',
    'silence-timed-out': 'The line went silent',
    'customer-did-not-answer': 'No answer',
    voicemail: 'Reached voicemail',
  };
  return map[reason] ?? reason.replace(/-/g, ' ');
}

// Interaction view — everything about one phone call Calen placed: live status,
// outcome, and the call summary. (No transcript or recording — those artifacts
// are disabled at the voice provider by design; see specs/features/ai-assistant.md.)
// Opened from the call notice in Invitations and from the Call to Cancel card on
// the event view. From here the user acts on the outcome: delete the event (or
// keep it flagged cancelled) after a confirmed cancellation, update the event
// time after a confirmed reschedule, or — when the automatic evaluation couldn't
// confirm — mark the appointment cancelled themselves.
export default function InteractionScreen() {
  const navigation = useNavigation<Nav>();
  const { id } = useRoute<Rt>().params;
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['calls', id],
    queryFn: async () => (await callsApi.get(id)).data,
    // Live view while the call runs; stop once the outcome is in.
    refetchInterval: (query) => {
      const c = query.state.data;
      return c && (!TERMINAL.includes(c.status) || !c.outcome) ? 5_000 : false;
    },
  });
  const call = q.data;

  const ack = useMutation({
    mutationFn: () => callsApi.ack(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calls'] });
      navigation.goBack();
    },
    onError: (e: any) => Alert.alert('Couldn’t confirm', e?.response?.data?.error || 'Please try again.'),
  });

  // Manual confirmation when the call's automatic judgement was unsure: the
  // user read the summary (or spoke to the business) and knows the appointment
  // IS cancelled.
  const markCancelled = useMutation({
    mutationFn: async () => {
      await calendarApi.updateEvent(call!.eventId!, { cancelled: true });
      await callsApi.ack(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['calls'] });
      navigation.goBack();
    },
    onError: (e: any) => Alert.alert('Couldn’t update', e?.response?.data?.error || 'Please try again.'),
  });

  // Confirmed cancellation: the appointment is gone at the business, so the
  // natural next step is removing the event from the calendar (and dismissing
  // the notice). A ghost "Keep on calendar" flags it cancelled but leaves it.
  const deleteEvent = useMutation({
    mutationFn: async () => {
      await calendarApi.deleteEvent(call!.eventId!);
      await callsApi.ack(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['calls'] });
      // The event is gone — a plain goBack() would land on its now-dead detail
      // view. Pop past any event-detail/action/form screens beneath this one
      // (the whole cancel-from-event flow) to the first screen that survives.
      const { routes, index } = navigation.getState();
      let target = index - 1;
      while (target >= 0 && EVENT_SCREENS.has(routes[target].name)) target--;
      if (target < 0) navigation.popToTop();
      else navigation.pop(index - target);
    },
    onError: (e: any) => Alert.alert('Couldn’t delete', e?.response?.data?.error || 'Please try again.'),
  });

  if (q.isLoading) return <CenteredLoader />;
  if (q.isError || !call) {
    return (
      <Screen>
        <FormError>Could not load this call.</FormError>
      </Screen>
    );
  }

  const live = !TERMINAL.includes(call.status);
  const confirmed = call.outcome === 'confirmed';
  const failed = call.status === 'failed' || call.outcome === 'unconfirmed';
  const statusColor = live ? colors.primary : confirmed ? colors.success : failed ? colors.warning : colors.textMuted;
  const calledAt = new Date(call.createdAt);
  // A real event id (chat calls on E2EE households may carry a client-only id
  // the server can't resolve) — gates the event link + manual confirmation.
  const hasEvent = Boolean(call.eventId && /^[0-9a-f]{24}$/i.test(call.eventId));

  return (
    <Screen>
      <ScreenTitle>{call.action === 'cancel' ? 'Cancellation call' : 'Reschedule call'}</ScreenTitle>

      <View style={styles.statusRow}>
        <Badge label={STATUS_LABEL[call.status] ?? call.status} color={statusColor} />
        {call.outcome ? (
          <Badge
            label={confirmed ? (call.action === 'cancel' ? 'Cancellation confirmed' : 'Rescheduled') : 'Couldn’t confirm'}
            color={confirmed ? colors.success : colors.warning}
          />
        ) : null}
        {live ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>

      {/* The recipient asked not to be called again — their number is now on the
          do-not-call list. Tell the user explicitly, so a future call that Calen
          refuses isn't a surprise. */}
      {call.dncCaptured ? (
        <View style={styles.dncNotice}>
          <Ionicons name="hand-left-outline" size={18} color={colors.warning} style={styles.dncIcon} />
          <Text style={styles.dncText}>{DNC_CAPTURED_NOTICE}</Text>
        </View>
      ) : null}

      <View style={styles.rows}>
        <CardRow
          title="Appointment"
          subtitle={call.eventDate || undefined}
          right={
            hasEvent ? (
              <View style={styles.rightRow}>
                <Text style={styles.rightValue} numberOfLines={1}>{call.eventTitle || 'Event'}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </View>
            ) : (
              <Text style={styles.rightValue} numberOfLines={1}>{call.eventTitle || 'Event'}</Text>
            )
          }
          onPress={hasEvent ? () => navigation.navigate('EventDetail', { eventId: call.eventId! }) : undefined}
        />
        {call.phone ? (
          <CardRow
            title="Business phone"
            right={<Text style={styles.rightValue}>{formatDisplay(call.phone)}</Text>}
            onPress={() => Linking.openURL(`tel:${call.phone}`)}
          />
        ) : null}
        <CardRow
          title="Called"
          right={
            <Text style={styles.rightValue}>
              {calledAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })},{' '}
              {calledAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}
            </Text>
          }
        />
        {call.durationSeconds != null ? (
          <CardRow title="Duration" right={<Text style={styles.rightValue}>{Math.max(1, Math.round(call.durationSeconds / 60))} min</Text>} />
        ) : null}
        {!live && call.endedReason ? (
          <CardRow title="How it ended" right={<Text style={styles.rightValue}>{endedReasonLabel(call.endedReason)}</Text>} />
        ) : null}
      </View>

      {call.summary ? (
        <>
          <SectionTitle>Summary</SectionTitle>
          <Text style={styles.summary}>{call.summary}</Text>
        </>
      ) : null}

      <View style={styles.footer}>
        {/* A confirmed cancellation: the appointment is gone at the business.
            Delete the event from the calendar (primary) or keep it flagged
            cancelled for the record (ghost). Both dismiss the notice. */}
        {confirmed && call.action === 'cancel' && !call.acknowledged && hasEvent ? (
          <>
            <Button
              title="Delete event"
              variant="danger"
              loading={deleteEvent.isPending}
              onPress={() =>
                Alert.alert(
                  'Delete this event?',
                  'The appointment was cancelled. Remove it from your calendar? This can’t be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteEvent.mutate() },
                  ],
                )
              }
            />
            <Button
              title="Keep on calendar"
              variant="ghost"
              loading={markCancelled.isPending}
              onPress={() => markCancelled.mutate()}
            />
          </>
        ) : null}

        {/* A confirmed reschedule doesn't move the event automatically — the
            agreed time only exists in the call summary. Route to the edit form
            so the calendar can be brought in line with what was agreed. */}
        {confirmed && call.action === 'reschedule' && !call.acknowledged && hasEvent ? (
          <>
            <Button
              title="Update event time"
              onPress={() => navigation.navigate('EventForm', { eventId: call.eventId! })}
            />
            <Button title="Dismiss" variant="ghost" loading={ack.isPending} onPress={() => ack.mutate()} />
          </>
        ) : null}

        {/* Everything else that still needs dismissing: couldn't-confirm calls,
            or a confirmed call whose event we can't resolve. */}
        {call.outcome && !call.acknowledged && !(confirmed && hasEvent) ? (
          <Button title="Dismiss" loading={ack.isPending} onPress={() => ack.mutate()} />
        ) : null}

        {call.outcome === 'unconfirmed' && call.action === 'cancel' && hasEvent ? (
          <Button
            title="Mark appointment as cancelled"
            variant="ghost"
            loading={markCancelled.isPending}
            onPress={() =>
              Alert.alert(
                'Mark as cancelled?',
                'Use this if the business did cancel the appointment even though the call couldn’t confirm it automatically.',
                [
                  { text: 'Not yet', style: 'cancel' },
                  { text: 'Mark cancelled', onPress: () => markCancelled.mutate() },
                ],
              )
            }
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.lg },
  dncNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  dncIcon: { marginTop: 1 },
  dncText: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 20 },
  rows: { gap: spacing.md },
  rightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 1 },
  rightValue: { fontSize: 16, color: colors.textMuted, flexShrink: 1 },
  summary: { fontSize: 15, color: colors.text, lineHeight: 22, marginTop: spacing.xs },
  footer: { marginTop: spacing.xl, gap: spacing.sm },
});
