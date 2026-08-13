import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { Text } from '../../components/Text';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tasksApi, itemsApi, propertiesApi, settingsApi, Task, Item, LinkedRef } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { ensureDefaultCategories } from '../../lib/categories';
import * as replica from '../../lib/replica';
import { Card, CenteredLoader, RoundIconButton, SectionHeader, SkeletonList, EmptyState, IconAvatar, Select, Hint } from '../../components/ui';
import { parseCalendarDate } from '../../lib/recurrence';
import { hasUpcomingOccurrence } from '../../lib/repeatingItemScope';
import { itemTypeConfig } from '../../lib/itemTypes';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { useOwnedAddons } from '../../lib/addons';
import AddonLockedView from '../plan/AddonLockedView';
import { resolveTaskIcon } from '../../lib/maintenanceCategories';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'MaintenanceHome'>;

// Item type → icon/color (mirrors DashboardView.vue TYPE_ICONS / TYPE_COLORS,
// with mdi names mapped to MaterialCommunityIcons glyphs).
const TYPE_ICONS: Record<string, string> = {
  vehicle: 'car',
  equipment: 'tools',
  appliance: 'washing-machine',
  system: 'cog',
  structure: 'home',
  other: 'package-variant',
};
const TYPE_COLORS: Record<string, string> = {
  vehicle: '#607D8B',
  equipment: '#795548',
  appliance: '#9C27B0',
  system: '#FF9800',
  structure: '#4CAF50',
  other: '#9E9E9E',
};

type StatusKey = 'overdue' | 'due-soon' | 'upcoming' | 'paused';
type StatusTask = Task & { _status: StatusKey };

const STATUS_COLORS: Record<StatusKey, string> = {
  overdue: colors.error,
  'due-soon': colors.warning,
  upcoming: colors.success,
  paused: colors.textMuted,
};
const STATUS_ORDER: Record<StatusKey, number> = { overdue: 0, 'due-soon': 1, upcoming: 2, paused: 3 };

// Preset "due soon" windows offered for the household reminderLeadDays setting.
const LEAD_PRESETS = [3, 7, 14, 30];
function leadLabel(d: number): string {
  if (d === 7) return '1 week';
  if (d === 14) return '2 weeks';
  if (d === 30) return '30 days';
  return `${d} day${d === 1 ? '' : 's'}`;
}

function refName(ref?: LinkedRef | string | null): string | null {
  if (!ref) return null;
  return typeof ref === 'object' ? ref.name : null;
}

function refId(ref?: LinkedRef | string | null): string | null {
  if (!ref) return null;
  return typeof ref === 'object' ? ref._id : ref;
}

// Client-side status bucket for a task, used to colour its due chip when we
// list every task under an expanded item (the server-side buckets are only
// fetched for the flat overdue/due-soon list above).
function taskStatus(task: Task): StatusKey {
  if (task.active === false) return 'paused';
  if (!task.nextDueDate) return 'upcoming';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((parseCalendarDate(task.nextDueDate).getTime() - today.getTime()) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 14) return 'due-soon';
  return 'upcoming';
}

// Coarse "time until due" for the task chips: days, then weeks+days, then
// months+weeks (30-day months / 7-day weeks — good enough for an at-a-glance
// countdown). Past-due tasks read "Overdue".
function timeUntil(dueDate?: string | null): string {
  if (!dueDate) return 'No date';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((parseCalendarDate(dueDate).getTime() - today.getTime()) / 86400000);
  if (days < 0) return 'Overdue';
  if (days === 0) return 'Today';
  const plur = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  if (days < 7) return plur(days, 'day');
  const months = Math.floor(days / 30);
  if (months >= 1) {
    const weeks = Math.floor((days - months * 30) / 7);
    return weeks ? `${plur(months, 'month')} ${plur(weeks, 'week')}` : plur(months, 'month');
  }
  const weeks = Math.floor(days / 7);
  const rem = days - weeks * 7;
  return rem ? `${plur(weeks, 'week')} ${plur(rem, 'day')}` : plur(weeks, 'week');
}

// Add-on gate: Maintenance is a one-time purchase (see billing-plans spec).
// Gating at the home screen covers every entry path — Calendars row, deep
// links, AI navigation, restored nav state.
export default function MaintenanceScreen() {
  const { isUnlocked, loaded } = useOwnedAddons();
  const accent = useCalendarColors().colors.maintenance;
  if (!loaded) return <CenteredLoader color={accent} />;
  if (!isUnlocked('maintenance')) return <AddonLockedView addon="maintenance" />;
  return <MaintenanceHome />;
}

