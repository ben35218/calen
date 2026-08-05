import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Linking, Share, Image, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, useFocusEffect, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { calendarApi, callsApi, invitationsApi, eventAttachmentsApi, settingsApi, EventAttachment, CalendarEvent, PhoneCallRecord } from '../../api';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';
import { getHDK, openRecord } from '../../lib/e2ee';
import { decryptDownloadedFile } from '../../lib/attachments';
import { Screen, ScreenTitle, SectionTitle, CardRow, Card, Button, CenteredLoader, FormError, IconAvatar } from '../../components/ui';
import {
  EVENT_CALENDAR_TYPES, eventWhenFromStored, eventStoredFromWhen, shiftEventWhen, occurrenceShiftDays,
  DEFAULT_DAY_ALERT_TIME, allDayAlertLabel,
} from '../../lib/calendar';
import { useCustomCalendars, useCalendarColors } from '../../lib/calendarPrefs';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { formatDuration } from '../../lib/format';
import { RepeatRule, repeatSummary } from '../../lib/eventRepeat';
import { promptEventDelete } from '../../lib/eventDelete';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'EventDetail'>;
type Rt = RouteProp<CalendarStackParamList, 'EventDetail'>;

// Same broad-kind glyph + extension helpers as the event form's attachments.
function attachmentIcon(fileType?: string): keyof typeof Ionicons.glyphMap {
  if (fileType?.includes('pdf')) return 'document-text-outline';
  if (fileType?.startsWith('image')) return 'image-outline';
  return 'document-outline';
}
function extForType(fileType?: string): string {
  if (fileType?.includes('png')) return 'png';
  if (fileType?.includes('pdf')) return 'pdf';
  if (fileType?.includes('heic')) return 'heic';
  if (fileType?.includes('webp')) return 'webp';
  if (fileType?.includes('gif')) return 'gif';
  return 'jpg';
}
// iOS Uniform Type Identifier for the share/open sheet — helps it pick the right
// preview + "Open in…" targets. Undefined (Android/unknown) falls back to mime.
function utiForType(fileType?: string): string | undefined {
  if (fileType?.includes('pdf')) return 'com.adobe.pdf';
  if (fileType?.includes('png')) return 'public.png';
  if (fileType?.includes('heic')) return 'public.heic';
  if (fileType?.startsWith('image')) return 'public.jpeg';
  return undefined;
}

const CALL_TERMINAL = ['ended', 'failed'];

// A rich call-outcome status card: header (icon + title + one-liner), optional
// call summary, then a vertical stack of resolution actions.
function StatusCard({ icon, bg, title, sub, summary, children }: {
  icon: keyof typeof Ionicons.glyphMap; bg: string; title: string; sub?: string;
  summary?: string | null; children: React.ReactNode;
}) {
  return (
    <Card style={styles.statusCard}>
      <View style={styles.statusHeader}>
        <IconAvatar icon={icon} bg={bg} />
        <View style={styles.statusHeaderText}>
          <Text style={styles.statusTitle}>{title}</Text>
          {sub ? <Text style={styles.statusSub}>{sub}</Text> : null}
        </View>
      </View>
      {summary ? <Text style={styles.statusSummary}>{summary}</Text> : null}
      <View style={styles.statusActions}>{children}</View>
    </Card>
  );
}

