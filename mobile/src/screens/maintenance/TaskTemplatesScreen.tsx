import React, { useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tasksApi, itemsApi, propertiesApi, TaskTemplate, LinkedRef } from '../../api';
import { createTaskFromTemplate } from '../../lib/taskTemplates';
import { Input, Badge, SectionHeader, CenteredLoader, IconAvatar } from '../../components/ui';
import { recurrenceLabelShort } from '../../lib/recurrence';
import { diyBadge } from '../../lib/diy';
import { categoryMeta, orderCategories, resolveTaskIcon } from '../../lib/maintenanceCategories';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, radius, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'TaskTemplates'>;
type Rt = RouteProp<MaintenanceStackParamList, 'TaskTemplates'>;

export default function TaskTemplatesScreen() {
  const navigation = useNavigation<Nav>();
  const { mode, categoryName, itemId } = useRoute<Rt>().params || {};
  const isMulti = mode === 'multi';
  const accent = useCalendarColors().colors.maintenance;
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  // Multi-select flow: ids checked off before continuing to the review step.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Side-rail: which category's templates the right pane is showing. Null falls
  // back to the first available category (see `activeCat` below).
  const [activeCatState, setActiveCat] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (isMulti) navigation.setOptions({ title: 'Select Tasks' });
  }, [navigation, isMulti]);

  const templatesQ = useQuery({
    queryKey: ['task-templates'],
    queryFn: async () => (await tasksApi.templates()).data,
  });
  const tasksQ = useQuery({ queryKey: ['tasks', 'list'], queryFn: async () => (await tasksApi.list()).data });
  const itemsQ = useQuery({ queryKey: ['items', 'list'], queryFn: async () => (await itemsApi.list()).data });
  const propertiesQ = useQuery({ queryKey: ['properties'], queryFn: async () => (await propertiesApi.list()).data });

  const refId = (ref?: LinkedRef | string | null): string | null =>
    ref ? (typeof ref === 'object' ? ref._id : ref) : null;

  // Item id → its property id, so we can tell which property a task belongs to.
  const itemProperty = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const it of itemsQ.data ?? []) m.set(it._id, refId(it.propertyId));
    return m;
  }, [itemsQ.data]);

  // Which property this list is browsed for: the linked item's property when
  // opened from an item, else the household's primary property.
  const contextPropertyId = itemId
    ? itemProperty.get(itemId) ?? null
    : propertiesQ.data?.[0]?._id ?? null;

  // A template is "in use" only for the property it's already applied to, so the
  // same template stays available for other properties. Tasks with no property
  // (unlinked, or an item without one) block in every context.
  const usedIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasksQ.data ?? []) {
      if (!t.templateId) continue;
      const pid = refId(t.itemId) ? itemProperty.get(refId(t.itemId)!) ?? null : null;
      if (!pid || pid === contextPropertyId) s.add(t.templateId);
    }
    return s;
  }, [tasksQ.data, itemProperty, contextPropertyId]);

  // Single-tap flow: create one task and jump to it. When opened from an item,
  // link the new task to it (so the block scopes to that item's property).
  // Instantiation is client-side now (Signal-parity D4): the template's task is
  // built + sealed on-device and created through the ordinary POST /tasks.
  const create = useMutation({
    mutationFn: async (templateId: string) => {
      const tpl = templatesQ.data?.find((t) => t.id === templateId);
      if (!tpl) throw new Error('Template not found');
      return createTaskFromTemplate(tpl, itemId ? { itemId } : {});
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      if (created?._id) navigation.replace('TaskDetail', { id: created._id });
      else navigation.goBack();
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Templates available in this context (scoped to a category when browsing for a
  // known item; hides ones already applied). Search + rail filter this further.
  const available = useMemo(() => {
    let list = templatesQ.data ?? [];
    if (categoryName) list = list.filter((t) => t.defaultCategoryName === categoryName);
    return list.filter((t) => !usedIds.has(t.id));
  }, [templatesQ.data, usedIds, categoryName]);

  // Category → count, ordered canonically, for the side rail.
  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of available) {
      const c = t.defaultCategoryName || 'General';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [available]);
  const catNames = useMemo(() => orderCategories([...catCounts.keys()]), [catCounts]);

  // Fall back to the first available category until one is tapped.
  const activeCat = activeCatState && catNames.includes(activeCatState) ? activeCatState : catNames[0] ?? null;

  const searching = search.trim().length > 0;
  // While searching, span every category; otherwise show the active one only.
  const sections = useMemo(() => {
    if (searching) {
      const q = search.trim().toLowerCase();
      const g: Record<string, TaskTemplate[]> = {};
      for (const t of available) {
        if (!(t.title.toLowerCase().includes(q) || (t.defaultCategoryName || '').toLowerCase().includes(q))) continue;
        (g[t.defaultCategoryName || 'General'] ||= []).push(t);
      }
      return orderCategories(Object.keys(g)).map((cat) => ({ cat, items: g[cat], showHeader: true }));
    }
    const items = available.filter((t) => (t.defaultCategoryName || 'General') === activeCat);
    return activeCat ? [{ cat: activeCat, items, showHeader: false }] : [];
  }, [available, searching, search, activeCat]);

  // A rail tap clears any search so its category filter actually takes effect.
  const pickCategory = (cat: string) => { setSearch(''); setActiveCat(cat); };

  if (templatesQ.isLoading) {
    return <CenteredLoader />;
  }

  const renderCard = (tpl: TaskTemplate) => {
    const used = usedIds.has(tpl.id);
    const busy = create.isPending && create.variables === tpl.id;
    const checked = selected.has(tpl.id);
    const diy = diyBadge(tpl.diy);
    const cat = categoryMeta(tpl.defaultCategoryName || '');
    return (
      <TouchableOpacity
        key={tpl.id}
        style={[styles.card, checked && { borderColor: accent }, !isMulti && used && styles.cardUsed]}
        disabled={isMulti ? false : used || create.isPending}
        onPress={() => (isMulti ? toggle(tpl.id) : create.mutate(tpl.id))}
        activeOpacity={0.7}
      >
        <IconAvatar
          mdiIcon={resolveTaskIcon(tpl.icon, tpl.defaultCategoryName)}
          bg={cat.color}
          size={40}
          style={styles.cardAvatar}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{tpl.title}</Text>
          <Text style={styles.cardSub}>{recurrenceLabelShort(tpl.recurrence)}</Text>
          {used || diy ? (
            <View style={styles.chipRow}>
              {used ? <Badge label="In Use" color={colors.success} /> : null}
              {diy ? <Badge label={diy.label} color={diy.color} /> : null}
            </View>
          ) : null}
        </View>
        {isMulti ? (
          <Ionicons name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={checked ? accent : colors.border} />
        ) : busy ? (
          <ActivityIndicator color={colors.primary} />
        ) : !used ? (
          <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
        ) : null}
      </TouchableOpacity>
    );
  };

  // The scrolling template pane (right side, or the whole width when there's no
  // rail — i.e. browsing a single category for a known item).
  const showRail = !categoryName && catNames.length > 1;
  const activeMeta = activeCat ? categoryMeta(activeCat) : null;
  const pane = (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={styles.paneContent}
      refreshControl={<RefreshControl refreshing={templatesQ.isRefetching} onRefresh={templatesQ.refetch} />}
    >
      {!searching && showRail && activeMeta ? (
        <View style={styles.paneHeader}>
          <MaterialCommunityIcons name={activeMeta.icon} size={20} color={activeMeta.color} />
          <SectionHeader style={styles.paneHeaderText}>
            {activeMeta.name} <Text style={styles.groupCount}>{sections[0]?.items.length ?? 0}</Text>
          </SectionHeader>
        </View>
      ) : null}
      {sections.length === 0 || sections.every((s) => s.items.length === 0) ? (
        <Text style={styles.empty}>{searching ? 'No templates match your search.' : 'No templates left to add here.'}</Text>
      ) : (
        sections.map((s) => (
          <View key={s.cat} style={styles.group}>
            {s.showHeader ? (
              <SectionHeader style={styles.groupTitle}>
                {s.cat} <Text style={styles.groupCount}>{s.items.length}</Text>
              </SectionHeader>
            ) : null}
            {s.items.map(renderCard)}
          </View>
        ))
      )}
    </KeyboardAwareScrollView>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.searchWrap}>
        <Input placeholder="Search all templates…" value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} />
      </View>

      {showRail ? (
        <View style={styles.body}>
          <View style={styles.rail}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.railContent}>
              {catNames.map((cat) => {
                const meta = categoryMeta(cat);
                const isActive = !searching && cat === activeCat;
                return (
                  <TouchableOpacity
                    key={cat}
                    style={[styles.railItem, isActive && { backgroundColor: meta.color + '22', borderColor: meta.color }]}
                    activeOpacity={0.7}
                    onPress={() => pickCategory(cat)}
                  >
                    <MaterialCommunityIcons name={meta.icon} size={22} color={isActive ? meta.color : colors.textMuted} />
                    <Text style={[styles.railLabel, isActive && { color: colors.text }]} numberOfLines={1}>{meta.short}</Text>
                    <Text style={styles.railCount}>{catCounts.get(cat)}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
          {pane}
        </View>
      ) : (
        pane
      )}

      {isMulti ? (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.footerBtn, { backgroundColor: accent }, selected.size === 0 && styles.footerBtnDisabled]}
            disabled={selected.size === 0}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('TaskTemplateReview', { templateIds: [...selected] })}
          >
            <Text style={styles.footerBtnText}>
              {selected.size ? `Link ${selected.size} task${selected.size === 1 ? '' : 's'} →` : 'Select tasks to continue'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const RAIL_WIDTH = 88;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  searchWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  body: { flex: 1, flexDirection: 'row' },
  // Left category rail.
  rail: { width: RAIL_WIDTH, borderRightWidth: 1, borderRightColor: colors.border },
  railContent: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm, gap: spacing.sm },
  railItem: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    gap: 4,
  },
  railLabel: { fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'center' },
  railCount: { fontSize: 10, color: colors.textMuted },
  // Right (or full-width) template pane.
  paneContent: { padding: spacing.md },
  paneHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm },
  paneHeaderText: { flex: 1 },
  empty: { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },
  group: { marginBottom: spacing.lg },
  groupTitle: { flex: 1 },
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
  },
  cardUsed: { opacity: 0.6 },
  cardAvatar: { marginRight: spacing.md },
  cardTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  cardSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm },
  footer: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  footerBtn: { borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  footerBtnDisabled: { opacity: 0.4 },
  footerBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
