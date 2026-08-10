import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { choresApi, ChoreTemplate } from '../../api';
import { createChoreFromTemplate } from '../../lib/taskTemplates';
import { Input, Badge, SectionHeader, CenteredLoader } from '../../components/ui';
import { recurrenceLabelShort, mdiName } from '../../lib/recurrence';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, radius, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'ChoreTemplates'>;

export default function ChoreTemplatesScreen() {
  const navigation = useNavigation<Nav>();
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.chores;
  const [search, setSearch] = useState('');

  const templatesQ = useQuery({
    queryKey: ['chore-templates'],
    queryFn: async () => (await choresApi.templates()).data,
  });
  const choresQ = useQuery({ queryKey: ['chores', 'list'], queryFn: async () => (await choresApi.list()).data });

  // Templates are reusable — a household may add the same one more than once.
  // We still track which are already in use to show a non-blocking "In Use" hint.
  const usedIds = useMemo(
    () => new Set((choresQ.data ?? []).map((c: any) => c.templateId).filter(Boolean) as string[]),
    [choresQ.data]
  );

  // Instantiation is client-side now (Signal-parity D4): the template's chore
  // is built + sealed on-device and created through the ordinary POST /chores.
  const create = useMutation({
    mutationFn: async (templateId: string) => {
      const tpl = templatesQ.data?.find((t) => t.id === templateId);
      if (!tpl) throw new Error('Template not found');
      return createChoreFromTemplate(tpl);
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['chores'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      if (created?._id) navigation.replace('ChoreDetail', { id: created._id });
      else navigation.goBack();
    },
  });

  const grouped = useMemo(() => {
    let list = templatesQ.data ?? [];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) => t.title.toLowerCase().includes(q) || t.defaultCategoryName?.toLowerCase().includes(q)
      );
    }
    const g: Record<string, ChoreTemplate[]> = {};
    for (const t of list) {
      const cat = t.defaultCategoryName || 'General';
      (g[cat] ||= []).push(t);
    }
    return g;
  }, [templatesQ.data, search]);

  if (templatesQ.isLoading) {
    return <CenteredLoader color={accent} />;
  }

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={templatesQ.isRefetching} onRefresh={templatesQ.refetch} />}
    >
      <Input placeholder="Search templates…" value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} />

      {Object.entries(grouped).map(([cat, items]) => (
        <View key={cat} style={styles.group}>
          <SectionHeader>
            {cat} <Text style={styles.groupCount}>{items.length}</Text>
          </SectionHeader>
          {items.map((tpl) => {
            const used = usedIds.has(tpl.id);
            const busy = create.isPending && create.variables === tpl.id;
            return (
              <TouchableOpacity
                key={tpl.id}
                style={styles.card}
                disabled={create.isPending}
                onPress={() => create.mutate(tpl.id)}
                activeOpacity={0.7}
              >
                <View style={[styles.avatar, { backgroundColor: accent }]}>
                  <MaterialCommunityIcons name={mdiName(tpl.icon) as any} size={20} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{tpl.title}</Text>
                  <Text style={styles.cardSub}>{recurrenceLabelShort(tpl.recurrence)}</Text>
                  {used ? (
                    <View style={styles.chipRow}>
                      <Badge label="In Use" color={colors.success} />
                    </View>
                  ) : null}
                </View>
                {busy ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  group: { marginBottom: spacing.lg },
  groupCount: { color: colors.textMuted, fontWeight: '600' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  cardSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm },
});