// The event's AI-call surface — a single card that both sets up a call and,
// once one resolves, becomes the place to act on the outcome WITHOUT drilling
// into the call view. States:
//   • in progress  → live "Calen is calling…" (tap to watch)
//   • cancelled     → "Appointment cancelled" + the business + call summary,
//                     with Delete / Keep-on-calendar / View-call-details inline
//   • rescheduled   → "Reschedule confirmed" + Update-time / Dismiss / details
//   • couldn't confirm → review + retry (and mark-cancelled for a cancel call)
//   • idle          → the "Cancel or Reschedule" prompt (or add-a-phone)
// The shared ['calls'] query polls while a call runs. The Interaction view still
// exists (full outcome detail, and Invitations has no event context) — "View
// call details" links to it.
function EventActionCard({
  event,
  eventId,
  accent,
  occurrenceDate,
  onAddPhone,
  onOpen,
  onOpenCall,
  onUpdateTime,
}: {
  event: CalendarEvent;
  eventId: string;
  accent: string;
  // Recurring event: the tapped occurrence's local Y-M-D. Scopes the call and
  // its outcome to that instance; undefined for a non-recurring event.
  occurrenceDate?: string;
  onAddPhone: () => void;
  // Open the Event Action view (cancel/reschedule setup).
  onOpen: () => void;
  // Open the Interaction view for a placed call (live status / summary).
  onOpenCall: (callRecordId: string) => void;
  // Open the edit form to apply a rescheduled time.
  onUpdateTime: () => void;
}) {
  const qc = useQueryClient();
  const isRecurring = !!event.recurrence?.freq;
  const callsQ = useQuery({
    queryKey: ['calls'],
    queryFn: async () => (await callsApi.list()).data,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => !CALL_TERMINAL.includes(c.status)) ? 10_000 : false,
  });
  // Scope to this occurrence: a call carrying an occurrenceDate matches only its
  // own instance; an unscoped call (non-recurring / legacy) matches regardless.
  const forEvent = (callsQ.data ?? []).filter(
    (c) => c.eventId === eventId && (c.occurrenceDate == null || c.occurrenceDate === occurrenceDate),
  );
  const activeCall = forEvent.find((c) => !CALL_TERMINAL.includes(c.status));
  const lastCall: PhoneCallRecord | undefined = forEvent[0];

  // A finished call may have confirmed the cancellation — re-pull the event so
  // the server-set `cancelled` flag lands without leaving the screen.
  const done = Boolean(lastCall && CALL_TERMINAL.includes(lastCall.status));
  useEffect(() => {
    if (done) qc.invalidateQueries({ queryKey: ['calendar', 'event', eventId] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const ackLast = async () => {
    if (lastCall && !lastCall.acknowledged) await callsApi.ack(lastCall._id);
  };
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['calls'] });
    qc.invalidateQueries({ queryKey: ['calendar', 'event', eventId] });
  };

  // Mark the event cancelled by hand (struck-through on the calendar) — used from
  // the "couldn't confirm" state when the user knows the business did cancel.
  const flagCancelled = useMutation({
    mutationFn: async () => { if (!event.cancelled) await calendarApi.cancelEvent(eventId); await ackLast(); },
    onSuccess: invalidateAll,
    onError: (e: any) => Alert.alert('Couldn’t update', e?.response?.data?.error || 'Please try again.'),
  });
  // Just dismiss the call notice (reschedule handled elsewhere / couldn't confirm).
  const dismiss = useMutation({
    mutationFn: ackLast,
    onSuccess: invalidateAll,
    onError: (e: any) => Alert.alert('Couldn’t update', e?.response?.data?.error || 'Please try again.'),
  });

  const business = lastCall?.phone || event.phone || null;
  // Dismissing (acknowledging) a confirmed cancel returns the event to normal —
  // matches the calendar un-dimming. A hand-set `event.cancelled` flag persists.
  const confirmedCancel =
    lastCall?.action === 'cancel' && lastCall?.outcome === 'confirmed' && !lastCall.acknowledged;
  const reschedulePending =
    lastCall?.action === 'reschedule' && lastCall?.outcome === 'confirmed' && !lastCall.acknowledged;
  const couldntConfirm = Boolean(lastCall && done && lastCall.outcome !== 'confirmed');

  const viewDetailsBtn = lastCall ? (
    <Button title="View call details" variant="ghost" onPress={() => onOpenCall(lastCall._id)} />
  ) : null;

  // ── In progress ──────────────────────────────────────────────────────────
  if (activeCall) {
    return (
      <CardRow
        leading={<IconAvatar icon="call" bg={accent} />}
        title="Calen is calling…"
        subtitle={
          activeCall.action === 'cancel'
            ? 'Requesting the cancellation now — tap to watch the call'
            : 'Rescheduling the appointment now — tap to watch the call'
        }
        right={<ActivityIndicator size="small" color={accent} />}
        onPress={() => onOpenCall(activeCall._id)}
      />
    );
  }

  // ── Confirmed cancellation ───────────────────────────────────────────────
  if (event.cancelled || confirmedCancel) {
    return (
      <StatusCard
        icon="checkmark-circle"
        bg={colors.success}
        title="Appointment cancelled"
        sub={business ? `Calen cancelled this with ${business}` : 'This appointment is cancelled'}
        summary={lastCall?.summary}
      >
        {/* No delete here — the event's own "Delete Event" button at the bottom
            of the screen covers it. */}
        {lastCall && !lastCall.acknowledged ? (
          <Button title="Dismiss" variant="ghost" loading={dismiss.isPending} onPress={() => dismiss.mutate()} />
        ) : null}
        {viewDetailsBtn}
      </StatusCard>
    );
  }

  // ── Confirmed reschedule, time not applied yet ───────────────────────────
  if (reschedulePending) {
    return (
      <StatusCard
        icon="time"
        bg={accent}
        title="Reschedule confirmed"
        sub={business ? `Calen agreed a new time with ${business}` : 'A new time was agreed'}
        summary={lastCall?.summary}
      >
        <Button title="Update event time" color={accent} onPress={onUpdateTime} />
        <Button title="Dismiss" variant="ghost" loading={dismiss.isPending} onPress={() => dismiss.mutate()} />
        {viewDetailsBtn}
      </StatusCard>
    );
  }

  // ── Couldn't confirm ─────────────────────────────────────────────────────
  if (couldntConfirm) {
    return (
      <StatusCard
        icon="alert-circle"
        bg={colors.warning}
        title="Call couldn’t confirm"
        sub={
          lastCall?.action === 'cancel'
            ? 'Calen couldn’t confirm the cancellation — review the call or try again'
            : 'Calen couldn’t confirm the reschedule — review the call or try again'
        }
        summary={lastCall?.summary}
      >
        <Button title="Try the call again" color={accent} onPress={onOpen} />
        {/* Marking cancelled sets a series-wide flag, so it's hidden on a
            recurring occurrence — deleting that single occurrence is the path. */}
        {lastCall?.action === 'cancel' && !isRecurring ? (
          <Button
            title="Mark appointment as cancelled"
            variant="ghost"
            loading={flagCancelled.isPending}
            onPress={() =>
              Alert.alert(
                'Mark as cancelled?',
                'Use this if the business did cancel even though the call couldn’t confirm it automatically.',
                [
                  { text: 'Not yet', style: 'cancel' },
                  { text: 'Mark cancelled', onPress: () => flagCancelled.mutate() },
                ],
              )
            }
          />
        ) : null}
        {viewDetailsBtn}
      </StatusCard>
    );
  }

  // ── Idle: no phone yet ───────────────────────────────────────────────────
  if (!event.phone) {
    return (
      <CardRow
        leading={<IconAvatar icon="call" bg={accent} />}
        title="Reschedule/Cancel"
        onPress={onAddPhone}
      />
    );
  }

  // ── Idle: ready to place a call ──────────────────────────────────────────
  return (
    <CardRow
      leading={<IconAvatar icon="call" bg={accent} />}
      title="Reschedule/Cancel"
      onPress={onOpen}
    />
  );
}

