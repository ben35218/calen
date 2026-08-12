import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Linking, Share } from 'react-native';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tripsApi, placesApi, TripItemType, TripItemAttachment, FormAssistField } from '../../api';
import { sealNew, sealUpdate, openRecord, getHDK, newObjectId, loadResourceKeys, currentResourceKeyVersion, sealForResource } from '../../lib/e2ee';
import { encryptFileForUpload, encryptFileForUploadResource, decryptDownloadedFile } from '../../lib/attachments';
import { pickDocument } from '../../lib/media';
import { uploadFile } from '../../lib/upload';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';

// Encrypted trip-item content (cost/sharing/confirmation/dates stay plaintext).
const TRIP_ITEM_ENC = (p: Record<string, unknown>) => ({
  title: p.title, location: p.location, url: p.url, phone: p.phone, notes: p.notes, details: p.details,
});
import { Button, Input, Screen, SwitchRow, SectionTitle, DateField, TimeField, Select, PhoneField, useHeaderCheckButton, CenteredLoader, FormError } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import FormAssist from '../../components/FormAssist';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { TRIP_TYPES, tripTypeMeta } from '../../lib/tripTypes';
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

const SHARING_OPTIONS = [
  { value: 'private', label: 'Just my family' },
  { value: 'shared_separate', label: 'Shared — separate bookings' },
  { value: 'shared_one_separate', label: 'Shared — one booking, separate bills' },
  { value: 'shared_shared', label: 'Shared — one booking, one shared bill' },
];
const PRIVATE_BILL = ['shared_separate', 'shared_one_separate'];

const DURATION_OPTIONS = [
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '45 minutes', value: 45 },
  { label: '1 hour', value: 60 },
  { label: '1.5 hours', value: 90 },
  { label: '2 hours', value: 120 },
  { label: '2.5 hours', value: 150 },
  { label: '3 hours', value: 180 },
  { label: '4 hours', value: 240 },
  { label: '6 hours', value: 360 },
  { label: '8 hours', value: 480 },
];

// Schema the AI form assistant fills. Names match the form-state keys; the model
// picks the relevant subset based on the booking type in the request.
const ASSIST_FIELDS: FormAssistField[] = [
  { name: 'type', type: 'select', label: 'Booking type', options: TRIP_TYPES.map((t) => ({ label: t.label, value: t.value })) },
  { name: 'title', type: 'text', label: 'Title' },
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
  { name: 'airline', type: 'text', label: 'Airline' },
  { name: 'flightNumber', type: 'text', label: 'Flight number' },
  { name: 'seat', type: 'text', label: 'Seat' },
  { name: 'mode', type: 'text', label: 'Transit mode (train / bus / ferry)' },
  { name: 'cost', type: 'number', label: 'Cost' },
  { name: 'currency', type: 'select', label: 'Currency', options: CURRENCIES.map((c) => ({ label: c, value: c })) },
  { name: 'confirmation', type: 'text', label: 'Confirmation number' },
  { name: 'confirmed', type: 'boolean', label: 'Booked / confirmed' },
  { name: 'url', type: 'text', label: 'URL' },
  { name: 'phone', type: 'text', label: 'Phone' },
  { name: 'notes', type: 'text', label: 'Notes' },
];

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function timeDiffMinutes(start: string, end: string): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff > 0 ? diff : null;
}

type ShareRow = { householdId: string; name: string; included: boolean; amount: number | null };

