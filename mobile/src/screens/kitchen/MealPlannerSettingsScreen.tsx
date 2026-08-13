import React, { useEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../../api';
import { Button, Card, Input, Skeleton } from '../../components/ui';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, spacing } from '../../theme';

import { DEFAULT_SECTIONS } from '../../lib/groceryOrganize';

// Mirrors client/src/views/MealPlannerSettingsView.vue.
export default function MealPlannerSettingsScreen() {
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await settingsApi.get()).data,
  });

  const [sections, setSections] = useState<string[]>([...DEFAULT_SECTIONS]);
  const [newSection, setNewSection] = useState('');
  const [sectionSaving, setSectionSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const gs = (settings.grocerySections as string[] | undefined) ?? [];
    setSections(gs.length ? gs : [...DEFAULT_SECTIONS]);
  }, [settings]);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const s = [...sections];
    [s[i], s[j]] = [s[j], s[i]];
    setSections(s);
  }
  function addSection() {
    const name = newSection.trim();
    if (!name || sections.includes(name)) return;
    setSections((s) => [...s, name]);
    setNewSection('');
  }
  function removeSection(i: number) {
    setSections((s) => s.filter((_, idx) => idx !== i));
  }
  async function saveOrder() {
    setSectionSaving(true);
    try {
      await settingsApi.update({ grocerySections: sections });
      qc.invalidateQueries({ queryKey: ['settings'] });
    } finally {
      setSectionSaving(false);
    }
  }

  if (isLoading) {
    // The card's shape while settings load: title/subtitle, then the numbered
    // section rows the saved order will fill.
    return (
      <View style={[styles.container, styles.content]}>
        <Card style={styles.card}>
          <Skeleton width={'52%'} height={15} />
          <Skeleton width={'86%'} height={13} style={styles.skelSubtitle} />
          {(['40%', '32%', '46%', '36%', '42%', '30%'] as const).map((w, i) => (
            <View key={i} style={styles.sectionRow}>
              <Skeleton width={18} height={12} />
              <Skeleton width={w} height={15} />
            </View>
          ))}
        </Card>
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        <Text style={styles.title}>Grocery Section Order</Text>
        <Text style={styles.subtitle}>
          Set your preferred shopping order. The assistant uses these sections when organizing your list.
        </Text>
        {sections.map((section, i) => (
          <View key={section} style={styles.sectionRow}>
            <Text style={styles.num}>{i + 1}</Text>
            <Text style={styles.sectionName}>{section}</Text>
            <TouchableOpacity disabled={i === 0} onPress={() => move(i, -1)}>
              <Ionicons name="chevron-up" size={20} color={i === 0 ? colors.border : colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity disabled={i === sections.length - 1} onPress={() => move(i, 1)}>
              <Ionicons name="chevron-down" size={20} color={i === sections.length - 1 ? colors.border : colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => removeSection(i)}>
              <Ionicons name="close" size={20} color={colors.error} />
            </TouchableOpacity>
          </View>
        ))}
        <View style={styles.addRow}>
          <View style={styles.addInput}>
            <Input value={newSection} onChangeText={setNewSection} placeholder="Add section…" onSubmitEditing={addSection} returnKeyType="done" />
          </View>
          <TouchableOpacity style={[styles.addBtn, { backgroundColor: accent }]} onPress={addSection}>
            <Ionicons name="add" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.formActions}>
          <Button title="Reset to defaults" variant="ghost" onPress={() => setSections([...DEFAULT_SECTIONS])} />
          <Button title="Save Order" onPress={saveOrder} loading={sectionSaving} />
        </View>
      </Card>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  card: { marginBottom: spacing.md },
  // Matches the real subtitle's top/bottom margins so the rows land in place.
  skelSubtitle: { marginTop: 6, marginBottom: spacing.sm },
  title: { fontSize: 15, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm, lineHeight: 18 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 8 },
  num: { width: 18, textAlign: 'right', color: colors.textMuted, fontSize: 12 },
  sectionName: { flex: 1, fontSize: 15, color: colors.text },
  addRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.sm },
  addInput: { flex: 1 },
  addBtn: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
});
