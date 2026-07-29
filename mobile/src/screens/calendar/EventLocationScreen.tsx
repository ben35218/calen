import React, { useEffect, useState } from 'react';
import { View, Image, StyleSheet, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { calendarApi, placesApi, PlacePrediction } from '../../api';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';
import { openRecord, sealUpdate } from '../../lib/e2ee';
import { setLocationDraft } from '../../lib/locationDraft';
import { Screen, Input, SectionTitle, Hint, PhoneField, useHeaderCheckButton, CenteredLoader } from '../../components/ui';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<Record<string, object | undefined>>;
type Rt = RouteProp<{ EventLocation: { eventId?: string; initial?: { location?: string; phone?: string; placeId?: string } } }, 'EventLocation'>;

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
  const { eventId, initial } = useRoute<Rt>().params ?? {};
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState(initial?.location ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [placeId, setPlaceId] = useState<string | undefined>(initial?.placeId);

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
      navigation.goBack();
    }
  };

  useHeaderCheckButton(navigation, {
    onPress: commit,
    loading: save.isPending || (!!eventId && !event),
  });

  if (eventId && eventQ.isLoading) return <CenteredLoader />;

  const previewAddress = address.trim();
  const token = getCachedToken();

  return (
    <Screen>
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
  mapCard: {
    height: 160, borderRadius: radius.lg, overflow: 'hidden',
    marginTop: spacing.lg, backgroundColor: colors.surface,
  },
  mapImage: { width: '100%', height: '100%' },
});
