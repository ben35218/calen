import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Text, TouchableOpacity, StyleSheet, Alert, Linking } from 'react-native';
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
import { Screen, Input, SectionTitle, Hint, PhoneField, useHeaderCheckButton, CenteredLoader, SetupCallout } from '../../components/ui';
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
  'reminderMinutes', 'alert2Minutes', 'alertAnchor', 'alert2Anchor',
  'alertAudience', 'guestListVisible', 'recurrence',
  'householdInvitees',
] as const;

// Google Places details, shaped by the server proxy (routes/places.js).
interface PlaceDetails {
  name?: string;
  formatted_address?: string;
  formatted_phone_number?: string;
  international_phone_number?: string;
}

// Strip a leading business name from an address so the resolved place card never
// shows the same name on both lines. Google's autocomplete `description` (and
// sometimes `formatted_address`) prefixes an establishment's address with its
// name — "St. Martha's Brasserie, 2571 St Joseph Blvd…" — which read as a bug
// when dumped verbatim into a field labeled "Address".
function addressWithoutName(addr: string, nm: string): string {
  const a = addr.trim();
  const n = nm.trim();
  if (n && a.toLowerCase().startsWith(n.toLowerCase())) {
    return a.slice(n.length).replace(/^[\s,]+/, '');
  }
  return a;
}

