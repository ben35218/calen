import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { setWeatherSource } from '../../lib/weatherSource';
import { Screen } from '../../components/ui';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { spacing } from '../../theme';

// The Weather screen's "Another location" search — a pushed full screen, like
// the event form's Location screen, NOT a field inside the picker sheet. That
// is the load-bearing decision: a bottom sheet rides on top of the keyboard, so
// anything under a field in one renders behind the keys. Here the field hangs
// from the header — the keyboard can never reach it — and the matches own the
// rest of the screen, ending where the keyboard begins (the KAV inset), so the
// input and its suggestions are both visible for as long as the user types.
//
// Selecting a suggestion IS the confirmation: it persists the source and pops
// straight back to Weather (which re-reads the source on focus). Free text is
// never accepted, so an unrecognized place can't be saved; backing out changes
// nothing.
export default function WeatherLocationSearchScreen() {
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const [draft, setDraft] = useState('');
  return (
    <Screen scroll={false}>
      {/* Keeps the END of the results list above the keyboard — the field is
          already safe at the top. Offset by the header, which eats into the
          window height the KAV measures against. */}
      <KeyboardAvoidingView
        style={styles.pane}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        <PlacesAutocomplete
          type="city"
          expand
          autoFocus
          value={draft}
          onChangeText={setDraft}
          onSelect={(p) => {
            void setWeatherSource({ kind: 'custom', place: p.description });
            navigation.goBack();
          }}
          placeholder="Search for a city or place…"
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1, padding: spacing.md },
});
