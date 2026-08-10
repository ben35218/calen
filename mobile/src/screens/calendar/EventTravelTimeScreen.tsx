import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Linking } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { Screen, SwitchRow, useHeaderCheckButton } from '../../components/ui';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { resolveHomeAddress } from '../../lib/homeAddress';
import { setTravelDraft } from '../../lib/travelDraft';
import { TRAVEL_MODES } from '../../lib/travelModes';
import type { TravelMode } from '../../api';
import { resolveCurrentAddress } from '../../lib/currentLocation';
import { form } from '../../components/formStyles';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Rt = RouteProp<CalendarStackParamList, 'EventTravelTime'>;
type Nav = NativeStackNavigationProp<Record<string, object | undefined>>;

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
  const navigation = useNavigation<Nav>();
  const params = useRoute<Rt>().params;
  const [enabled, setEnabled] = useState(params.enabled);
  const [fromAddress, setFromAddress] = useState(params.fromAddress);
  const [mode, setMode] = useState<TravelMode>(params.mode);
  const [manualMinutes, setManualMinutes] = useState<number | null>(params.manualMinutes);
  const [locating, setLocating] = useState(false);

  // Home address backs the "Home" shortcut (the form also seeds the origin with
  // it on first load). It's E2EE-sealed, so decrypt it client-side rather than
  // reading the raw settings column (which holds ciphertext for E2EE households).
  const homeQ = useQuery({ queryKey: ['homeAddress'], queryFn: resolveHomeAddress });
  const homeAddress = (homeQ.data || '').trim();

  const sync = (next: Partial<{ enabled: boolean; fromAddress: string; mode: TravelMode; manualMinutes: number | null }>) => {
    if (next.enabled !== undefined) setEnabled(next.enabled);
    if (next.fromAddress !== undefined) setFromAddress(next.fromAddress);
    if (next.mode !== undefined) setMode(next.mode);
    if (next.manualMinutes !== undefined) setManualMinutes(next.manualMinutes);
    setTravelDraft({ enabled, fromAddress, mode, manualMinutes, ...next });
  };

  // Edits sync back to the event form live through the travelDraft store, so the
  // checkmark is just "done" — go back and let the form apply the draft.
  useHeaderCheckButton(navigation, { onPress: () => navigation.goBack() });

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
          {manualMinutes == null ? (
            // Apple Maps-style mode row: bare glyphs, with the active mode sat
            // in a tinted capsule. The glyph alone names the mode visually, so
            // every button carries an explicit accessibility label.
            <View style={styles.modeRow}>
              {TRAVEL_MODES.map((m) => {
                const active = m.value === mode;
                return (
                  <TouchableOpacity
                    key={m.value}
                    style={[styles.modeBtn, active && styles.modeBtnActive]}
                    onPress={() => sync({ mode: m.value })}
                    activeOpacity={0.7}
                    hitSlop={{ top: 6, bottom: 6 }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Travel by ${m.label.toLowerCase()}`}
                  >
                    <MaterialCommunityIcons name={m.icon as any} size={20} color={active ? colors.primary : colors.text} />
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
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
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  modeBtn: {
    minWidth: 52,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeBtnActive: { backgroundColor: colors.primary + '22' },
  quickRow: { flexDirection: 'row', gap: spacing.lg, marginTop: -spacing.xs, marginBottom: spacing.md },
  quick: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  quickLabel: { fontSize: 13, color: colors.primary, fontWeight: '600' },
});
