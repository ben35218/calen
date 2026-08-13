import React from 'react';
import { View, StyleSheet, TouchableOpacity, ViewStyle, StyleProp } from 'react-native';
import { Text } from './Text';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius } from '../theme';

// The iOS-grouped-list form look, extracted from EventFormScreen so every
// add/edit form shares one source of truth. Field components (Input, Select,
// DateField, TimeField) consume these via their style props (containerStyle /
// fieldStyle / valueStyle), so the raw styles are the API here; GroupCard,
// CardDivider and FormRow below are just the recurring row shapes.
export const form = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  // iOS-style grouped card: a rounded inset box of hairline-divided rows.
  groupCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, marginBottom: spacing.md, overflow: 'hidden',
  },
  cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 14 },
  groupPad: { paddingHorizontal: 14 },
  headField: { marginBottom: 0 },
  // Borderless input row (Title/Location-style): placeholder text only, the
  // card supplies the chrome. AI-changed highlight is the tint-only style
  // below — NOT Input's `highlight` prop, which adds a border the card look
  // doesn't want.
  headInput: { backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0 },
  headInputHighlight: { backgroundColor: colors.primary + '22' },
  // Label-left / value-right rows (date/time card style)
  dtRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, minHeight: 46 },
  dtLabel: { flex: 1, fontSize: 16, color: colors.text, marginRight: spacing.sm },
  dtFields: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dtFieldWrap: { marginBottom: 0 },
  dtField: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, paddingVertical: 7 },
  // Full-width card rows (Calendar/Repeat/Alert…): the field IS the row —
  // label inside via inlineLabel — so a tap anywhere on it opens the picker.
  rowField: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 14, paddingVertical: 7, minHeight: 46 },
  // flex: 0 so the pill sizes to its text (the default flex: 1 collapses in a
  // content-sized field).
  dtValue: { flex: 0 },
  groupValue: { fontSize: 16, color: colors.text, flexShrink: 1 },
  groupValueMuted: { color: colors.textMuted },
  // Editable value on the right of a label row (Servings, Est. Cost, Airline…).
  // minWidth keeps an empty field tappable.
  rowInput: {
    backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0,
    flex: 1, textAlign: 'right', minWidth: 80, paddingHorizontal: 0,
  },
  rowInputWrap: { flex: 1, marginBottom: 0 },
  error: { color: colors.error, marginVertical: spacing.sm },
  notes: { height: 90, textAlignVertical: 'top' },
  footer: { marginTop: spacing.md, marginBottom: spacing.xl },
  rowChevron: { marginLeft: 6 },
});

export function GroupCard({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return <View style={[form.groupCard, style]}>{children}</View>;
}

export function CardDivider() {
  return <View style={form.cardDivider} />;
}

// Label-left / value-right row; tappable when onPress is given (Travel Time /
// Invitees pattern). `right` replaces the value text with arbitrary content.
export function FormRow({
  label,
  value,
  muted,
  onPress,
  chevron,
  right,
  highlight,
}: {
  label: string;
  value?: string;
  muted?: boolean;
  onPress?: () => void;
  chevron?: 'forward' | 'expand';
  right?: React.ReactNode;
  highlight?: boolean;
}) {
  const inner = (
    <>
      <Text style={form.dtLabel}>{label}</Text>
      {right ??
        (value != null ? (
          <Text style={[form.groupValue, muted && form.groupValueMuted]} numberOfLines={1}>
            {value}
          </Text>
        ) : null)}
      {chevron ? (
        <Ionicons
          name={chevron === 'expand' ? 'chevron-expand' : 'chevron-forward'}
          size={18}
          color={colors.textMuted}
          style={form.rowChevron}
        />
      ) : null}
    </>
  );
  const rowStyle = [form.dtRow, highlight && form.headInputHighlight];
  if (onPress) {
    return (
      <TouchableOpacity style={rowStyle} activeOpacity={0.7} onPress={onPress}>
        {inner}
      </TouchableOpacity>
    );
  }
  return <View style={rowStyle}>{inner}</View>;
}
