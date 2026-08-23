import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert, ActionSheetIOS, ActivityIndicator, Platform } from 'react-native';
import { Text } from '../../components/Text';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { regionForAddress } from '@household/weather';
import { tripsApi, placesApi, settingsApi, TripItemType, TripItemAttachment, FormAssistField } from '../../api';
import { openRecord, getHDK, newObjectId, loadResourceKeys, currentResourceKeyVersion } from '../../lib/e2ee';
import { fetchTripDetail, sealTripItemPayload } from '../../lib/tripData';
import { encryptFileForUpload, encryptFileForUploadResource } from '../../lib/attachments';
import { pickDocument, pickImage, takePhoto, PickedFile } from '../../lib/media';
import {
  getQueuedAttachments, addQueuedAttachment, removeQueuedAttachment,
  clearQueuedAttachments, useQueuedAttachments,
} from '../../lib/attachmentDraft';
import { currencyForCountry, currencySymbol } from '../../lib/currency';
import { uploadFile } from '../../lib/upload';

import { Button, Input, Screen, SwitchRow, SectionTitle, DateField, TimeField, Select, useHeaderCheckButton, CenteredLoader, FormError, Hint } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import FormAssist from '../../components/FormAssist';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { useLocationDraft, clearLocationDraft } from '../../lib/locationDraft';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { TRIP_TYPES, TRIP_SHARING_OPTIONS, tripTypeMeta } from '../../lib/tripTypes';
import { BOOKING_ALERT_ASSIST_OPTIONS, buildBookingAlertItems } from '../../lib/tripAlerts';
import { CUSTOM_ALERT, alertKey, excludeUsedAlertKey } from '../../lib/eventAlertOptions';
import {
  ALL_DAY_ALERT_OFFSETS, DEFAULT_DAY_ALERT_TIME, alertsForAllDay, allDayAlertLabel, promoteSecondAlert,
} from '../../lib/calendar';
import CustomAlertSheet from '../../components/CustomAlertSheet';
import { openTripAttachment } from '../../lib/tripAttachments';
import { startKeepingDuration, endKeepingDuration } from '../../lib/datetime';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { zonedWallclockToUtc, zonedParts } from '../../lib/tz';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<TripsStackParamList, 'TripItemForm'>;
type Rt = RouteProp<TripsStackParamList, 'TripItemForm'>;

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF', 'CNY', 'MXN', 'INR'];
const TZ_OPTIONS = [
  '', 'America/Toronto', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Vancouver', 'Europe/London', 'Europe/Paris',
  'Europe/Madrid', 'Asia/Tokyo', 'Asia/Dubai', 'Australia/Sydney',
];

const PRIVATE_BILL = ['shared_separate', 'shared_one_separate'];

// Schema the AI form assistant fills. Names match the form-state keys; the model
// picks the relevant subset based on the booking type in the request.
const ASSIST_FIELDS: FormAssistField[] = [
  { name: 'type', type: 'select', label: 'Booking type', options: TRIP_TYPES.map((t) => ({ label: t.label, value: t.value })) },
  { name: 'title', type: 'text', label: 'Title' },
  { name: 'allDay', type: 'boolean', label: 'All day', description: 'True for a date-only booking. Set false when a specific time is given.' },
  { name: 'startDate', type: 'date', label: 'Start date' },
  { name: 'startTime', type: 'time', label: 'Start time' },
  { name: 'endDate', type: 'date', label: 'End date' },
  { name: 'endTime', type: 'time', label: 'End time' },
  { name: 'location', type: 'text', label: 'Location / address' },
  { name: 'depName', type: 'text', label: 'Departure airport / station' },
  { name: 'depDate', type: 'date', label: 'Departure date' },
  { name: 'depTime', type: 'time', label: 'Departure time' },
  { name: 'arrName', type: 'text', label: 'Arrival airport / station' },
  { name: 'arrDate', type: 'date', label: 'Arrival date' },
  { name: 'arrTime', type: 'time', label: 'Arrival time' },
  // No airline / flight # / seat: a flight's form doesn't ask for them, so the
  // assistant has no field to fill (they survive an edit only as pass-through
  // state — see the form's initial state).
  { name: 'mode', type: 'text', label: 'Transit mode (train / bus / ferry)' },
  { name: 'cost', type: 'number', label: 'Cost' },
  { name: 'currency', type: 'select', label: 'Currency', options: CURRENCIES.map((c) => ({ label: c, value: c })) },
  { name: 'confirmed', type: 'boolean', label: 'Booked', description: 'True once the booking has actually been made.' },
  { name: 'reminderMinutes', type: 'select', label: 'Alert before the booking', options: BOOKING_ALERT_ASSIST_OPTIONS },
  { name: 'url', type: 'text', label: 'URL' },
  { name: 'phone', type: 'text', label: 'Phone' },
  { name: 'notes', type: 'text', label: 'Notes' },
];

// Leading glyph for an attachment row, by broad file kind (the event form's).
function attachmentIcon(fileType?: string): keyof typeof Ionicons.glyphMap {
  if (fileType?.includes('pdf')) return 'document-text-outline';
  if (fileType?.startsWith('image')) return 'image-outline';
  return 'document-outline';
}

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

type ShareRow = { householdId: string; name: string; included: boolean; amount: number | null };

