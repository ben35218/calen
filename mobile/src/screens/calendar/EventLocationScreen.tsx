import React, { useEffect, useRef, useState } from 'react';
import { View, Image, StyleSheet, Alert, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { calendarApi, placesApi, PlacePrediction } from '../../api';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';
import { openRecord, sealUpdate } from '../../lib/e2ee';
import { setLocationDraft } from '../../lib/locationDraft';
import { useCalendarColors, useCustomCalendars } from '../../lib/calendarPrefs';
import { Screen, Input, SectionTitle, Hint, PhoneField, useHeaderCheckButton, CenteredLoader } from '../../components/ui';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<Record<string, object | undefined>>;
type Rt = RouteProp<{ EventLocation: { eventId?: string; initial?: { location?: string; phone?: string; placeId?: string }; promptPhone?: boolean } }, 'EventLocation'>;

// The content payload the event API accepts — the subset re-sealed on save.
// Must stay the full content set (mirrors EventFormScreen's payload): sealing
// only the edited fields would replace the E2EE blob and wipe the rest.
const CONTENT_KEYS = [
  'title', 'calendarType', 'allDay', 'startDate', 'endDate', 'description',
  'location', 'placeId', 'url', 'phone', 'travelMinutes', 'travelDistanceKm',
  'reminderMinutes', 'alert2Minutes', 'alertAudience', 'guestListVisible', 'recurrence',
] as const;

// Google Places details, shaped by the server proxy (routes/places.js).
interface PlaceDetails {
  name?: string;
  formatted_address?: string;
  formatted_phone_number?: string;
  international_phone_number?: string;
}

// The event's Location view (Apple Calendar-style): search a place, preview and
// edit its details — name, address, and the business phone Calen dials for
// Call to Cancel. Two modes:
//  - draft (from the event form): the checkmark hands the values back via
//    locationDraft, and the form saves them with the event.
//  - event (eventId param; e.g. Call to Cancel needing a phone number): the
//    checkmark saves straight onto the event.
export default function EventLocationScreen() {
  const navigation = useNavigation<Nav>();
  const { eventId, initial, promptPhone } = useRoute<Rt>().params ?? {};
  const qc = useQueryClient();
  const { colors: calColors } = useCalendarColors();
  const { calendars: customCalendars } = useCustomCalendars();

  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState(initial?.location ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [placeId, setPlaceId] = useState<string | undefined>(initial?.placeId);
  // Draft mode is ready immediately; event mode waits for the decrypt below
  // before the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!eventId);

  // Event mode: load + decrypt the event, seed the fields once.
  const eventQ = useQuery({
    queryKey: ['calendar', 'event', eventId],
    queryFn: async () => (await calendarApi.getEvent(eventId!)).data,
    enabled: !!eventId,
  });
  const [event, setEvent] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!eventQ.data) return;
    let cancelled = false;
    (async () => {
      const e = (await openRecord('CalendarEvent', eventQ.data)) as unknown as Record<string, unknown>;
      if (cancelled) return;
      setEvent(e);
      setAddress((prev) => prev || String(e.location ?? ''));
      setPhone((prev) => prev || String(e.phone ?? ''));
      setPlaceId((prev) => prev ?? (e.placeId ? String(e.placeId) : undefined));
      setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [eventQ.data]);

  // A picked place prefills the details from Google where available.
  const onPick = async (p: PlacePrediction) => {
    setPlaceId(p.place_id);
    setName(p.main_text ?? '');
    setAddress(p.secondary_text ?? p.description);
    try {
      const details = (await placesApi.getDetails(p.place_id)).data?.result as PlaceDetails | undefined;
      if (!details) return;
      if (details.name) setName(details.name);
      if (details.formatted_address) setAddress(details.formatted_address);
      const ph = details.international_phone_number || details.formatted_phone_number;
      if (ph) setPhone(ph);
    } catch {
      /* details are best-effort — fields stay editable either way */
    }
  };

  // The single string stored on the event: "Name, address" like the
  // autocomplete's description, or whichever part exists.
  const locationString = () => {
    const n = name.trim();
    const a = address.trim();
    if (n && a && !a.toLowerCase().startsWith(n.toLowerCase())) return `${n}, ${a}`;
    return a || n;
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      for (const k of CONTENT_KEYS) if (event && event[k] !== undefined) payload[k] = event[k];
      payload.location = locationString() || undefined;
      payload.placeId = placeId || undefined;
      payload.phone = phone.trim() || undefined;
      return calendarApi.updateEvent(eventId!, await sealUpdate('CalendarEvent', eventId!, payload));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      navigation.goBack();
    },
    onError: (e: any) =>
      Alert.alert('Couldn’t save', e?.response?.data?.error || 'Please try again.'),
  });

  const commit = () => {
    if (eventId) {
      if (!event) return; // still decrypting — the check button shows loading
      save.mutate();
    } else {
      setLocationDraft({ location: locationString(), phone: phone.trim(), placeId });
      allowLeave();
      navigation.goBack();
    }
  };

  useHeaderCheckButton(navigation, {
    onPress: commit,
    loading: save.isPending || (!!eventId && !event),
  });

  // Discard guard: prompt before leaving with unsaved edits to the place details
  // (name / address / phone / picked place). Baseline is taken once seeded.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ name, address, phone, placeId });
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  if (eventId && eventQ.isLoading) return <CenteredLoader />;

  const previewAddress = address.trim();
  const token = getCachedToken();

  // The callout is tinted with the event's own calendar colour (the calendar
  // whose Reschedule/Cancel card sent the user here), not the app primary —
  // falling back to primary until the event decrypts / for a non-event draft.
  const calType = String((event?.calendarType as string | undefined) ?? 'activities');
  const accent = calColors[calType] || customCalendars.find((c) => c.id === calType)?.color || colors.primary;

  return (
    <Screen>
      {/* Sent here from the event view's Reschedule/Cancel card with no number
          yet: a prominent accent callout (not a muted hint) so the reason the
          user is here — and the action to take — is the first thing they see. */}
      {promptPhone && !phone.trim() ? (
        <View style={[styles.callout, { backgroundColor: accent + '1A', borderColor: accent + '55' }]}>
          <View style={[styles.calloutIcon, { backgroundColor: accent }]}>
            <Ionicons name="call" size={16} color="#fff" />
          </View>
          <Text style={styles.calloutText}>Add a business phone number to activate calling.</Text>
        </View>
      ) : null}

      <PlacesAutocomplete
        value={search}
        onChangeText={setSearch}
        onSelect={onPick}
        placeholder="Search for a business or address"
      />

      <SectionTitle>Details</SectionTitle>
      <Input label="Name" value={name} onChangeText={setName} placeholder="Business or place name" />
      <Input label="Address" value={address} onChangeText={setAddress} placeholder="Street address" />
      <PhoneField
        label="Phone"
        value={phone}
        onChangeText={setPhone}
        placeholder="Business phone number"
        // Draw attention to the empty field when we sent the user here to add one.
        highlight={promptPhone && !phone.trim()}
      />
      <Hint>Calen uses the phone number to call the business — for example to cancel this appointment for you.</Hint>

      {previewAddress ? (
        <View style={styles.mapCard}>
          <Image
            source={{ uri: `${API_URL}/places/staticmap?token=${token}&q=${encodeURIComponent(previewAddress)}&w=640&h=320` }}
            style={styles.mapImage}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Accent callout (mirrors the app's tinted-banner convention, e.g. CreditsBanner):
  // a calendar-colour-tinted fill + border, a filled icon disc, and bold text —
  // deliberately louder than a muted Hint so the CTA doesn't blend into the page.
  // The tint colours are applied inline from the event's calendar accent.
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  calloutIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calloutText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text, lineHeight: 19 },
  mapCard: {
    height: 160, borderRadius: radius.lg, overflow: 'hidden',
    marginTop: spacing.lg, backgroundColor: colors.surface,
  },
  mapImage: { width: '100%', height: '100%' },
});
