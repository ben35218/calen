import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { computeNextDueDate } from '@household/calendar';
import { tasksApi, itemsApi, settingsApi, householdApi, FormAssistField, Task } from '../../api';
import { sealNew, sealUpdate, openRecord } from '../../lib/e2ee';
import { TASK_ENC } from '../../lib/encSubsets';
import { loadCategories } from '../../lib/categories';
import { Input, Select, Screen, DateField, TimeField, NavField, useHeaderCheckButton, FormError, CenteredLoader } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { SUGGESTED_TASK_ICONS } from '../../lib/maintenanceCategories';
import FormAssist from '../../components/FormAssist';
import IconPicker from '../../components/IconPicker';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  recurrenceToRule,
  ruleToRecurrence,
  recurrenceAssistFields,
  recurrenceAssistCurrent,
  patchTouchesRecurrence,
  applyRecurrenceAssistPatch,
  ALERT_DAY_OPTIONS,
  excludeUsedAlert,
} from '../../lib/recurrence';
import { RepeatRule, EMPTY_REPEAT, repeatSummary } from '../../lib/eventRepeat';
import { useRepeatDraft, clearRepeatDraft } from '../../lib/repeatDraft';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'TaskForm'>;
type Rt = RouteProp<MaintenanceStackParamList, 'TaskForm'>;

interface TaskForm {
  title: string;
  categoryId: string | null;
  itemId: string | null;
  // Bare MaterialCommunityIcons glyph; empty = fall back to the category icon.
  icon: string;
  description: string;
  nextDueDate: string;
  reminderDaysBefore: number | null;
  alert2DaysBefore: number | null;
  reminderTime: string;
  // Explicit alert recipients; empty = everyone in the household.
  alertUserIds: string[];
}

const EMPTY: TaskForm = {
  title: '',
  categoryId: null,
  itemId: null,
  icon: '',
  description: '',
  nextDueDate: '',
  reminderDaysBefore: 0,
  alert2DaysBefore: null,
  reminderTime: '',
  alertUserIds: [],
};

