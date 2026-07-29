import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { computeNextDueDate } from '@household/calendar';
import { choresApi, peopleApi, settingsApi, FormAssistField, Chore } from '../../api';
import { sealNew, sealUpdate, openRecord } from '../../lib/e2ee';
import { CHORE_ENC } from '../../lib/encSubsets';
import { useAuth } from '../../store/auth';
import { Input, Select, Screen, DateField, TimeField, NavField, useHeaderCheckButton, FormError, CenteredLoader } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
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
  AUDIENCE_OPTIONS,
  excludeUsedAlert,
  mdiName,
} from '../../lib/recurrence';
import { RepeatRule, EMPTY_REPEAT, repeatSummary } from '../../lib/eventRepeat';
import { useRepeatDraft, clearRepeatDraft } from '../../lib/repeatDraft';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'ChoreForm'>;
type Rt = RouteProp<MaintenanceStackParamList, 'ChoreForm'>;

// Ported from ChoreFormView's CHORE_ICONS (mdi- prefix stripped for RN).
const CHORE_ICONS = [
  // Cleaning & indoor
  'broom', 'vacuum', 'spray-bottle', 'bucket', 'washing-machine', 'tumble-dryer',
  'dishwasher', 'trash-can', 'recycle', 'shower', 'toilet', 'bed', 'sofa',
  'window-closed', 'iron',
  // Kitchen & appliances
  'fridge', 'stove', 'microwave', 'coffee-maker', 'kettle', 'food-fork-drink',
  // Outdoor & grounds
  'flower', 'leaf', 'grass', 'pine-tree', 'shovel', 'mower', 'sprinkler-variant',
  'fence', 'saw-blade', 'grill', 'pool', 'hot-tub', 'snowflake',
  // Home systems & repair
  'wrench', 'hammer', 'screwdriver', 'tools', 'ladder', 'format-paint',
  'lightbulb', 'water', 'fire', 'garage', 'home-roof', 'air-filter',
  'smoke-detector', 'fire-extinguisher', 'solar-panel',
  // Vehicles
  'car', 'oil', 'car-battery', 'tire', 'ev-station', 'fuel',
  // Errands & misc
  'cart', 'dog', 'mailbox-outline', 'pill',
];

interface ChoreFormState {
  title: string;
  instructions: string;
  icon: string;
  assignedTo: string | null;
  nextDueDate: string;
  reminderDaysBefore: number | null;
  alert2DaysBefore: number | null;
  reminderTime: string;
  alertAudience: string;
}

const EMPTY: ChoreFormState = {
  title: '',
  instructions: '',
  icon: 'mdi-broom',
  assignedTo: null,
  nextDueDate: '',
  reminderDaysBefore: 0,
  alert2DaysBefore: null,
  reminderTime: '',
  alertAudience: 'everyone',
};

