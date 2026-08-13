import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Keyboard, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { Text } from './Text';
import { Ionicons } from '@expo/vector-icons';
import { placesApi, PlacePrediction } from '../api';
import { getPlaceBias } from '../lib/placeBias';
import { Input, useReveal } from './ui';
import { colors, spacing } from '../theme';

// Reusable Google-Places address autocomplete (debounced) used across every
// address field — replaces the web's <v-combobox> + placesApi.autocomplete.
// `onSelect` receives the chosen prediction so callers can look up a timezone
// (journey legs) or store the place_id.
//
// Two layouts, same search:
//   - the default **inline** one — a field in a form, results in a dropdown
//     hanging under it, sized to the results;
//   - `expand`, the **search-pane** one — the field pinned at the top of the
//     space it's given and the results filling the rest of it, scrolling. Use
//     it whenever the search owns the surface (a sheet, a search step), where a
//     hanging dropdown would grow straight into the keyboard.
export default function PlacesAutocomplete({
  label,
  value,
  onChangeText,
  onSelect,
  onBlur,
  placeholder,
  type,
  highlight,
  expand,
  autoFocus,
  inputStyle,
  containerStyle,
  style,
}: {
  label?: string;
  value: string;
  onChangeText: (text: string) => void;
  onSelect?: (p: PlacePrediction) => void;
  // Fires when the field loses focus, with the text it holds — the "the user is
  // done entering this address" signal for a hand-typed entry that never went
  // through `onSelect` (e.g. the Account screen deriving the home area from it).
  onBlur?: (text: string) => void;
  placeholder?: string;
  type?: string;
  highlight?: boolean;
  // Fill the available height: field on top, results scrolling below it.
  expand?: boolean;
  autoFocus?: boolean;
  inputStyle?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  // The outer wrap (an `expand` search pane is normally flex: 1 inside its own
  // container).
  style?: StyleProp<ViewStyle>;
}) {
  const [suggestions, setSuggestions] = useState<PlacePrediction[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSelected = useRef(false);
  // Only autocomplete once the user has actually typed. Guards against the
  // field being pre-filled from saved settings (e.g. the Account home address),
  // which would otherwise pop the dropdown open on load without any input.
  const userTyped = useRef(false);
  // Inline layout only: the dropdown renders below the input, which the
  // keyboard-aware scroll keeps just above the keyboard — scroll the pair clear
  // when it opens, and again while the field merely holds focus, since a
  // keyboard arriving later covers whatever was under it. (`expand` needs none
  // of this: its results live in their own scroll area above the keyboard.)
  const [focused, setFocused] = useState(false);
  const { ref: wrapRef, reveal } = useReveal();
  useEffect(() => {
    if (expand || !open || suggestions.length === 0) return;
    reveal();
  }, [expand, open, suggestions.length, reveal]);
  useEffect(() => {
    if (expand || !focused) return;
    reveal();
    // Focus fires before the keyboard finishes animating in, so the measurement
    // that matters is the one after it has actually taken its space.
    const sub = Keyboard.addListener('keyboardDidShow', reveal);
    return () => sub.remove();
  }, [expand, focused, reveal]);

  const query = value.trim();
  useEffect(() => {
    if (justSelected.current) { justSelected.current = false; return; }
    if (!userTyped.current) return;
    if (timer.current) clearTimeout(timer.current);
    if (query.length < 3) { setSuggestions([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const bias = await getPlaceBias();
        const { data } = await placesApi.autocomplete(query, type, bias);
        setSuggestions(data.predictions ?? []);
        setOpen(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, type]);

  function handleChange(text: string) {
    userTyped.current = true;
    onChangeText(text);
  }

  function pick(p: PlacePrediction) {
    justSelected.current = true;
    onChangeText(p.description);
    onSelect?.(p);
    setSuggestions([]);
    setOpen(false);
    // Picking a suggestion completes the entry: blur + close the keyboard so
    // the field shows the chosen address from its start instead of a cursor
    // parked at the end of a long string.
    Keyboard.dismiss();
  }

  const rows = suggestions.slice(0, expand ? suggestions.length : 6).map((p) => (
    <TouchableOpacity key={p.place_id} style={styles.row} onPress={() => pick(p)}>
      <Ionicons name="location-outline" size={16} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={styles.main} numberOfLines={1}>{p.main_text || p.description}</Text>
        {p.secondary_text ? <Text style={styles.sub} numberOfLines={1}>{p.secondary_text}</Text> : null}
      </View>
    </TouchableOpacity>
  ));

  const field = (
    <>
      <Input
        label={label}
        value={value}
        onChangeText={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); onBlur?.(value); }}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="search"
        highlight={highlight}
        style={inputStyle}
        containerStyle={containerStyle}
      />
      {loading ? (
        <ActivityIndicator
          size="small"
          color={colors.primary}
          style={[styles.spinner, !label && styles.spinnerNoLabel]}
        />
      ) : null}
    </>
  );

  // The search pane: the field never moves, and the results own the rest of the
  // height. Nothing can be pushed under the keyboard, because the pane's bottom
  // IS the top of the keyboard.
  if (expand) {
    return (
      <View style={[styles.expandWrap, style]}>
        {field}
        <ScrollView
          testID="places-results"
          style={styles.results}
          contentContainerStyle={styles.resultsContent}
          keyboardShouldPersistTaps="handled"
          // Scrolling the results is also how you get the keyboard out of the
          // way — the pane grows into the space it leaves.
          keyboardDismissMode="on-drag"
        >
          {rows.length > 0 ? rows : (
            <Text style={styles.hint}>
              {query.length < 3
                ? 'Type a city, town, or place to see matches.'
                : loading ? 'Searching…' : `No places found for “${query}”.`}
            </Text>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View ref={wrapRef} collapsable={false} style={[styles.wrap, style]}>
      {field}
      {open && rows.length > 0 ? <View style={styles.dropdown}>{rows}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  expandWrap: { position: 'relative', flex: 1 },
  // Left of the Input's clear ✕ (loading only happens mid-typing, when the
  // clear button is showing too). The default offset clears a label; without
  // one the field starts at the top of the wrap, so the spinner rides up with it.
  spinner: { position: 'absolute', right: 40, top: 34 },
  spinnerNoLabel: { top: 13 },
  dropdown: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface,
    marginTop: -spacing.sm, marginBottom: spacing.sm, overflow: 'hidden',
  },
  // No border/card in the pane: the results ARE the surface here, so a box
  // around them would just draw a line inside the sheet.
  results: { flex: 1, marginTop: -spacing.xs },
  resultsContent: { paddingBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  main: { fontSize: 14, color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted },
  hint: { fontSize: 13, color: colors.textMuted, paddingHorizontal: spacing.sm, paddingTop: spacing.xs },
});