function MaintenanceHome() {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.maintenance;
  const qc = useQueryClient();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <RoundIconButton icon="add" onPress={() => navigation.navigate('ItemForm', {})} bg={accent} />
      ),
    });
  }, [navigation, accent]);

  // Every task, decrypted over the replica (offline-first). Due/overdue
  // bucketing happens HERE now (Signal-parity D4) — nextDueDate is sealed
  // content the server can't filter on. Populated item/category refs carry
  // their own enc, so their sealed names decrypt too.
  const itemTasksQ = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: async () => {
      const rows = await replica.syncedList<Task>('MaintenanceTask', async () => (await tasksApi.list()).data);
      return Promise.all(rows.map(async (t) => {
        const task = await openRecord('MaintenanceTask', t);
        if (task.itemId && typeof task.itemId === 'object') task.itemId = await openRecord('Item', task.itemId);
        if (task.categoryId && typeof task.categoryId === 'object') task.categoryId = await openRecord('Category', task.categoryId);
        return task;
      }));
    },
  });
  const itemsQ = useQuery({
    queryKey: ['items', 'list'],
    queryFn: async () => {
      const rows = await replica.syncedList<Item>('Item', async () => (await itemsApi.list()).data);
      return Promise.all(rows.map((i) => openRecord('Item', i)));
    },
  });
  const propertiesQ = useQuery({
    queryKey: ['properties'],
    queryFn: async () => (await propertiesApi.list()).data,
  });
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });

  // P1-pattern client-side seed: an E2EE-active household with no categories
  // gets the encrypted default set (no-ops everywhere else).
  useEffect(() => {
    ensureDefaultCategories().catch(() => {});
  }, []);

  // Overdue / due-soon buckets over the decrypted tasks (mirrors the retired
  // server ?status= filters, including the reminderLeadDays window).
  const leadDays = settingsQ.data?.reminderLeadDays ?? 7;

  // reminderLeadDays is a household-shared setting (see households-sharing spec):
  // it sets how far ahead a task counts as "due soon". Edited here, where it
  // takes effect; the write applies to the whole household. Fold the current
  // value into the preset list so an off-preset value still shows selected.
  const leadOptions = [...new Set([...LEAD_PRESETS, leadDays])]
    .sort((a, b) => a - b)
    .map((d) => ({ value: d, label: leadLabel(d) }));
  const updateSettings = useMutation({
    mutationFn: (patch: Record<string, unknown>) => settingsApi.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const allTasks = useMemo((): StatusTask[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return (itemTasksQ.data ?? [])
      // An ENDED series would otherwise read as permanently overdue: its anchor
      // (`nextDueDate`) still sits in the past, but the schedule stopped. It has
      // no outstanding work, so it leaves this status dashboard — the task is
      // still reachable through its item, which lists every task unfiltered.
      .filter((t) => t.active !== false && t.nextDueDate && hasUpcomingOccurrence(t))
      .map((t) => {
        const days = Math.round((parseCalendarDate(t.nextDueDate!).getTime() - today.getTime()) / 86400000);
        const status: StatusKey | null = days < 0 ? 'overdue' : days <= leadDays ? 'due-soon' : null;
        return status ? ({ ...t, _status: status } as StatusTask) : null;
      })
      .filter((t): t is StatusTask => t !== null);
  }, [itemTasksQ.data, leadDays]);
  const items = itemsQ.data ?? [];
  const properties = propertiesQ.data ?? [];

  // Which item cards are expanded to reveal their tasks.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleItem = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Tasks keyed by the item they belong to, sorted overdue-first then by due date.
  const tasksByItem = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of itemTasksQ.data ?? []) {
      const id = refId(task.itemId);
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(task);
    }
    for (const list of map.values())
      list.sort(
        (a, b) =>
          STATUS_ORDER[taskStatus(a)] - STATUS_ORDER[taskStatus(b)] ||
          new Date(a.nextDueDate || 0).getTime() - new Date(b.nextDueDate || 0).getTime()
      );
    return map;
  }, [itemTasksQ.data]);

  // Overdue + due-soon tasks as a flat list — overdue first, then earliest due.
  // Tasks whose series has stopped. They are deliberately absent from the
  // dashboard above (an ended series' anchor sits in the past, so it would read
  // as permanently overdue) — but their detail page is the only route to Resume
  // schedule, and a task with NO linked item has no other home on this screen,
  // so they get their own collapsed group. Mirrors the Chores list.
  // Ended tasks stay collapsed until asked for — they're history, not work.
  const [showEndedTasks, setShowEndedTasks] = useState(false);

  const endedTasks = useMemo(
    () => (itemTasksQ.data ?? []).filter((t) => t.active !== false && !hasUpcomingOccurrence(t)),
    [itemTasksQ.data],
  );

  const dueTasks = useMemo(
    () =>
      [...allTasks].sort(
        (a, b) =>
          STATUS_ORDER[a._status] - STATUS_ORDER[b._status] ||
          new Date(a.nextDueDate || 0).getTime() - new Date(b.nextDueDate || 0).getTime()
      ),
    [allTasks]
  );

  // Group items: vehicles together under "Vehicles"; everything else by the
  // property it belongs to ("<Property> Items"). Vehicles group first, then
  // property groups alphabetically.
  const groupedItems = useMemo(() => {
    const propName = new Map<string, string>();
    for (const p of properties) propName.set(p._id, p.name);

    const groups = new Map<string, { key: string; label: string; items: Item[] }>();
    const add = (key: string, label: string, item: Item) => {
      if (!groups.has(key)) groups.set(key, { key, label, items: [] });
      groups.get(key)!.items.push(item);
    };
    for (const item of items) {
      if (item.type === 'vehicle') {
        add('__vehicles__', 'Vehicles', item);
        continue;
      }
      const pid =
        item.propertyId && typeof item.propertyId === 'object'
          ? item.propertyId._id
          : (item.propertyId as string) || null;
      const name =
        (item.propertyId && typeof item.propertyId === 'object' && item.propertyId.name) ||
        (pid ? propName.get(pid) : null) ||
        'Unassigned';
      add(pid ? `prop-${pid}` : 'prop-unassigned', `${name} Items`, item);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.key === '__vehicles__') return -1;
      if (b.key === '__vehicles__') return 1;
      return a.label.localeCompare(b.label);
    });
  }, [items, properties]);
  const showGroups = groupedItems.length > 1;

  if (itemTasksQ.isLoading || itemsQ.isLoading) {
    return <SkeletonList />;
  }

  const refreshing =
    itemsQ.isRefetching || propertiesQ.isRefetching || itemTasksQ.isRefetching;
  const onRefresh = () => {
    itemsQ.refetch();
    propertiesQ.refetch();
    itemTasksQ.refetch();
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Overdue + due-soon tasks, as a flat to-do list. */}
        {dueTasks.length ? (
          <>
          <SectionHeader>Overdue &amp; Upcoming Tasks</SectionHeader>
          <Card style={styles.dueCard}>
            {dueTasks.map((task, i) => (
              <TouchableOpacity
                key={task._id}
                style={[styles.dueRow, i > 0 && styles.dueRowBorder]}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('TaskDetail', { id: task._id })}
              >
                <MaterialCommunityIcons
                  name={resolveTaskIcon(
                    task.icon,
                    typeof task.categoryId === 'object' ? task.categoryId?.name : null,
                  )}
                  size={22}
                  color={colors.textMuted}
                />
                <View style={styles.dueRowText}>
                  <Text style={styles.taskTitle} numberOfLines={1}>{task.title}</Text>
                  <Text style={styles.dueRowSub} numberOfLines={1}>{refName(task.itemId) || '—'}</Text>
                </View>
                <Text style={[styles.taskChipText, { color: STATUS_COLORS[task._status] }]}>
                  {timeUntil(task.nextDueDate)}
                </Text>
              </TouchableOpacity>
            ))}
          </Card>
          </>
        ) : (
          <Card style={styles.dueEmptyCard}>
            <Text style={styles.dueEmptyText}>Nothing overdue or due soon 🎉</Text>
          </Card>
        )}

        {endedTasks.length ? (
          <>
            <TouchableOpacity
              style={styles.endedToggle}
              onPress={() => setShowEndedTasks((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={`${showEndedTasks ? 'Hide' : 'Show'} ended tasks`}
            >
              <Text style={styles.endedLabel}>{`Ended tasks (${endedTasks.length})`}</Text>
              <Ionicons name={showEndedTasks ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
            </TouchableOpacity>
            {showEndedTasks ? (
              <Card style={[styles.dueCard, styles.endedCard]}>
                {endedTasks.map((task, i) => (
                  <TouchableOpacity
                    key={task._id}
                    style={[styles.dueRow, i > 0 && styles.dueRowBorder]}
                    activeOpacity={0.7}
                    onPress={() => navigation.navigate('TaskDetail', { id: task._id })}
                  >
                    <MaterialCommunityIcons
                      name={resolveTaskIcon(
                        task.icon,
                        typeof task.categoryId === 'object' ? task.categoryId?.name : null,
                      )}
                      size={22}
                      color={colors.textMuted}
                    />
                    <View style={styles.dueRowText}>
                      <Text style={styles.taskTitle} numberOfLines={1}>{task.title}</Text>
                      <Text style={styles.dueRowSub} numberOfLines={1}>{refName(task.itemId) || '—'}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </Card>
            ) : null}
          </>
        ) : null}

        {!items.length ? (
          <EmptyState
            variant="inline"
            mdiIcon="tools"
            title="Nothing to maintain yet"
            message="Add items to start tracking maintenance tasks."
            actionLabel="Add Item"
            onAction={() => navigation.navigate('ItemForm', {})}
            accent={accent}
          />
        ) : null}

        {groupedItems.map((group) => (
          <View key={group.key} style={styles.group}>
            {showGroups ? <SectionHeader>{group.label}</SectionHeader> : null}
            {group.items.map((item) => {
              const isExpanded = expanded.has(item._id);
              const itemTasks = tasksByItem.get(item._id) ?? [];
              return (
                <Card key={item._id} style={styles.itemCard}>
                  <View style={styles.itemRow}>
                    <TouchableOpacity
                      style={styles.itemMain}
                      activeOpacity={0.7}
                      onPress={() => navigation.navigate('ItemDetail', { id: item._id })}
                    >
                      <IconAvatar
                        mdiIcon={TYPE_ICONS[item.type || 'other'] || 'package-variant'}
                        bg={TYPE_COLORS[item.type || 'other'] || '#9E9E9E'}
                        style={styles.itemAvatar}
                      />
                      <View style={styles.itemText}>
                        <Text style={styles.itemName}>{item.name}</Text>
                        <Text style={styles.itemSub} numberOfLines={1}>
                          {[itemTypeConfig(item.type).label, item.manufacturer, item.modelNumber].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.itemExpand}
                      activeOpacity={0.7}
                      onPress={() => toggleItem(item._id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={20}
                        color={colors.textMuted}
                      />
                    </TouchableOpacity>
                  </View>
                  {isExpanded ? (
                    <View style={styles.itemTasks}>
                      {itemTasks.length ? (
                        itemTasks.map((task) => (
                          <TouchableOpacity
                            key={task._id}
                            style={styles.itemTaskRow}
                            activeOpacity={0.7}
                            onPress={() => navigation.navigate('TaskDetail', { id: task._id })}
                          >
                            <MaterialCommunityIcons
                              name={resolveTaskIcon(
                                task.icon,
                                typeof task.categoryId === 'object' ? task.categoryId?.name : null,
                              )}
                              size={18}
                              color={colors.textMuted}
                            />
                            <Text style={styles.itemTaskTitle} numberOfLines={1}>{task.title}</Text>
                            <Text style={[styles.taskChipText, { color: STATUS_COLORS[taskStatus(task)] }]}>
                              {timeUntil(task.nextDueDate)}
                            </Text>
                          </TouchableOpacity>
                        ))
                      ) : (
                        <Text style={styles.itemTaskEmpty}>No tasks yet</Text>
                      )}
                    </View>
                  ) : null}
                </Card>
              );
            })}
          </View>
        ))}

        {/* Household-shared "due soon" window. Sets how far ahead a task shows
            as due soon (the flag list at the top); applies to everyone. */}
        <SectionHeader>Reminders</SectionHeader>
        <Select
          inlineLabel="Flag tasks due within"
          value={leadDays}
          options={leadOptions}
          onChange={(v) => { if (v != null && v !== leadDays) updateSettings.mutate({ reminderLeadDays: v }); }}
          disabled={updateSettings.isPending}
          chevronIcon="chevron-expand"
        />
        <Hint>Shared with everyone in your household.</Hint>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  // Overdue / due-soon to-do list.
  dueCard: { marginBottom: spacing.lg, padding: 0 },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: spacing.md },
  dueRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  dueRowText: { flex: 1 },
  dueRowSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  dueEmptyCard: { marginBottom: spacing.lg, alignItems: 'center', paddingVertical: spacing.lg },
  dueEmptyText: { fontSize: 14, color: colors.textMuted },
  endedToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, marginTop: spacing.md,
  },
  endedLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase' },
  endedCard: { opacity: 0.6 },

  group: { marginBottom: spacing.md },
  itemCard: { marginBottom: spacing.sm, padding: 0 },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  itemMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingLeft: spacing.md },
  itemExpand: { paddingVertical: spacing.md, paddingHorizontal: spacing.md, alignSelf: 'stretch', justifyContent: 'center' },
  itemAvatar: { marginRight: spacing.md },
  itemText: { flex: 1, minWidth: 0 },
  itemName: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
  itemSub: { fontSize: 13, color: colors.textMuted },

  // Tasks revealed under an expanded item.
  itemTasks: { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: spacing.md },
  itemTaskRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10 },
  itemTaskTitle: { flex: 1, fontSize: 14, color: colors.text },
  itemTaskEmpty: { fontSize: 13, color: colors.textMuted, paddingVertical: 12 },

  taskTitle: { flex: 1, fontSize: 14, color: colors.text },
  taskChipText: { fontSize: 12, fontWeight: '600' },
});