// The event's Location view (Apple Calendar-style). One input model at a time:
//  - EMPTY: a single search field (Google Places) with a quiet "Enter an address
//    manually" escape hatch below it.
//  - PICKED: a picked place collapses into a read-only place card — map, name,
//    and address on separate lines (name stripped from the address) — with an ✕
//    to change/clear it. The business phone stays a first-class editable field
//    below the card (it's what Calen dials for Call to Cancel, and is often the
//    thing being added).
//  - MANUAL: the Name / Address fields for a place Google can't find, reached via
//    the escape hatch, with a "Search for a place instead" link back.
// Two save modes:
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
  // A location already on the event but with no place_id (typed by hand, or a
  // legacy record) opens straight into the manual fields so its value is visible
  // and editable rather than hidden behind an empty search box.
  const [manual, setManual] = useState<boolean>(!!(initial?.location && !initial?.placeId));
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
      const loc = String(e.location ?? '');
      const pid = e.placeId ? String(e.placeId) : undefined;
      setAddress((prev) => prev || loc);
      setPhone((prev) => prev || String(e.phone ?? ''));
      setPlaceId((prev) => prev ?? pid);
      // Same rule as the initial seed: a saved location with no place_id opens
      // in the editable manual fields.
      if (loc && !pid && !initial?.placeId) setManual(true);
      setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [eventQ.data]);

  // A picked place prefills the details from Google where available and collapses
  // the search into the resolved place card.
  const onPick = async (p: PlacePrediction) => {
    setManual(false);
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

  // Clear the picked place / manual entry and return to the empty search state.
  const clearPlace = () => {
    setPlaceId(undefined);
    setName('');
    setAddress('');
    setPhone('');
    setSearch('');
    setManual(false);
  };

  // The single string stored on the event: "Name, address" like the
  // autocomplete's description, or whichever part exists.
  const locationString = () => {
    const n = name.trim();
    const a = address.trim();
    if (n && a && !a.toLowerCase().startsWith(n.toLowerCase())) return `${n}, ${a}`;
    return a || n;
  };

  // Tapping the map preview opens the place in Maps, the same as tapping the
  // location map on the event view. The query is the string the event stores,
  // so both entry points land on the same place.
  const openInMaps = () => {
    const q = locationString().trim();
    if (!q) return;
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`);
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
  const mapUri = previewAddress
    ? `${API_URL}/places/staticmap?token=${token}&q=${encodeURIComponent(previewAddress)}&w=640&h=320`
    : null;

  // The callout is tinted with the event's own calendar colour (the calendar
  // whose Reschedule/Cancel card sent the user here), not the app primary —
  // falling back to primary until the event decrypts / for a non-event draft.
  const calType = String((event?.calendarType as string | undefined) ?? 'activities');
  const accent = calColors[calType] || customCalendars.find((c) => c.id === calType)?.color || colors.primary;

  const picked = !!placeId;
  // Card lines: name titles the place; address sits below with the name stripped
  // so it never repeats. With no name (a bare address) the address is the title.
  const cardAddress = addressWithoutName(address, name);
  const cardTitle = name.trim() || cardAddress || previewAddress;
  const cardSubtitle = name.trim() ? cardAddress : '';

  return (
    <Screen>
      {/* Sent here from the event view's Reschedule/Cancel card — or a Calen
          "Add business phone" setup chip — with no number yet: a prominent accent
          callout so the reason the user is here is the first thing they see. */}
      {promptPhone && !phone.trim() ? (
        <SetupCallout icon="call" accent={accent}>Add a business phone number to activate calling.</SetupCallout>
      ) : null}

      {picked ? (
        /* PICKED — the resolved place collapses into a read-only card. */
        <View style={styles.placeCard}>
          {mapUri ? (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={openInMaps}
              accessibilityRole="button"
              accessibilityLabel="Open in Maps"
            >
              <Image source={{ uri: mapUri }} style={styles.placeMap} />
            </TouchableOpacity>
          ) : null}
          <View style={styles.placeBody}>
            <View style={{ flex: 1 }}>
              <Text style={styles.placeName} numberOfLines={2}>{cardTitle}</Text>
              {cardSubtitle ? <Text style={styles.placeAddr} numberOfLines={2}>{cardSubtitle}</Text> : null}
            </View>
            <TouchableOpacity
              onPress={clearPlace}
              style={styles.changeBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Change location"
            >
              <Ionicons name="close" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>
      ) : manual ? (
        /* MANUAL — enter a place Google can't find. */
        <>
          <TouchableOpacity onPress={() => setManual(false)} accessibilityRole="button">
            <Text style={[styles.link, { color: accent }]}>Search for a place instead</Text>
          </TouchableOpacity>
          <SectionTitle>Location details</SectionTitle>
          <Input label="Name" value={name} onChangeText={setName} placeholder="Business or place name" />
          <Input label="Address" value={address} onChangeText={setAddress} placeholder="Street address" />
          {mapUri ? (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={openInMaps}
              style={styles.mapCard}
              accessibilityRole="button"
              accessibilityLabel="Open in Maps"
            >
              <Image source={{ uri: mapUri }} style={styles.mapImage} />
            </TouchableOpacity>
          ) : null}
        </>
      ) : (
        /* EMPTY — search is the primary path; manual is the escape hatch. */
        <>
          <PlacesAutocomplete
            value={search}
            onChangeText={setSearch}
            onSelect={onPick}
            placeholder="Search for a business or address"
          />
          <TouchableOpacity onPress={() => setManual(true)} accessibilityRole="button">
            <Text style={[styles.link, { color: accent }]}>Enter an address manually</Text>
          </TouchableOpacity>
        </>
      )}

      {/* The business phone is always editable — it's the field Calen dials for
          Call to Cancel, and often the reason the user is on this screen. */}
      <PhoneField
        label="Phone"
        value={phone}
        onChangeText={setPhone}
        placeholder="Business phone number"
        containerStyle={styles.phone}
        // Draw attention to the empty field when we sent the user here to add one.
        highlight={promptPhone && !phone.trim()}
      />
      <Hint>Calen uses the phone number to call the business — for example to cancel this appointment for you.</Hint>
    </Screen>
  );
}

const styles = StyleSheet.create({
  link: { fontSize: 14, fontWeight: '600', paddingVertical: spacing.sm },
  placeCard: {
    borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  placeMap: { width: '100%', height: 140 },
  placeBody: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md },
  placeName: { fontSize: 16, fontWeight: '600', color: colors.text },
  placeAddr: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  changeBtn: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background,
  },
  phone: { marginTop: spacing.lg },
  mapCard: {
    height: 160, borderRadius: radius.lg, overflow: 'hidden',
    marginTop: spacing.lg, backgroundColor: colors.surface,
  },
  mapImage: { width: '100%', height: '100%' },
});
