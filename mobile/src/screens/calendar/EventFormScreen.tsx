import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Linking, Share, ActionSheetIOS, Platform } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { calendarApi, householdApi, invitationsApi, placesApi, eventAttachmentsApi, settingsApi, CalendarEvent, EventAttachment, FormAssistField, TravelMode } from '../../api';
import { EVENT_INVITATIONS_KEY, fetchEventInvitations } from '../../lib/eventInvitations';
import { useAuth } from '../../store/auth';
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
import { Button, Input, Select, Screen, SwitchRow, SectionTitle, DateField, TimeField, useHeaderCheckButton, FormError, CenteredLoader, Hint, ScreenTitle, Card, ListRow, InfoCard } from '../../components/ui';
import FormAssist from '../../components/FormAssist';
import { form as formStyles } from '../../components/formStyles';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  EVENT_CALENDAR_TYPES, ymd, eventWhenFromStored, eventStoredFromWhen, shouldAutoFocusTitle,
  shiftEventWhen, occurrenceShiftDays,
  ALL_DAY_ALERT_OFFSETS, DEFAULT_DAY_ALERT_TIME, allDayAlertLabel, alertsForAllDay,
  AlertAnchor, LEAVE_ALERT_BUFFERS, effectiveAlertAnchor, inferAlertAnchor,
  leaveAlertMinutes, promoteSecondAlert, rebaseLeaveAlert, timedAlertLabel,
} from '../../lib/calendar';
import { startKeepingDuration, endKeepingDuration } from '../../lib/datetime';
import { useCalendarColors, useCustomCalendars, useDeletedDefaultCalendars } from '../../lib/calendarPrefs';
import {
  sealNew, sealUpdate, openRecord, getHDK, newObjectId, ensureHouseholdKey,
  loadCalendarKeys, currentCalendarKeyVersion, sealForCalendar,
} from '../../lib/e2ee';
import { getFeedEventById, FEED_EVENT_ID_PREFIX } from '../../lib/calendarFeeds';
import { formatDuration } from '../../lib/format';
import { promptEventDelete } from '../../lib/eventDelete';
import {
  promptSaveScope, saveScopeDecision, isFirstOccurrence, seriesStartDay,
  reanchorRecurrence, splitExceptionDates, shiftExceptionDates, exceptionShift,
  SaveScope,
} from '../../lib/eventSave';
import CustomAlertSheet from '../../components/CustomAlertSheet';
import {
  getQueuedInvitees, clearQueuedInvitees, useQueuedInvitees,
  getDraftGuestListVisible, setDraftGuestListVisible,
  getQueuedHouseholdInvitees, setQueuedHouseholdInvitees, useQueuedHouseholdInvitees,
} from '../../lib/inviteeDraft';
import { inviteeKey, sendInvitations, formatWhen } from '../../lib/invitees';
import { notifyHouseholdInvitees, rsvpsForEvent } from '../../lib/householdRsvp';
import { useEmailComposer } from '../../components/EmailAppSheet';
import { useTravelDraft, clearTravelDraft } from '../../lib/travelDraft';
import { normalizeTravelMode, travelModeLabel } from '../../lib/travelModes';
import { RepeatRule, WeekdayKind, isCustomRule, repeatSummary } from '../../lib/eventRepeat';
import { useRepeatDraft, clearRepeatDraft } from '../../lib/repeatDraft';
import { useLocationDraft, clearLocationDraft } from '../../lib/locationDraft';
import { rebindDetailBelow } from '../../navigation/rebindDetailBelow';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<CalendarStackParamList, 'EventForm'>;
type Rt = RouteProp<CalendarStackParamList, 'EventForm'>;

// Alert offsets for a TIMED event — minutes before its start. An all-day event
// has no start time, so it gets the whole-day grid instead (ALL_DAY_ALERT_OFFSETS
// in lib/calendar, labelled with the hour they fire at); see `alertItems`.
const ALERT_OPTIONS = [
  { label: 'None', value: -1 },
  { label: 'At time of event', value: 0 },
  { label: '15 min before', value: 15 },
  { label: '30 min before', value: 30 },
  { label: '1 hour before', value: 60 },
  { label: '1 day before', value: 1440 },
];

// The alert Selects are keyed by "<anchor>:<minutes>", not by the minute count:
// the same number means two different settings depending on its anchor (with a
// 45-minute drive, 60 minutes before the event and 15 minutes before leaving are
// both "60"), and they diverge the moment the drive time changes. Two sentinel
// keys sit alongside: no alert, and the row that opens the custom sheet.
const NONE_ALERT = 'none';
const CUSTOM_ALERT = 'custom';

type AlertItem = { value: string; label: string; minutes: number | null; anchor: AlertAnchor };

const alertKey = (minutes: number | null, anchor: AlertAnchor): string =>
  minutes == null ? NONE_ALERT : `${anchor === 'leave' ? 'l' : 'e'}:${minutes}`;

