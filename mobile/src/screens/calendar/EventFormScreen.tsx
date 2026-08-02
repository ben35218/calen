import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Linking, Share, ActionSheetIOS, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { calendarApi, invitationsApi, placesApi, eventAttachmentsApi, EventAttachment, FormAssistField } from '../../api';
import { resolveCurrentAddressIfShared } from '../../lib/currentLocation';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';
import { pickDocument, takePhoto, pickImage, PickedFile } from '../../lib/media';
import { uploadFile } from '../../lib/upload';
import { encryptFileForUpload, decryptDownloadedFile } from '../../lib/attachments';
import {
  getQueuedAttachments, addQueuedAttachment, removeQueuedAttachment,
  clearQueuedAttachments, useQueuedAttachments,
} from '../../lib/attachmentDraft';
import { Button, Input, Select, Screen, SwitchRow, SegmentedControl, SectionTitle, DateField, TimeField, useHeaderCheckButton, FormError, CenteredLoader, Hint, ScreenTitle, BottomSheet, Card, ListRow, InfoCard } from '../../components/ui';
import FormAssist from '../../components/FormAssist';
import { form as formStyles } from '../../components/formStyles';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { EVENT_CALENDAR_TYPES, ymd } from '../../lib/calendar';
import { startKeepingDuration, endKeepingDuration } from '../../lib/datetime';
import { useCalendarColors, useCustomCalendars, useDeletedDefaultCalendars } from '../../lib/calendarPrefs';
import {
  sealNew, sealUpdate, openRecord, getHDK, newObjectId, ensureHouseholdKey,
  loadCalendarKeys, currentCalendarKeyVersion, sealForCalendar,
} from '../../lib/e2ee';
import { getFeedEventById, FEED_EVENT_ID_PREFIX } from '../../lib/calendarFeeds';
import { formatDuration } from '../../lib/format';
import { excludeUsedAlert } from '../../lib/recurrence';
import { eventDeletePrompt } from '../../lib/eventDelete';
import WheelPicker, { WHEEL_ITEM_H, WHEEL_VISIBLE } from '../../components/WheelPicker';
import {
  getQueuedInvitees, clearQueuedInvitees, useQueuedInvitees,
  getDraftGuestListVisible, setDraftGuestListVisible,
} from '../../lib/inviteeDraft';
import { inviteeKey, sendInvitations } from '../../lib/invitees';
import { useEmailComposer } from '../../components/EmailAppSheet';
import { useTravelDraft, clearTravelDraft } from '../../lib/travelDraft';
import { RepeatRule, WeekdayKind, isCustomRule, repeatSummary } from '../../lib/eventRepeat';
import { useRepeatDraft, clearRepeatDraft } from '../../lib/repeatDraft';
import { useLocationDraft, clearLocationDraft } from '../../lib/locationDraft';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'EventForm'>;
type Rt = RouteProp<CalendarStackParamList, 'EventForm'>;

const ALERT_OPTIONS = [
  { label: 'None', value: -1 },
  { label: 'At time of event', value: 0 },
  { label: '15 min before', value: 15 },
  { label: '30 min before', value: 30 },
  { label: '1 hour before', value: 60 },
  { label: '1 day before', value: 1440 },
];

// Sentinel picker value: opens the custom dual-wheel sheet instead of setting a time.
const CUSTOM_ALERT = -2;

// Leading glyph for an attachment row, by broad file kind.
function attachmentIcon(fileType?: string): keyof typeof Ionicons.glyphMap {
  if (fileType?.includes('pdf')) return 'document-text-outline';
  if (fileType?.startsWith('image')) return 'image-outline';
  return 'document-outline';
}

// File extension for a decrypted attachment's temp filename, from its mime type.
function extForType(fileType?: string): string {
  if (fileType?.includes('png')) return 'png';
  if (fileType?.includes('pdf')) return 'pdf';
  if (fileType?.includes('heic')) return 'heic';
  if (fileType?.includes('webp')) return 'webp';
  if (fileType?.includes('gif')) return 'gif';
  return 'jpg';
}

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Custom-alert unit: a string key so it drives the SegmentedControl directly.
type AlertUnit = 'min' | 'hr' | 'day';
const UNIT_MINUTES: Record<AlertUnit, number> = { min: 1, hr: 60, day: 1440 };
// Word shown beside the amount wheel (the live "[30] minutes" spinner readout).
const UNIT_LABEL: Record<AlertUnit, string> = { min: 'minutes', hr: 'hours', day: 'days' };
// Amount wheel range per unit (iOS timer-style: finer units, shorter ranges).
const AMOUNT_MAX: Record<AlertUnit, number> = { min: 59, hr: 23, day: 31 };
const CUSTOM_UNITS: { label: string; value: AlertUnit }[] = [
  { label: 'Minutes', value: 'min' },
  { label: 'Hours', value: 'hr' },
  { label: 'Days', value: 'day' },
];

// Decompose stored "minutes before the event" into the largest clean unit, to
// seed the wheel from the field's current value. No usable value → 30 minutes.
function decomposeAlert(minutes: number | null): { amount: number; unit: AlertUnit } {
  if (!minutes || minutes <= 0) return { amount: 30, unit: 'min' };
  const unit: AlertUnit = minutes % 1440 === 0 ? 'day' : minutes % 60 === 0 ? 'hr' : 'min';
  return { amount: Math.min(minutes / UNIT_MINUTES[unit], AMOUNT_MAX[unit]), unit };
}

