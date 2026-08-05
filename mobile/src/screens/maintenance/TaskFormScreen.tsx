import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { computeNextDueDate } from '@household/calendar';
import { tasksApi, itemsApi, settingsApi, householdApi, FormAssistField, Task } from '../../api';
import { sealNew, sealUpdate, openRecord } from '../../lib/e2ee';
import { TASK_ENC } from '../../lib/encSubsets';
import { loadCategories } from '../../lib/categories';
import { Input, Select, Screen, DateField, TimeField, NavField, useHeaderCheckButton, FormError, CenteredLoader, Button, Hint } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { SUGGESTED_TASK_ICONS } from '../../lib/maintenanceCategories';
import FormAssist from '../../components/FormAssist';
import IconPicker from '../../components/IconPicker';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  formatCalendarDate,
  recurrenceToRule,
  ruleToRecurrence,
  recurrenceAssistFields,
  recurrenceAssistCurrent,
  patchTouchesRecurrence,
  applyRecurrenceAssistPatch,
  ALERT_DAY_OPTIONS,
  excludeUsedAlert,
} from '../../lib/recurrence';
import { addDays, daysBetween } from '../../lib/calendar';
import {
  ItemScope, itemSaveScopeDecision, isFirstItemOccurrence, promptItemSaveScope, itemRepeats, promptItemDelete,
} from '../../lib/repeatingItemScope';
import { RepeatRule, EMPTY_REPEAT, repeatSummary } from '../../lib/eventRepeat';
import { useRepeatDraft, clearRepeatDraft } from '../../lib/repeatDraft';
import { rebindDetailBelow, popPastDetail } from '../../navigation/rebindDetailBelow';
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
  const { id, itemId: presetItemId, categoryId: presetCategoryId, date } = useRoute<Rt>().params || {};
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
  // The series' own anchor day, kept aside because the form displays the
  // OCCURRENCE the user tapped instead. A whole-series save shifts back by the
  // difference; without that, saving from the third occurrence would drag the
  // whole task's anchor onto that day.
  const seriesAnchorRef = React.useRef<string>('');
  // Mirrors `dirty`, which is computed below the save handler.
  const dirtyRef = React.useRef(false);

  // Hydrate the form once the existing task loads.
  useEffect(() => {
    if (!taskQ.data) return;
    let cancelled = false;
    (async () => {
    const t = await openRecord('MaintenanceTask', taskQ.data); // decrypt content over plaintext
    if (cancelled) return;
    decryptedTask.current = t;
    const anchor = t.nextDueDate ? t.nextDueDate.slice(0, 10) : '';
    seriesAnchorRef.current = anchor;
    const repeats = !!t.recurrence?.type && t.recurrence.type !== 'one-time';
    const occurrenceDue = repeats && date ? date : anchor;
    const catId = t.categoryId && typeof t.categoryId === 'object' ? t.categoryId._id : (t.categoryId as string) || null;
    const itemId = t.itemId && typeof t.itemId === 'object' ? t.itemId._id : (t.itemId as string) || null;
    setForm({
      title: t.title ?? '',
      categoryId: catId,
      itemId,
      icon: t.icon ?? '',
      description: t.description ?? '',
      // The occurrence the user opened, not the series anchor (Apple shows the
      // day you tapped). `date` is only passed from a calendar cell.
      nextDueDate: occurrenceDue,
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

  // Everything the form knows, in one frame. 'occurrence' is the day the form
  // literally shows — where a detached one-off or a forked series begins;
  // 'series' shifts the due date back onto the record's own anchor.
  // Opened from a calendar cell, the date field holds the OCCURRENCE the user
  // tapped, not the series' anchor — so "Next Due Date" would name the wrong
  // thing (the next due date may be months behind what's shown). Call it what
  // it is in that frame, and say which occurrence is being edited, since that
  // is what the scope sheet will act on when they save.
  const editingOccurrence = isEdit && !!date && itemRepeats(decryptedTask.current);
  const dueDateLabel = editingOccurrence ? 'Date' : 'Next Due Date';

  const buildPayload = (frame: 'occurrence' | 'series'): Record<string, unknown> => {
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
    const due =
      frame === 'series' && seriesAnchorRef.current && date
        ? addDays(seriesAnchorRef.current, daysBetween(date, form.nextDueDate || date))
        : form.nextDueDate;
    if (due) payload.nextDueDate = due;
    // Client-owned due-date lifecycle (Signal-parity D4): seed the first due
    // date from the recurrence when the user didn't pick one — the server no
    // longer computes it (it can't once the field is sealed).
    if (!isEdit && !payload.nextDueDate && (payload.recurrence as { type?: string } | undefined)?.type !== 'one-time') {
      const d = computeNextDueDate({ recurrence: payload.recurrence }, new Date());
      if (d) payload.nextDueDate = d.toISOString();
    }
    return payload;
  };

  const writeTask = async (payload: Record<string, unknown>, targetId?: string) =>
    targetId
      ? tasksApi.update(targetId, await sealUpdate('MaintenanceTask', targetId, payload, TASK_ENC({ ...decryptedTask.current, ...payload })))
      : tasksApi.create(await sealNew('MaintenanceTask', payload, TASK_ENC(payload)));

  const save = useMutation({
    // The scope picked in the save sheet. A create, a one-time task, and an
    // edit made from the series' first occurrence all arrive as 'series'.
    mutationFn: async (scope: ItemScope = 'series') => {
      const editing = decryptedTask.current;
      // "Save for Future" chosen ON the series' first occurrence has nothing
      // behind it to preserve: truncating would leave an empty husk beside the
      // fork. The whole-series rewrite IS that outcome, so the choice resolves
      // to it here — the sheet still asked, because the user is applying a
      // change to every future occurrence either way.
      const futureIsWholeSeries =
        scope === 'future' && !!editing && isFirstItemOccurrence(editing, date);
      if (!isEdit || scope === 'series' || futureIsWholeSeries) {
        return writeTask(buildPayload('series'), isEdit ? id! : undefined);
      }

      const occDay = date || seriesAnchorRef.current;
      const payload = buildPayload('occurrence');

      if (scope === 'occurrence') {
        // "Save for This Task Only": a standalone one-time task on this day, and
        // the day struck out of the series. The fork is a NEW record, so the
        // completion ledger (keyed on the original's id) stays with the series —
        // history describes the schedule that produced it.
        payload.recurrence = { type: 'one-time' };
        // Link back to the series so "Resume schedule" can tell this day already
        // has a standalone copy and leave it skipped rather than double-booking it.
        payload.detachedFrom = id!;
        payload.detachedDate = occDay;
        const created = await writeTask(payload);
        try {
          await tasksApi.skipOccurrence(id!, occDay);
        } catch (e) {
          // The override exists but the series still shows this day — two tasks
          // on one cell. Undo the half that landed.
          await tasksApi.delete(created.data._id).catch(() => {});
          throw e;
        }
        return created;
      }

      // "Save for Future Tasks": end the old series the day before this
      // occurrence and start a new one here carrying the edits. Skips from here
      // on ride along, moved by however far the occurrence was dragged.
      const rec = (payload.recurrence as Record<string, unknown>) ?? {};
      const oldSkips = ((decryptedTask.current?.recurrence as { skipDates?: string[] } | undefined)?.skipDates) ?? [];
      const delta = daysBetween(occDay, form.nextDueDate || occDay);
      payload.recurrence = {
        ...rec,
        skipDates: oldSkips.filter((d) => d >= occDay).map((d) => addDays(d, delta)),
      };
      const created = await writeTask(payload);
      try {
        await tasksApi.truncateSeries(id!, occDay);
      } catch (e) {
        // Without the truncation the old series still covers these days, so the
        // fork would double every remaining occurrence.
        await tasksApi.delete(created.data._id).catch(() => {});
        throw e;
      }
      return created;
    },
    onSuccess: (res, scope) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      // An occurrence override or a series fork wrote a NEW record and left the
      // original skipped/truncated, so the detail screen under this form is still
      // bound to the old id and day — going straight back would show the unedited
      // task (and, after an override, a day the series no longer has). Rebind it
      // to what was just saved.
      // Keyed on the id actually written rather than the chosen scope, since
      // "future" from the first occurrence rewrites in place and creates nothing.
      if (isEdit && res?.data?._id && res.data._id !== id) {
        rebindDetailBelow(navigation, 'TaskDetail', { id: res.data._id, date: form.nextDueDate });
      } else {
        navigation.goBack();
      }
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Save failed'),
  });

  const onSave = () => {
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    setError('');
    const original = decryptedTask.current;
    if (!isEdit || !original || !dirtyRef.current) {
      save.mutate('series');
      return;
    }
    const decision = itemSaveScopeDecision(original, buildPayload('series'));
    if (decision.kind === 'none') {
      save.mutate('series');
      return;
    }
    // Cancel resolves to null: stay on the form with the edits intact.
    promptItemSaveScope('task', decision, (scope) => {
      if (scope) save.mutate(scope);
    });
  };

  // Delete from the edit form — the same control the task's detail page carries,
  // so the user who opened the form to change something and decided to bin it
  // instead doesn't have to back out first. A one-time task confirms once; a
  // repeating one offers the "this task" / "all future" choices against the
  // occurrence the form is showing. The chosen action is the mutation's argument,
  // so Delete keeps its pending state whichever scope is picked.
  const del = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      // Past the detail below, which is bound to what was just deleted.
      popPastDetail(navigation, 'TaskDetail');
    },
    onError: (e: any) => Alert.alert("Couldn't delete task", e?.response?.data?.error || 'Delete failed'),
  });

  const onDelete = () => {
    if (!decryptedTask.current) return;
    promptItemDelete('task', decryptedTask.current, date, (perform) => del.mutate(perform));
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
  // `onSave` is declared above but only runs from a tap, by which point this
  // holds the current render's value.
  dirtyRef.current = dirty;

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
          inlineLabel={dueDateLabel}
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
      {/* Names the occurrence being edited. Without it the form looks like the
          whole task, and the save sheet's "This … Only" choice has no
          visible referent. */}
      {editingOccurrence ? (
        <Hint>{`Editing the ${formatCalendarDate(form.nextDueDate)} task in this repeating series.`}</Hint>
      ) : null}

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

      {isEdit ? (
        <View style={fs.footer}>
          <Button title="Delete Task" variant="danger" loading={del.isPending} onPress={onDelete} />
        </View>
      ) : null}
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
