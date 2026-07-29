import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, RouteProp } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen, SwitchRow } from '../../components/ui';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { resolveHomeAddress } from '../../lib/homeAddress';
import { setTravelDraft } from '../../lib/travelDraft';
import { resolveCurrentAddress } from '../../lib/currentLocation';
import { form } from '../../components/formStyles';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Rt = RouteProp<CalendarStackParamList, 'EventTravelTime'>;

const MANUAL_OPTIONS = [
  { label: '5 minutes', value: 5 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '1 hour, 30 minutes', value: 90 },
  { label: '2 hours', value: 120 },
];

// Pushed from the event form's Travel Time row. Edits sync back to the form
// live through the travelDraft store; going back is the only "save".
export default function EventTravelTimeScreen() {
  const params = useRoute<Rt>().params;
  const [enabled, setEnabled] = useState(params.enabled);
  const [fromAddress, setFromAddress] = useState(params.fromAddress);
  const [manualMinutes, setManualMinutes] = useState<number | null>(params.manualMinutes);
  const [locating, setLocating] = useState(false);

  // Home address backs the "Home" shortcut (the form also seeds the origin with
  // it on first load). It's E2EE-sealed, so decrypt it client-side rather than
  // reading the raw settings column (which holds ciphertext for E2EE households).
  const homeQ = useQuery({ queryKey: ['homeAddress'], queryFn: resolveHomeAddress });
  const homeAddress = (homeQ.data || '').trim();

  const sync = (next: Partial<{ enabled: boolean; fromAddress: string; manualMinutes: number | null }>) => {
    if (next.enabled !== undefined) setEnabled(next.enabled);
    if (next.fromAddress !== undefined) setFromAddress(next.fromAddress);
    if (next.manualMinutes !== undefined) setManualMinutes(next.manualMinutes);
    setTravelDraft({ enabled, fromAddress, manualMinutes, ...next });
  };

  // One-shot device GPS → reverse-geocoded address, dropped straight into the
  // origin. Same opt-in path as the Account home-address field.
  async function useCurrentLocation() {
    setLocating(true);
    try {
      const res = await resolveCurrentAddress();
      if (res.ok) { sync({ fromAddress: res.address }); return; }
      if (res.reason === 'unavailable') {
        Alert.alert('App update needed', 'This build doesn’t include location support yet. Rebuild/reinstall the app to use this — or just type an address.');
      } else if (res.reason === 'denied') {
        Alert.alert(
          'Location is off',
          'Allow location access in Settings to use your current location — or just type an address above.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        Alert.alert('Could not find your location', 'Please type an address instead.');
      }
    } finally {
      setLocating(false);
    }
  }

  return (
    <Screen>
      <View style={form.groupCard}>
        <View style={form.groupPad}>
          <SwitchRow label="Travel Time" value={enabled} onValueChange={(v) => sync({ enabled: v })} />
        </View>
      </View>

      {enabled ? (
        <>
          <PlacesAutocomplete
            label="Starting location"
            value={fromAddress}
            onChangeText={(v) => sync({ fromAddress: v })}
            type="address"
            placeholder="Starting address"
          />
          {manualMinutes == null ? (
            <View style={styles.quickRow}>
              <TouchableOpacity style={styles.quick} onPress={useCurrentLocation} disabled={locating} activeOpacity={0.7}>
                {locating
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="locate" size={16} color={colors.primary} />}
                <Text style={styles.quickLabel}>Current location</Text>
              </TouchableOpacity>
              {homeAddress && homeAddress !== fromAddress.trim() ? (
                <TouchableOpacity style={styles.quick} onPress={() => sync({ fromAddress: homeAddress })} activeOpacity={0.7}>
                  <Ionicons name="home-outline" size={16} color={colors.primary} />
                  <Text style={styles.quickLabel}>Home</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
          <Text style={styles.hint}>
            {manualMinutes == null
              ? 'Travel time is calculated from the starting location to the event location.'
              : 'A manual travel time is set; the starting location is not used.'}
          </Text>

          <View style={form.groupCard}>
            <TouchableOpacity style={form.dtRow} activeOpacity={0.7} onPress={() => sync({ manualMinutes: null })}>
              <Text style={form.dtLabel}>Based on starting location</Text>
              {manualMinutes == null ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
            </TouchableOpacity>
            {MANUAL_OPTIONS.map((o) => (
              <React.Fragment key={o.value}>
                <View style={form.cardDivider} />
                <TouchableOpacity style={form.dtRow} activeOpacity={0.7} onPress={() => sync({ manualMinutes: o.value })}>
                  <Text style={form.dtLabel}>{o.label}</Text>
                  {manualMinutes === o.value ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: colors.textMuted, marginTop: -spacing.sm, marginBottom: spacing.md },
  quickRow: { flexDirection: 'row', gap: spacing.lg, marginTop: -spacing.xs, marginBottom: spacing.md },
  quick: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  quickLabel: { fontSize: 13, color: colors.primary, fontWeight: '600' },
});