// Faithful port of client/src/views/TripItemFormView.vue: standard + journey
// (dual-timezone) bookings and the multi-family cost-sharing modes. (Place
// autocomplete + timezone auto-fill are wired in the cross-cutting Places wave;
// here the leg timezone is chosen explicitly.)
export default function TripItemFormScreen() {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.trips;
  const { tripId, itemId, date, prefill } = useRoute<Rt>().params;
  const isEdit = !!itemId;
  const qc = useQueryClient();

  const today = date || new Date().toISOString().slice(0, 10);
  // A long-press on the day itinerary arrives with the pressed hour already
  // filled in (see navigation/types → TripItemForm.prefill) and opens timed on
  // it; the plain add button opens All day, the event form's own default, with
  // the 9–10 AM pair waiting behind the switch for when it's toggled off.
  // `endDate` stays '' while the booking ends on its own start date (the event
  // form's normalization), so the Ends date field shows the start date back.
  const [form, setForm] = useState({
    type: 'activity' as TripItemType,
    title: '',
    allDay: !prefill?.startTime,
    startDate: today,
    startTime: prefill?.startTime ?? '09:00',
    endDate: prefill?.endDate ?? '',
    endTime: prefill?.endTime ?? '10:00',
    // journey
    depName: '', departureTz: '', depDate: today, depTime: prefill?.startTime ?? '09:00',
    arrName: '', arrivalTz: '', arrDate: prefill?.endDate ?? today, arrTime: prefill?.endTime ?? '12:00',
    // `airline` / `flightNumber` / `seat` have no form fields anymore — a
    // flight is placed by its airports and times, and the ticket itself is an
    // attachment. Like `confirmation` below they stay in state as pass-through,
    // so an older booking's (or the from-confirmation parser's) values survive
    // an edit and still render on the booking view.
    airline: '', flightNumber: '', seat: '', mode: '',
    // common — `confirmation` has no form field anymore; it stays in state so
    // an edit reads back (and the save echoes) whatever an older booking or
    // the from-confirmation parser stored. `phone` is entered on the pushed
    // Location view only.
    location: '', placeId: '', cost: '', currency: '', confirmation: '', confirmed: false,
    url: '', phone: '', notes: '',
    // Alert pair — minutes before `start` (the calendar form's slots; sealed).
    reminderMinutes: null as number | null,
    alert2Minutes: null as number | null,
    sharing: 'private', paidByHouseholdId: '',
  });
  const [shareRows, setShareRows] = useState<ShareRow[]>([]);
  const [error, setError] = useState('');
  // Which alert slot the Custom… dual-wheel sheet is editing (null = closed).
  const [customFor, setCustomFor] = useState<'reminderMinutes' | 'alert2Minutes' | null>(null);
  // The Cost row's ⓘ disclosure (what the number is used for).
  const [costHint, setCostHint] = useState(false);
  // A new booking is ready immediately; an edit waits for the item (and the
  // families list its share rows build from) to load and hydrate below before
  // the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!isEdit);
  const assist = useFormAssist();

  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  // Apply the location picked on the pushed Location view (address + business
  // phone + placeId; the phone comes back even when cleared there on purpose) —
  // the same draft handshake the event form uses.
  const locationDraft = useLocationDraft();
  useEffect(() => {
    if (!locationDraft) return;
    set({
      location: locationDraft.location,
      phone: locationDraft.phone,
      placeId: locationDraft.placeId ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationDraft]);
  useEffect(() => () => clearLocationDraft(), []);

  // ── Journey Departs/Arrives pair ────────────────────────────────────────────
  // Editing the arrival (date/time) to at/before the departure drags the
  // departure back so the leg keeps its length (see lib/datetime).
  const setJourneyEnd = (part: 'date' | 'time', v: string) => {
    const key = part === 'date' ? 'arrDate' : 'arrTime';
    const patch: Partial<typeof form> = { [key]: v } as Partial<typeof form>;
    if (form.depDate) {
      const endDate = form.arrDate || form.depDate;
      const newEnd = {
        date: part === 'date' ? v : endDate,
        time: part === 'time' ? v : form.arrTime || '00:00',
      };
      const shifted = startKeepingDuration(
        { date: form.depDate, time: form.depTime || '00:00' },
        { date: endDate, time: form.arrTime || '00:00' },
        newEnd
      );
      if (shifted) {
        patch.depDate = shifted.date;
        if (form.depTime) patch.depTime = shifted.time;
      }
    }
    set(patch);
  };

  // Editing the departure carries the arrival with it, in either direction, so
  // the leg keeps its length — changing the length is the arrival's job
  // (setJourneyEnd). Only runs when an arrival is set; a **time** edit
  // additionally needs both clocks set, or the midnight fallback would drag a
  // date-only arrival across days.
  const setJourneyStart = (part: 'date' | 'time', v: string) => {
    const key = part === 'date' ? 'depDate' : 'depTime';
    const patch: Partial<typeof form> = { [key]: v } as Partial<typeof form>;
    const timeShiftOk = part === 'date' || Boolean(form.depTime && form.arrTime);
    if (form.depDate && form.arrDate && timeShiftOk) {
      const newStart = {
        date: part === 'date' ? v : form.depDate,
        time: part === 'time' ? v : form.depTime || '00:00',
      };
      const shifted = endKeepingDuration(
        { date: form.depDate, time: form.depTime || '00:00' },
        { date: form.arrDate, time: form.arrTime || '00:00' },
        newStart
      );
      if (shifted) {
        patch.arrDate = shifted.date;
        if (form.arrTime) patch.arrTime = shifted.time;
      }
    }
    set(patch);
  };

  // ── Standard Starts/Ends pair — the event form's handlers, verbatim in
  // spirit (calendar.md): moving the start carries the end so the booking
  // keeps its length; the end sets the length, except dragging it to at/before
  // the start, which pulls the start back. All-day treats both clocks as
  // midnight, and `endDate` normalizes to '' whenever the end lands back on
  // the start's own day.
  const setStdStart = (patch: { date?: string; time?: string }) => {
    const nextDate = patch.date ?? form.startDate;
    const nextTime = patch.time ?? form.startTime;
    const out: Partial<typeof form> = {};
    if (patch.date !== undefined) out.startDate = patch.date;
    if (patch.time !== undefined) out.startTime = patch.time;
    const startTime = form.allDay ? '00:00' : form.startTime || '00:00';
    const endTime = form.allDay ? '00:00' : form.endTime || '00:00';
    const newStartTime = form.allDay ? '00:00' : nextTime || '00:00';
    const shifted = endKeepingDuration(
      { date: form.startDate, time: startTime },
      { date: form.endDate || form.startDate, time: endTime },
      { date: nextDate, time: newStartTime }
    );
    if (shifted) {
      if (!form.allDay) out.endTime = shifted.time;
      out.endDate = shifted.date === nextDate ? '' : shifted.date;
    }
    set(out);
  };

  const setStdEndTime = (v: string) => {
    const patch: Partial<typeof form> = { endTime: v };
    if (!form.allDay && form.startTime && form.endTime) {
      const endDate = form.endDate || form.startDate;
      const shifted = startKeepingDuration(
        { date: form.startDate, time: form.startTime },
        { date: endDate, time: form.endTime },
        { date: endDate, time: v }
      );
      if (shifted) {
        patch.startTime = shifted.time;
        if (shifted.date !== form.startDate) {
          patch.startDate = shifted.date;
          if (!form.endDate) patch.endDate = form.startDate;
        }
      }
    }
    set(patch);
  };

  const setStdEndDate = (v: string) => {
    const startTime = form.allDay ? '00:00' : form.startTime || '00:00';
    const endTime = form.allDay ? '00:00' : form.endTime || '00:00';
    const shifted = startKeepingDuration(
      { date: form.startDate, time: startTime },
      { date: form.endDate || form.startDate, time: endTime },
      { date: v, time: endTime }
    );
    if (shifted) {
      const patch: Partial<typeof form> = { endDate: v, startDate: shifted.date };
      if (!form.allDay) patch.startTime = shifted.time;
      set(patch);
      return;
    }
    set({ endDate: v === form.startDate ? '' : v });
  };

  const applyPatch = (patch: Record<string, unknown>) => {
    const next: Partial<typeof form> = {};
    const changedKeys: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in form)) continue;
      // Alert minutes are number | null (the assist schema's -1 = None), never
      // the '' the string fields fall back to; booleans stay booleans.
      const val =
        k === 'reminderMinutes' || k === 'alert2Minutes' ? (v === -1 || v == null ? null : v)
        : k === 'cost' ? (v == null ? '' : String(v))
        : k === 'allDay' || k === 'confirmed' ? !!v
        : v == null ? '' : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    // Whatever the patch set, an all-day booking's alerts must land on the
    // whole-day grid — turning all-day on in the same patch has to re-base an
    // alert the patch (or the form) holds in minutes (the event form's rule).
    const effectiveAllDay = 'allDay' in next ? !!next.allDay : form.allDay;
    if (effectiveAllDay && !(form.type === 'flight' || form.type === 'transit')) {
      const merged = {
        reminderMinutes: 'reminderMinutes' in next ? ((next.reminderMinutes as number | null) ?? null) : form.reminderMinutes,
        alert2Minutes: 'alert2Minutes' in next ? ((next.alert2Minutes as number | null) ?? null) : form.alert2Minutes,
      };
      const snapped = alertsForAllDay(true, merged);
      if (snapped.reminderMinutes !== merged.reminderMinutes) next.reminderMinutes = snapped.reminderMinutes;
      if (snapped.alert2Minutes !== merged.alert2Minutes) next.alert2Minutes = snapped.alert2Minutes;
    }
    // However the first alert ends up cleared — the assistant setting it to
    // None included — the second one moves up rather than staying set behind a
    // hidden row (same rule as the Alert picker).
    setForm((f) => {
      const merged = { ...f, ...next };
      const p = promoteSecondAlert(merged);
      return { ...merged, reminderMinutes: p.reminderMinutes, alert2Minutes: p.alert2Minutes };
    });
    assist.mark(changedKeys);
  };

  const isJourney = form.type === 'flight' || form.type === 'transit';
  // A journey is placed by its departure clock; All day only exists on the
  // standard Starts/Ends card.
  const isAllDay = !isJourney && form.allDay;

  // The hour an all-day booking's alerts fire at: the account-level day-alert
  // default (Profile → Reminders), same as an all-day event's. Cached by
  // react-query, so this is the fetch those screens already make.
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const dayAlertTime = settingsQ.data?.dayAlertTime || DEFAULT_DAY_ALERT_TIME;

  // The same rows the booking view's live pickers offer, from the same builder
  // (lib/tripAlerts) — the two surfaces set the same field and must never
  // disagree about what can be picked.
  const alertItems = buildBookingAlertItems({
    type: form.type,
    allDay: isAllDay,
    dayAlertTime,
    reminderMinutes: form.reminderMinutes,
    alert2Minutes: form.alert2Minutes,
  });

  // The assistant's Alert select must offer what the picker offers: on an
  // all-day booking that's the whole-day grid, not minute offsets the booking
  // can't honour (the event form's rule).
  const assistFields = useMemo<FormAssistField[]>(
    () =>
      ASSIST_FIELDS.map((f) => {
        if (f.name === 'reminderMinutes' && isAllDay) {
          return {
            ...f,
            description:
              'All-day booking: alerts are whole days before it, delivered at the user\'s day-alert time. 0 = on the day itself.',
            options: [
              { label: 'None', value: -1 },
              ...ALL_DAY_ALERT_OFFSETS.map((v) => ({ value: v, label: allDayAlertLabel(v, dayAlertTime) })),
            ],
          };
        }
        return f;
      }),
    [isAllDay, dayAlertTime]
  );

  // Shared decrypting fetcher on the shared key (lib/tripData) — see the note
  // there: a per-screen plaintext fetch would blank the detail screen behind
  // this form. The trip's timezone is sealed content too, so it only reads
  // through the opened record.
  const tripQ = useQuery({ queryKey: ['trips', tripId], queryFn: () => fetchTripDetail(tripId) });
  const familiesQ = useQuery({ queryKey: ['trips', tripId, 'families'], queryFn: async () => (await tripsApi.families(tripId)).data });
  // GET /trips/:id returns { trip, items, isOwner }: a booking's wall-clock times
  // are entered in the DESTINATION's timezone (what the itinerary renders in),
  // not the device's.
  const tz = tripQ.data?.trip?.destinationTz || '';
  const families = familiesQ.data ?? [];
  const multiFamily = families.length > 1;

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Booking' : 'Add Booking' });
  }, [navigation, isEdit]);

  function buildShareRows(existing: { householdId: string; amount?: number | null }[] = [], myId?: string) {
    const byId = Object.fromEntries(existing.map((s) => [String(s.householdId), s.amount ?? null]));
    setShareRows(
      families.map((f) => ({
        householdId: String(f.householdId),
        name: f.name,
        included: existing.length ? Object.prototype.hasOwnProperty.call(byId, String(f.householdId)) : String(f.householdId) === String(myId),
        amount: byId[String(f.householdId)] ?? null,
      }))
    );
  }

  // Hydrate for edit.
  useEffect(() => {
    if (!isEdit || !tripQ.data) return;
    const found = tripQ.data.items?.find((x) => x._id === itemId);
    if (!found) return;
    let cancelled = false;
    (async () => {
    const it = await openRecord('TripItem', found); // decrypt content over plaintext
    if (cancelled) return;
    const d = (it.details as any) || {};
    // A booking holding only a SECOND alert (a first later cleared elsewhere)
    // opens with it in the first slot — the Second Alert row renders only while
    // a first exists, and a hidden-but-set alert can't be seen or edited.
    const alerts = promoteSecondAlert({
      reminderMinutes: it.reminderMinutes ?? null,
      alert2Minutes: it.alert2Minutes ?? null,
    });
    const alertPair = { reminderMinutes: alerts.reminderMinutes, alert2Minutes: alerts.alert2Minutes };
    const journey = it.type === 'flight' || it.type === 'transit';
    if (journey && (d.departureTz || d.arrivalTz)) {
      const dep = zonedParts(it.start, d.departureTz);
      const arr = it.end ? zonedParts(it.end, d.arrivalTz) : null;
      setForm((f) => ({
        ...f, type: it.type, title: it.title ?? '',
        depName: d.departureName ?? '', departureTz: d.departureTz ?? '', depDate: dep.dateStr, depTime: dep.timeStr,
        arrName: d.arrivalName ?? '', arrivalTz: d.arrivalTz ?? '', arrDate: arr?.dateStr ?? '', arrTime: arr?.timeStr ?? '12:00',
        airline: d.airline ?? '', flightNumber: d.flightNumber ?? '', seat: d.seat ?? '', mode: d.mode ?? '',
        cost: it.cost != null ? String(it.cost) : '', currency: it.currency ?? '', confirmation: it.confirmation ?? '',
        url: it.url ?? '', phone: it.phone ?? '', notes: it.notes ?? '', ...alertPair,
        sharing: it.sharing || 'private', paidByHouseholdId: it.paidByHouseholdId ?? '',
        confirmed: it.sharing === 'shared_separate' ? !!it.myData?.confirmed : !!it.confirmed,
      }));
    } else {
      const sp = zonedParts(it.start, tz);
      const ep = it.end ? zonedParts(it.end, tz) : null;
      const allDay = !!it.allDay;
      setForm((f) => ({
        ...f, type: it.type, title: it.title ?? '',
        allDay,
        startDate: sp.dateStr,
        // An all-day booking has no clocks: keep the 9–10 AM defaults waiting
        // behind the switch (what toggling All day off reveals). A timed one
        // saved without an end (legacy rows) reads back as one hour long, the
        // same default a new booking's Ends time opens on.
        startTime: allDay ? f.startTime : sp.timeStr,
        endDate: ep && ep.dateStr !== sp.dateStr ? ep.dateStr : '',
        endTime: allDay ? f.endTime : ep?.timeStr ?? addMinutesToTime(sp.timeStr, 60),
        location: it.location ?? '', placeId: it.placeId ?? '', airline: d.airline ?? '', flightNumber: d.flightNumber ?? '', seat: d.seat ?? '', mode: d.mode ?? '',
        cost: (it.myData?.cost ?? it.cost) != null ? String(it.myData?.cost ?? it.cost) : '', currency: it.currency ?? '',
        confirmation: it.confirmation ?? '', url: it.url ?? '', phone: it.phone ?? '', notes: it.notes ?? '', ...alertPair,
        sharing: it.sharing || 'private', paidByHouseholdId: it.paidByHouseholdId ?? '',
        confirmed: it.sharing === 'shared_separate' ? !!it.myData?.confirmed : !!it.confirmed,
      }));
    }
    const existing = it.shares ?? (it.participants ?? []).map((hid: string) => ({ householdId: hid, amount: null }));
    if (existing.length) buildShareRows(existing);
    // Only baseline once the families list is in — the share rows build from it,
    // so seeding earlier would let that fill register as an unsaved edit.
    if (familiesQ.data) setSeeded(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripQ.data, familiesQ.data, isEdit, itemId, tz]);

  function toggleSharing(val: string) {
    set({ sharing: val });
    if (val !== 'private' && !shareRows.some((r) => r.included)) buildShareRows();
  }
  function splitEqually() {
    const inc = shareRows.filter((r) => r.included);
    if (!inc.length || !form.cost) return;
    const each = Math.round((Number(form.cost) / inc.length) * 100) / 100;
    setShareRows((rows) => rows.map((r) => (r.included ? { ...r, amount: each } : r)));
  }
  const includedFamilies = shareRows.filter((r) => r.included);
  const shareSum = includedFamilies.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const save = useMutation({
    mutationFn: async () => {
      const mode = multiFamily ? form.sharing : 'private';
      const common: Record<string, unknown> = {
        url: form.url || undefined, phone: form.phone || undefined, notes: form.notes || undefined,
        // The alert pair (sealed via TRIP_ITEM_ENC). The form's rule: a second
        // alert without a first is an alert the user can neither see nor edit.
        reminderMinutes: form.reminderMinutes ?? undefined,
        alert2Minutes: form.reminderMinutes !== null && form.alert2Minutes !== null ? form.alert2Minutes : undefined,
      };
      const included = shareRows.filter((r) => r.included).map((r) => r.householdId);
      if (mode === 'shared_separate') {
        Object.assign(common, {
          sharing: 'shared_separate', participants: included,
          myData: { cost: form.cost ? Number(form.cost) : null, currency: form.currency || undefined, confirmation: form.confirmation || undefined, confirmed: form.confirmed },
        });
      } else if (mode === 'shared_one_separate') {
        Object.assign(common, {
          sharing: 'shared_one_separate', participants: included,
          confirmation: form.confirmation || undefined, confirmed: form.confirmed,
          myData: { cost: form.cost ? Number(form.cost) : null, currency: form.currency || undefined },
        });
      } else if (mode === 'shared_shared') {
        Object.assign(common, {
          sharing: 'shared_shared', cost: form.cost ? Number(form.cost) : undefined, currency: form.currency || undefined,
          confirmation: form.confirmation || undefined, confirmed: form.confirmed,
          shares: shareRows.filter((r) => r.included).map((r) => ({ householdId: r.householdId, amount: r.amount ?? undefined })),
          paidByHouseholdId: form.paidByHouseholdId || undefined,
        });
      } else {
        Object.assign(common, {
          sharing: 'private', cost: form.cost ? Number(form.cost) : undefined, currency: form.currency || undefined,
          confirmation: form.confirmation || undefined, confirmed: form.confirmed,
        });
      }

      let payload: Record<string, unknown>;
      if (isJourney) {
        const start = zonedWallclockToUtc(form.depDate, form.depTime, form.departureTz || tz);
        const end = form.arrDate ? zonedWallclockToUtc(form.arrDate, form.arrTime, form.arrivalTz || tz) : undefined;
        const details: Record<string, unknown> = {};
        if (form.type === 'flight') {
          if (form.airline) details.airline = form.airline;
          if (form.flightNumber) details.flightNumber = form.flightNumber;
          if (form.seat) details.seat = form.seat;
        } else if (form.mode) details.mode = form.mode;
        if (form.depName) details.departureName = form.depName;
        if (form.departureTz) details.departureTz = form.departureTz;
        if (form.arrName) details.arrivalName = form.arrName;
        if (form.arrivalTz) details.arrivalTz = form.arrivalTz;
        payload = {
          type: form.type, title: form.title.trim(), start: start?.toISOString(), end: end ? end.toISOString() : undefined,
          location: form.depName || undefined, details: Object.keys(details).length ? details : undefined, ...common,
        };
      } else {
        // All-day: dates only — stored as midnight instants in the destination
        // tz (the plaintext routing columns never change shape), the flag
        // itself sealed beside the title. A single-day all-day booking keeps
        // `end` empty. Timed: the event form's model — an end always exists,
        // on the start's own day unless the Ends date says otherwise.
        const start = zonedWallclockToUtc(form.startDate, form.allDay ? '00:00' : form.startTime, tz);
        const end = form.allDay
          ? form.endDate && form.endDate !== form.startDate
            ? zonedWallclockToUtc(form.endDate, '00:00', tz)
            : undefined
          : zonedWallclockToUtc(
              form.endDate || form.startDate,
              form.endTime || addMinutesToTime(form.startTime || '09:00', 60),
              tz
            );
        payload = {
          type: form.type, title: form.title.trim(), start: start?.toISOString(), end: end ? end.toISOString() : undefined,
          allDay: form.allDay || undefined,
          location: form.location || undefined, placeId: form.placeId || undefined, ...common,
        };
      }
      // Seal lane (TripKey vs HDK) chosen in the shared helper — the booking
      // view's live alert pickers reseal the same content and must agree.
      // `tripShared` is derived below from the loaded trip.
      if (isEdit) return tripsApi.updateItem(tripId, itemId!, await sealTripItemPayload(tripId, tripShared, itemId!, payload, false));
      return tripsApi.addItem(tripId, await sealTripItemPayload(tripId, tripShared, await newObjectId(), payload, true));
    },
    onSuccess: async (r: any) => {
      // Attachments picked on a draft form upload now that the booking exists
      // (the event form's pattern) — track which files failed to attach (and
      // why we say so) so a failure isn't mistaken for a successful upload.
      const createdId = !isEdit ? r?.data?._id : null;
      if (!isEdit) {
        const queuedFiles = getQueuedAttachments();
        const failed: string[] = [];
        for (const f of queuedFiles) {
          if (!createdId) { failed.push(f.name); continue; }
          try { await uploadBookingAttachment(createdId, f); } catch { failed.push(f.name); }
        }
        clearQueuedAttachments();
        if (failed.length) {
          Alert.alert(
            'Some attachments didn’t upload',
            `The booking was saved, but these files couldn’t be attached: ${failed.join(', ')}. Open the booking to try again.`,
          );
        }
      }
      qc.invalidateQueries({ queryKey: ['trips', tripId] });
      allowLeave();
      navigation.goBack();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Save failed'),
  });

  const remove = useMutation({
    mutationFn: () => tripsApi.removeItem(tripId, itemId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trips', tripId] });
      allowLeave();
      navigation.goBack();
    },
  });

  // ── Attachments (confirmation files; E2EE on private bookings) ─────────────
  // GET /trips/:id responds { trip, items, isOwner }; the mobile Trip type
  // flattens this, so reach into the raw payload for both.
  const rawTrip = (tripQ.data as any)?.trip;
  const rawItem = isEdit ? (tripQ.data as any)?.items?.find((x: any) => x._id === itemId) : undefined;
  const tripShared = !!((rawTrip?.sharedWithOutside?.length ?? 0) > 0 || (rawTrip?.collaborators?.length ?? 0) > 0);
  const attachments: TripItemAttachment[] = rawItem?.attachments ?? [];

  // A NEW booking has no item id to upload against, so picks stage in the
  // shared draft queue (lib/attachmentDraft, the event form's store) and upload
  // after the save creates the item — see the save mutation's onSuccess.
  const queuedAttachments = useQueuedAttachments();
  useEffect(() => {
    if (!isEdit) clearQueuedAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Encrypt the bytes on-device and upload ciphertext + the wrapped file key,
  // wrapping the per-file key by whichever key the readers hold:
  //   • shared_shared booking (one receipt every participant sees) → the
  //     TripKey (§D2), so cross-household collaborators can open it;
  //   • any other booking (private / per-family) → the HDK, since only the
  //     owning family may download it.
  const uploadBookingAttachment = async (toItemId: string, file: PickedFile) => {
    const endpoint = `/trips/${tripId}/items/${toItemId}/attachments`;
    if (getHDK()) {
      const attId = await newObjectId();
      let sealed = null as Awaited<ReturnType<typeof encryptFileForUpload>>;
      if (form.sharing === 'shared_shared' && tripShared) {
        await loadResourceKeys('trip', tripId).catch(() => {});
        if (currentResourceKeyVersion(tripId) > 0) {
          sealed = await encryptFileForUploadResource('trip', 'TripItemAttachment', attId, tripId, file.uri);
        }
      } else {
        sealed = await encryptFileForUpload('TripItemAttachment', attId, file.uri);
      }
      if (sealed) {
        return uploadFile(endpoint, { uri: sealed.uri, name: `${attId}.bin`, type: 'application/octet-stream' }, 'file', {
          encrypted: true,
          _id: attId,
          wrappedFileKey: sealed.wrappedFileKey,
          keyVersion: sealed.keyVersion,
          fileType: file.type || 'application/pdf',
          title: file.name,
        });
      }
    }
    return uploadFile(endpoint, file, 'file');
  };

  // Upload a pick to a saved booking (new bookings queue it instead).
  const addAttachment = useMutation({
    mutationFn: (file: PickedFile) => uploadBookingAttachment(itemId!, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trips', tripId] }),
    onError: (e: any) => Alert.alert('Upload failed', e.response?.data?.error || 'Could not upload that file.'),
  });

  const onPickFile = (file: PickedFile | null) => {
    if (!file) return;
    if (isEdit) addAttachment.mutate(file);
    else addQueuedAttachment(file);
  };

  // Add-attachment source picker: camera / photo library / file (PDF etc.) —
  // the event form's picker, verbatim.
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

  // Open: encrypted attachments download as ciphertext, decrypt on-device to a
  // temp file, and share/open; plaintext ones open via the tokened URL. The
  // booking view shows the same list, so the how lives in lib/tripAttachments.
  const openAttachment = useMutation({
    mutationFn: (att: TripItemAttachment) => openTripAttachment(tripId, itemId!, att),
    onError: (e: any) => Alert.alert('Could not open attachment', e?.message || 'Please try again.'),
  });

  const deleteAttachment = useMutation({
    mutationFn: (attId: string) => tripsApi.removeAttachment(tripId, itemId!, attId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trips', tripId] }),
    onError: (e: any) => Alert.alert('Could not remove attachment', e.response?.data?.error || 'Please try again.'),
  });

  const onSave = () => {
    if (!form.title.trim()) return setError('Title is required');
    if (isJourney ? !form.depDate : !form.startDate) return setError('A date is required');
    setError('');
    save.mutate();
  };


  // Discard guard: prompt before leaving with unsaved edits to the booking
  // fields or its cost-share rows. Baseline is taken once the form has seeded.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ form, shareRows });
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  useHeaderCheckButton(navigation, { onPress: onSave, loading: save.isPending, color: accent, dirty });
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  // A NEW booking guesses its currency from the trip destination's country —
  // resolved via the keyless geocoders (shared/weather.regionForAddress), so
  // the sealed destination never touches our server. The guess only fills an
  // empty Currency, and it also lands in the discard-guard baseline: a prefill
  // is a seed, not an unsaved edit.
  const destination = tripQ.data?.trip?.destination;
  useEffect(() => {
    if (isEdit || !destination) return;
    let cancelled = false;
    (async () => {
      const region = await regionForAddress(destination).catch(() => null);
      const code = currencyForCountry(region?.countryCode);
      if (cancelled || !code) return;
      setForm((f) => (f.currency ? f : { ...f, currency: code }));
      if (baselineRef.current) {
        try {
          const base = JSON.parse(baselineRef.current);
          if (!base.form.currency) {
            base.form.currency = code;
            baselineRef.current = JSON.stringify(base);
          }
        } catch { /* leave the baseline as-is */ }
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, destination]);

  if (isEdit && tripQ.isLoading) {
    return <CenteredLoader color={accent} />;
  }

  const costLabel = PRIVATE_BILL.includes(form.sharing) && multiFamily ? 'Your cost' : 'Cost';

  // A hotel's start and end are its check-in and check-out — what the booking
  // itself calls them, and what the booking view, the day grid's lodging blocks
  // and the alert anchor already say. Every other type keeps Starts / Ends.
  const startLabel = form.type === 'hotel' ? 'Check in' : 'Starts';
  const endLabel = form.type === 'hotel' ? 'Check out' : 'Ends';

  // The cost renders with its currency's symbol embedded ("$450"), so the value
  // reads as money while staying a plain right-aligned field; an edit strips
  // the prefix back off before it reaches the stored number. A destination
  // whose inferred currency isn't in the standard list still has to be
  // offerable, so it joins the picker's options at the top.
  const costSym = currencySymbol(form.currency);
  const costDisplay = form.cost ? `${costSym}${form.cost}` : '';
  const setCost = (v: string) => {
    // Strip the embedded symbol wherever the edit left it (typing with the
    // cursor at position 0 pushes digits ahead of it), then any leading
    // remnant of a partially deleted multi-char symbol ("CH450").
    let s = costSym ? v.split(costSym).join('') : v;
    s = s.replace(/^[^\d.,-]+/, '');
    set({ cost: s });
  };
  const currencyOptions = (!form.currency || CURRENCIES.includes(form.currency) ? CURRENCIES : [form.currency, ...CURRENCIES])
    .map((c) => ({ label: c, value: c }));

  return (
    <Screen>
      <FormAssist
        accent={accent}
        formType="trip booking"
        placeholder={'Describe the booking, e.g. "flight from Toronto to Paris June 5, 6pm–7:30am, $650, booked"'}
        fields={assistFields}
        current={{ ...form }}
        onApply={applyPatch}
      />

      <SectionTitle>Type</SectionTitle>
      <View style={styles.typeGrid}>
        {TRIP_TYPES.map((t) => {
          const active = form.type === t.value;
          return (
            <TouchableOpacity
              key={t.value}
              style={[styles.typeChip, active && { backgroundColor: t.color, borderColor: t.color }]}
              onPress={() => set({ type: t.value })}
            >
              <MaterialCommunityIcons name={t.icon as any} size={18} color={active ? '#fff' : t.color} />
              <Text style={[styles.typeLabel, active && { color: '#fff' }]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <GroupCard>
        <Input
          value={form.title}
          onChangeText={(v) => set({ title: v })}
          placeholder={tripTypeMeta(form.type).label}
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('title') && fs.headInputHighlight]}
        />
        {!isJourney ? (
          <>
            <CardDivider />
            {/* Opens the shared Location view (search + editable details incl.
                the business phone), same as the event form; the picked values
                flow back via locationDraft. */}
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
                  placeholder="Location"
                  containerStyle={fs.headField}
                  style={[fs.headInput, assist.changed.has('location') && fs.headInputHighlight]}
                />
              </View>
            </TouchableOpacity>
          </>
        ) : null}
      </GroupCard>

      {isJourney ? (
        <>
          <SectionTitle>Departure</SectionTitle>
          <GroupCard>
            <PlacesAutocomplete
              value={form.depName}
              onChangeText={(v) => set({ depName: v })}
              placeholder={form.type === 'flight' ? 'Departure airport' : 'Departure station / port'}
              type={form.type === 'flight' ? 'airport' : 'transit'}
              onSelect={(p) => placesApi.getTimezone(p.place_id).then((r) => set({ departureTz: r.data.timeZoneId || form.departureTz })).catch(() => {})}
              containerStyle={fs.headField}
              inputStyle={[fs.headInput, assist.changed.has('depName') && fs.headInputHighlight]}
            />
            <CardDivider />
            <View style={fs.dtRow}>
              <Text style={fs.dtLabel}>Departs</Text>
              <View style={fs.dtFields}>
                <DateField
                  value={form.depDate}
                  onChange={(v) => setJourneyStart('date', v)}
                  highlight={assist.changed.has('depDate')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
                <TimeField
                  value={form.depTime}
                  onChange={(v) => setJourneyStart('time', v)}
                  highlight={assist.changed.has('depTime')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
              </View>
            </View>
            <CardDivider />
            <Select
              inlineLabel="Timezone"
              value={form.departureTz}
              options={TZ_OPTIONS.map((t) => ({ label: t || 'Use destination tz', value: t }))}
              onChange={(v) => set({ departureTz: (v as string) || '' })}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </GroupCard>

          <SectionTitle>Arrival</SectionTitle>
          <GroupCard>
            <PlacesAutocomplete
              value={form.arrName}
              onChangeText={(v) => set({ arrName: v })}
              placeholder={form.type === 'flight' ? 'Arrival airport' : 'Arrival station / port'}
              type={form.type === 'flight' ? 'airport' : 'transit'}
              onSelect={(p) => placesApi.getTimezone(p.place_id).then((r) => set({ arrivalTz: r.data.timeZoneId || form.arrivalTz })).catch(() => {})}
              containerStyle={fs.headField}
              inputStyle={[fs.headInput, assist.changed.has('arrName') && fs.headInputHighlight]}
            />
            <CardDivider />
            <View style={fs.dtRow}>
              <Text style={fs.dtLabel}>Arrives</Text>
              <View style={fs.dtFields}>
                <DateField
                  value={form.arrDate}
                  onChange={(v) => setJourneyEnd('date', v)}
                  highlight={assist.changed.has('arrDate')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
                <TimeField
                  value={form.arrTime}
                  onChange={(v) => setJourneyEnd('time', v)}
                  highlight={assist.changed.has('arrTime')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
              </View>
            </View>
            <CardDivider />
            <Select
              inlineLabel="Timezone"
              value={form.arrivalTz}
              options={TZ_OPTIONS.map((t) => ({ label: t || 'Use destination tz', value: t }))}
              onChange={(v) => set({ arrivalTz: (v as string) || '' })}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </GroupCard>

          {/* Transit names its own mode; a flight has no details card — the
              airports, times and the ticket attachment are the booking. */}
          {form.type === 'transit' ? (
            <GroupCard>
              <View style={fs.dtRow}>
                <Text style={fs.dtLabel}>Mode</Text>
                <Input
                  value={form.mode}
                  onChangeText={(v) => set({ mode: v })}
                  placeholder="train / bus / ferry"
                  clearable={false}
                  containerStyle={[fs.headField, fs.rowInputWrap]}
                  style={[fs.headInput, fs.rowInput, assist.changed.has('mode') && fs.headInputHighlight]}
                />
              </View>
            </GroupCard>
          ) : null}
        </>
      ) : (
        <GroupCard>
          <View style={fs.groupPad}>
            {/* Switching All day on re-bases any configured alerts onto the
                whole-day grid — the booking loses the start time they were
                counting back from, so leaving them as-is would keep firing
                them at an hour the booking no longer has (the event form's
                rule, alertsForAllDay). */}
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
                })
              }
              color={accent}
              highlight={assist.changed.has('allDay')}
            />
          </View>
          <CardDivider />
          <View style={fs.dtRow}>
            <Text style={fs.dtLabel}>{startLabel}</Text>
            <View style={fs.dtFields}>
              <DateField
                value={form.startDate}
                onChange={(v) => setStdStart({ date: v })}
                highlight={assist.changed.has('startDate')}
                containerStyle={fs.dtFieldWrap}
                fieldStyle={fs.dtField}
                valueStyle={fs.dtValue}
                hideIcon
              />
              {!form.allDay ? (
                <TimeField
                  value={form.startTime}
                  onChange={(v) => setStdStart({ time: v })}
                  highlight={assist.changed.has('startTime')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
              ) : null}
            </View>
          </View>
          <CardDivider />
          <View style={fs.dtRow}>
            <Text style={fs.dtLabel}>{endLabel}</Text>
            <View style={fs.dtFields}>
              {/* Defaults to the start date; form.endDate stays unset (= same
                  day) until a different date is picked. */}
              <DateField
                value={form.endDate || form.startDate}
                onChange={setStdEndDate}
                highlight={assist.changed.has('endDate')}
                containerStyle={fs.dtFieldWrap}
                fieldStyle={fs.dtField}
                valueStyle={fs.dtValue}
                hideIcon
              />
              {!form.allDay ? (
                <TimeField
                  value={form.endTime}
                  onChange={setStdEndTime}
                  defaultValue={addMinutesToTime(form.startTime || '09:00', 60)}
                  highlight={assist.changed.has('endTime')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
              ) : null}
            </View>
          </View>
        </GroupCard>
      )}

      <GroupCard>
        <View style={fs.groupPad}>
          <SwitchRow
            label="Booked"
            value={form.confirmed}
            onValueChange={(v) => set({ confirmed: v })}
            color={accent}
            highlight={assist.changed.has('confirmed')}
          />
        </View>
        {multiFamily ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Sharing"
              value={form.sharing}
              options={TRIP_SHARING_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              onChange={(v) => toggleSharing((v as string) || 'private')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
        <CardDivider />
        {/* One money row: the amount and the currency it's in belong together,
            so the picker sits on the Cost line rather than in a row of its own.
            The label carries the ⓘ disclosure (whole label + glyph is the tap
            target) explaining where the number goes — the trip's budget. */}
        <View>
          <View style={fs.dtRow}>
            <TouchableOpacity
              style={styles.costLabelBtn}
              onPress={() => setCostHint((v) => !v)}
              activeOpacity={0.7}
              // The label + glyph is only ~22pt tall inside the row, so the
              // slop is what makes it a 44pt target.
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="What the cost is used for"
              accessibilityState={{ expanded: costHint }}
            >
              <Text style={styles.costLabel}>{costLabel}</Text>
              <Ionicons
                name={costHint ? 'information-circle' : 'information-circle-outline'}
                size={18}
                color={colors.textMuted}
              />
            </TouchableOpacity>
            <Input
              keyboardType="decimal-pad"
              value={costDisplay}
              onChangeText={setCost}
              placeholder={costSym || undefined}
              clearable={false}
              containerStyle={[fs.headField, fs.rowInputWrap]}
              style={[fs.headInput, fs.rowInput, assist.changed.has('cost') && fs.headInputHighlight]}
            />
            <Select
              placeholder="Currency"
              value={form.currency}
              options={currencyOptions}
              onChange={(v) => set({ currency: (v as string) || '' })}
              clearable
              highlight={assist.changed.has('currency')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={styles.currencyField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </View>
          {costHint ? (
            <Hint style={styles.costHint}>
              What you enter here is what the trip's budget adds up — every booking's cost rolls into
              the “Your budget” total on the trip overview, converted to your base currency.
            </Hint>
          ) : null}
        </View>
      </GroupCard>

      {multiFamily && form.sharing !== 'private' ? (
        <>
          <GroupCard>
            <View style={styles.shareHead}>
              <Text style={styles.shareTitle}>
                {form.sharing === 'shared_shared' ? "Families & each one's share" : 'Families sharing this booking'}
              </Text>
              {form.sharing === 'shared_shared' ? (
                <TouchableOpacity onPress={splitEqually}><Text style={[styles.splitBtn, { color: accent }]}>Split equally</Text></TouchableOpacity>
              ) : null}
            </View>
            {shareRows.map((row) => (
              <React.Fragment key={row.householdId}>
                <CardDivider />
                <View style={styles.shareRow}>
                  <TouchableOpacity onPress={() => setShareRows((rows) => rows.map((r) => (r.householdId === row.householdId ? { ...r, included: !r.included } : r)))}>
                    <Ionicons name={row.included ? 'checkbox' : 'square-outline'} size={22} color={row.included ? accent : colors.textMuted} />
                  </TouchableOpacity>
                  <Text style={styles.shareName}>{row.name}</Text>
                  {form.sharing === 'shared_shared' ? (
                    <Input
                      value={row.amount != null ? String(row.amount) : ''}
                      onChangeText={(v) => setShareRows((rows) => rows.map((r) => (r.householdId === row.householdId ? { ...r, amount: v ? Number(v) : null } : r)))}
                      keyboardType="decimal-pad"
                      editable={row.included}
                      placeholder="0"
                      containerStyle={[fs.headField, styles.shareAmt]}
                      style={[fs.headInput, styles.shareAmtInput]}
                    />
                  ) : null}
                </View>
              </React.Fragment>
            ))}
            {form.sharing === 'shared_shared' ? (
              <>
                <CardDivider />
                <Select
                  inlineLabel="Paid by"
                  placeholder="Who fronted the bill?"
                  value={form.paidByHouseholdId}
                  options={includedFamilies.map((r) => ({ label: r.name, value: r.householdId }))}
                  onChange={(v) => set({ paidByHouseholdId: (v as string) || '' })}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.rowField}
                  valueStyle={fs.dtValue}
                  chevronIcon="chevron-expand"
                />
              </>
            ) : null}
          </GroupCard>
          {form.sharing === 'shared_shared' ? (
            <Text style={styles.shareSum}>Shares total {shareSum}{form.cost ? ` of ${form.cost}` : ''}</Text>
          ) : null}
        </>
      ) : null}

      {/* Alert / Second Alert grouped card — the calendar event form's pair,
          counting back from the booking's start (a journey's departure, a
          hotel's check-in), and in the event form's place: the last card
          before Attachments. Delivery is the on-device reminder pass. */}
      <GroupCard>
        <Select
          inlineLabel="Alert"
          value={alertKey(form.reminderMinutes, 'event')}
          options={excludeUsedAlertKey(alertItems, form.alert2Minutes, form.reminderMinutes)}
          placeholder="None"
          onChange={(v) => {
            if (v === CUSTOM_ALERT) setCustomFor('reminderMinutes');
            else {
              const opt = alertItems.find((i) => i.value === v);
              // Clearing this one hands the slot to the second alert, which the
              // form would otherwise hide while leaving it set.
              const p = promoteSecondAlert({ reminderMinutes: opt?.minutes ?? null, alert2Minutes: form.alert2Minutes });
              set({ reminderMinutes: p.reminderMinutes, alert2Minutes: p.alert2Minutes });
            }
          }}
          highlight={assist.changed.has('reminderMinutes')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        {form.reminderMinutes !== null ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Second Alert"
              value={alertKey(form.alert2Minutes, 'event')}
              options={excludeUsedAlertKey(alertItems, form.reminderMinutes, form.alert2Minutes)}
              placeholder="None"
              onChange={(v) => {
                if (v === CUSTOM_ALERT) setCustomFor('alert2Minutes');
                else set({ alert2Minutes: alertItems.find((i) => i.value === v)?.minutes ?? null });
              }}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
      </GroupCard>

      <CustomAlertSheet
        visible={customFor !== null}
        dayOnly={isAllDay}
        travelMinutes={null}
        initialMinutes={customFor ? form[customFor] : null}
        initialAnchor="event"
        onSave={(minutes) => {
          if (customFor) set({ [customFor]: minutes } as Partial<typeof form>);
        }}
        onClose={() => setCustomFor(null)}
      />

      {/* Attachments — the event form's card: an Add row on top opening the
          camera / photo library / file picker, then one row per file. A saved
          booking lists (and uploads to) the server; a draft form stages picks
          in the shared queue and uploads them after the create. */}
      <SectionTitle>Attachments</SectionTitle>
      <GroupCard>
        <TouchableOpacity style={styles.attAddRow} activeOpacity={0.7} onPress={openAttachmentPicker}>
          <View style={[styles.attAddIcon, { backgroundColor: colors.textMuted }]}>
            <Ionicons name="add" size={18} color="#fff" />
          </View>
          <Text style={styles.attAddLabel}>Add attachment…</Text>
          {addAttachment.isPending ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        </TouchableOpacity>
        {isEdit
          ? attachments.map((att) => (
              <View key={att._id}>
                <CardDivider />
                <View style={styles.attRow}>
                  <TouchableOpacity style={styles.attMain} activeOpacity={0.7} onPress={() => openAttachment.mutate(att)}>
                    <Ionicons name={attachmentIcon(att.fileType)} size={20} color={colors.textMuted} />
                    <Text style={styles.attName} numberOfLines={1}>{att.filename || 'Attachment'}</Text>
                    {openAttachment.isPending && openAttachment.variables?._id === att._id ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : null}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.attRemove}
                    accessibilityLabel="Remove attachment"
                    onPress={() =>
                      Alert.alert('Remove attachment?', att.filename, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => deleteAttachment.mutate(att._id) },
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
                <CardDivider />
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
      </GroupCard>

      {/* URL — a single link for the booking (the confirmation page, the
          restaurant's site). The event form's labelled section, same slot. */}
      <SectionTitle>URL</SectionTitle>
      <GroupCard>
        <Input
          value={form.url}
          onChangeText={(v) => set({ url: v })}
          placeholder="Add a link…"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('url') && fs.headInputHighlight]}
        />
      </GroupCard>

      <SectionTitle>Notes</SectionTitle>
      <Input
        value={form.notes}
        onChangeText={(v) => set({ notes: v })}
        multiline
        placeholder="Add any notes…"
        style={fs.notes}
        highlight={assist.changed.has('notes')}
      />

      {tz ? <Text style={styles.tzNote}>Standard bookings are local to {tz}</Text> : null}
      <FormError>{error}</FormError>

      {isEdit ? (
        <View style={fs.footer}>
          <Button
            title="Delete"
            variant="danger"
            onPress={() =>
              Alert.alert('Delete booking?', '', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
              ])
            }
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  typeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  typeLabel: { fontSize: 13, fontWeight: '600', color: colors.text },
  shareHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, gap: spacing.sm },
  shareTitle: { fontSize: 13, fontWeight: '600', color: colors.text, flex: 1 },
  splitBtn: { fontWeight: '600', fontSize: 13 },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: 14, minHeight: 46 },
  shareName: { flex: 1, fontSize: 14, color: colors.text },
  shareAmt: { width: 110 },
  shareAmtInput: { textAlign: 'right', paddingHorizontal: 0 },
  shareSum: { fontSize: 12, color: colors.textMuted, marginTop: -spacing.sm, marginBottom: spacing.md },
  // Cost row: label + ⓘ on the left (sized to its text, not fs.dtLabel's flex:1,
  // so the amount keeps the flexible middle), currency picker on the right.
  costLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: spacing.sm },
  costLabel: { fontSize: 16, color: colors.text },
  // minHeight so the picker's tap target is the full row, not just its text.
  currencyField: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, paddingVertical: 7, minHeight: 46, marginLeft: spacing.sm },
  costHint: { paddingHorizontal: 14, paddingBottom: 12, marginBottom: 0 },
  tzNote: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm },
  // Attachments card — the event form's styles, verbatim.
  attAddRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  attAddIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  attAddLabel: { flex: 1, fontSize: 16, color: colors.text },
  attRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md, paddingRight: spacing.xs },
  attMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  attName: { flex: 1, fontSize: 16, color: colors.text },
  attRemove: { padding: spacing.sm },
});
