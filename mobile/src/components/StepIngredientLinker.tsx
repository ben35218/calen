import React, { useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from './Text';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Input } from './ui';
import { colors, spacing } from '../theme';

export interface LidIngredient {
  _lid: string;
  name: string;
  amount?: string;
  unit?: string;
}

// Faithful port of client/src/components/StepIngredientLinker.vue: three zones —
// linked chips, an "unassigned" worklist (ingredients mentioned in the step text
// float to the top), and a searchable browse-all list.
export default function StepIngredientLinker({
  value,
  ingredients,
  assignmentsById,
  stepNumber,
  stepText,
  onChange,
  accent = colors.primary,
}: {
  value: string[];
  ingredients: LidIngredient[];
  assignmentsById: Record<string, number[]>;
  stepNumber: number;
  stepText: string;
  onChange: (lids: string[]) => void;
  // Section/calendar accent colour for the add-chip outline + plus icon.
  accent?: string;
}) {
  const [showBrowse, setShowBrowse] = useState(false);
  const [query, setQuery] = useState('');

  const byId = useMemo(() => Object.fromEntries(ingredients.map((i) => [i._lid, i])), [ingredients]);
  const linked = value.map((lid) => byId[lid]).filter(Boolean) as LidIngredient[];
  const unassigned = ingredients.filter((i) => (assignmentsById[i._lid]?.length ?? 0) === 0);

  const rootWords = (name: string) =>
    String(name).toLowerCase().replace(/\(.*?\)/g, '').split(/\s+/).filter((w) => w.length > 2);
  const isMentioned = (ing: LidIngredient) => {
    const t = stepText.toLowerCase();
    return rootWords(ing.name).some((w) => t.includes(w));
  };
  const unassignedSorted = [...unassigned].sort((a, b) => Number(isMentioned(b)) - Number(isMentioned(a)));

  const browseList = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q ? ingredients.filter((i) => i.name.toLowerCase().includes(q)) : ingredients;
  }, [query, ingredients]);

  const isLinked = (lid: string) => value.includes(lid);
  const amountLabel = (ing: LidIngredient) => [ing.amount, ing.unit].filter(Boolean).join(' ');
  const link = (lid: string) => !value.includes(lid) && onChange([...value, lid]);
  const unlink = (lid: string) => onChange(value.filter((x) => x !== lid));
  const toggle = (lid: string) => (isLinked(lid) ? unlink(lid) : link(lid));

  const statusOf = (ing: LidIngredient) => {
    const steps = assignmentsById[ing._lid] || [];
    if (isLinked(ing._lid)) {
      const others = steps.filter((s) => s !== stepNumber);
      return others.length ? `also step ${others.join(', ')}` : 'in this step';
    }
    return steps.length ? `step ${steps.join(', ')}` : 'unassigned';
  };

  return (
    <View style={styles.sil}>
      <Text style={styles.label}>In this step</Text>
      <View style={styles.chips}>
        {linked.length ? (
          linked.map((ing) => (
            <TouchableOpacity key={ing._lid} style={styles.linkedChip} onPress={() => unlink(ing._lid)}>
              {amountLabel(ing) ? <Text style={styles.amount}>{amountLabel(ing)} </Text> : null}
              <Text style={styles.linkedText}>{ing.name}</Text>
              <Ionicons name="close" size={13} color={colors.primary} />
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.empty}>Nothing linked yet</Text>
        )}
      </View>

      <Text style={[styles.label, { marginTop: spacing.sm }]}>Unassigned</Text>
      <View style={styles.chips}>
        {unassigned.length ? (
          unassignedSorted.map((ing) => (
            <TouchableOpacity
              key={ing._lid}
              style={[styles.addChip, { borderColor: accent }]}
              onPress={() => link(ing._lid)}
            >
              <MaterialCommunityIcons name="plus" size={13} color={accent} />
              <Text style={styles.addText}>{ing.name}</Text>
            </TouchableOpacity>
          ))
        ) : (
          <View style={styles.doneRow}>
            <Ionicons name="checkmark-circle" size={15} color={colors.success} />
            <Text style={styles.doneText}>Every ingredient is used in a step</Text>
          </View>
        )}
      </View>

      <TouchableOpacity style={styles.browseBtn} onPress={() => setShowBrowse((s) => !s)}>
        <Ionicons name={showBrowse ? 'chevron-up' : 'search'} size={14} color={colors.textMuted} />
        <Text style={styles.browseBtnText}>Browse all ingredients</Text>
      </TouchableOpacity>
      {showBrowse ? (
        <View style={styles.browseCard}>
          <Input value={query} onChangeText={setQuery} placeholder="Search…" autoCapitalize="none" autoCorrect={false} />
          {browseList.map((ing) => (
            <TouchableOpacity key={ing._lid} style={styles.browseRow} onPress={() => toggle(ing._lid)}>
              <Ionicons
                name={isLinked(ing._lid) ? 'checkbox' : 'square-outline'}
                size={20}
                color={isLinked(ing._lid) ? colors.primary : colors.textMuted}
              />
              <Text style={[styles.browseName, isLinked(ing._lid) && { color: colors.primary }]}>
                {amountLabel(ing) ? `${amountLabel(ing)} ` : ''}{ing.name}
              </Text>
              <Text style={[styles.status, isLinked(ing._lid) && styles.statusActive]}>{statusOf(ing)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sil: { paddingLeft: 20, marginTop: spacing.sm },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', color: colors.textMuted, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', minHeight: 28 },
  linkedChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.primary + '1A', borderRadius: 14, paddingHorizontal: 8, paddingVertical: 3 },
  linkedText: { color: colors.primary, fontSize: 12, fontWeight: '600' },
  amount: { color: colors.primary, opacity: 0.6, fontSize: 11 },
  empty: { fontSize: 12, fontStyle: 'italic', color: colors.textMuted },
  addChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 8, paddingVertical: 3 },
  addText: { fontSize: 12, color: colors.text },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doneText: { fontSize: 12, color: colors.success },
  browseBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
  browseBtnText: { fontSize: 12, color: colors.textMuted },
  browseCard: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: spacing.sm, marginTop: 6 },
  browseRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  browseName: { flex: 1, fontSize: 13, color: colors.text },
  status: { fontSize: 11, color: colors.textMuted },
  statusActive: { color: colors.primary },
});
