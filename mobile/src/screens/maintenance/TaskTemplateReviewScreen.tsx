import React, { useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tasksApi, itemsApi, propertiesApi, Item, LinkedRef, ProposedTask } from '../../api';
import { sealNew, openRecord } from '../../lib/e2ee';
import { TASK_ENC, ITEM_ENC } from '../../lib/encSubsets';
import { loadCategories } from '../../lib/categories';
import { createTaskFromTemplate } from '../../lib/taskTemplates';
import { SectionHeader, FormError, Skeleton } from '../../components/ui';
import { GroupCard, CardDivider } from '../../components/formStyles';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { TYPE_CATEGORY_MATCH } from '../../lib/itemTypes';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, radius, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'TaskTemplateReview'>;
type Rt = RouteProp<MaintenanceStackParamList, 'TaskTemplateReview'>;

// Category name → item type (inverse of TYPE_CATEGORY_MATCH); default 'other'.
const CATEGORY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_CATEGORY_MATCH).map(([type, cat]) => [cat, type])
);

const CREATE_NEW = '__new__';

function refId(ref?: LinkedRef | string | null): string | null {
  if (!ref) return null;
  return typeof ref === 'object' ? ref._id : ref;
}

export default function TaskTemplateReviewScreen() {
  const navigation = useNavigation<Nav>();
  const params = useRoute<Rt>().params;
  // Two sources: real templates (bulk template flow) or tasks Calen staged in the
  // AI plan chat. Both group by category and link items the same way; only how
  // the tasks get created at the end differs.
  const templateIds = 'templateIds' in params ? params.templateIds : [];
  const proposedTasks: ProposedTask[] = 'proposedTasks' in params ? params.proposedTasks : [];
  const isProposed = 'proposedTasks' in params;
  const accent = useCalendarColors().colors.maintenance;
  const qc = useQueryClient();
  const [error, setError] = useState('');
  // Per category name → chosen item id, or CREATE_NEW.
  const [choice, setChoice] = useState<Record<string, string>>({});

  const templatesQ = useQuery({ queryKey: ['task-templates'], queryFn: async () => (await tasksApi.templates()).data });
  // Decrypted: item and category names are sealed content post-drop.
  const itemsQ = useQuery({
    queryKey: ['items', 'list'],
    queryFn: async () => {
      const rows = (await itemsApi.list()).data;
      return Promise.all(rows.map((i) => openRecord('Item', i)));
    },
  });
  const categoriesQ = useQuery({ queryKey: ['categories', 'topLevel'], queryFn: () => loadCategories({ topLevel: 'true' }) });
  const propertiesQ = useQuery({ queryKey: ['properties'], queryFn: async () => (await propertiesApi.list()).data });

  // The selected templates / proposed tasks, grouped by their default category.
  // `templates` holds template-flow entries; `tasks` holds AI-proposed specs.
  type Group = { category: string; templates: { id: string; title: string }[]; tasks: ProposedTask[] };
  const groups = useMemo(() => {
    const byCat = new Map<string, Group>();
    const ensure = (cat: string) => {
      if (!byCat.has(cat)) byCat.set(cat, { category: cat, templates: [], tasks: [] });
      return byCat.get(cat)!;
    };
    if (isProposed) {
      for (const t of proposedTasks) ensure(t.defaultCategoryName || 'General').tasks.push(t);
    } else {
      for (const id of templateIds) {
        const tpl = templatesQ.data?.find((t) => t.id === id);
        if (!tpl) continue;
        ensure(tpl.defaultCategoryName || 'General').templates.push({ id: tpl.id, title: tpl.title });
      }
    }
    return [...byCat.values()];
  }, [templateIds, proposedTasks, isProposed, templatesQ.data]);

  const groupCount = (g: Group) => (isProposed ? g.tasks.length : g.templates.length);

  // Existing items per category name (matched via the category's _id).
  const itemsByCat = useMemo(() => {
    const catId = new Map<string, string>();
    for (const c of categoriesQ.data ?? []) catId.set(c.name, c._id);
    const map = new Map<string, Item[]>();
    for (const g of groups) {
      const cid = catId.get(g.category);
      const items = cid ? (itemsQ.data ?? []).filter((i) => refId(i.categoryId) === cid) : [];
      map.set(g.category, items);
    }
    return map;
  }, [groups, categoriesQ.data, itemsQ.data]);

  // Default each category to its first existing item, else "create new".
  const choiceFor = (cat: string) => choice[cat] ?? (itemsByCat.get(cat)?.[0]?._id ?? CREATE_NEW);

  const submit = useMutation({
    mutationFn: async () => {
      const catId = new Map<string, string>();
      for (const c of categoriesQ.data ?? []) catId.set(c.name, c._id);
      const primaryProperty = propertiesQ.data?.[0]?._id ?? null;

      // Resolve each category to an item id, creating a bare item where chosen.
      const itemForCat = new Map<string, string | undefined>();
      for (const g of groups) {
        const chosen = choiceFor(g.category);
        if (chosen !== CREATE_NEW) {
          itemForCat.set(g.category, chosen);
          continue;
        }
        const type = CATEGORY_TYPE[g.category] || 'other';
        const cid = catId.get(g.category);
        const payload: Record<string, unknown> = { name: g.category, type };
        if (cid) payload.categoryId = cid;
        // Vehicles stand alone; everything else lands on the primary property.
        if (type !== 'vehicle' && primaryProperty) {
          payload.propertyId = primaryProperty;
          payload.location = propertiesQ.data?.[0]?.name;
        }
        const { data } = await itemsApi.create(await sealNew('Item', payload, ITEM_ENC(payload)));
        itemForCat.set(g.category, (data as Item)._id);
      }

      // AI-proposed tasks aren't real templates — create each directly (sealed),
      // linked to the resolved item.
      if (isProposed) {
        for (const g of groups) {
          const itemId = itemForCat.get(g.category);
          const categoryId = catId.get(g.category);
          for (const t of g.tasks) {
            const payload: Record<string, unknown> = {
              itemId,
              title: t.title,
              recurrence: t.recurrence,
              nextDueDate: t.nextDueDate,
              priority: t.priority,
            };
            if (categoryId) payload.categoryId = categoryId;
            if (t.description) payload.description = t.description;
            if (t.templateId) payload.templateId = t.templateId;
            await tasksApi.create(await sealNew('MaintenanceTask', payload, TASK_ENC(payload)));
          }
        }
        return;
      }

      // Template flow: instantiate each selection client-side (Signal-parity
      // D4 — anchorRecurrence + seedDueDate run on-device, sealed create).
      for (const g of groups) {
        for (const t of g.templates) {
          const tpl = templatesQ.data?.find((x) => x.id === t.id);
          if (!tpl) continue;
          await createTaskFromTemplate(tpl, {
            itemId: itemForCat.get(g.category),
            categoryId: catId.get(g.category),
            categories: categoriesQ.data,
          });
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      navigation.popToTop();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not create tasks'),
  });

  if (templatesQ.isLoading || itemsQ.isLoading || categoriesQ.isLoading) {
    // The screen's shape while templates/items/categories load: the intro line,
    // then a couple of grouped cards of selectable item rows.
    return (
      <View style={[styles.screen, styles.content]}>
        <Skeleton width={'88%'} height={14} style={styles.skelIntro} />
        {[0, 1].map((g) => (
          <View key={g} style={styles.group}>
            <Skeleton width={96} height={12} style={styles.skelHeader} />
            <GroupCard>
              {[0, 1, 2].map((i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <CardDivider /> : null}
                  <View style={styles.row}>
                    <Skeleton width={20} height={20} radius={10} style={styles.rowIcon} />
                    <Skeleton width={i % 2 ? '44%' : '58%'} height={15} />
                  </View>
                </React.Fragment>
              ))}
            </GroupCard>
          </View>
        ))}
      </View>
    );
  }

  const taskCount = groups.reduce((n, g) => n + groupCount(g), 0);

  return (
    <View style={styles.screen}>
      <KeyboardAwareScrollView bottomOffset={24} style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          Choose an item for each group. Tasks in a group share one item — we’ll create a placeholder
          item where you don’t have one yet, which you can flesh out later.
        </Text>

        {groups.map((g) => {
          const items = itemsByCat.get(g.category) ?? [];
          const selected = choiceFor(g.category);
          return (
            <View key={g.category} style={styles.group}>
              <SectionHeader>
                {g.category} <Text style={styles.count}>{groupCount(g)} task{groupCount(g) === 1 ? '' : 's'}</Text>
              </SectionHeader>
              <GroupCard>
                {items.map((it, i) => (
                  <React.Fragment key={it._id}>
                    {i > 0 ? <CardDivider /> : null}
                    <Row
                      icon="cube-outline"
                      label={it.name}
                      selected={selected === it._id}
                      accent={accent}
                      onPress={() => setChoice((c) => ({ ...c, [g.category]: it._id }))}
                    />
                  </React.Fragment>
                ))}
                {items.length ? <CardDivider /> : null}
                <Row
                  icon="add-circle-outline"
                  label={`Create new “${g.category}” item`}
                  selected={selected === CREATE_NEW}
                  accent={accent}
                  onPress={() => setChoice((c) => ({ ...c, [g.category]: CREATE_NEW }))}
                />
              </GroupCard>
            </View>
          );
        })}

        <FormError>{error}</FormError>
      </KeyboardAwareScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.footerBtn, { backgroundColor: accent }, submit.isPending && styles.footerBtnDisabled]}
          disabled={submit.isPending || taskCount === 0}
          activeOpacity={0.8}
          onPress={() => { setError(''); submit.mutate(); }}
        >
          <Text style={styles.footerBtnText}>
            {submit.isPending ? 'Creating…' : `Add ${taskCount} task${taskCount === 1 ? '' : 's'}`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Row({ icon, label, selected, accent, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  selected: boolean;
  accent: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={onPress}>
      <Ionicons name={icon} size={20} color={colors.textMuted} style={styles.rowIcon} />
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? accent : colors.border}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  intro: { fontSize: 14, color: colors.textMuted, marginBottom: spacing.md },
  group: { marginBottom: spacing.md },
  // Skeleton stand-ins for the intro text and each group's eyebrow header.
  skelIntro: { marginBottom: spacing.md },
  skelHeader: { marginBottom: spacing.xs },
  count: { color: colors.textMuted, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  rowIcon: { marginRight: spacing.sm },
  rowLabel: { flex: 1, fontSize: 15, color: colors.text },
  footer: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  footerBtn: { borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  footerBtnDisabled: { opacity: 0.5 },
  footerBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