const INVITEE_STATUS: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  accepted: { icon: 'checkmark-circle', color: colors.success },
  declined: { icon: 'close-circle', color: colors.error },
  left: { icon: 'exit-outline', color: colors.textMuted },
  pending: { icon: 'help-circle-outline', color: colors.textMuted },
};

// A location card: the Google Static Map (with a pin) as the backdrop and a
// Street View thumbnail overlaid, mirroring Apple Calendar's look. Images come
// from the server proxy (/places/staticmap, /places/streetview) which keeps the
// API key server-side; each hides itself if the image is unavailable. Tapping
// opens the address in the device's Maps app.
function LocationCard({ location, onOpen, onUnavailable }: { location: string; onOpen: () => void; onUnavailable?: () => void }) {
  const [mapOk, setMapOk] = useState(true);
  const [svOk, setSvOk] = useState(true);
  const token = getCachedToken();
  const q = encodeURIComponent(location);
  const mapUri = `${API_URL}/places/staticmap?token=${token}&q=${q}&w=640&h=320`;
  const svUri = `${API_URL}/places/streetview?token=${token}&q=${q}&w=280&h=280`;

  if (!mapOk) return null; // no map imagery → the address row above already shows it
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onOpen} style={styles.mapCard}>
      <Image source={{ uri: mapUri }} style={styles.mapImage} onError={() => { setMapOk(false); onUnavailable?.(); }} />
      {svOk ? (
        <Image source={{ uri: svUri }} style={styles.streetView} onError={() => setSvOk(false)} />
      ) : null}
    </TouchableOpacity>
  );
}