export default function ChoreFormScreen() {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.chores;
  const { id } = useRoute<Rt>().params || {};
  const isEdit = !!id;
  const qc = useQueryClient();
  const { user } = useAuth();

  const [form, setForm] = useState<ChoreFormState>(EMPTY);
  // Recurrence is edited on the shared calendar Repeat screen; we hold its rule
  // here and convert to/from the chore recurrence shape on load/save.
  const [repeatRule, setRepeatRule] = useState<RepeatRule>({ ...EMPTY_REPEAT, freq: 'weekly', interval: 1 });
  const [error, setError] = useState('');
  // A new chore is ready immediately; an edit waits for the chore to load and
  // seed below before the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!isEdit);
  const assist = useFormAssist();

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Chore' : 'Add Chore' });
  }, [navigation, isEdit]);

  // Edits made on the pushed Repeat screen sync back live via the draft store.
  const repeatDraft = useRepeatDraft();
  useEffect(() => {
    if (repeatDraft) setRepeatRule(repeatDraft);
  }, [repeatDraft]);
  useEffect(() => () => clearRepeatDraft(), []);

  const set = (patch: Partial<ChoreFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  // Names are sealed Person content — decrypt so the assignee options read as
  // names, not ciphertext (and to match the shared ['people'] cache elsewhere).
  const peopleQ = useQuery({
    queryKey: ['people'],
    queryFn: async () => Promise.all((await peopleApi.list()).data.map((p) => openRecord('Person', p))),
  });
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const memberCount = settingsQ.data?.householdMemberCount ?? 1;

  const myId = String(user?._id ?? '');
  const familyOptions = (peopleQ.data ?? [])
    .filter((p) => p.type === 'family')
    .map((p) => ({
      value: p._id,
      label: p.accountId && String(p.accountId) === myId ? `${p.name} (You)` : p.name,
    }));

  const alertOptions = ALERT_DAY_OPTIONS.map((o) => ({ label: o.label, value: o.value ?? -1 }));
  const assistFields: FormAssistField[] = [
    { name: 'title', type: 'text', label: 'Chore title' },
    { name: 'instructions', type: 'text', label: 'Instructions' },
    {
      name: 'icon',
      type: 'select',
      label: 'Icon',
      description: 'The most fitting glyph for the chore',
      options: CHORE_ICONS.map((n) => ({ label: n, value: `mdi-${n}` })),
    },
    { name: 'assignedTo', type: 'select', label: 'Assigned to', options: familyOptions },
    { name: 'nextDueDate', type: 'date', label: 'Next due date' },
    ...recurrenceAssistFields(),
    { name: 'reminderDaysBefore', type: 'select', label: 'Alert', description: 'When to send the first reminder', options: alertOptions },
    { name: 'alert2DaysBefore', type: 'select', label: 'Second alert', description: 'An optional second reminder', options: alertOptions },
    { name: 'alertAudience', type: 'select', label: 'Alert who', description: 'Who receives the alerts', options: AUDIENCE_OPTIONS },
  ];

  const applyPatch = (patch: Record<string, unknown>) => {
    const next: Partial<ChoreFormState> = {};
    const changedKeys: string[] = [];
    if (patchTouchesRecurrence(patch)) {
      setRepeatRule((prev) => applyRecurrenceAssistPatch(prev, patch));
      changedKeys.push('recurrence');
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in EMPTY)) continue;
      // The two alert selects use -1 as the "No alert" sentinel; state holds null.
      const val = (k === 'reminderDaysBefore' || k === 'alert2DaysBefore') && v === -1 ? null : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    setForm((f) => ({ ...f, ...next }));
    assist.mark(changedKeys);
  };

  const choreQ = useQuery({
    queryKey: ['chores', id],
    queryFn: async () => (await choresApi.get(id!)).data,
    enabled: isEdit,
  });

  // The decrypted record backing an edit — spread under the update at seal time
  // so content fields the form doesn't edit survive the shared CHORE_ENC subset.
  const decryptedChore = React.useRef<Chore | null>(null);

  useEffect(() => {
    if (!choreQ.data) return;
    let cancelled = false;
    (async () => {
    const c = await openRecord('Chore', choreQ.data); // decrypt content over plaintext
    if (cancelled) return;
    decryptedChore.current = c;
    const assignedTo =
      typeof c.assignedTo === 'object' && c.assignedTo ? c.assignedTo._id ?? null : (c.assignedTo as string) ?? null;
    setForm({
      title: c.title ?? '',
      instructions: c.instructions ?? c.description ?? '',
      icon: c.icon || 'mdi-broom',
      assignedTo,
      nextDueDate: c.nextDueDate ? c.nextDueDate.slice(0, 10) : '',
      reminderDaysBefore: c.reminderDaysBefore ?? 0,
      alert2DaysBefore: c.alert2DaysBefore ?? null,
      reminderTime: c.reminderTime ?? '',
      alertAudience: c.alertAudience ?? 'everyone',
    });
    setRepeatRule(recurrenceToRule(c.recurrence));
    setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [choreQ.data]);

  // A new chore drafted by the Chores assistant: seed the form so the user can
  // review and save it. Only on a fresh form (no id); runs once.
  const prefill = useRoute<Rt>().params?.prefill as Record<string, any> | undefined;
  useEffect(() => {
    if (isEdit || !prefill) return;
    if (prefill.title != null) set({ title: String(prefill.title) });
    if (prefill.instructions != null) set({ instructions: String(prefill.instructions) });
    if (prefill.recurrence) setRepeatRule(recurrenceToRule(prefill.recurrence));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        title: form.title,
        instructions: form.instructions,
        icon: form.icon,
        assignedTo: form.assignedTo || null,
        reminderDaysBefore: form.reminderDaysBefore,
        alert2DaysBefore: form.reminderDaysBefore == null ? null : form.alert2DaysBefore,
        reminderTime: form.reminderDaysBefore == null ? null : (form.reminderTime || null),
        alertAudience: form.alertAudience,
        recurrence: ruleToRecurrence(repeatRule),
      };
      if (form.nextDueDate) payload.nextDueDate = form.nextDueDate;
      // Client-owned due-date lifecycle (Signal-parity D4): seed the first due
      // date from the recurrence when the user didn't pick one.
      if (!isEdit && !payload.nextDueDate && (payload.recurrence as { type?: string } | undefined)?.type !== 'one-time') {
        const d = computeNextDueDate({ recurrence: payload.recurrence }, new Date());
        if (d) payload.nextDueDate = d.toISOString();
      }
      return isEdit
        ? choresApi.update(id!, await sealUpdate('Chore', id!, payload, CHORE_ENC({ ...decryptedChore.current, ...payload })))
        : choresApi.create(await sealNew('Chore', payload, CHORE_ENC(payload)));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chores'] });
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

  // Discard guard: prompt before leaving with unsaved edits to the chore fields
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

  if (isEdit && choreQ.isLoading) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  return (
    <Screen>
      <FormAssist
        formType="household chore"
        placeholder={'Describe the chore, e.g. "take out the recycling every Sunday, assign to Alex"'}
        fields={assistFields}
        current={{ ...form, ...recurrenceAssistCurrent(repeatRule), recurrence: repeatSummary(repeatRule) }}
        onApply={applyPatch}
      />

      <GroupCard>
        <Input
          value={form.title}
          onChangeText={(v) => set({ title: v })}
          placeholder="Chore Title"
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('title') && fs.headInputHighlight]}
        />
        <CardDivider />
        <IconPicker
          value={mdiName(form.icon)}
          onChange={(name) => set({ icon: `mdi-${name}` })}
          suggested={CHORE_ICONS}
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
          inlineLabel="Assigned to"
          clearable
          placeholder="Unassigned"
          value={form.assignedTo ?? undefined}
          options={familyOptions}
          onChange={(v) => set({ assignedTo: (v as string) ?? null })}
          highlight={assist.changed.has('assignedTo')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
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
              value={form.alertAudience}
              options={AUDIENCE_OPTIONS}
              onChange={(v) => set({ alertAudience: (v as string) ?? 'everyone' })}
              highlight={assist.changed.has('alertAudience')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
      </GroupCard>

      <Input
        value={form.instructions}
        onChangeText={(v) => set({ instructions: v })}
        multiline
        placeholder="Add instructions…"
        style={fs.notes}
        highlight={assist.changed.has('instructions')}
      />

      <FormError>{error}</FormError>
    </Screen>
  );
}