// The other slot's alert, dropped from this slot's list — two alerts on the same
// instant would just fire the same notification twice. Sentinels and the slot's
// own current selection always stay (mirrors `excludeUsedAlert`, by minutes
// rather than by key, so the two framings of one instant can't both be picked).
function excludeUsedAlertKey(options: AlertItem[], used: number | null, self: number | null): AlertItem[] {
  if (used == null) return options;
  return options.filter((o) => o.minutes == null || o.minutes === self || o.minutes !== used);
}

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
  // Sender name for household invite/response pushes (client-chosen strings —
  // the server relay can't read the sealed event).
  const { user } = useAuth();
  const myDisplayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'A housemate';

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
    travelMode: 'DRIVE' as TravelMode,
    travelMinutes: null as number | null,
    travelDistanceKm: null as string | null,
    // Alerts are stored as minutes before the EVENT; the anchor beside each one
    // records whether the user set that lead time against the event's start or
    // against departure ("30 min before leaving"). See lib/calendar.
    reminderMinutes: null as number | null,
    alertAnchor: 'event' as AlertAnchor,
    alert2Minutes: null as number | null,
    alert2Anchor: 'event' as AlertAnchor,
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
  const travelSeedRef = useRef<{ location: string; fromAddress: string; mode: TravelMode } | null>(null);
  // The decrypted event this form is editing. Sealed fields the form doesn't
  // surface (exceptionDates) must be read back from here and re-sent on save —
  // `sealUpdate` seals the payload wholesale, so anything missing from it is
  // erased from `enc`. Dropping exceptionDates resurrected every occurrence the
  // user had deleted with "Delete This Event Only".
  const decryptedRef = useRef<CalendarEvent | null>(null);
  // Whole days between the series' own start and the occurrence the form was
  // opened from (0 for a one-off, or when opened without an occurrence day).
  // The form works in the occurrence's frame; a whole-series save shifts back.
  const occurrenceShiftRef = useRef(0);
  // Mirrors the `dirty` flag computed near the bottom of this component, so the
  // save handler (declared above it) can read it without a forward reference.
  const dirtyRef = useRef(false);
  // Set when a scoped save's attachment copy failed, so onSuccess can say so.
  // A failed copy must not fail the save the user already confirmed.
  const attachmentCopyFailedRef = useRef(false);
  const [travelLoading, setTravelLoading] = useState(false);
  const [travelError, setTravelError] = useState('');
  // Set when the assistant asked for a "time to leave" alert before the drive
  // time was known; resolved to reminderMinutes once travel time computes.
  const [pendingLeaveAlert, setPendingLeaveAlert] = useState(false);
  const assist = useFormAssist();

  // The hour an all-day event's alerts fire at: the account-level day-alert
  // default shared with tasks, chores, occasions and holidays (Profile →
  // Reminders). Cached by react-query, so this is the same fetch those screens
  // already make. Its label ("9:00 AM") rides on every all-day alert option.
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const dayAlertTime = settingsQ.data?.dayAlertTime || DEFAULT_DAY_ALERT_TIME;

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
  // The assistant's Calendar select must offer the same set — and on an all-day
  // event its Alert select must offer the whole-day grid, not minute offsets the
  // event can't honour.
  const assistFields = useMemo<FormAssistField[]>(
    () =>
      ASSIST_FIELDS.map((f) => {
        if (f.name === 'calendarType') return { ...f, options: calendarOptions };
        if (f.name === 'reminderMinutes' && form.allDay) {
          return {
            ...f,
            label: 'Alert',
            description:
              'All-day event: alerts are whole days before it, delivered at the user\'s day-alert time. 0 = on the day itself.',
            options: [
              { label: 'None', value: -1 },
              ...ALL_DAY_ALERT_OFFSETS.map((v) => ({ value: v, label: allDayAlertLabel(v, dayAlertTime) })),
            ],
          };
        }
        return f;
      }),
    [calendarOptions, form.allDay, dayAlertTime]
  );

  // Manual edits clear the "AI changed this" highlight for the touched fields.
  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  // Moving the start (time or date) carries the end with it by the same amount,
  // in either direction, so the event keeps its length (9–10 → start 8am
  // becomes 8–9; start 2pm becomes 2–3) — changing the length is the end
  // field's job (setEndTime/setEndDate). Shared lib/datetime rule;
  // cross-midnight aware, so a pushed end may roll onto a later day (and folds
  // back to a blank endDate when it lands on the start's own day).
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

  // The end sets the duration, so a moved end normally leaves the start put —
  // except dragging it to at/before the start, which pulls the start back so the
  // event keeps its length (8–9 → end 4am makes start 3am). If
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

    // A lead time the assistant set is plain minutes before the event — the
    // departure framing only comes from the leave-time intent below.
    if ('reminderMinutes' in next) next.alertAnchor = 'event';

    // A leave-time alert takes precedence over any fixed reminder. Apply it now
    // if the drive time is already known; otherwise defer until it computes.
    if (wantsLeaveAlert) {
      if (form.travelMinutes && !form.allDay) {
        next.reminderMinutes = form.travelMinutes;
        next.alertAnchor = 'leave';
        if (!changedKeys.includes('reminderMinutes')) changedKeys.push('reminderMinutes');
        setPendingLeaveAlert(false);
      } else {
        // Travel time must be on for the drive time to compute at all.
        next.travelEnabled = true;
        setPendingLeaveAlert(true);
      }
    }

    // Whatever the patch set, an all-day event's alerts must land on the whole
    // -day grid — the assistant can ask for "15 minutes before" on an event
    // with no start time, and turning all-day on in the same patch has to
    // re-base the alerts already in the form.
    if (effectiveAllDay) {
      const merged = {
        reminderMinutes: 'reminderMinutes' in next ? (next.reminderMinutes ?? null) : form.reminderMinutes,
        alert2Minutes: 'alert2Minutes' in next ? (next.alert2Minutes ?? null) : form.alert2Minutes,
      };
      const snapped = alertsForAllDay(true, merged);
      if (snapped.reminderMinutes !== merged.reminderMinutes) next.reminderMinutes = snapped.reminderMinutes;
      if (snapped.alert2Minutes !== merged.alert2Minutes) next.alert2Minutes = snapped.alert2Minutes;
      // No start time, so no departure to anchor to (see the All day switch).
      next.alertAnchor = 'event';
      next.alert2Anchor = 'event';
    }

    // However the first alert ends up cleared — the assistant setting it to None
    // included — the second one moves up rather than staying set behind a hidden
    // row (same rule as the Alert picker).
    setForm((f) => {
      const merged = { ...f, ...next };
      return { ...merged, ...promoteSecondAlert(merged) };
    });
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

  // Compute travel time from the origin to the event location for the chosen
  // mode (traffic-aware for driving; schedule-aware for transit, which is why
  // the event's start rides along as the departure anchor).
  const fetchTravelTime = async () => {
    const destination = form.location?.trim();
    const origin = form.fromAddress?.trim();
    if (!destination) return;
    // Transit estimates depend on when you're going — anchor them to the
    // event's start (its local wall clock) rather than "now".
    const departureTime =
      !form.allDay && form.date && form.startTime
        ? new Date(`${form.date}T${form.startTime}:00`).toISOString()
        : undefined;
    setForm((f) => ({ ...f, travelMinutes: null, travelDistanceKm: null }));
    setTravelError('');
    setTravelLoading(true);
    try {
      const { data } = await placesApi.getTravelTime(destination, origin, form.travelMode, departureTime);
      const d = data as { minutes?: number; distanceKm?: string };
      setForm((f) => ({ ...f, travelMinutes: d.minutes ?? null, travelDistanceKm: d.distanceKm ?? null }));
    } catch (e: any) {
      setTravelError(e.response?.data?.error || "Couldn't calculate travel time");
    } finally {
      setTravelLoading(false);
    }
  };

  // Recompute (debounced) whenever the location, starting point or mode
  // changes — only while travel time is enabled and not set to a manual
  // duration.
  useEffect(() => {
    if (!form.travelEnabled || form.travelManual) return;
    if (!form.location.trim()) return;
    // Editing: never auto-change travel time just from opening the event. The
    // seed populates location (and leaves origin blank), which would otherwise
    // trigger a recompute that overwrites the saved minutes. Only recompute once
    // the user actually changes the destination, starting point or mode.
    const seed = travelSeedRef.current;
    if (seed && seed.location === form.location && seed.fromAddress === form.fromAddress && seed.mode === form.travelMode) return;
    const t = setTimeout(fetchTravelTime, 700);
    return () => clearTimeout(t);
  }, [form.location, form.fromAddress, form.travelMode, form.travelEnabled, form.travelManual]);

  // Apply edits made on the pushed Travel Time screen as they happen.
  const travelDraft = useTravelDraft();
  useEffect(() => {
    if (!travelDraft) return;
    setForm((f) => ({
      ...f,
      travelEnabled: travelDraft.enabled,
      fromAddress: travelDraft.fromAddress,
      travelMode: travelDraft.mode,
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
    setForm((f) => ({ ...f, reminderMinutes: f.travelMinutes, alertAnchor: 'leave' }));
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

  // The anchor each slot can actually honour right now — a departure anchor
  // survives only while the event is timed and its drive time is known.
  const alertAnchor = effectiveAlertAnchor(form.alertAnchor, form.allDay, form.travelMinutes);
  const alert2Anchor = effectiveAlertAnchor(form.alert2Anchor, form.allDay, form.travelMinutes);

  // A departure-anchored alert holds its distance from DEPARTURE, so a changed
  // drive time moves it: "30 min before leaving" must still be 30 minutes before
  // the new departure, not 30 before the old one. Losing the drive time entirely
  // (travel time switched off, or the destination cleared) leaves the stored
  // lead time alone but drops the departure framing with it — there is no
  // departure left to describe.
  const prevTravelRef = useRef<number | null>(form.travelMinutes);
  useEffect(() => {
    const prev = prevTravelRef.current;
    const next = form.travelMinutes;
    prevTravelRef.current = next;
    if (prev === next) return;
    setForm((f) => ({
      ...f,
      reminderMinutes: rebaseLeaveAlert(f.reminderMinutes, f.alertAnchor, prev, next),
      alert2Minutes: rebaseLeaveAlert(f.alert2Minutes, f.alert2Anchor, prev, next),
      alertAnchor: next ? f.alertAnchor : 'event',
      alert2Anchor: next ? f.alert2Anchor : 'event',
    }));
  }, [form.travelMinutes]);

  // Alert options.
  //
  // An ALL-DAY event has no start time, so minute offsets have nothing to count
  // back from: its alerts are whole days off the day-alert hour (see the alert
  // note in lib/calendar), and that is the only list it may be offered — the
  // minute list would be describing a time the event doesn't have. Travel time
  // is meaningless there too, which is why the departure options below are
  // already all-day-gated.
  //
  // On a TIMED event, when a drive time is available, prepend a set of
  // departure-anchored choices so the user can be alerted when it's time to
  // leave — or a chosen number of minutes before that. Every row carries the
  // anchor it was built with, so picking one records the framing the user chose
  // instead of leaving it to be guessed back out of the number later.
  const alertItems = useMemo<AlertItem[]>(() => {
    const none: AlertItem = { value: NONE_ALERT, label: 'None', minutes: null, anchor: 'event' };
    const custom: AlertItem = { value: CUSTOM_ALERT, label: 'Custom…', minutes: null, anchor: 'event' };
    if (form.allDay) {
      const items: AlertItem[] = [
        none,
        ...ALL_DAY_ALERT_OFFSETS.map((v) => ({
          value: alertKey(v, 'event'), label: allDayAlertLabel(v, dayAlertTime), minutes: v, anchor: 'event' as AlertAnchor,
        })),
      ];
      // A saved value off the grid — a custom day count, or a minute offset
      // carried by an event saved before all-day alerts became day-based —
      // still needs a row, or the field would fall back to its placeholder.
      for (const v of [form.reminderMinutes, form.alert2Minutes]) {
        if (v == null || items.some((i) => i.minutes === v)) continue;
        items.push({ value: alertKey(v, 'event'), label: allDayAlertLabel(v, dayAlertTime), minutes: v, anchor: 'event' });
      }
      items.push(custom);
      return items;
    }
    const travel = form.travelMinutes;
    const leaveItems: AlertItem[] = [];
    if (travel) {
      for (const buf of LEAVE_ALERT_BUFFERS) {
        // No computable departure time (e.g. no start time yet) — omit "Time to leave".
        if (buf === 0 && !leaveByTime) continue;
        const minutes = leaveAlertMinutes(buf, travel);
        leaveItems.push({
          value: alertKey(minutes, 'leave'),
          label: timedAlertLabel(minutes, 'leave', travel, leaveByTime),
          minutes,
          anchor: 'leave',
        });
      }
    }
    const base: AlertItem[] = ALERT_OPTIONS.filter((o) => o.value >= 0).map((o) => ({
      value: alertKey(o.value, 'event'), label: o.label, minutes: o.value, anchor: 'event',
    }));
    // "None" stays first; departure-anchored options follow it so they're
    // visible without scrolling (the option modal caps at 70% screen height).
    const items: AlertItem[] = [none, ...leaveItems, ...base];
    // A saved custom value has no canned row — synthesize one in its own
    // framing, so the field shows the setting back rather than its placeholder.
    for (const [v, anchor] of [
      [form.reminderMinutes, alertAnchor],
      [form.alert2Minutes, alert2Anchor],
    ] as const) {
      if (v == null || items.some((i) => i.value === alertKey(v, anchor))) continue;
      items.push({ value: alertKey(v, anchor), label: timedAlertLabel(v, anchor, travel, leaveByTime), minutes: v, anchor });
    }
    items.push(custom);
    return items;
  }, [
    form.travelMinutes, form.allDay, leaveByTime, form.reminderMinutes, form.alert2Minutes,
    alertAnchor, alert2Anchor, dayAlertTime,
  ]);

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
      decryptedRef.current = e;
      // Timed events must be read back in the device's local zone (date AND
      // clock), all-day ones in UTC — `eventWhenFromStored` is the inverse of
      // the `eventStoredFromWhen` the save runs through, so reopening a saved
      // event is a fixed point. Slicing the ISO date instead would read the
      // UTC day and step an 11:05pm event forward one day per edit.
      const seriesWhen = eventWhenFromStored(e);
      // A repeating event's record starts on the series' FIRST day, but the user
      // tapped one occurrence — show that one, the way Apple does. The save
      // shifts back for a whole-series write (see buildStartEnd).
      occurrenceShiftRef.current = occurrenceShiftDays(seriesWhen, date, !!e.recurrence?.freq);
      set({
        title: e.title ?? '',
        calendarType: e.calendarType ?? 'activities',
        ...shiftEventWhen(seriesWhen, occurrenceShiftRef.current),
        description: e.description ?? '',
        location: e.location ?? '',
        placeId: (e as { placeId?: string }).placeId ?? '',
        url: e.url ?? '',
        phone: e.phone ?? '',
        travelEnabled: e.travelMinutes != null,
        // Auto-computed times always store a distance; a bare minutes value
        // means a manually picked duration.
        travelManual: e.travelMinutes != null && e.travelDistanceKm == null,
        // Pre-mode records were always drive times.
        travelMode: normalizeTravelMode(e.travelMode),
        travelMinutes: e.travelMinutes ?? null,
        travelDistanceKm: e.travelDistanceKm ?? null,
        // Events saved before the anchor was recorded carry only a number, so
        // read the framing back the way that event has always displayed: the
        // canned departure rows keep their "before leaving" wording, everything
        // else is what it literally says — minutes before the event. A record
        // holding only a SECOND alert (written before the promotion rule) opens
        // with it in the first slot rather than with an invisible alert set.
        ...promoteSecondAlert({
          reminderMinutes: e.reminderMinutes ?? null,
          alert2Minutes: e.alert2Minutes ?? null,
          alertAnchor: e.alertAnchor ?? inferAlertAnchor(e.reminderMinutes, e.allDay, e.travelMinutes),
          alert2Anchor: e.alert2Anchor ?? inferAlertAnchor(e.alert2Minutes, e.allDay, e.travelMinutes),
        }),
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
      travelSeedRef.current = { location: e.location ?? '', fromAddress: '', mode: normalizeTravelMode(e.travelMode) };
      // Seed the Invitees screen's guest-list switch (missing on events that
      // predate the setting — treated as visible).
      setDraftGuestListVisible(e.guestListVisible !== false);
      // Same seed-through for the household invitee list: a whole-payload
      // re-save re-seals it from the draft store, so seeding here is what keeps
      // an edit from wiping it out of `enc`.
      setQueuedHouseholdInvitees(e.householdInvitees ?? []);
      // The form now mirrors the saved event — let the guard snapshot it as the
      // clean baseline (any later edit registers as unsaved).
      setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [eventQ.data]);

  // Form date/time state → the ISO instants the API stores (all-day at noon UTC,
  // timed events as the local wall clock's real instant).
  // `frame` picks which event the instants describe. 'occurrence' is what the
  // form literally shows — the day the user opened — and is what a detached
  // override or a forked series starts on. 'series' shifts back onto the stored
  // record's own start, for a save that rewrites the whole repeating event in
  // place; without it, saving from the third occurrence would drag the entire
  // series forward onto that day.
  const buildStartEnd = (frame: 'occurrence' | 'series' = 'occurrence') =>
    eventStoredFromWhen(frame === 'series' ? shiftEventWhen(form, -occurrenceShiftRef.current) : form);

  // The decrypted event content an invitation carries (email + .ics + the
  // recipient's copy) — the server can't read an E2EE event's own fields.
  // Describes the stored record, so it reads the series frame (identical to the
  // occurrence frame for a new event, where the shift is 0).
  const buildSnapshot = () => {
    const { startDate, endDate } = buildStartEnd('series');
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

  // Everything the form knows, expressed in one frame. 'series' rewrites the
  // stored record in place; 'occurrence' describes the single day the user is
  // looking at, which is where a detached override or a forked series begins.
  const buildPayload = (frame: 'occurrence' | 'series'): Record<string, unknown> => {
    const { startDate, endDate } = buildStartEnd(frame);
    // The drive time the saved event will actually carry — what the alert
    // anchors below are judged against.
    const travelForSave = form.travelEnabled ? form.travelMinutes : null;
    return {
      title: form.title.trim(),
      calendarType: form.calendarType,
      allDay: form.allDay,
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
      travelMode: form.travelEnabled ? form.travelMode : null,
      // Sealed event content (C3b) set on the Invitees screen; the draft store
      // is seeded from the fetched event on edit, so re-sealing here preserves
      // the current value instead of wiping it from `enc`.
      guestListVisible: getDraftGuestListVisible(),
      // Household members asked to accept/decline — same draft-store doctrine.
      householdInvitees: getQueuedHouseholdInvitees().length ? getQueuedHouseholdInvitees() : undefined,
      reminderMinutes: form.reminderMinutes ?? undefined,
      alert2Minutes:
        form.reminderMinutes !== null && form.alert2Minutes !== null ? form.alert2Minutes : undefined,
      // Which instant each lead time was set against (see lib/calendar). Sent as
      // the anchor the event can still honour, so an alert that was departure-
      // anchored before the event went all-day is stored as what it now is.
      alertAnchor: effectiveAlertAnchor(form.alertAnchor, form.allDay, travelForSave),
      alert2Anchor: effectiveAlertAnchor(form.alert2Anchor, form.allDay, travelForSave),
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
      // Occurrences the user removed with "Delete This Event Only". The form
      // never surfaces them, but the seal replaces the whole blob — omit them
      // and every deleted occurrence comes back on the next edit. Dropped
      // entirely once the event no longer repeats (nothing left to except).
      exceptionDates: form.recurrFreq ? decryptedRef.current?.exceptionDates : undefined,
    };
  };

  // Seal a payload the right way for its calendar and write it. Signal-parity
  // D1: an event on an outside-shared calendar we hold a CalendarKey for seals
  // under that key (enc.ks='cal') so collaborators can read it — no plaintext
  // feed. Otherwise it dual-writes under the HDK.
  const writeEvent = async (payload: Record<string, unknown>, targetId?: string) => {
    const calType = String(payload.calendarType);
    let useCalKey = false;
    if (calType.startsWith('custom-')) {
      await loadCalendarKeys(calType).catch(() => {});
      useCalKey = currentCalendarKeyVersion(calType) > 0;
    }
    if (targetId) {
      const sealed = useCalKey
        ? await sealForCalendar('CalendarEvent', targetId, calType, payload)
        : null;
      const body = sealed ? { ...payload, ...sealed } : await sealUpdate('CalendarEvent', targetId, payload);
      return calendarApi.updateEvent(targetId, body);
    }
    if (useCalKey) {
      const _id = await newObjectId();
      const sealed = await sealForCalendar('CalendarEvent', _id, calType, payload);
      if (sealed) return calendarApi.createEvent({ _id, ...payload, ...sealed });
    }
    return calendarApi.createEvent(await sealNew('CalendarEvent', payload));
  };

  // Attachments hang off the event id, so a detached override or a forked series
  // starts with none. Copy them across — for a fork especially, since the fork
  // becomes the ongoing series and would otherwise drop the files from every
  // future occurrence. Never fatal: the record is already written by this point,
  // so a failure is reported rather than rolled back.
  const copyAttachments = async (fromId: string, toId: string) => {
    try {
      await eventAttachmentsApi.copyFrom(toId, fromId);
    } catch {
      attachmentCopyFailedRef.current = true;
    }
  };

  const save = useMutation({
    // The scope the user picked in the save sheet (see onSave). A create, a
    // one-off edit, and an edit made from the series' first occurrence all
    // arrive here as 'series' without ever showing the sheet.
    mutationFn: async (scope: SaveScope = 'series') => {
      const editing = decryptedRef.current;
      // "Save for Future Events" chosen ON the series' first occurrence has
      // nothing behind it to preserve: truncating the original would leave an
      // empty husk beside the fork. The whole-series rewrite IS that outcome, so
      // the choice resolves to it here — the sheet still asked, because the user
      // is applying a change to every future event either way.
      const futureIsWholeSeries =
        scope === 'future' && !!editing && isFirstOccurrence(editing, date);
      if (!isEdit || scope === 'series' || futureIsWholeSeries) {
        return writeEvent(buildPayload('series'), isEdit ? eventId! : undefined);
      }

      const original = decryptedRef.current!;
      // The occurrence the user opened, in the series' own day-keying. Both
      // writes below hinge on it: it's the day excluded or truncated from the
      // original, and the anchor the fork's exceptions are measured from.
      const occDay = date || seriesStartDay(original);
      const payload = buildPayload('occurrence');
      const newStartDay = form.date;

      if (scope === 'occurrence') {
        // "Save for This Event Only": a standalone event on this day, and the
        // day struck out of the series. A detached override doesn't repeat, so
        // it carries neither a rule nor exceptions of its own.
        payload.recurrence = undefined;
        payload.exceptionDates = undefined;
        const created = await writeEvent(payload);
        await copyAttachments(original._id, created.data._id);
        try {
          await calendarApi.excludeOccurrence(original._id, occDay);
        } catch (e) {
          // The override exists but the series still shows this day — two
          // events on one cell. Undo the half that landed rather than leave the
          // duplicate behind.
          await calendarApi.deleteEvent(created.data._id).catch(() => {});
          throw e;
        }
        return created;
      }

      // "Save for Future Events": end the old series the day before this
      // occurrence and start a new one here carrying the edits.
      const { forked } = splitExceptionDates(original.exceptionDates, occDay);
      payload.recurrence = reanchorRecurrence(
        payload.recurrence as Parameters<typeof reanchorRecurrence>[0],
        occDay,
        newStartDay,
      );
      // Exceptions ride along, moved by however far the user dragged this
      // occurrence — a skipped day is relative to the series it belongs to.
      payload.exceptionDates = shiftExceptionDates(forked, exceptionShift(occDay, newStartDay));
      const created = await writeEvent(payload);
      await copyAttachments(original._id, created.data._id);
      try {
        await calendarApi.truncateSeries(original._id, occDay);
      } catch (e) {
        // Same rollback: without the truncation the old series still covers
        // these days, so the fork would double every remaining occurrence.
        await calendarApi.deleteEvent(created.data._id).catch(() => {});
        throw e;
      }
      return created;
    },
    onSuccess: async (res, scope) => {
      // A new event sends the invitees queued on its Invitees screen — a draft
      // has no event id, so this is the first moment invitations CAN go out.
      // Emails post in parallel; each phone entry opens the Messages composer
      // in turn (send failures are dropped — the form is already closing).
      if (!isEdit) {
        const queued = getQueuedInvitees();
        // Household members picked on the Invitees screen get their instant
        // "accept or decline?" push now that the event exists. Best-effort —
        // the durable channel is their Invitations inbox (synced records).
        const queuedHousehold = getQueuedHouseholdInvitees();
        if (queuedHousehold.length) {
          notifyHouseholdInvitees(
            res.data._id, queuedHousehold, 'Event invitation',
            `${myDisplayName} invited you to “${form.title.trim()}” — accept or decline`,
          ).catch(() => {});
        }
        if (queued.length) {
          await sendInvitations(res.data._id, queued, buildSnapshot(), getDraftGuestListVisible(), composeEmail);
        }
        if (queued.length || queuedHousehold.length) clearQueuedInvitees();
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
      if (attachmentCopyFailedRef.current) {
        attachmentCopyFailedRef.current = false;
        Alert.alert(
          'Attachments didn’t copy',
          'The event was saved, but its attachments stayed on the original event. Open it to re-attach them.',
        );
      }
      // Edit-renotify: a date/time change on an event with household invitees
      // re-pushes an update to everyone who hasn't declined. RSVPs are kept —
      // an edit does not reset responses. In-place rewrites only: an occurrence
      // override / series fork writes a NEW record, whose RSVPs start fresh.
      if (isEdit && res.data?._id === eventId) {
        const before = decryptedRef.current;
        const hhIds = getQueuedHouseholdInvitees();
        const snap = buildSnapshot();
        const whenChanged =
          !!before &&
          (String(before.startDate) !== String(snap.startDate) ||
            String(before.endDate ?? '') !== String(snap.endDate ?? '') ||
            !!before.allDay !== !!snap.allDay);
        if (hhIds.length && whenChanged) {
          rsvpsForEvent(eventId!)
            .then((rsvps) => {
              const to = hhIds.filter((id) => rsvps[id]?.status !== 'declined');
              if (!to.length) return;
              return notifyHouseholdInvitees(eventId!, to, `“${snap.title}” changed`, `Now ${formatWhen(snap)}`);
            })
            .catch(() => {});
        }
      }
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      // An occurrence override or a series fork wrote a NEW record and left the
      // original excepted/truncated, so the detail screen under this form is
      // still bound to the old id and day — going straight back would show the
      // unedited event (and, after an override, a day the series no longer has).
      // Rebind it to what was just saved.
      // Keyed on the id actually written rather than on the chosen scope, since
      // "future" from the first occurrence resolves to a whole-series rewrite and
      // creates nothing new.
      if (isEdit && res.data?._id && res.data._id !== eventId) {
        rebindDetailBelow(navigation, 'EventDetail', { eventId: res.data._id, date: form.date });
      } else {
        navigation.goBack();
      }
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

  // The guest's own invitation, to show who invited them. Shared key AND
  // shared queryFn — see lib/eventInvitations: a second reader of this key with
  // its own fetcher decides what every OTHER reader sees.
  const myInvitesQ = useQuery({
    queryKey: EVENT_INVITATIONS_KEY,
    queryFn: fetchEventInvitations,
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

  // Household invitees join the row's count/preview by name. The draft store is
  // live for drafts AND seeded/updated on edit, so one source covers both.
  const queuedHouseholdIds = useQueuedHouseholdInvitees();
  const householdQ = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
    enabled: queuedHouseholdIds.length > 0,
  });
  const householdInviteeNames = queuedHouseholdIds.map((id) => {
    const m = householdQ.data?.members?.find((x) => x._id === id);
    return m ? [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.email || 'Member' : '…';
  });
  const allInviteeLabels = [...householdInviteeNames, ...inviteeEmails];

  // Guest leaves the event: their copy is deleted and the invitation retired.
  const leave = useMutation({
    mutationFn: () => invitationsApi.leave(guestInvitationId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: EVENT_INVITATIONS_KEY });
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
    const original = decryptedRef.current;
    // A create, or an event we couldn't decrypt, has no series to scope against.
    if (!isEdit || !original) {
      save.mutate('series');
      return;
    }
    // The form's own dirty flag decides whether there is anything to scope —
    // it compares the live form to the baseline it seeded with, which is a
    // truer "did the user change something" than diffing the built payload
    // (a timed event with no stored end acquires a default one on the way out,
    // and that alone would prompt on an untouched save).
    if (!dirtyRef.current) {
      save.mutate('series');
      return;
    }
    const decision = saveScopeDecision(original, buildPayload('series'));
    if (decision.kind === 'none') {
      save.mutate('series');
      return;
    }
    // Cancel resolves to null: stay on the form with the edits intact.
    promptSaveScope(decision, (scope) => {
      if (scope) save.mutate(scope);
    });
  };

  // Delete from the edit form: a one-off event confirms once; a recurring one
  // offers Apple's "this event" / "all future" choices. Uses the decrypted event
  // (eventQ.data) so the recurrence + start day are the real ones, and `date`
  // (the occurrence the form was opened from) as the target occurrence.
  const onDelete = () => {
    if (!decryptedRef.current) return;
    promptEventDelete(decryptedRef.current, date, (perform) => del.mutate(perform));
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
  // `onSave` is declared above this line but only ever runs from a tap, by which
  // point the ref holds the current render's value. It reads dirtiness to decide
  // whether a repeating event's save needs the scope sheet at all.
  dirtyRef.current = dirty;

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
          // A new event opens straight into the title with the keyboard up
          // (blank creates only — see shouldAutoFocusTitle).
          autoFocus={shouldAutoFocusTitle({ eventId, prefill })}
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
          {/* Switching All day on re-bases any configured alerts onto the whole
              -day grid — the event loses the start time they were counting back
              from, so leaving them as-is would keep firing them at an hour the
              event no longer has. */}
          <SwitchRow
            label="All day"
            value={form.allDay}
            onValueChange={(v) =>
              set({
                allDay: v,
                ...alertsForAllDay(v, {
                  reminderMinutes: form.reminderMinutes,
                  alert2Minutes: form.alert2Minutes,
                }),
                // An all-day event has no departure to count back from, so the
                // re-based alerts land plainly before the day itself.
                ...(v ? { alertAnchor: 'event' as AlertAnchor, alert2Anchor: 'event' as AlertAnchor } : {}),
              })
            }
            color={accent}
            highlight={assist.changed.has('allDay')}
          />
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
              mode: form.travelMode,
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
                  ? `${formatDuration(form.travelMinutes)}${!form.travelManual && form.travelMode !== 'DRIVE' ? ` · ${travelModeLabel(form.travelMode)}` : ''}${leaveByTime ? ` · Leave by ${leaveByTime}` : ''}`
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
          <Text style={[formStyles.groupValue, !allInviteeLabels.length && formStyles.groupValueMuted]} numberOfLines={1}>
            {allInviteeLabels.length ? `${allInviteeLabels.length} invited · ${inviteePreview(allInviteeLabels)}` : 'None'}
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
          value={alertKey(form.reminderMinutes, alertAnchor)}
          options={excludeUsedAlertKey(alertItems, form.alert2Minutes, form.reminderMinutes)}
          placeholder="None"
          onChange={(v) => {
            if (v === CUSTOM_ALERT) setCustomFor('reminderMinutes');
            else {
              const opt = alertItems.find((i) => i.value === v);
              // Clearing this one hands the slot to the second alert, which the
              // form would otherwise hide while leaving it set.
              set(promoteSecondAlert({
                reminderMinutes: opt?.minutes ?? null,
                alertAnchor: opt?.anchor ?? 'event',
                alert2Minutes: form.alert2Minutes,
                alert2Anchor: form.alert2Anchor,
              }));
            }
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
              value={alertKey(form.alert2Minutes, alert2Anchor)}
              options={excludeUsedAlertKey(alertItems, form.reminderMinutes, form.alert2Minutes)}
              placeholder="None"
              onChange={(v) => {
                if (v === CUSTOM_ALERT) setCustomFor('alert2Minutes');
                else {
                  const opt = alertItems.find((i) => i.value === v);
                  set({ alert2Minutes: opt?.minutes ?? null, alert2Anchor: opt?.anchor ?? 'event' });
                }
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
        dayOnly={form.allDay}
        travelMinutes={form.travelMinutes}
        initialMinutes={customFor ? form[customFor] : null}
        initialAnchor={customFor === 'alert2Minutes' ? alert2Anchor : alertAnchor}
        onSave={(minutes, anchor) => {
          if (!customFor) return;
          set(
            customFor === 'alert2Minutes'
              ? { alert2Minutes: minutes, alert2Anchor: anchor }
              : { reminderMinutes: minutes, alertAnchor: anchor },
          );
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
});