// A compact hour-grid card (Apple Calendar-style) that places the event as a
// block on a few hours of timeline, so its start/end read at a glance. Timed
// events only — an all-day event has no clock position. A multi-day timed event
// is clipped to its first day (the mini card shows a single day).
const TIME_CARD_HOUR = 44; // px per hour
const TIME_CARD_PAD = 10; // vertical breathing room around the hour lines
// The mini card is a compact, fixed-size window (this many hours, incl. the
// hour of lead-in) so it never grows into a wall of hours. A longer event
// overflows the window and its block is clipped at the bottom edge instead.
const TIME_CARD_MAX_HOURS = 3;
function EventTimeCard({ event, accent }: { event: CalendarEvent; accent: string }) {
  const start = new Date(event.startDate);
  const end = event.endDate ? new Date(event.endDate) : new Date(start.getTime() + 3600_000);
  const startDec = start.getHours() + start.getMinutes() / 60;
  let endDec = end.getHours() + end.getMinutes() / 60;
  // Spans past midnight or has a non-positive length once clipped → run to end of day.
  if (end.toDateString() !== start.toDateString() || endDec <= startDec) endDec = 24;

  // The block's height caps how much text fits. > 1 hour: title + location +
  // time; exactly 1 hour: title + time (no room for location); < 1 hour: title
  // only. (`endDec` was clamped to 24 above for midnight-spanning events, which
  // are long enough to show everything.)
  const durationHours = endDec - startDec;
  const showTime = durationHours >= 1;
  const showLocation = durationHours > 1 && !!event.location;

  const winStart = Math.max(0, Math.floor(startDec) - 1);
  // Grow the window to the event's end, but cap it at TIME_CARD_MAX_HOURS past
  // winStart (Apple-style). A longer event overflows this window — its block is
  // clipped at the bottom edge rather than stretching the card indefinitely.
  const fullWinEnd = Math.min(24, Math.max(Math.ceil(endDec), Math.floor(startDec) + 2));
  const winEnd = Math.min(fullWinEnd, winStart + TIME_CARD_MAX_HOURS);
  const clipped = endDec > winEnd;
  const hours: number[] = [];
  for (let h = winStart; h <= winEnd; h++) hours.push(h);

  const y = (dec: number) => TIME_CARD_PAD + (dec - winStart) * TIME_CARD_HOUR;
  const canvasH = TIME_CARD_PAD * 2 + (winEnd - winStart) * TIME_CARD_HOUR;
  const blockTop = y(startDec);
  // A clipped block bleeds all the way to the card's bottom edge — down through
  // the card's own bottom padding (`spacing.md`) past the timeline canvas — so
  // it's clear the event runs past the visible window rather than ending here.
  // An unclipped block ends at its real end time.
  const blockBottom = clipped ? canvasH + spacing.md : y(endDec);
  const blockH = Math.max(TIME_CARD_HOUR * 0.6, blockBottom - blockTop);

  const hourLabel = (h: number) => {
    if (h === 12) return 'Noon';
    const ampm = h < 12 || h === 24 ? 'AM' : 'PM';
    return `${h % 12 === 0 ? 12 : h % 12} ${ampm}`;
  };
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true });

  return (
    <Card style={styles.timeCard}>
      <View style={{ height: canvasH }}>
        {hours.map((h) => (
          <View key={h} style={[styles.hourRow, { top: y(h) - 8 }]}>
            <Text style={styles.hourLabel}>{hourLabel(h)}</Text>
            <View style={styles.hourRule} />
          </View>
        ))}
        <View
          style={[styles.timeBlock, { top: blockTop, height: blockH, backgroundColor: accent + '33', borderLeftColor: accent }]}
        >
          <Text style={[styles.timeBlockTitle, { color: accent }]} numberOfLines={1}>{event.title}</Text>
          {showLocation ? (
            <View style={styles.timeBlockMeta}>
              <Ionicons name="location-outline" size={11} color={accent} />
              <Text style={[styles.timeBlockMetaText, { color: accent }]} numberOfLines={1}>{event.location}</Text>
            </View>
          ) : null}
          {showTime ? (
            <View style={styles.timeBlockMeta}>
              <Ionicons name="time-outline" size={11} color={accent} />
              <Text style={[styles.timeBlockMetaText, { color: accent }]}>{fmtTime(start)} – {fmtTime(end)}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

export default function EventDetailScreen() {
  const navigation = useNavigation<Nav>();
  const { eventId, date } = useRoute<Rt>().params;
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { colors: calColors } = useCalendarColors();
  const { calendars: customCalendars } = useCustomCalendars();
  const aiEnabled = usePrivacyPrefs().prefs.aiEnabled;
  const [error, setError] = useState('');
  // Whether the location map imagery loaded — drives the floating "Delete Event"
  // overlay (Apple-style) vs. the plain full-width button fallback.
  const [mapAvailable, setMapAvailable] = useState(true);

  const eventQ = useQuery({
    queryKey: ['calendar', 'event', eventId],
    queryFn: async () => (await calendarApi.getEvent(eventId)).data,
  });

  // Re-pull the event whenever this screen regains focus (e.g. returning from the
  // edit form). Edits to fields that drive what's rendered here — turning off
  // recurrence, which un-hides the Reschedule/Cancel card — must be reflected
  // without a manual refresh. The refetch keeps the current data during the
  // fetch, so there's no loading flicker.
  useFocusEffect(
    React.useCallback(() => {
      eventQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventId]),
  );

  // E2EE dual-write: decrypt the content over the plaintext fields.
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  useEffect(() => {
    if (!eventQ.data) return;
    let cancelled = false;
    (async () => {
      const e = await openRecord('CalendarEvent', eventQ.data);
      if (!cancelled) setEvent(e as CalendarEvent);
    })();
    return () => { cancelled = true; };
  }, [eventQ.data]);

  // A guest copy / view-only collaborator event has no owner-editable detail —
  // send those straight to the form, which renders its own read-only view.
  const readOnly = !!eventQ.data?.invitationId || !!eventQ.data?.readOnly;
  useEffect(() => {
    if (readOnly) navigation.replace('EventForm', { eventId, date });
  }, [readOnly, navigation, eventId, date]);

  const calType: string = event?.calendarType ?? 'activities';
  const accent = calColors[calType] || customCalendars.find((c) => c.id === calType)?.color || colors.primary;

  // Per-occurrence identity for the AI cancel/reschedule call. A recurring event
  // is one record; the detail screen was opened for a specific day (`date`), so
  // scope the call to THAT occurrence: its own local Y-M-D (`occurrenceDate`)
  // and its own start instant (`occurrenceStart` = the tapped day + the series'
  // time of day). A non-recurring event uses its stored values unchanged.
  const eventRecurs = !!event?.recurrence?.freq;
  const occurrenceDate = eventRecurs && date ? date : undefined;
  // These also drive what the screen DISPLAYS. A repeating event's record holds
  // the series' first day, so reading `event.startDate` straight would title
  // every occurrence with the series start — open the Aug 20 one and the page
  // says Aug 6. Routed through the same lib/calendar helpers the edit form
  // uses, so both screens agree on which day an occurrence lands and on how a
  // shift crosses a DST boundary (wall clock preserved for a timed event, noon
  // UTC preserved for an all-day one).
  const { occurrenceStart, occurrenceEnd } = useMemo(() => {
    if (!event) return { occurrenceStart: undefined, occurrenceEnd: undefined };
    const when = eventWhenFromStored(event);
    const shift = occurrenceShiftDays(when, date, eventRecurs);
    if (!shift) return { occurrenceStart: event.startDate, occurrenceEnd: event.endDate };
    const moved = eventStoredFromWhen(shiftEventWhen(when, shift));
    return {
      occurrenceStart: moved.startDate,
      // A same-day end round-trips to undefined (the form's "" convention), so
      // fall back to the shifted start rather than dropping the end entirely.
      occurrenceEnd: event.endDate ? moved.endDate ?? moved.startDate : event.endDate,
    };
  }, [event, eventRecurs, date]);

  const calName =
    EVENT_CALENDAR_TYPES.find((o) => o.value === calType)?.label ||
    customCalendars.find((c) => c.id === calType)?.name ||
    'Calendar';

  // "Edit" opens the full form; returns to the same day it was tapped from.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity onPress={() => navigation.navigate('EventForm', { eventId, date })} hitSlop={12}>
          <Text style={[styles.editBtn, { color: '#fff' }]}>Edit</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, eventId, date, accent]);

  const inviteesQ = useQuery({
    queryKey: ['invitations', 'sent', eventId],
    queryFn: async () => (await invitationsApi.sentForEvent(eventId)).data,
    enabled: !!event && !readOnly,
  });
  const invitees = inviteesQ.data ?? [];

  const attachmentsQ = useQuery({
    queryKey: ['calendar', 'attachments', eventId],
    queryFn: async () => (await eventAttachmentsApi.list(eventId)).data,
    enabled: !!event && !readOnly,
  });
  const attachments = attachmentsQ.data ?? [];

  // A one-off event deletes outright; a recurring occurrence offers Apple's
  // "this event" / "all future" choices (eventDeletePrompt). The chosen action's
  // api call is the mutation's argument, so the Delete control keeps its spinner.
  const del = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      navigation.goBack();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not delete the event'),
  });

  // Fetch a saved attachment to a local file: encrypted ones download as
  // ciphertext and decrypt on-device; plaintext ones (legacy) download to a temp
  // file. The file is named from the id only (never the user's title, which may
  // contain characters that break a file:// URI). Returns the local uri.
  const fetchToFile = async (a: EventAttachment): Promise<string> => {
    const dlUrl = `${API_URL}/calendar/attachments/${a._id}/download`;
    const name = `att-${a._id}.${extForType(a.fileType)}`;
    if (!a.encrypted) {
      const dl = await downloadAsync(`${dlUrl}?token=${getCachedToken()}`, `${cacheDirectory}${name}`);
      return dl.uri;
    }
    if (!getHDK() || !a.wrappedFileKey) throw new Error('Unlock your account to open this encrypted attachment.');
    const cipherUri = `${cacheDirectory}dl-att-${a._id}.bin`;
    const dl = await downloadAsync(dlUrl, cipherUri, { headers: { Authorization: `Bearer ${getCachedToken()}` } });
    const plainUri = await decryptDownloadedFile(
      'EventAttachment', a._id, a.keyVersion, a.wrappedFileKey, dl.uri, name,
    );
    if (!plainUri) throw new Error('Could not decrypt this attachment.');
    return plainUri;
  };

  // Tap an attachment → decrypt on-device, then preview in-app: images and PDFs
  // render inline in a WebView (RN's <Image> crashes on the new architecture, so
  // WebView is the reliable in-app path). Any other type falls back to the OS
  // share sheet (Open in… / Save to Files).
  const openAttachment = useMutation({
    mutationFn: async (a: EventAttachment) => {
      const uri = await fetchToFile(a);
      const previewable = a.fileType?.startsWith('image') || a.fileType?.includes('pdf');
      if (previewable) {
        navigation.navigate('AttachmentPreview', { uri, title: a.title, mimeType: a.fileType });
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: a.fileType || undefined, UTI: utiForType(a.fileType) });
      } else {
        await Share.share({ url: uri });
      }
    },
    onError: (e: any) => Alert.alert('Could not open attachment', e?.message || 'Please try again.'),
  });

  const when = useMemo(() => {
    if (!event) return '';
    const fmtDay = (d: Date) =>
      d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    const start = new Date(occurrenceStart ?? event.startDate);
    const end = occurrenceEnd ? new Date(occurrenceEnd) : null;
    if (event.allDay) {
      const endDay = end && end.toDateString() !== start.toDateString();
      return endDay ? `All-day from ${fmtDay(start)}\nto ${fmtDay(end!)}` : `All-day · ${fmtDay(start)}`;
    }
    return `${fmtDay(start)}, ${fmtTime(start)}${end ? ` – ${fmtTime(end)}` : ''}`;
  }, [event, occurrenceStart, occurrenceEnd]);

  // An all-day event's alerts are whole days off the day-alert hour, so they
  // read the way the form offers them ("1 day before (9:00 AM)") rather than as
  // minutes before a start time the event doesn't have.
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const dayAlertTime = settingsQ.data?.dayAlertTime || DEFAULT_DAY_ALERT_TIME;
  const fmtAlert = (m: number | null | undefined) => {
    if (m == null) return null;
    if (event?.allDay) return allDayAlertLabel(m, dayAlertTime);
    if (m <= 0) return 'At time of event';
    return `${formatDuration(m)} before`;
  };
  const alertLabel = useMemo(() => fmtAlert(event?.reminderMinutes) ?? 'None', [event, dayAlertTime]);
  const alert2Label = useMemo(() => fmtAlert(event?.alert2Minutes), [event, dayAlertTime]);

  // "Repeats weekly" / "Repeats every 2 weeks on Monday until Jul 29, 2027" —
  // the recurrence summary, mirroring the form's Repeat + End Repeat rows.
  const repeatLabel = useMemo(() => {
    const rec = event?.recurrence;
    if (!rec?.freq) return null;
    const rule: RepeatRule = {
      freq: rec.freq as RepeatRule['freq'],
      interval: rec.interval ?? 1,
      daysOfWeek: rec.daysOfWeek ?? [],
      daysOfMonth: rec.daysOfMonth ?? [],
      months: rec.months ?? [],
      weekOfMonth: rec.weekOfMonth ?? null,
      weekdayKind: rec.weekdayKind ?? null,
    };
    const summary = repeatSummary(rule); // "Weekly", "Every 2 weeks on Monday", …
    let s = `Repeats ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
    if (rec.until) {
      const until = new Date(rec.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      s += ` until ${until}`;
    }
    return s;
  }, [event]);

  // Travel time: the drive duration plus the clock time to leave by (start −
  // drive time) when the event is timed and the departure lands on the same day.
  const travelLabel = useMemo(() => {
    if (event?.travelMinutes == null) return null;
    const start = new Date(occurrenceStart ?? event.startDate);
    let leaveBy: string | null = null;
    if (event.allDay === false) {
      const dep = new Date(start.getTime() - event.travelMinutes * 60000);
      if (dep.toDateString() === start.toDateString()) {
        leaveBy = dep.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
      }
    }
    return { duration: formatDuration(event.travelMinutes), leaveBy };
  }, [event, occurrenceStart]);

  const openInMaps = () => {
    if (!event?.location) return;
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`);
  };

  const confirmDelete = () => {
    if (!event) return;
    promptEventDelete(event, date, (perform) => del.mutate(perform));
  };

  if (eventQ.isLoading || (!event && !eventQ.isError)) {
    return <CenteredLoader color={accent} />;
  }
  if (eventQ.isError || !event) {
    return (
      <Screen>
        <FormError>Could not load this event.</FormError>
      </Screen>
    );
  }
  if (readOnly) return <CenteredLoader color={accent} />; // replacing with the form

  const inviteePreview = invitees
    .slice(0, 3)
    .map((i) => i.toEmail || i.toPhone || '')
    .filter(Boolean)
    .join(', ');

  return (
    <View style={styles.root}>
    <Screen style={{ paddingBottom: insets.bottom + 96 }}>
      <ScreenTitle>{event.title}</ScreenTitle>

      {event.cancelled ? (
        <View style={styles.cancelledPill}>
          <Ionicons name="close-circle" size={14} color="#fff" />
          <Text style={styles.cancelledPillText}>Cancelled</Text>
        </View>
      ) : null}

      {event.location ? (
        <TouchableOpacity onPress={openInMaps} activeOpacity={0.7}>
          <Text style={[styles.location, { color: accent }]}>{event.location}</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.whenBlock}>
        <Text style={styles.when}>{when}</Text>

        {repeatLabel ? <Text style={[styles.repeat, { color: accent }]}>{repeatLabel}</Text> : null}

        {/* Apple-style mini timeline: the event as a block on a few hours of grid,
            so its start/end read at a glance. Timed events only. */}
        {!event.allDay ? <EventTimeCard event={event} accent={accent} /> : null}
      </View>

      <View style={styles.rows}>
        {/* Reschedule/Cancel is the first row, directly above the Calendar card.
            On a recurring event the call is scoped to the specific tapped
            occurrence (occurrenceDate + that day's start instant), so it
            cancels/reschedules just that instance — not the whole series. */}
        {aiEnabled ? (
          <EventActionCard
            event={event}
            eventId={eventId}
            accent={accent}
            occurrenceDate={occurrenceDate}
            // No phone yet → the event's Location view, where the details (and
            // the business number) can be filled in and saved directly.
            // `promptPhone` nudges the user to add the number to activate calling.
            onAddPhone={() => navigation.navigate('EventLocation', { eventId, promptPhone: true })}
            onOpen={() =>
              navigation.navigate('EventAction', {
                eventId,
                occurrenceDate,
                event: {
                  title: event.title,
                  startDate: occurrenceStart ?? event.startDate,
                  phone: event.phone!,
                  allDay: event.allDay !== false,
                  calendarType: calType,
                },
              })
            }
            onOpenCall={(id) => navigation.navigate('Interaction', { id })}
            onUpdateTime={() => navigation.navigate('EventForm', { eventId, date })}
          />
        ) : null}

        <CardRow
          title="Calendar"
          right={
            <View style={styles.rightRow}>
              <View style={[styles.dot, { backgroundColor: accent }]} />
              <Text style={styles.rightValue}>{calName}</Text>
            </View>
          }
        />

        {invitees.length ? (
          <CardRow
            title="Invitees"
            onPress={() =>
              navigation.navigate('EventInvitees', {
                eventId,
                snapshot: {
                  title: event.title,
                  description: event.description || undefined,
                  location: event.location || undefined,
                  startDate: event.startDate,
                  endDate: event.endDate,
                  allDay: event.allDay,
                  calendarType: calType,
                },
              })
            }
            right={
              <View style={styles.rightRow}>
                <Text style={styles.rightValue}>{invitees.length}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </View>
            }
            subtitle={
              <View style={styles.inviteeRow}>
                {invitees.slice(0, 4).map((i) => {
                  const s = INVITEE_STATUS[i.status] ?? INVITEE_STATUS.pending;
                  return (
                    <View key={i._id} style={styles.inviteeChip}>
                      <Ionicons name={s.icon} size={13} color={s.color} />
                      <Text style={styles.inviteeName} numberOfLines={1}>{i.toEmail || i.toPhone}</Text>
                    </View>
                  );
                })}
                {invitees.length > 4 ? <Text style={styles.inviteeName}>+{invitees.length - 4}</Text> : null}
              </View>
            }
          />
        ) : null}

        {travelLabel ? (
          <CardRow
            title="Travel Time"
            subtitle={travelLabel.leaveBy ? `Leave by ${travelLabel.leaveBy}` : undefined}
            right={<Text style={styles.rightValue}>{travelLabel.duration}</Text>}
          />
        ) : null}

        {/* Alert + Second alert share one card (divided), mirroring the form's
            two Alert slots and Apple Calendar's grouped alert block. */}
        <Card style={styles.alertCard}>
          <View style={styles.alertRow}>
            <Text style={styles.alertTitle}>Alert</Text>
            <Text style={styles.rightValue}>{alertLabel}</Text>
          </View>
          {alert2Label ? (
            <>
              <View style={styles.alertDivider} />
              <View style={styles.alertRow}>
                <Text style={styles.alertTitle}>Second alert</Text>
                <Text style={styles.rightValue}>{alert2Label}</Text>
              </View>
            </>
          ) : null}
        </Card>
      </View>

      {event.url ? (
        <View style={styles.rows}>
          <CardRow
            title="URL"
            onPress={() => Linking.openURL(/^https?:\/\//i.test(event.url!) ? event.url! : `https://${event.url}`)}
            subtitle={event.url}
            right={<Ionicons name="open-outline" size={18} color={colors.textMuted} />}
          />
        </View>
      ) : null}

      {attachments.length ? (
        <>
          <SectionTitle>Attachments</SectionTitle>
          <View style={styles.rows}>
            {attachments.map((a) => {
              const busy = openAttachment.isPending && openAttachment.variables?._id === a._id;
              return (
                <CardRow
                  key={a._id}
                  leading={<Ionicons name={attachmentIcon(a.fileType)} size={22} color={colors.textMuted} style={styles.attIcon} />}
                  title={a.title}
                  subtitle="Tap to preview"
                  onPress={() => openAttachment.mutate(a)}
                  right={
                    busy ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Ionicons name="open-outline" size={18} color={colors.textMuted} />
                    )
                  }
                />
              );
            })}
          </View>
        </>
      ) : null}

      {event.description ? (
        <>
          <SectionTitle>Notes</SectionTitle>
          <Text style={styles.notes}>{event.description}</Text>
        </>
      ) : null}

      <FormError>{error}</FormError>

      {/* The location map closes the page (Apple-style). Hidden when there's no
          location or the tiles fail to load. */}
      {event.location && mapAvailable ? (
        <LocationCard location={event.location} onOpen={openInMaps} onUnavailable={() => setMapAvailable(false)} />
      ) : null}

    </Screen>

      {/* Apple-style "Delete Event" pill — a translucent floating control PINNED
          to the screen (a sibling of the scroll view, not inside it), so it stays
          fixed in place as the event content scrolls beneath it. */}
      <View style={[styles.floatingDeleteWrap, { bottom: insets.bottom + spacing.lg }]} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.floatingDelete}
          activeOpacity={0.85}
          disabled={del.isPending}
          onPress={confirmDelete}
        >
          {del.isPending ? (
            <ActivityIndicator color={colors.error} />
          ) : (
            <Text style={styles.floatingDeleteText}>Delete Event</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Root wrapper: the scroll view plus the fixed floating Delete pill sibling.
  root: { flex: 1, backgroundColor: colors.background },
  // Call-outcome status card (cancelled / rescheduled / couldn't-confirm).
  statusCard: { gap: spacing.md },
  statusHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusHeaderText: { flex: 1 },
  statusTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  statusSub: { fontSize: 13, color: colors.textMuted, marginTop: 2, lineHeight: 18 },
  statusSummary: { fontSize: 14, color: colors.text, lineHeight: 20 },
  statusActions: { gap: spacing.sm },
  editBtn: { fontSize: 17, fontWeight: '500' },
  location: { fontSize: 16, marginTop: 6, lineHeight: 22 },
  // Wraps the date/time text, the repeat line, and the mini timeline so the gap
  // before the rows group is uniform whether or not a timeline card is present.
  whenBlock: { marginTop: spacing.md, marginBottom: spacing.lg },
  when: { fontSize: 15, color: colors.text, lineHeight: 22 },
  repeat: { fontSize: 15, marginTop: 2, lineHeight: 22 },
  // Mini hour-grid timeline card (Apple Calendar-style event block preview).
  timeCard: { marginTop: spacing.lg, marginBottom: 0 },
  hourRow: { position: 'absolute', left: 0, right: 0, height: 16, flexDirection: 'row', alignItems: 'center' },
  hourLabel: { width: 44, fontSize: 11, color: colors.textMuted, textAlign: 'right' },
  hourRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.sm },
  timeBlock: {
    position: 'absolute', left: 56, right: spacing.xs,
    borderRadius: radius.md, borderLeftWidth: 3, overflow: 'hidden',
    paddingHorizontal: spacing.sm, paddingVertical: 6, justifyContent: 'center',
  },
  timeBlockTitle: { fontSize: 13, fontWeight: '700' },
  timeBlockMeta: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  timeBlockMetaText: { fontSize: 11, flexShrink: 1 },
  rows: { gap: spacing.md },
  // Alert + Second alert grouped in one card (rows own their padding; a hairline
  // divides them), matching Apple Calendar's alert block.
  alertCard: { padding: 0 },
  alertRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: spacing.md,
  },
  alertTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  alertDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.md },
  rightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rightValue: { fontSize: 16, color: colors.textMuted },
  dot: { width: 12, height: 12, borderRadius: 6 },
  inviteeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  inviteeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '46%' },
  inviteeName: { fontSize: 13, color: colors.textMuted },
  // Location card: map backdrop + street-view thumbnail (Apple Calendar-style).
  mapCard: {
    height: 160, borderRadius: radius.lg, overflow: 'hidden',
    marginTop: spacing.lg, backgroundColor: colors.surface,
  },
  mapImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  streetView: {
    position: 'absolute', left: spacing.md, bottom: spacing.md,
    width: 96, height: 96, borderRadius: radius.md,
    borderWidth: 2, borderColor: '#fff',
  },
  attIcon: { marginRight: spacing.sm },
  notes: { fontSize: 15, color: colors.text, lineHeight: 22, marginTop: spacing.xs },
  // Fixed floating "Delete Event" pill (Apple-style translucent overlay), pinned
  // to the bottom of the screen. `bottom` is set inline from the safe-area inset.
  floatingDeleteWrap: {
    position: 'absolute', left: 0, right: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  floatingDelete: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg, paddingVertical: 12,
  },
  floatingDeleteText: { fontSize: 16, fontWeight: '600', color: colors.error },
  cancelledPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    backgroundColor: colors.error, borderRadius: radius.md,
    paddingHorizontal: spacing.sm, paddingVertical: 3, marginTop: spacing.sm,
  },
  cancelledPillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
