import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, Button, Input } from './ui';
import { GroupCard, CardDivider } from './formStyles';
import { colors, spacing, radius } from '../theme';
import type { LabeledValue } from '../lib/personFields';

// The Apple-Contacts-style label picker: a bottom sheet of preset labels plus an
// "Add Custom Label" path. Only the presets are listed — a custom (non-preset)
// current label is NOT added to the list; it lives solely on the row where it was
// created (the label chip), so the picker vocabulary stays fixed.
function LabelPicker({
  visible,
  value,
  presets,
  onSelect,
  onClose,
}: {
  visible: boolean;
  value: string;
  presets: string[];
  onSelect: (label: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'list' | 'custom'>('list');
  const [custom, setCustom] = useState('');

  const close = () => {
    setMode('list');
    setCustom('');
    onClose();
  };
  const choose = (label: string) => {
    onSelect(label);
    close();
  };

  return (
    // Only the custom-label input needs keyboard avoidance; wrapping the list
    // mode in a KeyboardAvoidingView imposes a flex height that stops the option
    // ScrollView self-sizing, clipping its last row ("Add Custom Label…").
    <BottomSheet visible={visible} onClose={close} title="Label" avoidKeyboard={mode === 'custom'}>
      {mode === 'list' ? (
        // Longer preset lists (related names) outgrow small screens, so the
        // options scroll within a capped height instead of overflowing the sheet.
        <ScrollView style={styles.optionList}>
          {presets.map((label) => {
            const selected = label.toLowerCase() === value.toLowerCase();
            return (
              <TouchableOpacity key={label} style={styles.optionRow} onPress={() => choose(label)}>
                <Text style={styles.optionText}>{label}</Text>
                {selected ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={styles.optionRow} onPress={() => setMode('custom')}>
            <Text style={[styles.optionText, styles.addCustom]}>Add Custom Label…</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <View>
          <Input
            value={custom}
            onChangeText={setCustom}
            placeholder="Custom label"
            autoFocus
            // Engage the keyboard's shift per word so the label reads Title Case
            // as it's typed; it's lowercased on save (labels are stored lowercase,
            // Title Case is display-only) and re-capitalized by the label chip.
            autoCapitalize="words"
            onSubmitEditing={() => custom.trim() && choose(custom.trim().toLowerCase())}
          />
          <Button title="Add Label" onPress={() => choose(custom.trim().toLowerCase())} disabled={!custom.trim()} />
        </View>
      )}
    </BottomSheet>
  );
}

// A tappable label pill (label text + chevron) that opens the LabelPicker. Styled
// like an inline form label so it sits flush in a grouped card row. Exported so
// callers can reuse the same picker outside a MultiValueField row (e.g. the
// person form's reciprocal-label control for a linked custom relationship).
export function LabelChip({
  value,
  presets,
  onChange,
}: {
  value: string;
  presets: string[];
  onChange: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity style={styles.labelChip} onPress={() => setOpen(true)} activeOpacity={0.6}>
        <Text style={styles.labelText} numberOfLines={1}>
          {value}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </TouchableOpacity>
      <LabelPicker
        visible={open}
        value={value}
        presets={presets}
        onSelect={onChange}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// A repeatable labeled-value editor (phones, emails, dates, URLs, related names…)
// modeled on Apple Contacts: each entry is a red-minus remove control + a
// tappable label + a caller-supplied value editor, followed by a green-plus "add"
// row. The value editor is a render prop so each field type supplies its own
// control (PhoneField, DateField, PlacesAutocomplete, plain Input). Generic over
// T so entries carrying extra keys (e.g. a related name's personId) round-trip.
export function MultiValueField<T extends LabeledValue>({
  entries,
  onChange,
  presets,
  defaultLabel,
  addLabel,
  stacked,
  renderEditor,
  renderTrailing,
  renderBelow,
  newEntry,
}: {
  entries: T[];
  onChange: (next: T[]) => void;
  presets: string[];
  // Label a freshly-added entry starts with.
  defaultLabel: string;
  // The "+ add …" row caption.
  addLabel: string;
  // Put the value editor on its own full-width line below the label row (used for
  // addresses, whose autocomplete field needs the width).
  stacked?: boolean;
  renderEditor: (entry: T, patch: (p: Partial<T>) => void, index: number) => React.ReactNode;
  // Optional extra control on the label row (e.g. the related-name link button).
  renderTrailing?: (entry: T, patch: (p: Partial<T>) => void, index: number) => React.ReactNode;
  // Optional full-width line rendered below a row (e.g. the related-name
  // reciprocal-label control for a linked custom relationship). Return null to
  // render nothing for a given entry.
  renderBelow?: (entry: T, patch: (p: Partial<T>) => void, index: number) => React.ReactNode;
  // Build a blank entry; defaults to { label: defaultLabel, value: '' }.
  newEntry?: () => T;
}) {
  const patchAt = (i: number, p: Partial<T>) =>
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  const removeAt = (i: number) => onChange(entries.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([...entries, newEntry ? newEntry() : ({ label: defaultLabel, value: '' } as T)]);

  return (
    <GroupCard>
      {entries.map((entry, i) => {
        const patch = (p: Partial<T>) => patchAt(i, p);
        const labelRow = (
          <View style={styles.labelRow}>
            <TouchableOpacity
              onPress={() => removeAt(i)}
              hitSlop={8}
              accessibilityLabel="Remove"
              style={styles.removeBtn}
            >
              <Ionicons name="remove-circle" size={22} color={colors.error} />
            </TouchableOpacity>
            <LabelChip value={entry.label} presets={presets} onChange={(label) => patch({ label } as Partial<T>)} />
            {stacked && renderTrailing ? renderTrailing(entry, patch, i) : null}
          </View>
        );
        return (
          <View key={i}>
            {i > 0 ? <CardDivider /> : null}
            {stacked ? (
              <View style={styles.stacked}>
                {labelRow}
                <View style={styles.stackedEditor}>{renderEditor(entry, patch, i)}</View>
              </View>
            ) : (
              <View style={styles.inlineRow}>
                {labelRow}
                <View style={styles.divider} />
                <View style={styles.inlineEditor}>{renderEditor(entry, patch, i)}</View>
                {renderTrailing ? renderTrailing(entry, patch, i) : null}
              </View>
            )}
            {renderBelow ? renderBelow(entry, patch, i) : null}
          </View>
        );
      })}
      {entries.length ? <CardDivider /> : null}
      <TouchableOpacity style={styles.addRow} onPress={add} activeOpacity={0.6}>
        <Ionicons name="add-circle" size={22} color={colors.success} />
        <Text style={styles.addText}>{addLabel}</Text>
      </TouchableOpacity>
    </GroupCard>
  );
}

const styles = StyleSheet.create({
  inlineRow: { flexDirection: 'row', alignItems: 'center', minHeight: 46, paddingRight: 12 },
  labelRow: { flexDirection: 'row', alignItems: 'center' },
  removeBtn: { paddingLeft: 12, paddingRight: 8, paddingVertical: 12 },
  labelChip: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 64, maxWidth: 110 },
  // Labels are stored lowercase; capitalize for display only (Title Case).
  labelText: { fontSize: 15, color: colors.primary, flexShrink: 1, textTransform: 'capitalize' },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: colors.border, marginHorizontal: 10, marginVertical: 8 },
  inlineEditor: { flex: 1 },
  stacked: { paddingBottom: 6 },
  stackedEditor: { paddingHorizontal: 14, paddingBottom: 4 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: 12, paddingRight: 14, paddingVertical: 12 },
  addText: { fontSize: 16, color: colors.text },
  optionList: { maxHeight: 400 },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  // Labels are stored lowercase; display Title Case to match the label chip on the
  // row. ("Add Custom Label…" is already cased, so `capitalize` leaves it as-is.)
  optionText: { fontSize: 16, color: colors.text, flex: 1, textTransform: 'capitalize' },
  addCustom: { color: colors.primary, fontWeight: '600' },
});
