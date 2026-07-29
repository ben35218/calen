import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { callsApi } from '../../api';
import {
  Screen, ScreenTitle, SectionTitle, SegmentedControl, SwitchRow,
  DateField, TimeField, Button, Hint, FormError, CardRow, IconAvatar,
} from '../../components/ui';
import { form as formStyles } from '../../components/formStyles';
import { ymd } from '../../lib/calendar';
import { startTimeKeepingDuration } from '../../lib/datetime';
import { useCalendarColors, useCustomCalendars } from '../../lib/calendarPrefs';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'EventAction'>;
type Rt = RouteProp<CalendarStackParamList, 'EventAction'>;

type Action = 'cancel' | 'reschedule';

// One proposed reschedule window: a date plus a from–to time range.
interface TimeWindow {
  date: string; // YYYY-MM-DD
  from: string; // HH:mm
  to: string;   // HH:mm
}

const MAX_WINDOWS = 3;
const CALL_TERMINAL = ['ended', 'failed'];

const fmtTime = (t: string) =>
  new Date(`2000-01-01T${t}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

// The human label a window travels as — read out loud on the call.
const windowLabel = (w: TimeWindow) => `${fmtDay(w.date)} between ${fmtTime(w.from)} and ${fmtTime(w.to)}`;

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return ymd(d);
}

// Event Action — set up the phone call Calen places for this appointment:
// pick Cancel or Reschedule, answer the fee question, and (for a reschedule)
// propose the date/time windows to offer the business. Placing the call lands
// on the Interaction view to watch it live.
export default function EventActionScreen() {
  const navigation = useNavigation<Nav>();
  const { eventId, event } = useRoute<Rt>().params;
  const qc = useQueryClient();
  const { colors: calColors } = useCalendarColors();
  const { calendars: customCalendars } = useCustomCalendars();
  const calType = event.calendarType ?? 'activities';
  const accent = calColors[calType] || customCalendars.find((c) => c.id === calType)?.color || colors.primary;

  const [action, setAction] = useState<Action>('cancel');
  const [feeAccepted, setFeeAccepted] = useState(false);
  // Per-call opt-in (spec ai-assistant.md): the AI caller only gets the user's
  // phone/email (for the business's identity check) when this is on.
  const [shareContact, setShareContact] = useState(false);
  const [windows, setWindows] = useState<TimeWindow[]>([]);
  const [error, setError] = useState('');

  // Windows may not be in the past; seed the first from the appointment's own
  // day (or today if that's already gone by).
  const today = ymd(new Date());
  const eventDay = event.startDate.slice(0, 10);
  const seedDay = eventDay < today ? today : eventDay;

  const addWindow = () =>
    setWindows((ws) => [
      ...ws,
      { date: ws.length ? nextDay(ws[ws.length - 1].date) : seedDay, from: '09:00', to: '12:00' },
    ]);

  const setWindow = (i: number, patch: Partial<TimeWindow>) =>
    setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  // Moving a window's "to" to at/before its "from" pulls "from" back so the window
  // keeps its width (same-day, clamped at 00:00).
  const setWindowTo = (i: number, v: string) =>
    setWindows((ws) =>
      ws.map((w, j) => {
        if (j !== i) return w;
        const from = startTimeKeepingDuration(w.from, w.to, v);
        return { ...w, to: v, ...(from ? { from } : {}) };
      })
    );

  const pickAction = (a: Action) => {
    setAction(a);
    setError('');
    if (a === 'reschedule' && !windows.length) {
      setWindows([{ date: seedDay, from: '09:00', to: '12:00' }]);
    }
  };

  // The most recent finished call for this event — a "review the last call"
  // pointer replacing the old card's popup options.
  const callsQ = useQuery({ queryKey: ['calls'], queryFn: async () => (await callsApi.list()).data });
  const lastCall = (callsQ.data ?? []).find((c) => c.eventId === eventId && CALL_TERMINAL.includes(c.status));

  const place = useMutation({
    mutationFn: () =>
      callsApi.eventAction({
        event: { _id: eventId, title: event.title, startDate: event.startDate, phone: event.phone },
        action,
        feeAccepted,
        shareContact,
        windows: action === 'reschedule' ? windows.map(windowLabel) : undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['calls'] });
      // Straight to the live call view; back from there returns to the event.
      navigation.replace('Interaction', { id: res.data._id });
    },
    onError: (e: any) => setError(e?.response?.data?.error || 'Couldn’t place the call. Please try again.'),
  });

  const onPlace = () => {
    if (action === 'reschedule') {
      if (!windows.length) {
        setError('Add at least one time window to propose.');
        return;
      }
      if (windows.some((w) => w.to <= w.from)) {
        setError('Each time window must end after it starts.');
        return;
      }
    }
    setError('');
    place.mutate();
  };

  const when = useMemo(() => {
    const start = new Date(event.startDate);
    const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return event.allDay === false
      ? `${day}, ${start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}`
      : day;
  }, [event.startDate, event.allDay]);

  const feeKind = action === 'cancel' ? 'cancellation' : 'reschedule';

  return (
    <Screen>
      <ScreenTitle>{event.title}</ScreenTitle>
      <Text style={styles.when}>{when} · {event.phone}</Text>

      <SegmentedControl<Action>
        value={action}
        options={[
          { label: 'Cancel', value: 'cancel' },
          { label: 'Reschedule', value: 'reschedule' },
        ]}
        onChange={pickAction}
      />
      <Hint style={styles.segmentHint}>
        {action === 'cancel'
          ? `Calen will call ${event.phone} and cancel this appointment for you.`
          : `Calen will call ${event.phone} and reschedule this appointment to one of your proposed times.`}
      </Hint>

      <SectionTitle>{action === 'cancel' ? 'Cancellation fee' : 'Reschedule fee'}</SectionTitle>
      <View style={formStyles.groupCard}>
        <View style={formStyles.groupPad}>
          <SwitchRow
            label="Proceed if there’s a fee"
            value={feeAccepted}
            onValueChange={setFeeAccepted}
            color={accent}
          />
        </View>
      </View>
      <Hint>
        {feeAccepted
          ? `If the business charges a ${feeKind} fee, Calen will accept it and go ahead.`
          : `If the business charges a ${feeKind} fee, Calen won’t go ahead — it will ask the amount so you can decide first.`}
      </Hint>

      <SectionTitle>Identity check</SectionTitle>
      <View style={formStyles.groupCard}>
        <View style={formStyles.groupPad}>
          <SwitchRow
            label="Share my contact details if asked"
            value={shareContact}
            onValueChange={setShareContact}
            color={accent}
          />
        </View>
      </View>
      <Hint>
        {shareContact
          ? 'If the business asks to verify the appointment, Calen may give your phone number or email on file.'
          : 'Calen gives only your name. If the business insists on verifying by phone or email, it will say it will check with you and call back.'}
      </Hint>

      {action === 'reschedule' ? (
        <>
          <SectionTitle>Proposed times</SectionTitle>
          {windows.map((w, i) => (
            <View key={i} style={formStyles.groupCard}>
              <View style={formStyles.dtRow}>
                <Text style={formStyles.dtLabel}>{`Option ${i + 1}`}</Text>
                <View style={formStyles.dtFields}>
                  <DateField
                    value={w.date}
                    onChange={(v) => setWindow(i, { date: v })}
                    minimumDate={new Date()}
                    containerStyle={formStyles.dtFieldWrap}
                    fieldStyle={formStyles.dtField}
                    valueStyle={formStyles.dtValue}
                    hideIcon
                  />
                </View>
                {windows.length > 1 ? (
                  <TouchableOpacity
                    accessibilityLabel={`Remove option ${i + 1}`}
                    hitSlop={8}
                    style={styles.removeBtn}
                    onPress={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
                  >
                    <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <View style={formStyles.cardDivider} />
              <View style={formStyles.dtRow}>
                <Text style={formStyles.dtLabel}>Between</Text>
                <View style={formStyles.dtFields}>
                  <TimeField
                    value={w.from}
                    onChange={(v) => setWindow(i, { from: v })}
                    containerStyle={formStyles.dtFieldWrap}
                    fieldStyle={formStyles.dtField}
                    valueStyle={formStyles.dtValue}
                    hideIcon
                  />
                  <Text style={styles.andText}>and</Text>
                  <TimeField
                    value={w.to}
                    onChange={(v) => setWindowTo(i, v)}
                    containerStyle={formStyles.dtFieldWrap}
                    fieldStyle={formStyles.dtField}
                    valueStyle={formStyles.dtValue}
                    hideIcon
                  />
                </View>
              </View>
            </View>
          ))}
          {windows.length < MAX_WINDOWS ? (
            <View style={formStyles.groupCard}>
              <TouchableOpacity style={styles.addRow} activeOpacity={0.7} onPress={addWindow}>
                <View style={[styles.addIcon, { backgroundColor: accent }]}>
                  <Ionicons name="add" size={18} color="#fff" />
                </View>
                <Text style={[styles.addLabel, { color: accent }]}>Add another time…</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <Hint>Calen offers these windows in order of preference until one works.</Hint>
        </>
      ) : null}

      {lastCall ? (
        <>
          <SectionTitle>Last call</SectionTitle>
          <CardRow
            leading={
              <IconAvatar
                icon={lastCall.outcome === 'confirmed' ? 'checkmark' : 'call'}
                bg={lastCall.outcome === 'confirmed' ? colors.success : colors.textMuted}
              />
            }
            title={lastCall.action === 'cancel' ? 'Cancellation call' : 'Reschedule call'}
            subtitle={
              lastCall.outcome === 'confirmed'
                ? 'Confirmed — tap for the call details'
                : 'Couldn’t confirm — tap to review the call'
            }
            onPress={() => navigation.navigate('Interaction', { id: lastCall._id })}
          />
        </>
      ) : null}

      <FormError>{error}</FormError>

      <View style={formStyles.footer}>
        <Button
          title={action === 'cancel' ? 'Call to Cancel' : 'Call to Reschedule'}
          color={accent}
          loading={place.isPending}
          onPress={onPlace}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  when: { fontSize: 15, color: colors.textMuted, marginTop: spacing.sm, marginBottom: spacing.lg, lineHeight: 22 },
  segmentHint: { marginTop: spacing.md },
  andText: { fontSize: 15, color: colors.textMuted },
  removeBtn: { marginLeft: spacing.sm },
  // Same look as the event form's "Add attachment…" row.
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  addIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  addLabel: { flex: 1, fontSize: 16 },
});