// The alert picker's "Custom…" choice. A single amount wheel + the unit word
// beside it (the classic "[30] minutes" spinner readout), with the unit chosen
// via a SegmentedControl below. This mirrors the Repeat screen's "Every" sheet —
// one scroll wheel inside the modal, which scrolls reliably; the earlier
// two-adjacent-wheels layout did not. The unit has only 3 values, so a tap
// control is both more robust and more discoverable than a second wheel.
// Done emits plain "minutes before the event".
function CustomAlertSheet({
  visible,
  initialMinutes,
  onSave,
  onClose,
}: {
  visible: boolean;
  initialMinutes: number | null;
  onSave: (minutes: number) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(30);
  const [unit, setUnit] = useState<AlertUnit>('min');

  // Reseed from the field's current value each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    const d = decomposeAlert(initialMinutes);
    setAmount(d.amount);
    setUnit(d.unit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Switching to a coarser unit can leave the amount past its wheel's range.
  const pickUnit = (u: AlertUnit) => {
    setUnit(u);
    setAmount((a) => Math.min(a, AMOUNT_MAX[u]));
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} style={styles.alertSheet}>
      <View style={styles.wheelRow}>
        {/* Selection band sits behind the centered row, like the native spinner's. */}
        <View pointerEvents="none" style={styles.wheelBand} />
        <WheelPicker
          // Remount per open (fresh position) and per unit (clamped range).
          key={`amount-${String(visible)}-${unit}`}
          width={96}
          items={Array.from({ length: AMOUNT_MAX[unit] }, (_, i) => ({ label: String(i + 1), value: i + 1 }))}
          value={amount}
          onChange={setAmount}
        />
        <Text style={styles.wheelUnit}>{UNIT_LABEL[unit]}</Text>
      </View>
      <SegmentedControl<AlertUnit> value={unit} options={CUSTOM_UNITS} onChange={pickUnit} />
      <Button
        title="Done"
        onPress={() => {
          onSave(amount * UNIT_MINUTES[unit]);
          onClose();
        }}
      />
    </BottomSheet>
  );
}

// "a@x.com, b@y.com +2 more" — the Invitees card's one-line preview.
function inviteePreview(emails: string[]): string {
  if (!emails.length) return 'No one invited yet';
  const shown = emails.slice(0, 2).join(', ');
  return emails.length > 2 ? `${shown} +${emails.length - 2} more` : shown;
}

const REPEAT_OPTIONS = [
  { label: 'Never', value: '' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

// Sentinel picker value for the Repeat select's "Custom…" row. While a custom
// rule is active the select's value IS this sentinel, so the row shows the
// rule's summary ("Every 2 weeks on Monday") and tapping it reopens the Repeat
// screen to edit.
const CUSTOM_REPEAT = 'custom';

// Schema the AI form assistant fills. Names match the form-state keys.
const ASSIST_FIELDS: FormAssistField[] = [
  { name: 'title', type: 'text', label: 'Title' },
  { name: 'calendarType', type: 'select', label: 'Calendar', options: EVENT_CALENDAR_TYPES },
  { name: 'date', type: 'date', label: 'Start date' },
  { name: 'endDate', type: 'date', label: 'End date', description: 'Only for multi-day events on a different day than the start' },
  { name: 'allDay', type: 'boolean', label: 'All day', description: 'True for all-day events. Set false when a specific time is given.' },
  { name: 'startTime', type: 'time', label: 'Start time' },
  { name: 'endTime', type: 'time', label: 'End time' },
  { name: 'location', type: 'text', label: 'Location / address' },
  { name: 'url', type: 'text', label: 'URL / link' },
  { name: 'phone', type: 'text', label: 'Phone number' },
  { name: 'description', type: 'text', label: 'Notes' },
  { name: 'reminderMinutes', type: 'select', label: 'Alert before event', options: ALERT_OPTIONS },
  {
    name: 'leaveTimeAlert',
    type: 'boolean',
    label: 'Alert when it is time to leave',
    description:
      'Set true when the user wants the alert timed to when they should leave (based on drive time to the location), instead of a fixed number of minutes before the event. When true, do not also set reminderMinutes.',
  },
  { name: 'recurrFreq', type: 'select', label: 'Repeat', options: REPEAT_OPTIONS },
  {
    name: 'recurrInterval',
    type: 'number',
    label: 'Repeat every N',
    description:
      'Only for custom repeats like "every 2 weeks" or "every 3 months": set recurrFreq to the unit (weekly/monthly/…) and this to N. Omit for simple repeats.',
  },
  { name: 'recurrUntil', type: 'date', label: 'End repeat', description: 'Last date the event repeats. Only when the event repeats.' },
];

// RSVP labels for the Guests card on the guest (read-only invitee) view.
const GUEST_STATUS_LABEL: Record<string, string> = {
  pending: 'Invited',
  accepted: 'Going',
  declined: 'Declined',
  left: 'Left',
};

export default function EventFormScreen() {
  const navigation = useNavigation<Nav>();
  const { eventId, date, prefill } = useRoute<Rt>().params || {};
  const isEdit = !!eventId;
  const qc = useQueryClient();
  // The save check is tinted with the selected calendar's colour (respects
  // user overrides).
  const cal = useCalendarColors().colors;
  // Built-in event calendars plus the user's own (Calendars → Add Calendar).
  const { calendars: customCalendars } = useCustomCalendars();
  const { deletedIds: deletedDefaults } = useDeletedDefaultCalendars();
  // Mail composer for a draft's queued email invitees (sent on save): each
  // invitee without an account gets an email composed from the organizer's own
  // mail app — the sheet must live on THIS screen since the Invitees screen is
  // already closed by then.
  const { composeEmail, emailSheet } = useEmailComposer();

  const [form, setForm] = useState({
    title: '',
    calendarType: 'activities',
    date: date || ymd(new Date()),
    endDate: '',
    allDay: true,
    startTime: '09:00',
    endTime: '10:00',
    description: '',
    location: '',
    placeId: '',
    url: '',
    phone: '',
    fromAddress: '',
    // Travel time is off until enabled on the Travel Time screen. travelManual
    // = the user picked a fixed duration there (no auto recompute).
    travelEnabled: false,
    travelManual: false,
    travelMinutes: null as number | null,
    travelDistanceKm: null as string | null,
    reminderMinutes: null as number | null,
    alert2Minutes: null as number | null,
    recurrFreq: '',
    recurrInterval: 1,
    recurrDaysOfWeek: [] as number[],
    recurrDaysOfMonth: [] as number[],
    recurrMonths: [] as number[],
    recurrWeekOfMonth: null as number | null,
    recurrWeekdayKind: null as WeekdayKind | null,
    recurrUntil: '',
  });
  const [error, setError] = useState('');
  // Baseline for the unsaved-changes guard: a serialized snapshot of the form
  // once it's initialized (a new event is ready immediately; an edit waits for
  // the event to load and seed below). `dirty` compares the live form to it.
  const [seeded, setSeeded] = useState(!isEdit);
  const baselineRef = useRef<string | null>(null);
  // The destination/origin an edited event loads with. The auto-recompute effect
  // below skips while the live values still match this snapshot, so merely
  // opening an event never rewrites its saved travel time — only a user edit to
  // the location or starting point does. Null for new events (no baseline).
  const travelSeedRef = useRef<{ location: string; fromAddress: string } | null>(null);
  const [travelLoading, setTravelLoading] = useState(false);
  const [travelError, setTravelError] = useState('');
  // Set when the assistant asked for a "time to leave" alert before the drive
  // time was known; resolved to reminderMinutes once travel time computes.
  const [pendingLeaveAlert, setPendingLeaveAlert] = useState(false);
  const assist = useFormAssist();

  // The Calendar picker: built-ins minus any the user deleted from the
  // Calendars view (the event's current calendar always stays offered, so old
  // events keep rendering theirs), plus custom calendars where this user can
  // actually put events (View Only calendars are excluded).
  const calendarOptions = useMemo(() => {
    const builtIns = EVENT_CALENDAR_TYPES.filter(
      (o) => !deletedDefaults.includes(o.value) || o.value === form.calendarType
    );
    const customs = customCalendars
      // Subscribed (feed) and holiday calendars are read-only — never an event
      // destination.
      .filter((c) => !c.feedUrl && !c.holiday && (c.access === 'full' || c.id === form.calendarType))
      .map((c) => ({ label: c.name, value: c.id }));
    const opts = [...builtIns, ...customs];
    return opts.length ? opts : EVENT_CALENDAR_TYPES;
  }, [customCalendars, deletedDefaults, form.calendarType]);
  // The assistant's Calendar select must offer the same set.
  const assistFields = useMemo<FormAssistField[]>(
    () => ASSIST_FIELDS.map((f) => (f.name === 'calendarType' ? { ...f, options: calendarOptions } : f)),
    [calendarOptions]
  );

  // Manual edits clear the "AI changed this" highlight for the touched fields.
  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  // Moving the start (time or date) to at/after the end drags the end forward by
  // the same amount so the event keeps its length and the end is never left
  // before the start (10–11 → start 2pm becomes 2–3pm). Mirror of setEndTime/
  // setEndDate via the shared lib/datetime rule; cross-midnight aware, so a
  // pushed end may roll onto a later day (and folds back to a blank endDate when
  // it lands on the start's own day).
  const setStart = (patch: { date?: string; time?: string }) => {
    const nextDate = patch.date ?? form.date;
    const nextTime = patch.time ?? form.startTime;
    const out: Partial<typeof form> = {};
    if (patch.date !== undefined) out.date = patch.date;
    if (patch.time !== undefined) out.startTime = patch.time;
    const startTime = form.allDay ? '00:00' : form.startTime || '00:00';
    const endTime = form.allDay ? '00:00' : form.endTime || '00:00';
    const newStartTime = form.allDay ? '00:00' : nextTime || '00:00';
    const shifted = endKeepingDuration(
      { date: form.date, time: startTime },
      { date: form.endDate || form.date, time: endTime },
      { date: nextDate, time: newStartTime }
    );
    if (shifted) {
      if (!form.allDay) out.endTime = shifted.time;
      out.endDate = shifted.date === nextDate ? '' : shifted.date;
    }
    set(out);
  };

  // The mirror of setStart: dragging the end to at/before the start pulls the
  // start back so the event keeps its length (8–9 → end 4am makes start 3am). If
  // the shifted start crosses back over midnight, its date rolls to the previous
  // day and the (previously same-day) end date is pinned to the original day.
  const setEndTime = (v: string) => {
    const patch: Partial<typeof form> = { endTime: v };
    if (!form.allDay && form.startTime && form.endTime) {
      const endDate = form.endDate || form.date;
      const shifted = startKeepingDuration(
        { date: form.date, time: form.startTime },
        { date: endDate, time: form.endTime },
        { date: endDate, time: v }
      );
      if (shifted) {
        patch.startTime = shifted.time;
        if (shifted.date !== form.date) {
          patch.date = shifted.date;
          if (!form.endDate) patch.endDate = form.date;
        }
      }
    }
    set(patch);
  };

  // Ends date change: same rule across dates. If the new end date lands before the
  // start, slide the start (date + time) back to preserve the span; otherwise keep
  // the existing "same day ⇒ blank endDate" normalization.
  const setEndDate = (v: string) => {
    const startTime = form.allDay ? '00:00' : form.startTime || '00:00';
    const endTime = form.allDay ? '00:00' : form.endTime || '00:00';
    const shifted = startKeepingDuration(
      { date: form.date, time: startTime },
      { date: form.endDate || form.date, time: endTime },
      { date: v, time: endTime }
    );
    if (shifted) {
      const patch: Partial<typeof form> = { endDate: v, date: shifted.date };
      if (!form.allDay) patch.startTime = shifted.time;
      set(patch);
      return;
    }
    set({ endDate: v === form.date ? '' : v });
  };

  // Upload one picked file as an attachment on `evId`. E2EE is mandatory
  // (crypto-e2ee.md: no plaintext-content lane), so we ALWAYS encrypt on-device
  // and upload opaque ciphertext + a wrapped per-file key. There is deliberately
  // no plaintext fallback: it uploaded the raw picked URI straight to RN's
  // FormData, and some iOS photo URIs can't be read that way — the multipart part
  // arrived empty and the server rejected it with "No file uploaded". The encrypt
  // path instead reads the bytes via expo-file-system into a cache file that
  // always uploads cleanly, for photos and PDFs alike. Mirrors receipts/manuals.
  const uploadAttachment = async (evId: string, file: PickedFile) => {
    const endpoint = `/calendar/events/${evId}/attachments/upload`;
    // Make sure the household key is loaded before we encrypt — ensureHouseholdKey
    // populates both the HDK and the household id the wrap binds to. A first
    // upload can otherwise race ahead of the focus re-sync that normally loads them.
    if (!getHDK()) await ensureHouseholdKey().catch(() => {});
    const attId = await newObjectId();
    const sealed = await encryptFileForUpload('EventAttachment', attId, file.uri);
    if (!sealed) throw new Error('Unlock your account to attach files, then try again.');
    return uploadFile(endpoint, { uri: sealed.uri, name: `${attId}.bin`, type: 'application/octet-stream' }, 'file', {
      encrypted: true,
      _id: attId,
      wrappedFileKey: sealed.wrappedFileKey,
      keyVersion: sealed.keyVersion,
      fileType: file.type || 'application/octet-stream',
      title: file.name,
    });
  };

  // A new event defaults to Activities; if the user deleted that calendar,
  // snap to the first calendar the picker actually offers.
  useEffect(() => {
    if (isEdit) return;
    if (!calendarOptions.some((o) => o.value === form.calendarType)) {
      setForm((f) => ({ ...f, calendarType: (calendarOptions[0]?.value as string) ?? 'activities' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, calendarOptions, form.calendarType]);

  // Merge an AI patch into the form and mark the fields that actually changed.
  const applyPatch = (patch: Record<string, unknown>, noHighlight?: string[]) => {
    const next: Partial<typeof form> = {};
    const changedKeys: string[] = [];
    // Intent flag — resolved to a concrete reminderMinutes below/asynchronously.
    const wantsLeaveAlert = patch.leaveTimeAlert === true;
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in form)) continue; // skips non-form keys like leaveTimeAlert
      const val = k === 'reminderMinutes' && v === -1 ? null : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    // If the assistant set a start time on a timed event but gave no end time,
    // default the end to 30 minutes later (otherwise it keeps the stale default).
    const effectiveAllDay = 'allDay' in next ? next.allDay : form.allDay;
    if (!effectiveAllDay && typeof next.startTime === 'string' && next.startTime && patch.endTime == null) {
      const defaultEnd = addMinutesToTime(next.startTime, 30);
      if (form.endTime !== defaultEnd) changedKeys.push('endTime');
      next.endTime = defaultEnd;
    }

    // A leave-time alert takes precedence over any fixed reminder. Apply it now
    // if the drive time is already known; otherwise defer until it computes.
    if (wantsLeaveAlert) {
      if (form.travelMinutes && !form.allDay) {
        next.reminderMinutes = form.travelMinutes;
        if (!changedKeys.includes('reminderMinutes')) changedKeys.push('reminderMinutes');
        setPendingLeaveAlert(false);
      } else {
        // Travel time must be on for the drive time to compute at all.
        next.travelEnabled = true;
        setPendingLeaveAlert(true);
      }
    }
    setForm((f) => ({ ...f, ...next }));
    assist.mark(noHighlight ? changedKeys.filter((k) => !noHighlight.includes(k)) : changedKeys);
  };

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Event' : 'New Event' });
  }, [navigation, isEdit]);

  // Pre-fill a new event from the calendar assistant's draft ("Edit in form").
  // Uses the same patch path as FormAssist so the filled fields get highlighted —
  // except the date/time/all-day fields, which every event always carries: the
  // form seeds them with defaults, so outlining them as "AI changed this" is just
  // noise. Highlight only the fields the assistant genuinely populated (title,
  // location, phone, notes, …).
  const prefilled = useRef(false);
  useEffect(() => {
    if (isEdit || prefilled.current || !prefill) return;
    prefilled.current = true;
    applyPatch(prefill, ['allDay', 'date', 'startTime', 'endDate', 'endTime']);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, isEdit]);

  // For a new event, once a destination (the event location) is set, default
  // travel time ON with the origin seeded from the user's CURRENT location — but
  // only when they've already shared location with the app (this never prompts;
  // the GPS fix is only taken once a destination exists). Travel time is not
  // relevant before then, so it stays off. With no shared location it stays off
  // too. Applied once so it never fights the user turning it back off. Edit keeps
  // the event's saved setting (the eventQ effect above owns those fields).
  const hasDestination = !!form.location.trim();
  const currentLocQ = useQuery({
    queryKey: ['currentLocationAddress'],
    queryFn: resolveCurrentAddressIfShared,
    enabled: !isEdit && hasDestination,
  });
  const travelDefaulted = useRef(false);
  useEffect(() => {
    if (isEdit || travelDefaulted.current || !hasDestination) return;
    const origin = currentLocQ.data;
    if (!origin) return;
    travelDefaulted.current = true;
    setForm((f) => ({ ...f, travelEnabled: true, fromAddress: f.fromAddress || origin }));
  }, [currentLocQ.data, hasDestination, isEdit]);

  // Travel time is anchored to the destination: clearing the location removes
  // that anchor, so switch travel time off (and drop the stale drive time). Runs
  // in both add and edit — only ever turns it off, so it can't fight the user.
  useEffect(() => {
    if (hasDestination || !form.travelEnabled) return;
    setForm((f) => ({
      ...f,
      travelEnabled: false,
      travelManual: false,
      travelMinutes: null,
      travelDistanceKm: null,
    }));
  }, [hasDestination, form.travelEnabled]);

  // Compute traffic-aware drive time from the origin to the event location.
  const fetchTravelTime = async () => {
    const destination = form.location?.trim();
    const origin = form.fromAddress?.trim();
    if (!destination) return;
    setForm((f) => ({ ...f, travelMinutes: null, travelDistanceKm: null }));
    setTravelError('');
    setTravelLoading(true);
    try {
      const { data } = await placesApi.getTravelTime(destination, origin);
      const d = data as { minutes?: number; distanceKm?: string };
      setForm((f) => ({ ...f, travelMinutes: d.minutes ?? null, travelDistanceKm: d.distanceKm ?? null }));
    } catch (e: any) {
      setTravelError(e.response?.data?.error || "Couldn't calculate drive time");
    } finally {
      setTravelLoading(false);
    }
  };

  // Recompute (debounced) whenever the location or starting point changes —
  // only while travel time is enabled and not set to a manual duration.
  useEffect(() => {
    if (!form.travelEnabled || form.travelManual) return;
    if (!form.location.trim()) return;
    // Editing: never auto-change travel time just from opening the event. The
    // seed populates location (and leaves origin blank), which would otherwise
    // trigger a recompute that overwrites the saved minutes. Only recompute once
    // the user actually changes the destination or starting point.
    const seed = travelSeedRef.current;
    if (seed && seed.location === form.location && seed.fromAddress === form.fromAddress) return;
    const t = setTimeout(fetchTravelTime, 700);
    return () => clearTimeout(t);
  }, [form.location, form.fromAddress, form.travelEnabled, form.travelManual]);

  // Apply edits made on the pushed Travel Time screen as they happen.
  const travelDraft = useTravelDraft();
  useEffect(() => {
    if (!travelDraft) return;
    setForm((f) => ({
      ...f,
      travelEnabled: travelDraft.enabled,
      fromAddress: travelDraft.fromAddress,
      travelManual: travelDraft.manualMinutes != null,
      travelMinutes: !travelDraft.enabled ? null : travelDraft.manualMinutes ?? f.travelMinutes,
      travelDistanceKm: travelDraft.enabled && travelDraft.manualMinutes == null ? f.travelDistanceKm : null,
    }));
  }, [travelDraft]);
  useEffect(() => () => clearTravelDraft(), []);

  // Apply the location picked on the pushed Location view (address + business
  // phone + placeId; the phone comes back even when cleared there on purpose).
  const locationDraft = useLocationDraft();
  useEffect(() => {
    if (!locationDraft) return;
    setForm((f) => ({
      ...f,
      location: locationDraft.location,
      phone: locationDraft.phone,
      placeId: locationDraft.placeId ?? '',
    }));
  }, [locationDraft]);
  useEffect(() => () => clearLocationDraft(), []);

  // Apply edits made on the pushed Repeat screen as they happen.
  const repeatDraft = useRepeatDraft();
  useEffect(() => {
    if (!repeatDraft) return;
    setForm((f) => ({
      ...f,
      recurrFreq: repeatDraft.freq,
      recurrInterval: repeatDraft.interval,
      recurrDaysOfWeek: repeatDraft.daysOfWeek,
      recurrDaysOfMonth: repeatDraft.daysOfMonth,
      recurrMonths: repeatDraft.months,
      recurrWeekOfMonth: repeatDraft.weekOfMonth,
      recurrWeekdayKind: repeatDraft.weekdayKind,
    }));
  }, [repeatDraft]);
  useEffect(() => () => clearRepeatDraft(), []);

  // Which alert field the custom dual-wheel sheet is editing (null = closed).
  const [customFor, setCustomFor] = useState<'reminderMinutes' | 'alert2Minutes' | null>(null);

  // The assistant may ask for a "time to leave" alert before the drive time is
  // known; apply it as soon as travel time computes (on a timed event).
  useEffect(() => {
    if (!pendingLeaveAlert || form.allDay || !form.travelMinutes) return;
    setForm((f) => ({ ...f, reminderMinutes: f.travelMinutes }));
    assist.add(['reminderMinutes']);
    setPendingLeaveAlert(false);
  }, [pendingLeaveAlert, form.travelMinutes, form.allDay]);

  // The clock time the user needs to leave by = start time − drive time.
  const leaveByTime = useMemo(() => {
    const { travelMinutes, allDay, startTime } = form;
    if (!travelMinutes || allDay || !startTime) return null;
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m - travelMinutes;
    if (total < 0) return null;
    const lh = Math.floor(total / 60);
    const lm = total % 60;
    const ampm = lh >= 12 ? 'PM' : 'AM';
    return `${lh % 12 || 12}:${String(lm).padStart(2, '0')} ${ampm}`;
  }, [form.travelMinutes, form.allDay, form.startTime]);

  // Alert options. When a drive time is available on a timed event, prepend a
  // set of departure-relative choices so the user can be alerted when it's time
  // to leave — or a chosen number of minutes before that. `reminderMinutes` is
  // stored as "minutes before the event", so leaving early = travelMinutes + buffer.
  const alertItems = useMemo(() => {
    const leaveItems: { value: number; label: string }[] = [];
    if (form.travelMinutes && !form.allDay) {
      const buffers = [0, 5, 10, 15, 30]; // minutes before departure
      for (const buf of buffers) {
        // No computable departure time (e.g. no start time yet) — omit "Time to leave".
        if (buf === 0 && !leaveByTime) continue;
        const label = buf === 0 ? `Time to leave (${leaveByTime})` : `${buf} min before leaving`;
        leaveItems.push({ value: form.travelMinutes + buf, label });
      }
    }
    // Dedupe by value (a leave option may collide with a base "X min before").
    const used = new Set(leaveItems.map((i) => i.value));
    const base = ALERT_OPTIONS.filter((o) => !used.has(o.value));
    // "None" stays first; departure-relative options follow it so they're
    // visible without scrolling (the option modal caps at 70% screen height).
    const items = [base[0], ...leaveItems, ...base.slice(1)];
    // A saved custom value has no canned option — synthesize a label for it so
    // the field doesn't show the placeholder. When a drive time is known and
    // the value reaches past it, describe it relative to departure instead.
    for (const v of [form.reminderMinutes, form.alert2Minutes]) {
      if (v == null || v <= 0 || items.some((i) => i.value === v)) continue;
      const label =
        form.travelMinutes && !form.allDay && v >= form.travelMinutes
          ? `${formatDuration(v - form.travelMinutes)} before leaving`
          : `${formatDuration(v)} before`;
      items.push({ value: v, label });
    }
    items.push({ label: 'Custom…', value: CUSTOM_ALERT });
    return items;
  }, [form.travelMinutes, form.allDay, leaveByTime, form.reminderMinutes, form.alert2Minutes]);

  // Repeat options + the select's value. A custom rule ("every 2 weeks on
  // Monday") selects the Custom row and labels it with the rule's summary.
  const repeatRule: RepeatRule = useMemo(
    () => ({
      freq: form.recurrFreq as RepeatRule['freq'],
      interval: form.recurrInterval,
      daysOfWeek: form.recurrDaysOfWeek,
      daysOfMonth: form.recurrDaysOfMonth,
      months: form.recurrMonths,
      weekOfMonth: form.recurrWeekOfMonth,
      weekdayKind: form.recurrWeekdayKind,
    }),
    [
      form.recurrFreq, form.recurrInterval, form.recurrDaysOfWeek,
      form.recurrDaysOfMonth, form.recurrMonths, form.recurrWeekOfMonth, form.recurrWeekdayKind,
    ],
  );
  const customRepeatActive = isCustomRule(repeatRule);
  const repeatItems = useMemo(
    () => [
      ...REPEAT_OPTIONS,
      { label: customRepeatActive ? repeatSummary(repeatRule) : 'Custom…', value: CUSTOM_REPEAT },
    ],
    [customRepeatActive, repeatRule],
  );
  const repeatValue = customRepeatActive ? CUSTOM_REPEAT : form.recurrFreq;

  // Feed occurrences are synthetic (feed:<cal>:<start>:<uid>): no server row
  // exists, so resolve them from the last local expansion. They carry
  // readOnly: true, so the read-only view renders without any further queries.
  const isFeedEvent = !!eventId?.startsWith(FEED_EVENT_ID_PREFIX);
  const eventQ = useQuery({
    queryKey: ['calendar', 'event', eventId],
    queryFn: async () => {
      if (isFeedEvent) {
        const e = getFeedEventById(eventId!);
        if (!e) throw new Error('Feed event not found');
        return e;
      }
      return (await calendarApi.getEvent(eventId!)).data;
    },
    enabled: isEdit,
  });
  useEffect(() => {
    if (!eventQ.data) return;
    let cancelled = false;
    (async () => {
      // E2EE dual-write: prefer decrypted content, falling back to plaintext.
      const e = await openRecord('CalendarEvent', eventQ.data);
      if (cancelled) return;
      const start = new Date(e.startDate);
      const pad = (n: number) => String(n).padStart(2, '0');
      set({
        title: e.title ?? '',
        calendarType: e.calendarType ?? 'activities',
        date: e.startDate.slice(0, 10),
        endDate: e.endDate ? e.endDate.slice(0, 10) : '',
        allDay: e.allDay ?? true,
        startTime: e.allDay ? '09:00' : `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        endTime: e.endDate && !e.allDay ? `${pad(new Date(e.endDate).getHours())}:${pad(new Date(e.endDate).getMinutes())}` : '10:00',
        description: e.description ?? '',
        location: e.location ?? '',
        placeId: (e as { placeId?: string }).placeId ?? '',
        url: e.url ?? '',
        phone: e.phone ?? '',
        travelEnabled: e.travelMinutes != null,
        // Auto-computed times always store a distance; a bare minutes value
        // means a manually picked duration.
        travelManual: e.travelMinutes != null && e.travelDistanceKm == null,
        travelMinutes: e.travelMinutes ?? null,
        travelDistanceKm: e.travelDistanceKm ?? null,
        reminderMinutes: e.reminderMinutes ?? null,
        alert2Minutes: e.alert2Minutes ?? null,
        recurrFreq: e.recurrence?.freq ?? '',
        recurrInterval: e.recurrence?.interval ?? 1,
        recurrDaysOfWeek: e.recurrence?.daysOfWeek ?? [],
        recurrDaysOfMonth: e.recurrence?.daysOfMonth ?? [],
        recurrMonths: e.recurrence?.months ?? [],
        recurrWeekOfMonth: e.recurrence?.weekOfMonth ?? null,
        recurrWeekdayKind: e.recurrence?.weekdayKind ?? null,
        // `until` is stored as end of the chosen *local* day (see save), so its
        // UTC calendar date can be the next day. Derive the local Y-M-D back —
        // slicing the ISO string would read the UTC date and drift a day forward
        // on every edit.
        recurrUntil: e.recurrence?.until ? ymd(new Date(String(e.recurrence.until))) : '',
      });
      // Remember what travel loaded with so the recompute effect can tell an
      // untouched open (skip) from a real user edit (recompute). Origin isn't
      // seeded onto the form, so it starts blank.
      travelSeedRef.current = { location: e.location ?? '', fromAddress: '' };
      // Seed the Invitees screen's guest-list switch (missing on events that
      // predate the setting — treated as visible).
      setDraftGuestListVisible(e.guestListVisible !== false);
      // The form now mirrors the saved event — let the guard snapshot it as the
      // clean baseline (any later edit registers as unsaved).
      setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [eventQ.data]);

  // Form date/time state → the ISO instants the API stores (all-day at noon UTC).
  const buildStartEnd = () => {
    const allDay = form.allDay;
    const startDate = allDay
      ? `${form.date}T12:00:00.000Z`
      : new Date(`${form.date}T${form.startTime}:00`).toISOString();
    const endPart = form.endDate || form.date;
    const endDate = allDay
      ? form.endDate
        ? `${form.endDate}T12:00:00.000Z`
        : undefined
      : form.endTime
      ? new Date(`${endPart}T${form.endTime}:00`).toISOString()
      : undefined;
    return { startDate, endDate };
  };

  // The decrypted event content an invitation carries (email + .ics + the
  // recipient's copy) — the server can't read an E2EE event's own fields.
  const buildSnapshot = () => {
    const { startDate, endDate } = buildStartEnd();
    return {
      title: form.title.trim(),
      description: form.description || undefined,
      location: form.location || undefined,
      phone: form.phone || undefined,
      startDate,
      endDate,
      allDay: form.allDay,
      calendarType: form.calendarType,
    };
  };

  const save = useMutation({
    mutationFn: async () => {
      const allDay = form.allDay;
      const { startDate, endDate } = buildStartEnd();
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        calendarType: form.calendarType,
        allDay,
        startDate,
        endDate,
        description: form.description || undefined,
        location: form.location || undefined,
        placeId: form.placeId || undefined,
        url: form.url || undefined,
        phone: form.phone || undefined,
        // null (not undefined) so turning travel time off clears the stored
        // values on update — the route skips undefined fields.
        travelMinutes: form.travelEnabled ? form.travelMinutes ?? null : null,
        travelDistanceKm: form.travelEnabled ? form.travelDistanceKm ?? null : null,
        // Sealed event content (C3b) set on the Invitees screen; the draft store
        // is seeded from the fetched event on edit, so re-sealing here preserves
        // the current value instead of wiping it from `enc`.
        guestListVisible: getDraftGuestListVisible(),
        reminderMinutes: form.reminderMinutes ?? undefined,
        alert2Minutes:
          form.reminderMinutes !== null && form.alert2Minutes !== null ? form.alert2Minutes : undefined,
        recurrence: form.recurrFreq
          ? {
              freq: form.recurrFreq,
              interval: form.recurrInterval > 1 ? form.recurrInterval : undefined,
              daysOfWeek:
                form.recurrFreq === 'weekly' && form.recurrDaysOfWeek.length ? form.recurrDaysOfWeek : undefined,
              daysOfMonth:
                form.recurrFreq === 'monthly' && form.recurrDaysOfMonth.length ? form.recurrDaysOfMonth : undefined,
              months: form.recurrFreq === 'yearly' && form.recurrMonths.length ? form.recurrMonths : undefined,
              // The ordinal rule rides with monthly "on the…" or yearly months.
              weekOfMonth:
                (form.recurrFreq === 'monthly' && !form.recurrDaysOfMonth.length) ||
                (form.recurrFreq === 'yearly' && form.recurrMonths.length)
                  ? form.recurrWeekOfMonth ?? undefined
                  : undefined,
              weekdayKind:
                (form.recurrFreq === 'monthly' && !form.recurrDaysOfMonth.length) ||
                (form.recurrFreq === 'yearly' && form.recurrMonths.length)
                  ? form.recurrWeekdayKind ?? undefined
                  : undefined,
              // End of the chosen local day, so the last occurrence is included.
              until: form.recurrUntil ? new Date(`${form.recurrUntil}T23:59:59`).toISOString() : undefined,
            }
          : undefined,
      };
      // Signal-parity D1: an event on an outside-shared calendar we hold a
      // CalendarKey for seals under that key (enc.ks='cal') so collaborators can
      // read it — no plaintext feed. Otherwise it dual-writes under the HDK.
      const calType = String(payload.calendarType);
      let useCalKey = false;
      if (calType.startsWith('custom-')) {
        await loadCalendarKeys(calType).catch(() => {});
        useCalKey = currentCalendarKeyVersion(calType) > 0;
      }
      // E2EE dual-write: send ciphertext alongside plaintext (no-op without an HDK).
      if (isEdit) {
        const sealed = useCalKey
          ? await sealForCalendar('CalendarEvent', eventId!, calType, payload)
          : null;
        const body = sealed ? { ...payload, ...sealed } : await sealUpdate('CalendarEvent', eventId!, payload);
        return calendarApi.updateEvent(eventId!, body);
      }
      if (useCalKey) {
        const _id = await newObjectId();
        const sealed = await sealForCalendar('CalendarEvent', _id, calType, payload);
        if (sealed) return calendarApi.createEvent({ _id, ...payload, ...sealed });
      }
      return calendarApi.createEvent(await sealNew('CalendarEvent', payload));
    },
    onSuccess: async (res) => {
      // A new event sends the invitees queued on its Invitees screen — a draft
      // has no event id, so this is the first moment invitations CAN go out.
      // Emails post in parallel; each phone entry opens the Messages composer
      // in turn (send failures are dropped — the form is already closing).
      if (!isEdit) {
        const queued = getQueuedInvitees();
        if (queued.length) {
          await sendInvitations(res.data._id, queued, buildSnapshot(), getDraftGuestListVisible(), composeEmail);
          clearQueuedInvitees();
        }
        // Attachments picked on the draft form upload now that the event exists.
        // A failed upload doesn't block the save the user just confirmed, but we
        // no longer swallow it silently — the user is told which files didn't
        // attach (and why) so a failure isn't mistaken for a successful upload.
        const queuedFiles = getQueuedAttachments();
        const failed: string[] = [];
        for (const f of queuedFiles) {
          try { await uploadAttachment(res.data._id, f); }
          catch (e: any) { failed.push(f.name); }
        }
        clearQueuedAttachments();
        if (failed.length) {
          Alert.alert(
            'Some attachments didn’t upload',
            `The event was saved, but these files couldn’t be attached: ${failed.join(', ')}. Open the event to try again.`,
          );
        }
      }
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      navigation.goBack();
    },
    // Surface save failures (e.g. the E2EE write-guard rejecting a locked save)
    // as a prominent alert rather than easily-missed inline text at the bottom.
    onError: (e: any) => Alert.alert("Couldn't save event", e.response?.data?.error || 'Save failed'),
  });

  // A one-off event deletes outright; a recurring occurrence offers Apple's
  // "this event" / "all future" choices (eventDeletePrompt) — the chosen action's
  // api call is the mutation's argument, so Delete keeps its pending state.
  const del = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      navigation.goBack();
    },
    onError: (e: any) => Alert.alert("Couldn't delete event", e.response?.data?.error || 'Delete failed'),
  });

  // An event copy accepted from a cross-household invitation. The recipient is
  // a guest, not the organizer: the whole event is READ-ONLY for them (the
  // server rejects edits with 403) and "Leave event" is their only action.
  // Household-owned events are unaffected — every member edits those as usual.
  const guestInvitationId = eventQ.data?.invitationId;
  // An event read as an outside collaborator on its shared calendar (§9.5):
  // the same read-only view, but there is nothing to leave — access is managed
  // via the calendar invitation, not per event. The server's `readOnly` stamp
  // retired with the C3b move to the opaque record store, so recompute it
  // client-side from the calendar's access level (the server 403s the write
  // regardless — this keeps the UI from offering one).
  const evCal = customCalendars.find((c) => c.id === eventQ.data?.calendarType);
  const collabReadOnly = !!eventQ.data?.readOnly || (!!evCal && evCal.access === 'view');
  const readOnlyView = !!guestInvitationId || collabReadOnly;
  useEffect(() => {
    if (readOnlyView) navigation.setOptions({ title: 'Event' });
  }, [navigation, readOnlyView]);

  // ── Attachments ──────────────────────────────────────────────────────────
  // A saved event loads its attachments from the server; a NEW event stages
  // picked files in the draft store and uploads them after the save creates the
  // event (see the save mutation's onSuccess).
  const attachmentsQ = useQuery({
    queryKey: ['calendar', 'attachments', eventId],
    queryFn: async () => (await eventAttachmentsApi.list(eventId!)).data,
    enabled: isEdit && !!eventQ.data && !readOnlyView,
  });
  const queuedAttachments = useQueuedAttachments();
  // Start each new form with an empty queue (an abandoned draft leaves picks behind).
  useEffect(() => {
    if (!isEdit) clearQueuedAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload a pick to a saved event (new events queue it instead).
  const addAttachment = useMutation({
    mutationFn: (file: PickedFile) => uploadAttachment(eventId!, file),
    onSuccess: () => attachmentsQ.refetch(),
    onError: (e: any) => Alert.alert('Upload failed', e.response?.data?.error || 'Could not upload that file.'),
  });

  const onPickFile = (file: PickedFile | null) => {
    if (!file) return;
    if (isEdit) addAttachment.mutate(file);
    else addQueuedAttachment(file);
  };

  // Add-attachment source picker: camera / photo library / file (PDF etc.).
  const openAttachmentPicker = () => {
    const cam = async () => onPickFile(await takePhoto());
    const lib = async () => onPickFile(await pickImage());
    const doc = async () => onPickFile(await pickDocument());
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Take Photo', 'Choose Photo', 'Choose File', 'Cancel'], cancelButtonIndex: 3 },
        (i) => { if (i === 0) cam(); else if (i === 1) lib(); else if (i === 2) doc(); }
      );
    } else {
      Alert.alert('Add attachment', undefined, [
        { text: 'Take Photo', onPress: cam },
        { text: 'Choose Photo', onPress: lib },
        { text: 'Choose File', onPress: doc },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  // Open a saved attachment: encrypted ones download as ciphertext, decrypt
  // on-device to a temp file, then share/open; plaintext ones open directly.
  const openAttachment = useMutation({
    mutationFn: async (a: EventAttachment) => {
      const dlUrl = `${API_URL}/calendar/attachments/${a._id}/download`;
      if (!a.encrypted) { await Linking.openURL(`${dlUrl}?token=${getCachedToken()}`); return; }
      if (!getHDK() || !a.wrappedFileKey) throw new Error('Unlock your account to open this encrypted attachment.');
      const cipherUri = `${cacheDirectory}dl-att-${a._id}.bin`;
      const dl = await downloadAsync(dlUrl, cipherUri, { headers: { Authorization: `Bearer ${getCachedToken()}` } });
      const plainUri = await decryptDownloadedFile(
        'EventAttachment', a._id, a.keyVersion, a.wrappedFileKey, dl.uri,
        `${a.title || 'attachment'}.${extForType(a.fileType)}`,
      );
      if (!plainUri) throw new Error('Could not decrypt this attachment.');
      await Share.share({ url: plainUri });
    },
    onError: (e: any) => Alert.alert('Could not open attachment', e?.message || 'Please try again.'),
  });

  const delAttachment = useMutation({
    mutationFn: (id: string) => eventAttachmentsApi.delete(id),
    onSuccess: () => attachmentsQ.refetch(),
    onError: (e: any) => Alert.alert('Could not remove', e.response?.data?.error || 'Please try again.'),
  });

  // The guest's own invitation, to show who invited them.
  const myInvitesQ = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => (await invitationsApi.list()).data,
    enabled: !!guestInvitationId,
  });
  const inviter = myInvitesQ.data?.find((i) => i._id === guestInvitationId);

  // Who else is invited — only returned if the organizer's event allows it
  // (guestListVisible); the server answers visible:false otherwise.
  const guestListQ = useQuery({
    queryKey: ['invitations', 'guests', guestInvitationId],
    queryFn: async () => (await invitationsApi.guests(guestInvitationId!)).data,
    enabled: !!guestInvitationId,
  });

  // The organizer's invitee list, previewed on the Invitees card (managed on
  // the EventInvitees screen; never fetched for a guest copy).
  const inviteesQ = useQuery({
    queryKey: ['invitations', 'sent', eventId],
    queryFn: async () => (await invitationsApi.sentForEvent(eventId!)).data,
    enabled: isEdit && !!eventQ.data && !readOnlyView,
  });

  // A NEW event's invitees queue in the draft store until save can send them.
  // Start each new form with a clean queue (an abandoned draft leaves one behind).
  const queuedInvitees = useQueuedInvitees();
  useEffect(() => {
    if (!isEdit) clearQueuedInvitees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const inviteeEmails = isEdit
    ? (inviteesQ.data ?? []).map((i) => i.toEmail ?? i.toPhone ?? '')
    : queuedInvitees.map(inviteeKey);

  // Guest leaves the event: their copy is deleted and the invitation retired.
  const leave = useMutation({
    mutationFn: () => invitationsApi.leave(guestInvitationId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['invitations'] });
      allowLeave();
      navigation.goBack();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not leave the event'),
  });

  const onSave = () => {
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    setError('');
    save.mutate();
  };

  // Delete from the edit form: a one-off event confirms once; a recurring one
  // offers Apple's "this event" / "all future" choices. Uses the decrypted event
  // (eventQ.data) so the recurrence + start day are the real ones, and `date`
  // (the occurrence the form was opened from) as the target occurrence.
  const onDelete = () => {
    if (!eventQ.data) return;
    const { title, message, choices } = eventDeletePrompt(eventQ.data, date);
    Alert.alert(
      title,
      message,
      choices.map((c) => ({
        text: c.text,
        style: c.style,
        onPress: c.perform ? () => del.mutate(c.perform!) : undefined,
      })),
    );
  };

  // The active calendar's colour, tinting this area's accents (save check, the
  // Add-attachment row, spinners) per the app's section-accent convention.
  const accent = cal[form.calendarType] || customCalendars.find((c) => c.id === form.calendarType)?.color || colors.primary;

  useHeaderCheckButton(navigation, {
    onPress: onSave,
    loading: save.isPending,
    color: accent,
    // Guests and calendar collaborators have nothing to save — read-only view below.
    enabled: !readOnlyView,
  });

  // Snapshot the clean baseline once the form is initialized (immediately for a
  // new event; after the edit seed sets `seeded`). Captured before the prefill
  // effect commits, so an assistant-prefilled draft correctly reads as dirty.
  useEffect(() => {
    if (baselineRef.current !== null || !seeded) return;
    baselineRef.current = JSON.stringify(form);
  }, [seeded, form]);

  // The form differs from its clean baseline, or a new event has queued invitees
  // or attachments that would be lost on leave. Read-only viewers can't edit, so
  // they never trigger the discard prompt.
  const dirty =
    !readOnlyView &&
    ((baselineRef.current !== null && JSON.stringify(form) !== baselineRef.current) ||
      (!isEdit && (queuedInvitees.length > 0 || queuedAttachments.length > 0)));
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  if (isEdit && eventQ.isLoading) {
    return <CenteredLoader color={cal[form.calendarType] || colors.primary} />;
  }

  // ── Read-only view (guest invitee or calendar collaborator): event details,
  // no form. Guests get Leave as their only action; collaborators get none —
  // their access is managed on the calendar invitation. ──
  if (readOnlyView) {
    const fmtDay = (d: string) =>
      new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const fmtTime = (t: string) =>
      new Date(`2000-01-01T${t}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    const when = form.allDay
      ? form.endDate && form.endDate !== form.date
        ? `${fmtDay(form.date)} – ${fmtDay(form.endDate)}`
        : fmtDay(form.date)
      : `${fmtDay(form.date)}, ${fmtTime(form.startTime)}${form.endTime ? ` – ${fmtTime(form.endTime)}` : ''}`;
    const inviterName = inviter?.fromName || inviter?.fromEmail;

    return (
      <Screen>
        <ScreenTitle>{form.title}</ScreenTitle>
        {inviterName ? <Text style={styles.guestInviter}>Invited by {inviterName}</Text> : null}

        <InfoCard style={styles.infoCard}>
          <ListRow icon="time-outline" title={when} />
          {form.location ? <ListRow icon="location-outline" title={form.location} /> : null}
          {form.phone ? <ListRow icon="call-outline" title={form.phone} /> : null}
        </InfoCard>

        {guestListQ.data?.visible && guestListQ.data.guests.length ? (
          <>
            <SectionTitle>Guests</SectionTitle>
            <InfoCard style={styles.infoCard}>
              <ListRow
                icon="person-circle-outline"
                title={guestListQ.data.organizer?.name || guestListQ.data.organizer?.email || 'Organizer'}
                right={<Text style={styles.guestStatus}>Organizer</Text>}
              />
              {guestListQ.data.guests.map((g) => (
                <ListRow
                  key={g._id}
                  icon="person-outline"
                  title={(g._id === guestInvitationId ? 'You' : g.toEmail || g.toPhone) || ''}
                  right={<Text style={styles.guestStatus}>{GUEST_STATUS_LABEL[g.status]}</Text>}
                />
              ))}
            </InfoCard>
          </>
        ) : null}

        {form.description ? (
          <>
            <SectionTitle>Notes</SectionTitle>
            <Text style={styles.guestNotes}>{form.description}</Text>
          </>
        ) : null}

        <Hint style={styles.guestHint}>
          {collabReadOnly
            ? `You have view-only access to “${
                customCalendars.find((c) => c.id === form.calendarType)?.name ?? 'this calendar'
              }”, so its events can’t be edited.`
            : 'You’re a guest on this event, so it can’t be edited. Only the organizer can change it.'}
        </Hint>

        <FormError>{error}</FormError>

        {guestInvitationId ? (
          <View style={formStyles.footer}>
            <Button
              title="Leave event"
              variant="danger"
              loading={leave.isPending}
              onPress={() =>
                Alert.alert('Leave event?', 'This removes the event from your calendar.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Leave', style: 'destructive', onPress: () => leave.mutate() },
                ])
              }
            />
          </View>
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen>
      <FormAssist
        formType="calendar event"
        placeholder={'Describe the event, e.g. "dentist next Tuesday at 2pm, remind me when it\'s time to leave"'}
        fields={assistFields}
        current={form}
        onApply={applyPatch}
        includeContacts
      />

      {/* Title + Location grouped in one card (Apple Calendar-style): no labels,
          placeholder text only, rows separated by a hairline. */}
      <View style={formStyles.groupCard}>
        <Input
          value={form.title}
          onChangeText={(v) => set({ title: v })}
          placeholder="Title"
          // Explicit: the keyboard must open shifted so the first letter of a
          // title is capitalized without reaching for shift (RN's documented
          // 'sentences' default doesn't survive to the native field here).
          autoCapitalize="sentences"
          containerStyle={formStyles.headField}
          style={[formStyles.headInput, assist.changed.has('title') && formStyles.headInputHighlight]}
        />
        <View style={formStyles.cardDivider} />
        {/* Opens the Location view (search + editable details incl. the
            business phone); the picked values flow back via locationDraft. */}
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() =>
            navigation.navigate('EventLocation', {
              initial: {
                location: form.location || undefined,
                phone: form.phone || undefined,
                placeId: form.placeId || undefined,
              },
            })
          }
        >
          <View pointerEvents="none">
            <Input
              value={form.location}
              editable={false}
              placeholder="Location or Video Call"
              containerStyle={formStyles.headField}
              style={[formStyles.headInput, assist.changed.has('location') && formStyles.headInputHighlight]}
            />
          </View>
        </TouchableOpacity>
      </View>

      {/* All day / Starts / Ends / Travel Time grouped card */}
      <View style={formStyles.groupCard}>
        <View style={formStyles.groupPad}>
          <SwitchRow label="All day" value={form.allDay} onValueChange={(v) => set({ allDay: v })} color={accent} highlight={assist.changed.has('allDay')} />
        </View>
        <View style={formStyles.cardDivider} />
        <View style={formStyles.dtRow}>
          <Text style={formStyles.dtLabel}>Starts</Text>
          <View style={formStyles.dtFields}>
            <DateField
              value={form.date}
              onChange={(v) => setStart({ date: v })}
              highlight={assist.changed.has('date')}
              containerStyle={formStyles.dtFieldWrap}
              fieldStyle={formStyles.dtField}
              valueStyle={formStyles.dtValue}
              hideIcon
            />
            {!form.allDay ? (
              <TimeField
                value={form.startTime}
                onChange={(v) => setStart({ time: v })}
                highlight={assist.changed.has('startTime')}
                containerStyle={formStyles.dtFieldWrap}
                fieldStyle={formStyles.dtField}
                valueStyle={formStyles.dtValue}
                hideIcon
              />
            ) : null}
          </View>
        </View>
        <View style={formStyles.cardDivider} />
        <View style={formStyles.dtRow}>
          <Text style={formStyles.dtLabel}>Ends</Text>
          <View style={formStyles.dtFields}>
            {/* Defaults to the start date; form.endDate stays unset (= same day)
                until a different date is picked. */}
            <DateField
              value={form.endDate || form.date}
              onChange={setEndDate}
              highlight={assist.changed.has('endDate')}
              containerStyle={formStyles.dtFieldWrap}
              fieldStyle={formStyles.dtField}
              valueStyle={formStyles.dtValue}
              hideIcon
            />
            {!form.allDay ? (
              <TimeField
                value={form.endTime}
                onChange={setEndTime}
                defaultValue={addMinutesToTime(form.startTime || '09:00', 60)}
                highlight={assist.changed.has('endTime')}
                containerStyle={formStyles.dtFieldWrap}
                fieldStyle={formStyles.dtField}
                valueStyle={formStyles.dtValue}
                hideIcon
              />
            ) : null}
          </View>
        </View>
        <View style={formStyles.cardDivider} />
        <TouchableOpacity
          style={formStyles.dtRow}
          activeOpacity={0.7}
          onPress={() =>
            navigation.navigate('EventTravelTime', {
              enabled: form.travelEnabled,
              fromAddress: form.fromAddress,
              manualMinutes: form.travelManual ? form.travelMinutes : null,
            })
          }
        >
          <Text style={formStyles.dtLabel}>Travel Time</Text>
          {travelLoading ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <Text style={[formStyles.groupValue, !form.travelMinutes && formStyles.groupValueMuted]} numberOfLines={1}>
              {!form.travelEnabled
                ? 'None'
                : form.travelMinutes
                  ? `${formatDuration(form.travelMinutes)}${leaveByTime ? ` · Leave by ${leaveByTime}` : ''}`
                  : 'On'}
            </Text>
          )}
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={formStyles.rowChevron} />
        </TouchableOpacity>
      </View>
      {form.travelEnabled ? <FormError>{travelError}</FormError> : null}

      {/* Repeat / End Repeat grouped card */}
      <View style={formStyles.groupCard}>
        <Select
          inlineLabel="Repeat"
          value={repeatValue}
          options={repeatItems}
          onChange={(v) => {
            if (v === CUSTOM_REPEAT) {
              navigation.navigate('EventRepeat', { rule: repeatRule, date: form.date });
            } else {
              set({
                recurrFreq: (v as string) ?? '',
                recurrInterval: 1,
                recurrDaysOfWeek: [],
                recurrDaysOfMonth: [],
                recurrMonths: [],
                recurrWeekOfMonth: null,
                recurrWeekdayKind: null,
                ...(v ? {} : { recurrUntil: '' }),
              });
            }
          }}
          highlight={assist.changed.has('recurrFreq')}
          containerStyle={formStyles.dtFieldWrap}
          fieldStyle={formStyles.rowField}
          valueStyle={formStyles.dtValue}
          chevronIcon="chevron-expand"
        />
        {form.recurrFreq ? (
          <>
            <View style={formStyles.cardDivider} />
            <DateField
              inlineLabel="End Repeat"
              clearable
              placeholder="Never"
              value={form.recurrUntil}
              onChange={(v) => set({ recurrUntil: v })}
              defaultValue={form.date}
              highlight={assist.changed.has('recurrUntil')}
              containerStyle={formStyles.dtFieldWrap}
              fieldStyle={formStyles.rowField}
              valueStyle={formStyles.dtValue}
              hideIcon
            />
          </>
        ) : null}
      </View>

      {/* Calendar / Invitees grouped card. The Invitees row opens the
          EventInvitees screen; previews who is currently invited. */}
      <View style={formStyles.groupCard}>
        <Select
          inlineLabel="Calendar"
          value={form.calendarType}
          options={calendarOptions}
          onChange={(v) => set({ calendarType: (v as string) ?? 'activities' })}
          highlight={assist.changed.has('calendarType')}
          containerStyle={formStyles.dtFieldWrap}
          fieldStyle={formStyles.rowField}
          valueStyle={formStyles.dtValue}
          chevronIcon="chevron-expand"
        />
        <View style={formStyles.cardDivider} />
        <TouchableOpacity
          style={formStyles.dtRow}
          activeOpacity={0.7}
          onPress={() =>
            navigation.navigate('EventInvitees', {
              eventId: isEdit ? eventId : undefined,
              snapshot: buildSnapshot(),
            })
          }
        >
          <Text style={formStyles.dtLabel}>Invitees</Text>
          <Text style={[formStyles.groupValue, !inviteeEmails.length && formStyles.groupValueMuted]} numberOfLines={1}>
            {inviteeEmails.length ? `${inviteeEmails.length} invited · ${inviteePreview(inviteeEmails)}` : 'None'}
          </Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={formStyles.rowChevron} />
        </TouchableOpacity>
      </View>

      {/* Phone has no visible field: it stays in the form state / assist schema /
          save payload so the AI assistant can still set and use it. */}

      {/* Alert / Second Alert grouped card */}
      <View style={formStyles.groupCard}>
        <Select
          inlineLabel="Alert"
          value={form.reminderMinutes ?? undefined}
          options={excludeUsedAlert(alertItems, form.alert2Minutes, form.reminderMinutes)}
          placeholder="None"
          onChange={(v) => {
            if (v === CUSTOM_ALERT) setCustomFor('reminderMinutes');
            else set({ reminderMinutes: v === -1 ? null : (v as number) });
          }}
          highlight={assist.changed.has('reminderMinutes')}
          containerStyle={formStyles.dtFieldWrap}
          fieldStyle={formStyles.rowField}
          valueStyle={formStyles.dtValue}
          chevronIcon="chevron-expand"
        />
        {form.reminderMinutes !== null ? (
          <>
            <View style={formStyles.cardDivider} />
            <Select
              inlineLabel="Second Alert"
              value={form.alert2Minutes ?? undefined}
              options={excludeUsedAlert(alertItems, form.reminderMinutes, form.alert2Minutes)}
              placeholder="None"
              onChange={(v) => {
                if (v === CUSTOM_ALERT) setCustomFor('alert2Minutes');
                else set({ alert2Minutes: v === -1 ? null : (v as number) });
              }}
              containerStyle={formStyles.dtFieldWrap}
              fieldStyle={formStyles.rowField}
              valueStyle={formStyles.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
      </View>

      <CustomAlertSheet
        visible={customFor !== null}
        initialMinutes={customFor ? form[customFor] : null}
        onSave={(minutes) => {
          if (customFor) set({ [customFor]: minutes } as Partial<typeof form>);
        }}
        onClose={() => setCustomFor(null)}
      />

      {/* Attachments — files (photos / PDFs) attached to the event row, so on a
          recurring event they apply to every occurrence. Encrypted on-device
          (E2EE) when the session is unlocked. */}
      <SectionTitle>Attachments</SectionTitle>
      <View style={formStyles.groupCard}>
        <TouchableOpacity style={styles.attAddRow} activeOpacity={0.7} onPress={openAttachmentPicker}>
          <View style={[styles.attAddIcon, { backgroundColor: colors.textMuted }]}>
            <Ionicons name="add" size={18} color="#fff" />
          </View>
          <Text style={styles.attAddLabel}>Add attachment…</Text>
          {addAttachment.isPending ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        </TouchableOpacity>
        {isEdit
          ? (attachmentsQ.data ?? []).map((a) => (
              <View key={a._id}>
                <View style={formStyles.cardDivider} />
                <View style={styles.attRow}>
                  <TouchableOpacity style={styles.attMain} activeOpacity={0.7} onPress={() => openAttachment.mutate(a)}>
                    <Ionicons name={attachmentIcon(a.fileType)} size={20} color={colors.textMuted} />
                    <Text style={styles.attName} numberOfLines={1}>{a.title}</Text>
                    {openAttachment.isPending && openAttachment.variables?._id === a._id ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : null}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.attRemove}
                    accessibilityLabel="Remove attachment"
                    onPress={() =>
                      Alert.alert('Remove attachment?', a.title, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => delAttachment.mutate(a._id) },
                      ])
                    }
                  >
                    <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          : queuedAttachments.map((f, i) => (
              <View key={`${f.uri}-${i}`}>
                <View style={formStyles.cardDivider} />
                <View style={styles.attRow}>
                  <View style={styles.attMain}>
                    <Ionicons name={attachmentIcon(f.type)} size={20} color={colors.textMuted} />
                    <Text style={styles.attName} numberOfLines={1}>{f.name}</Text>
                  </View>
                  <TouchableOpacity style={styles.attRemove} accessibilityLabel="Remove attachment" onPress={() => removeQueuedAttachment(i)}>
                    <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
      </View>
      <Hint>Attachments will be applied to all occurrences.</Hint>

      {/* URL — a single link for the event (e.g. a meeting or info page). */}
      <SectionTitle>URL</SectionTitle>
      <View style={formStyles.groupCard}>
        <Input
          value={form.url}
          onChangeText={(v) => set({ url: v })}
          placeholder="Add a link…"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          containerStyle={formStyles.headField}
          style={[formStyles.headInput, assist.changed.has('url') && formStyles.headInputHighlight]}
        />
      </View>

      <SectionTitle>Notes</SectionTitle>
      <Input
        value={form.description}
        onChangeText={(v) => set({ description: v })}
        multiline
        placeholder="Add any notes…"
        style={formStyles.notes}
        highlight={assist.changed.has('description')}
      />

      <FormError>{error}</FormError>

      {isEdit ? (
        <View style={formStyles.footer}>
          <Button
            title="Delete"
            variant="danger"
            loading={del.isPending}
            onPress={onDelete}
          />
        </View>
      ) : null}
      {emailSheet}
    </Screen>
  );
}

// Grouped-card form styles live in components/formStyles (shared by all
// add/edit forms); only screen-specific styles remain here.
const styles = StyleSheet.create({
  // Guest (read-only invitee) view
  guestInviter: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  // Detail info card: the Card supplies chrome, ListRows supply the rows (matches
  // ChoreDetail's infoCard). padding:0 so the rows own their spacing.
  infoCard: { marginTop: spacing.md },
  guestStatus: { fontSize: 13, color: colors.textMuted },
  guestNotes: { fontSize: 14, color: colors.text, lineHeight: 20 },
  guestHint: { marginTop: spacing.lg, marginBottom: 0 },
  // Attachments card
  attAddRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  attAddIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  attAddLabel: { flex: 1, fontSize: 16, color: colors.text },
  attRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md, paddingRight: spacing.xs },
  attMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  attName: { flex: 1, fontSize: 16, color: colors.text },
  attRemove: { padding: spacing.sm },
  // Custom alert dual wheel content inside the shared BottomSheet.
  alertSheet: { gap: spacing.sm },
  wheelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.md, height: WHEEL_ITEM_H * WHEEL_VISIBLE,
  },
  wheelBand: {
    position: 'absolute', left: 0, right: 0,
    top: ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ITEM_H, height: WHEEL_ITEM_H,
    borderRadius: radius.sm, backgroundColor: colors.border + '55',
  },
  // The unit word beside the amount wheel ("30 minutes").
  wheelUnit: { fontSize: 23, color: colors.text },
});