// Faithful port of client/src/views/TripItemFormView.vue: standard + journey
// (dual-timezone) bookings and the multi-family cost-sharing modes. (Place
// autocomplete + timezone auto-fill are wired in the cross-cutting Places wave;
// here the leg timezone is chosen explicitly.)
export default function TripItemFormScreen() {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.trips;
  const { tripId, itemId, date } = useRoute<Rt>().params;
  const isEdit = !!itemId;
  const qc = useQueryClient();

  const today = date || new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    type: 'activity' as TripItemType,
    title: '',
    startDate: today, startTime: '09:00', endDate: '', endTime: '',
    // journey
    depName: '', departureTz: '', depDate: today, depTime: '09:00',
    arrName: '', arrivalTz: '', arrDate: today, arrTime: '12:00',
    airline: '', flightNumber: '', seat: '', mode: '',
    // common
    location: '', cost: '', currency: '', confirmation: '', confirmed: false,
    url: '', phone: '', notes: '',
    sharing: 'private', paidByHouseholdId: '',
  });
  const [shareRows, setShareRows] = useState<ShareRow[]>([]);
  const [error, setError] = useState('');
  const [endMode, setEndMode] = useState<'time' | 'duration'>('time');
  // A new booking is ready immediately; an edit waits for the item (and the
  // families list its share rows build from) to load and hydrate below before
  // the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!isEdit);
  const assist = useFormAssist();

  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  // Editing an end (date/time) to at/before the start drags the start back so the
  // booking keeps its length (see lib/datetime). `sk`/`ek` name the start/end
  // field prefixes so this serves both the standard Starts/Ends pair and the
  // journey Departs/Arrives pair.
  const setEnd = (
    sk: { date: 'startDate' | 'depDate'; time: 'startTime' | 'depTime' },
    ek: { date: 'endDate' | 'arrDate'; time: 'endTime' | 'arrTime' },
    part: 'date' | 'time',
    v: string
  ) => {
    const patch: Partial<typeof form> = { [ek[part]]: v } as Partial<typeof form>;
    const startDate = (form as any)[sk.date] as string;
    if (startDate) {
      const startTime = ((form as any)[sk.time] as string) || '00:00';
      const endDate = ((form as any)[ek.date] as string) || startDate;
      const endTime = ((form as any)[ek.time] as string) || '00:00';
      const newEnd = {
        date: part === 'date' ? v : endDate,
        time: part === 'time' ? v : endTime,
      };
      const shifted = startKeepingDuration({ date: startDate, time: startTime }, { date: endDate, time: endTime }, newEnd);
      if (shifted) {
        (patch as any)[sk.date] = shifted.date;
        if ((form as any)[sk.time]) (patch as any)[sk.time] = shifted.time;
        if (part === 'date') (patch as any)[ek.date] = v;
      }
    }
    set(patch);
  };

  // Editing a start (date/time) carries the end with it, in either direction,
  // so the booking keeps its length — changing the length is the end field's
  // job (setEnd). Only runs when an end is set; a **time** edit additionally
  // needs a previous start time (a first-set isn't a move) and an end time to
  // keep in step — otherwise the midnight fallback would drag a date-only end
  // across days. Serves both the Starts/Ends and the journey Departs/Arrives
  // pair.
  const setStart = (
    sk: { date: 'startDate' | 'depDate'; time: 'startTime' | 'depTime' },
    ek: { date: 'endDate' | 'arrDate'; time: 'endTime' | 'arrTime' },
    part: 'date' | 'time',
    v: string
  ) => {
    const patch: Partial<typeof form> = { [sk[part]]: v } as Partial<typeof form>;
    const startDate = (form as any)[sk.date] as string;
    const endDate = (form as any)[ek.date] as string;
    const timeShiftOk =
      part === 'date' || Boolean((form as any)[sk.time] && (form as any)[ek.time]);
    if (startDate && endDate && timeShiftOk) {
      const startTime = ((form as any)[sk.time] as string) || '00:00';
      const endTime = ((form as any)[ek.time] as string) || '00:00';
      const newStart = {
        date: part === 'date' ? v : startDate,
        time: part === 'time' ? v : startTime,
      };
      const shifted = endKeepingDuration({ date: startDate, time: startTime }, { date: endDate, time: endTime }, newStart);
      if (shifted) {
        (patch as any)[ek.date] = shifted.date;
        if ((form as any)[ek.time]) (patch as any)[ek.time] = shifted.time;
      }
    }
    set(patch);
  };

  const applyPatch = (patch: Record<string, unknown>) => {
    const next: Partial<typeof form> = {};
    const changedKeys: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in form)) continue;
      const val = k === 'cost' ? (v == null ? '' : String(v)) : v == null ? '' : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    setForm((f) => ({ ...f, ...next }));
    assist.mark(changedKeys);
  };

  const isJourney = form.type === 'flight' || form.type === 'transit';

  const tripQ = useQuery({ queryKey: ['trips', tripId], queryFn: async () => (await tripsApi.get(tripId)).data });
  const familiesQ = useQuery({ queryKey: ['trips', tripId, 'families'], queryFn: async () => (await tripsApi.families(tripId)).data });
  const tz = tripQ.data?.destinationTz || '';
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
        url: it.url ?? '', phone: it.phone ?? '', notes: it.notes ?? '',
        sharing: it.sharing || 'private', paidByHouseholdId: it.paidByHouseholdId ?? '',
        confirmed: it.sharing === 'shared_separate' ? !!it.myData?.confirmed : !!it.confirmed,
      }));
    } else {
      const sp = zonedParts(it.start, tz);
      const ep = it.end ? zonedParts(it.end, tz) : null;
      setForm((f) => ({
        ...f, type: it.type, title: it.title ?? '',
        startDate: sp.dateStr, startTime: sp.timeStr, endDate: ep?.dateStr ?? '', endTime: ep?.timeStr ?? '',
        location: it.location ?? '', airline: d.airline ?? '', flightNumber: d.flightNumber ?? '', seat: d.seat ?? '', mode: d.mode ?? '',
        cost: (it.myData?.cost ?? it.cost) != null ? String(it.myData?.cost ?? it.cost) : '', currency: it.currency ?? '',
        confirmation: it.confirmation ?? '', url: it.url ?? '', phone: it.phone ?? '', notes: it.notes ?? '',
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
        const start = zonedWallclockToUtc(form.startDate, form.startTime, tz);
        const end = form.endDate ? zonedWallclockToUtc(form.endDate, form.endTime || '00:00', tz) : undefined;
        payload = {
          type: form.type, title: form.title.trim(), start: start?.toISOString(), end: end ? end.toISOString() : undefined,
          location: form.location || undefined, ...common,
        };
      }
      // Signal-parity D2: a shared trip's items seal under the TripKey (when this
      // device holds it), else the HDK dual-write (the owner's reconcile migrates
      // them later). `tripShared` is derived below from the loaded trip.
      const sealItem = async (id: string, includeId: boolean) => {
        if (tripShared && getHDK()) {
          await loadResourceKeys('trip', tripId).catch(() => {});
          if (currentResourceKeyVersion(tripId) > 0) {
            const sealed = await sealForResource('trip', 'TripItem', id, tripId, TRIP_ITEM_ENC(payload));
            if (sealed) return includeId ? { _id: id, ...payload, ...sealed } : { ...payload, ...sealed };
          }
        }
        return includeId
          ? await sealNew('TripItem', payload, TRIP_ITEM_ENC(payload))
          : await sealUpdate('TripItem', id, payload, TRIP_ITEM_ENC(payload));
      };
      if (isEdit) return tripsApi.updateItem(tripId, itemId!, await sealItem(itemId!, false));
      return tripsApi.addItem(tripId, await sealItem(await newObjectId(), true));
    },
    onSuccess: () => {
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
  const attachmentsUrl = `/trips/${tripId}/items/${itemId}/attachments`;

  const addAttachment = useMutation({
    mutationFn: async () => {
      const file = await pickDocument();
      if (!file) return null;
      // Encrypt the bytes on-device and upload ciphertext + the wrapped file key,
      // wrapping the per-file key by whichever key the readers hold:
      //   • shared_shared booking (one receipt every participant sees) → the
      //     TripKey (§D2), so cross-household collaborators can open it;
      //   • any other booking (private / per-family) → the HDK, since only the
      //     owning family may download it.
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
          return uploadFile(attachmentsUrl, { uri: sealed.uri, name: `${attId}.bin`, type: 'application/octet-stream' }, 'file', {
            encrypted: true,
            _id: attId,
            wrappedFileKey: sealed.wrappedFileKey,
            keyVersion: sealed.keyVersion,
            fileType: file.type || 'application/pdf',
            title: file.name,
          });
        }
      }
      return uploadFile(attachmentsUrl, file, 'file');
    },
    onSuccess: (r) => { if (r) qc.invalidateQueries({ queryKey: ['trips', tripId] }); },
    onError: (e: any) => Alert.alert('Upload failed', e.response?.data?.error || 'Could not upload that file.'),
  });

  // Open: encrypted attachments download as ciphertext, decrypt on-device to a
  // temp file, and share/open; plaintext ones open via the tokened URL.
  const openAttachment = useMutation({
    mutationFn: async (att: TripItemAttachment) => {
      const url = `${API_URL}${attachmentsUrl}/${att._id}/download`;
      if (!att.encrypted) { await Linking.openURL(`${url}?token=${getCachedToken()}`); return; }
      if (!getHDK() || !att.wrappedFileKey) throw new Error('Unlock your account to open this encrypted attachment.');
      const dl = await downloadAsync(url, `${cacheDirectory}dl-att-${att._id}.bin`, {
        headers: { Authorization: `Bearer ${getCachedToken()}` },
      });
      const name = att.filename && att.filename.includes('.')
        ? att.filename
        : `attachment${(att.fileType || '').includes('pdf') ? '.pdf' : ''}`;
      // A TripKey-wrapped file key (shared_shared receipt, §D2) unwraps with the
      // Trip's resource key; an HDK-wrapped one ignores the resource arg.
      const plainUri = await decryptDownloadedFile('TripItemAttachment', att._id, att.keyVersion, att.wrappedFileKey, dl.uri, name, tripId);
      if (!plainUri) throw new Error('Could not decrypt this attachment.');
      await Share.share({ url: plainUri });
    },
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

  useHeaderCheckButton(navigation, { onPress: onSave, loading: save.isPending, color: accent });

  // Discard guard: prompt before leaving with unsaved edits to the booking
  // fields or its cost-share rows. Baseline is taken once the form has seeded.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ form, shareRows });
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  if (isEdit && tripQ.isLoading) {
    return <CenteredLoader color={accent} />;
  }

  const costLabel = PRIVATE_BILL.includes(form.sharing) && multiFamily ? 'Your cost' : 'Cost';

  return (
    <Screen>
      <FormAssist
        accent={accent}
        formType="trip booking"
        placeholder={'Describe the booking, e.g. "flight AC123 to Paris June 5 at 6pm, seat 14C, $650 confirmed"'}
        fields={ASSIST_FIELDS}
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
            <PlacesAutocomplete
              value={form.location}
              onChangeText={(v) => set({ location: v })}
              placeholder="Location"
              containerStyle={fs.headField}
              inputStyle={[fs.headInput, assist.changed.has('location') && fs.headInputHighlight]}
            />
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
                  onChange={(v) => setStart({ date: 'depDate', time: 'depTime' }, { date: 'arrDate', time: 'arrTime' }, 'date', v)}
                  highlight={assist.changed.has('depDate')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
                <TimeField
                  value={form.depTime}
                  onChange={(v) => setStart({ date: 'depDate', time: 'depTime' }, { date: 'arrDate', time: 'arrTime' }, 'time', v)}
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
                  onChange={(v) => setEnd({ date: 'depDate', time: 'depTime' }, { date: 'arrDate', time: 'arrTime' }, 'date', v)}
                  highlight={assist.changed.has('arrDate')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
                <TimeField
                  value={form.arrTime}
                  onChange={(v) => setEnd({ date: 'depDate', time: 'depTime' }, { date: 'arrDate', time: 'arrTime' }, 'time', v)}
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

          {form.type === 'flight' ? (
            <GroupCard>
              <View style={fs.dtRow}>
                <Text style={fs.dtLabel}>Airline</Text>
                <Input
                  value={form.airline}
                  onChangeText={(v) => set({ airline: v })}
                  clearable={false}
                  containerStyle={[fs.headField, fs.rowInputWrap]}
                  style={[fs.headInput, fs.rowInput, assist.changed.has('airline') && fs.headInputHighlight]}
                />
              </View>
              <CardDivider />
              <View style={fs.dtRow}>
                <Text style={fs.dtLabel}>Flight #</Text>
                <Input
                  value={form.flightNumber}
                  onChangeText={(v) => set({ flightNumber: v })}
                  clearable={false}
                  containerStyle={[fs.headField, fs.rowInputWrap]}
                  style={[fs.headInput, fs.rowInput, assist.changed.has('flightNumber') && fs.headInputHighlight]}
                />
              </View>
              <CardDivider />
              <View style={fs.dtRow}>
                <Text style={fs.dtLabel}>Seat</Text>
                <Input
                  value={form.seat}
                  onChangeText={(v) => set({ seat: v })}
                  clearable={false}
                  containerStyle={[fs.headField, fs.rowInputWrap]}
                  style={[fs.headInput, fs.rowInput, assist.changed.has('seat') && fs.headInputHighlight]}
                />
              </View>
            </GroupCard>
          ) : (
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
          )}
        </>
      ) : (
        <>
          <GroupCard>
            <View style={fs.dtRow}>
              <Text style={fs.dtLabel}>Starts</Text>
              <View style={fs.dtFields}>
                <DateField
                  value={form.startDate}
                  onChange={(v) => setStart({ date: 'startDate', time: 'startTime' }, { date: 'endDate', time: 'endTime' }, 'date', v)}
                  highlight={assist.changed.has('startDate')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
                <TimeField
                  clearable
                  value={form.startTime}
                  onChange={(v) => setStart({ date: 'startDate', time: 'startTime' }, { date: 'endDate', time: 'endTime' }, 'time', v)}
                  highlight={assist.changed.has('startTime')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.dtField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
              </View>
            </View>
            <CardDivider />
            {endMode === 'time' ? (
              <View style={fs.dtRow}>
                <Text style={fs.dtLabel}>Ends</Text>
                <View style={fs.dtFields}>
                  <DateField
                    clearable
                    placeholder="None"
                    value={form.endDate}
                    onChange={(v) => setEnd({ date: 'startDate', time: 'startTime' }, { date: 'endDate', time: 'endTime' }, 'date', v)}
                    defaultValue={form.startDate}
                    highlight={assist.changed.has('endDate')}
                    containerStyle={fs.dtFieldWrap}
                    fieldStyle={fs.dtField}
                    valueStyle={fs.dtValue}
                    hideIcon
                  />
                  <TimeField
                    clearable
                    value={form.endTime}
                    onChange={(v) => setEnd({ date: 'startDate', time: 'startTime' }, { date: 'endDate', time: 'endTime' }, 'time', v)}
                    defaultValue={addMinutesToTime(form.startTime || '09:00', 60)}
                    highlight={assist.changed.has('endTime')}
                    containerStyle={fs.dtFieldWrap}
                    fieldStyle={fs.dtField}
                    valueStyle={fs.dtValue}
                    hideIcon
                  />
                </View>
              </View>
            ) : (
              <Select<number>
                inlineLabel="Duration"
                placeholder="None"
                value={timeDiffMinutes(form.startTime, form.endTime) ?? undefined}
                options={DURATION_OPTIONS}
                clearable
                onChange={(v) => {
                  if (v == null) { set({ endDate: '', endTime: '' }); return; }
                  set({ endDate: form.startDate, endTime: addMinutesToTime(form.startTime || '09:00', v) });
                }}
                containerStyle={fs.dtFieldWrap}
                fieldStyle={fs.rowField}
                valueStyle={fs.dtValue}
                chevronIcon="chevron-expand"
              />
            )}
          </GroupCard>
          <View style={styles.endModeToggle}>
            <TouchableOpacity
              style={[styles.endModeBtn, endMode === 'time' && styles.endModeBtnActive]}
              onPress={() => setEndMode('time')}
            >
              <Text style={[styles.endModeBtnText, endMode === 'time' && styles.endModeBtnTextActive]}>End time</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.endModeBtn, endMode === 'duration' && styles.endModeBtnActive]}
              onPress={() => setEndMode('duration')}
            >
              <Text style={[styles.endModeBtnText, endMode === 'duration' && styles.endModeBtnTextActive]}>Duration</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      <GroupCard>
        {multiFamily ? (
          <>
            <Select
              inlineLabel="Sharing"
              value={form.sharing}
              options={SHARING_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              onChange={(v) => toggleSharing((v as string) || 'private')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
            <CardDivider />
          </>
        ) : null}
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Confirmation #</Text>
          <Input
            value={form.confirmation}
            onChangeText={(v) => set({ confirmation: v })}
            clearable={false}
            containerStyle={[fs.headField, fs.rowInputWrap]}
            style={[fs.headInput, fs.rowInput, assist.changed.has('confirmation') && fs.headInputHighlight]}
          />
        </View>
        <CardDivider />
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>{costLabel}</Text>
          <Input
            keyboardType="decimal-pad"
            value={form.cost}
            onChangeText={(v) => set({ cost: v })}
            clearable={false}
            containerStyle={[fs.headField, fs.rowInputWrap]}
            style={[fs.headInput, fs.rowInput, assist.changed.has('cost') && fs.headInputHighlight]}
          />
        </View>
        <CardDivider />
        <Select
          inlineLabel="Currency"
          placeholder="None"
          value={form.currency}
          options={CURRENCIES.map((c) => ({ label: c, value: c }))}
          onChange={(v) => set({ currency: (v as string) || '' })}
          clearable
          highlight={assist.changed.has('currency')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
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

      <GroupCard>
        <View style={fs.groupPad}>
          <SwitchRow label={form.confirmed ? 'Booked' : 'Not booked yet'} value={form.confirmed} onValueChange={(v) => set({ confirmed: v })} highlight={assist.changed.has('confirmed')} />
        </View>
        <CardDivider />
        <Input
          value={form.url}
          onChangeText={(v) => set({ url: v })}
          placeholder="URL (optional)"
          autoCapitalize="none"
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('url') && fs.headInputHighlight]}
        />
        <CardDivider />
        <PhoneField
          value={form.phone}
          onChangeText={(v) => set({ phone: v })}
          placeholder="Phone (optional)"
          highlight={assist.changed.has('phone')}
          containerStyle={fs.headField}
          fieldStyle={fs.headInput}
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
        <>
          <SectionTitle>Attachments</SectionTitle>
          <GroupCard>
            {attachments.map((att, i) => (
              <React.Fragment key={att._id}>
                {i > 0 ? <CardDivider /> : null}
                <View style={styles.attachRow}>
                  <TouchableOpacity
                    style={styles.attachMain}
                    onPress={() => openAttachment.mutate(att)}
                    disabled={openAttachment.isPending}
                  >
                    <Ionicons
                      name={(att.fileType || '').startsWith('image/') ? 'image-outline' : 'document-outline'}
                      size={18}
                      color={accent}
                    />
                    <Text style={styles.attachName} numberOfLines={1}>{att.filename || 'Attachment'}</Text>
                    {att.encrypted ? <Ionicons name="lock-closed" size={13} color={colors.textMuted} /> : null}
                  </TouchableOpacity>
                  <TouchableOpacity
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPress={() =>
                      Alert.alert('Remove attachment?', '', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => deleteAttachment.mutate(att._id) },
                      ])
                    }
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </React.Fragment>
            ))}
            {attachments.length > 0 ? <CardDivider /> : null}
            <TouchableOpacity
              style={fs.dtRow}
              activeOpacity={0.7}
              disabled={addAttachment.isPending}
              onPress={() => addAttachment.mutate()}
            >
              <Text style={[styles.attachAdd, { color: accent }]}>
                {addAttachment.isPending ? 'Uploading…' : 'Attach confirmation (PDF or image)'}
              </Text>
            </TouchableOpacity>
          </GroupCard>
        </>
      ) : null}

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
  tzNote: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: 14, minHeight: 46 },
  attachMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  attachName: { flex: 1, fontSize: 14, color: colors.text },
  attachAdd: { fontSize: 16, fontWeight: '500' },
  endModeToggle: { flexDirection: 'row', backgroundColor: '#2A2A2A', borderRadius: 8, padding: 2, marginBottom: spacing.md, marginTop: -spacing.sm },
  endModeBtn: { flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: 6 },
  endModeBtnActive: { backgroundColor: colors.primary },
  endModeBtnText: { fontSize: 13, color: colors.textMuted },
  endModeBtnTextActive: { color: '#fff', fontWeight: '600' as const },
});