export default function TaskFormScreen() {
  const navigation = useNavigation<Nav>();
  const { id, itemId: presetItemId, categoryId: presetCategoryId } = useRoute<Rt>().params || {};
  const isEdit = !!id;
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.maintenance;

  const [form, setForm] = useState<TaskForm>(EMPTY);
  // Recurrence is edited on the shared calendar Repeat screen; we hold its rule
  // here and convert to/from the task recurrence shape on load/save.
  const [repeatRule, setRepeatRule] = useState<RepeatRule>({ ...EMPTY_REPEAT, freq: 'monthly', interval: 3 });
  const [error, setError] = useState('');
  // A new task is ready immediately; an edit waits for the task to load and seed
  // below before the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!isEdit);
  const assist = useFormAssist();

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Task' : 'Add Task' });
  }, [navigation, isEdit]);

  // When opened from a place that knows the item (e.g. an item's page), prefill
  // the linked item and its category so the user doesn't re-pick them.
  useEffect(() => {
    if (isEdit || (!presetItemId && !presetCategoryId)) return;
    setForm((f) => ({
      ...f,
      itemId: presetItemId ?? f.itemId,
      categoryId: presetCategoryId ?? f.categoryId,
    }));
  }, [isEdit, presetItemId, presetCategoryId]);

  // Edits made on the pushed Repeat screen sync back live via the draft store.
  const repeatDraft = useRepeatDraft();
  useEffect(() => {
    if (repeatDraft) setRepeatRule(repeatDraft);
  }, [repeatDraft]);
  useEffect(() => () => clearRepeatDraft(), []);

  // Manual edits clear the "AI changed this" highlight for the touched fields.
  const set = (patch: Partial<TaskForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  const categoriesQ = useQuery({
    queryKey: ['categories', 'top'],
    // Decrypted (names are sealed content — Signal-parity D5).
    queryFn: () => loadCategories({ topLevel: true }),
  });
  const itemsQ = useQuery({ queryKey: ['items', 'list'], queryFn: async () => (await itemsApi.list()).data });
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const householdQ = useQuery({ queryKey: ['household'], queryFn: async () => (await householdApi.get()).data });
  const members = householdQ.data?.members ?? [];
  const memberName = (m: { firstName?: string; lastName?: string; email?: string }) =>
    [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.email || 'Member';

  const memberCount = settingsQ.data?.householdMemberCount ?? 1;

  const taskQ = useQuery({
    queryKey: ['tasks', id],
    queryFn: async () => (await tasksApi.get(id!)).data,
    enabled: isEdit,
  });

  // The decrypted record backing an edit — spread under the update at seal time
  // so content fields the form doesn't edit (instructions, estimates) survive
  // re-sealing with the shared TASK_ENC subset.
  const decryptedTask = React.useRef<Task | null>(null);

  // Hydrate the form once the existing task loads.
  useEffect(() => {
    if (!taskQ.data) return;
    let cancelled = false;
    (async () => {
    const t = await openRecord('MaintenanceTask', taskQ.data); // decrypt content over plaintext
    if (cancelled) return;
    decryptedTask.current = t;
    const catId = t.categoryId && typeof t.categoryId === 'object' ? t.categoryId._id : (t.categoryId as string) || null;
    const itemId = t.itemId && typeof t.itemId === 'object' ? t.itemId._id : (t.itemId as string) || null;
    setForm({
      title: t.title ?? '',
      categoryId: catId,
      itemId,
      icon: t.icon ?? '',
      description: t.description ?? '',
      nextDueDate: t.nextDueDate ? t.nextDueDate.slice(0, 10) : '',
      reminderDaysBefore: t.reminderDaysBefore ?? 0,
      alert2DaysBefore: t.alert2DaysBefore ?? null,
      reminderTime: t.reminderTime ?? '',
      alertUserIds: (t.alertUserIds ?? []).map(String),
    });
    setRepeatRule(recurrenceToRule(t.recurrence));
    setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [taskQ.data]);

  // Schema the AI form assistant fills. Names match the form-state keys so the
  // returned patch can be merged directly.
  const assistFields: FormAssistField[] = useMemo(
    () => [
      { name: 'title', type: 'text', label: 'Task Title' },
      { name: 'categoryId', type: 'select', label: 'Category', options: (categoriesQ.data ?? []).map((c) => ({ label: c.name, value: c._id })) },
      { name: 'itemId', type: 'select', label: 'Linked Item', options: (itemsQ.data ?? []).map((i) => ({ label: i.name, value: i._id })) },
      {
        name: 'icon',
        type: 'select',
        label: 'Icon',
        description: 'The most fitting glyph for the task; leave unset to fall back to the category icon',
        options: SUGGESTED_TASK_ICONS.map((n) => ({ label: n, value: n })),
      },
      { name: 'description', type: 'text', label: 'Description' },
      { name: 'nextDueDate', type: 'date', label: 'Next Due Date' },
      ...recurrenceAssistFields(),
      { name: 'reminderDaysBefore', type: 'select', label: 'Alert', description: 'When to send the first reminder', options: ALERT_DAY_OPTIONS.map((o) => ({ label: o.label, value: o.value ?? -1 })) },
      { name: 'alert2DaysBefore', type: 'select', label: 'Second alert', description: 'An optional second reminder', options: ALERT_DAY_OPTIONS.map((o) => ({ label: o.label, value: o.value ?? -1 })) },
    ],
    [categoriesQ.data, itemsQ.data]
  );

  // Merge an AI patch into the form: reassemble any repeat* keys into the
  // RepeatRule, apply the -1 "No alert" sentinel, and mark changed fields.
  const applyPatch = (patch: Record<string, unknown>) => {
    const next: Partial<TaskForm> = {};
    const changedKeys: string[] = [];
    if (patchTouchesRecurrence(patch)) {
      setRepeatRule((prev) => applyRecurrenceAssistPatch(prev, patch));
      changedKeys.push('recurrence');
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in EMPTY)) continue;
      const val = (k === 'reminderDaysBefore' || k === 'alert2DaysBefore') && v === -1 ? null : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    setForm((f) => ({ ...f, ...next }));
    assist.mark(changedKeys);
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        title: form.title,
        // Bare glyph or null so the app falls back to the category icon.
        icon: form.icon || null,
        description: form.description,
        reminderDaysBefore: form.reminderDaysBefore,
        alert2DaysBefore: form.reminderDaysBefore == null ? null : form.alert2DaysBefore,
        reminderTime: form.reminderDaysBefore == null ? null : (form.reminderTime || null),
        // Empty recipients = everyone; also reset alertAudience so a previously
        // "owner"-scoped task falls back to everyone rather than lingering.
        alertUserIds: form.reminderDaysBefore == null ? [] : form.alertUserIds,
        alertAudience: 'everyone',
        recurrence: ruleToRecurrence(repeatRule),
      };
      if (form.categoryId) payload.categoryId = form.categoryId;
      if (form.itemId) payload.itemId = form.itemId;
      if (form.nextDueDate) payload.nextDueDate = form.nextDueDate;
      // Client-owned due-date lifecycle (Signal-parity D4): seed the first due
      // date from the recurrence when the user didn't pick one — the server no
      // longer computes it (it can't once the field is sealed).
      if (!isEdit && !payload.nextDueDate && (payload.recurrence as { type?: string } | undefined)?.type !== 'one-time') {
        const d = computeNextDueDate({ recurrence: payload.recurrence }, new Date());
        if (d) payload.nextDueDate = d.toISOString();
      }
      return isEdit
        ? tasksApi.update(id!, await sealUpdate('MaintenanceTask', id!, payload, TASK_ENC({ ...decryptedTask.current, ...payload })))
        : tasksApi.create(await sealNew('MaintenanceTask', payload, TASK_ENC(payload)));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      navigation.goBack();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Save failed'),
  });

  const onSave = () => {
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    setError('');
    save.mutate();
  };

  useHeaderCheckButton(navigation, { onPress: onSave, loading: save.isPending, color: accent });

  // Discard guard: prompt before leaving with unsaved edits to the task fields
  // or its repeat rule. Baseline snapshot is taken once the form has seeded.
  const baselineRef = React.useRef<string | null>(null);
  const snapshot = JSON.stringify({ form, repeatRule });
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  // Tapping the Repeat field opens the shared Repeat screen directly.
  const openRepeatScreen = () =>
    navigation.navigate('EventRepeat', {
      rule: repeatRule,
      date: form.nextDueDate || new Date().toISOString().slice(0, 10),
    });

  // Category to scope the template browser to: the linked item's category when
  // an item is linked, otherwise the form's own category selection (undefined =
  // show all categories).
  const linkedCategoryName = useMemo(() => {
    const catName = (cid: unknown): string | undefined => {
      if (cid && typeof cid === 'object') return (cid as { name?: string }).name;
      const c = categoriesQ.data?.find((x) => x._id === cid);
      return c?.name;
    };
    if (form.itemId) {
      const it = itemsQ.data?.find((i) => i._id === form.itemId);
      if (it) return catName(it.categoryId);
    }
    return form.categoryId ? catName(form.categoryId) : undefined;
  }, [form.itemId, form.categoryId, itemsQ.data, categoriesQ.data]);

  if (isEdit && taskQ.isLoading) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  return (
    <Screen>
      <FormAssist
        formType="home maintenance task"
        placeholder={'Describe the task, e.g. "replace the furnace filter every 3 months"'}
        fields={assistFields}
        // Recurrence lives outside `form`; pass a readable summary so Calen
        // sees the schedule already set (context only — not an editable field).
        current={{ ...form, ...recurrenceAssistCurrent(repeatRule), recurrence: repeatSummary(repeatRule) }}
        onApply={applyPatch}
      />

      <GroupCard>
        <Input
          value={form.title}
          onChangeText={(v) => set({ title: v })}
          placeholder="Task Title"
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('title') && fs.headInputHighlight]}
        />
        <CardDivider />
        <Input
          value={form.description}
          onChangeText={(v) => set({ description: v })}
          multiline
          placeholder="Add a description…"
          containerStyle={fs.headField}
          style={[fs.headInput, styles.descInput, assist.changed.has('description') && fs.headInputHighlight]}
        />
      </GroupCard>

      <GroupCard>
        <Select
          clearable
          placeholder="Linked Item"
          value={form.itemId ?? undefined}
          options={(itemsQ.data ?? []).map((i) => ({ label: i.name, value: i._id }))}
          onChange={(v) => set({ itemId: (v as string) ?? null })}
          highlight={assist.changed.has('itemId')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        <CardDivider />
        <Select
          clearable
          placeholder="Category"
          value={form.categoryId ?? undefined}
          options={(categoriesQ.data ?? []).map((c) => ({ label: c.name, value: c._id }))}
          onChange={(v) => set({ categoryId: (v as string) ?? null })}
          highlight={assist.changed.has('categoryId')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
      </GroupCard>

      <GroupCard>
        <IconPicker
          value={form.icon || undefined}
          onChange={(name) => set({ icon: name })}
          suggested={SUGGESTED_TASK_ICONS}
          accent={accent}
        />
      </GroupCard>

      <GroupCard>
        <DateField
          inlineLabel="Next Due Date"
          clearable
          placeholder="None"
          value={form.nextDueDate}
          onChange={(v) => set({ nextDueDate: v })}
          highlight={assist.changed.has('nextDueDate')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          hideIcon
        />
        <CardDivider />
        <NavField
          inlineLabel="Repeat"
          value={repeatSummary(repeatRule)}
          onPress={openRepeatScreen}
          highlight={assist.changed.has('recurrence')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
        />
      </GroupCard>

      <GroupCard>
        <Select
          inlineLabel="Alert"
          value={form.reminderDaysBefore ?? undefined}
          options={excludeUsedAlert(
            ALERT_DAY_OPTIONS.map((o) => ({ label: o.label, value: o.value ?? -1 })),
            form.alert2DaysBefore,
            form.reminderDaysBefore,
          )}
          onChange={(v) => set({ reminderDaysBefore: v === -1 ? null : (v as number) })}
          highlight={assist.changed.has('reminderDaysBefore')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        {form.reminderDaysBefore != null ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Second alert"
              value={form.alert2DaysBefore ?? undefined}
              options={excludeUsedAlert(
                ALERT_DAY_OPTIONS.map((o) => ({ label: o.label, value: o.value ?? -1 })),
                form.reminderDaysBefore,
                form.alert2DaysBefore,
              )}
              onChange={(v) => set({ alert2DaysBefore: v === -1 ? null : (v as number) })}
              highlight={assist.changed.has('alert2DaysBefore')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
        {form.reminderDaysBefore != null ? (
          <>
            <CardDivider />
            <TimeField
              inlineLabel="Remind at"
              clearable
              placeholder="9:00 AM"
              defaultValue="09:00"
              value={form.reminderTime}
              onChange={(v) => set({ reminderTime: v })}
              highlight={assist.changed.has('reminderTime')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              hideIcon
            />
          </>
        ) : null}
        {memberCount > 1 && form.reminderDaysBefore != null ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Alert who?"
              multiple
              placeholder="Everyone"
              values={form.alertUserIds}
              options={members.map((m) => ({ label: memberName(m), value: m._id }))}
              onChangeMultiple={(v) => set({ alertUserIds: v as string[] })}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
      </GroupCard>

      {!isEdit ? (
        <TouchableOpacity style={styles.templatesLink} onPress={() => navigation.navigate('TaskTemplates', { categoryName: linkedCategoryName, itemId: form.itemId ?? undefined })}>
          <Ionicons name="grid-outline" size={18} color={accent} />
          <Text style={[styles.templatesLinkText, { color: accent }]}>Browse task templates</Text>
        </TouchableOpacity>
      ) : null}

      <FormError>{error}</FormError>
    </Screen>
  );
}

const styles = StyleSheet.create({
  templatesLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: spacing.sm, paddingBottom: spacing.md },
  templatesLinkText: { fontSize: 15, fontWeight: '600' },
  // Grows to fit the description (minHeight, not a fixed height) so long text
  // isn't clipped against the bottom of the card.
  descInput: { minHeight: 90, textAlignVertical: 'top' },
});
