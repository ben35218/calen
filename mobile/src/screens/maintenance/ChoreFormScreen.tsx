import React, { useEffect, useState } from 'react';
import { View, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { seedDueDate } from '@household/calendar';
import { choresApi, householdApi, contactsApi, settingsApi, FormAssistField, Chore } from '../../api';
import { sealNew, sealUpdate, openRecord } from '../../lib/e2ee';
import { CHORE_ENC } from '../../lib/encSubsets';
import { useAuth } from '../../store/auth';
import { Input, Select, Screen, DateField, TimeField, NavField, useHeaderCheckButton, FormError, CenteredLoader, Button, Hint } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import FormAssist from '../../components/FormAssist';
import IconPicker from '../../components/IconPicker';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  formatCalendarDate,
  recurrenceToRule,
  ruleToRecurrence,
  dueDateForRule,
  ruleDateMismatch,
  recurrenceAssistFields,
  recurrenceAssistCurrent,
  patchTouchesRecurrence,
  applyRecurrenceAssistPatch,
  ALERT_DAY_OPTIONS,
  AUDIENCE_OPTIONS,
  excludeUsedAlert,
  mdiName,
} from '../../lib/recurrence';
import { RepeatRule, EMPTY_REPEAT, repeatSummary, repeatsLine } from '../../lib/eventRepeat';
import { useRepeatDraft, clearRepeatDraft } from '../../lib/repeatDraft';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { choreAssigneeOptions, matchAssigneeByName } from '../../lib/choreAssignees';
import { ymd, addDays, daysBetween } from '../../lib/calendar';
import {
  ItemScope, itemSaveScopeDecision, isFirstItemOccurrence, promptItemSaveScope, itemRepeats, promptItemDelete,
} from '../../lib/repeatingItemScope';
import { rebindDetailBelow, popPastDetail } from '../../navigation/rebindDetailBelow';
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
  const { id, date } = useRoute<Rt>().params || {};
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

  // A repeat change reseeds Next Due Date from the new rule — the date the old
  // cadence produced has no meaning under the new one (client-owned due-date
  // lifecycle, Signal-parity D4). "Does not repeat" implies no date, so turning
  // the repeat off leaves the picked date alone.
  const dueDateFor = (rule: RepeatRule): string | null => {
    const d = dueDateForRule(rule);
    return d ? ymd(d) : null;
  };

  // Edits made on the pushed Repeat screen sync back live via the draft store.
  const repeatDraft = useRepeatDraft();
  useEffect(() => {
    if (!repeatDraft) return;
    setRepeatRule(repeatDraft);
    const due = dueDateFor(repeatDraft);
    if (due) {
      setForm((f) => (f.nextDueDate === due ? f : { ...f, nextDueDate: due }));
      assist.clear(['nextDueDate']);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatDraft]);
  useEffect(() => () => clearRepeatDraft(), []);

  const set = (patch: Partial<ChoreFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  // Names are sealed Contact content — decrypt so the assignee options read as
  // names, not ciphertext (and to match the shared ['contacts'] cache elsewhere).
  const contactsQ = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => Promise.all((await contactsApi.list()).data.map((p) => openRecord('Contact', p))),
  });
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const memberCount = settingsQ.data?.householdMemberCount ?? 1;
  const householdQ = useQuery({ queryKey: ['household'], queryFn: async () => (await householdApi.get()).data });

  const myId = String(user?._id ?? '');
  const memberIds = (householdQ.data?.members ?? []).map((m) => String(m._id));
  // Household members only — a chore belongs to someone who lives here, not to a
  // contact. The picker also carries an existing non-member assignee; the
  // assistant's option list never does, so it can't assign one.
  const memberOptions = choreAssigneeOptions({ contacts: contactsQ.data ?? [], memberIds, myId });
  const assigneeOptions = choreAssigneeOptions({
    contacts: contactsQ.data ?? [], memberIds, myId, currentAssigneeId: form.assignedTo,
  });

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
    { name: 'assignedTo', type: 'select', label: 'Assigned to', options: memberOptions },
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
      const rule = applyRecurrenceAssistPatch(repeatRule, patch);
      setRepeatRule(rule);
      changedKeys.push('recurrence');
      // Same reset as the Repeat screen — unless the assistant named a due date
      // itself, in which case the field loop below wins.
      const due = dueDateFor(rule);
      if (due && patch.nextDueDate == null) {
        next.nextDueDate = due;
        changedKeys.push('nextDueDate');
      }
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
  // The series' own anchor day, kept aside because the form displays the
  // OCCURRENCE the user tapped instead. A whole-series save shifts back by the
  // difference; without that, saving from the third occurrence would drag the
  // whole chore's anchor onto that day.
  const seriesAnchorRef = React.useRef<string>('');
  // Mirrors `dirty`, which is computed below the save handler.
  const dirtyRef = React.useRef(false);

  useEffect(() => {
    if (!choreQ.data) return;
    let cancelled = false;
    (async () => {
    const c = await openRecord('Chore', choreQ.data); // decrypt content over plaintext
    if (cancelled) return;
    decryptedChore.current = c;
    const anchor = c.nextDueDate ? c.nextDueDate.slice(0, 10) : '';
    seriesAnchorRef.current = anchor;
    const repeats = !!c.recurrence?.type && c.recurrence.type !== 'one-time';
    const occurrenceDue = repeats && date ? date : anchor;
    const assignedTo =
      typeof c.assignedTo === 'object' && c.assignedTo ? c.assignedTo._id ?? null : (c.assignedTo as string) ?? null;
    setForm({
      title: c.title ?? '',
      instructions: c.instructions ?? c.description ?? '',
      icon: c.icon || 'mdi-broom',
      assignedTo,
      // The occurrence the user opened, not the series anchor (Apple shows the
      // day you tapped). `date` is only passed from a calendar cell.
      nextDueDate: occurrenceDue,
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
    // Icon and alert settings, each validated against what the form itself
    // offers — a draft value the pickers don't carry is dropped, not saved.
    if (prefill.icon != null) {
      const name = mdiName(String(prefill.icon));
      if (CHORE_ICONS.includes(name)) set({ icon: `mdi-${name}` });
    }
    const alertDay = (v: unknown): number | undefined =>
      typeof v === 'number' && ALERT_DAY_OPTIONS.some((o) => o.value === v) ? v : undefined;
    const firstAlert = alertDay(prefill.reminderDaysBefore);
    if (firstAlert !== undefined) set({ reminderDaysBefore: firstAlert });
    const secondAlert = alertDay(prefill.alert2DaysBefore);
    if (secondAlert !== undefined && secondAlert !== firstAlert) set({ alert2DaysBefore: secondAlert });
    if (typeof prefill.reminderTime === 'string' && /^\d{1,2}:\d{2}$/.test(prefill.reminderTime)) {
      set({ reminderTime: prefill.reminderTime.padStart(5, '0') });
    }
    if (prefill.alertAudience === 'everyone' || prefill.alertAudience === 'owner') {
      set({ alertAudience: prefill.alertAudience });
    }
    if (prefill.recurrence) {
      const rule = recurrenceToRule(prefill.recurrence);
      setRepeatRule(rule);
      // Show the due date the drafted cadence produces rather than a blank field
      // the save path would fill in silently.
      const due = dueDateFor(rule);
      if (due) set({ nextDueDate: due });
    }
    // The draft's own first-occurrence date beats the interval-from-today seed
    // above — "every 2 weeks starting this Sunday" must anchor on that Sunday
    // (the anchor day IS the pattern day for an interval series).
    if (typeof prefill.firstDueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(prefill.firstDueDate)) {
      set({ nextDueDate: prefill.firstDueDate });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The draft names its assignee (the assistant only ever sees the name the
  // user typed); the ids live on-device, so the match waits for the member
  // options to finish loading. One shot — matched or not, it never re-runs, so
  // a hand-cleared field stays cleared.
  const draftAssigneeRef = React.useRef<string | null>(
    !isEdit && prefill && prefill.assignedToName != null ? String(prefill.assignedToName) : null
  );
  useEffect(() => {
    const name = draftAssigneeRef.current;
    if (!name || !contactsQ.isFetched || !householdQ.isFetched) return;
    draftAssigneeRef.current = null;
    const match = matchAssigneeByName(memberOptions, name);
    if (match) set({ assignedTo: match.value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactsQ.isFetched, householdQ.isFetched]);

  // Everything the form knows, in one frame. 'occurrence' is the day the form
  // literally shows — where a detached one-off or a forked series begins;
  // 'series' shifts the due date back onto the record's own anchor.
  // Opened from a calendar cell, the date field holds the OCCURRENCE the user
  // tapped, not the series' anchor — so "Next Due Date" would name the wrong
  // thing (the next due date may be months behind what's shown). Call it what
  // it is in that frame, and say which occurrence is being edited, since that
  // is what the scope sheet will act on when they save.
  const editingOccurrence = isEdit && !!date && itemRepeats(decryptedChore.current);
  const dueDateLabel = editingOccurrence ? 'Date' : 'Next Due Date';

  const buildPayload = (frame: 'occurrence' | 'series'): Record<string, unknown> => {
    const recurrence: Record<string, unknown> = { ...ruleToRecurrence(repeatRule) };
    // The Repeat screen edits only the rule; the skip/end bookkeeping sealed
    // beside it rides along — without this a plain series save resurrects
    // every skipped day and un-ends an ended series.
    const prior = decryptedChore.current?.recurrence as
      | { skipDates?: string[]; until?: string | Date | null }
      | undefined;
    if (recurrence.type !== 'one-time' && prior) {
      if (prior.skipDates?.length) recurrence.skipDates = prior.skipDates;
      if (prior.until != null) recurrence.until = prior.until;
    }
    const payload: Record<string, unknown> = {
      title: form.title,
      instructions: form.instructions,
      icon: form.icon,
      assignedTo: form.assignedTo || null,
      reminderDaysBefore: form.reminderDaysBefore,
      alert2DaysBefore: form.reminderDaysBefore == null ? null : form.alert2DaysBefore,
      reminderTime: form.reminderDaysBefore == null ? null : (form.reminderTime || null),
      alertAudience: form.alertAudience,
      recurrence,
    };
    const due =
      frame === 'series' && seriesAnchorRef.current && date
        ? addDays(seriesAnchorRef.current, daysBetween(date, form.nextDueDate || date))
        : form.nextDueDate;
    if (due) payload.nextDueDate = due;
    // Client-owned due-date lifecycle (Signal-parity D4): seed the first due
    // date from the recurrence when the user didn't pick one.
    if (!isEdit && !payload.nextDueDate && recurrence.type !== 'one-time') {
      const d = seedDueDate(recurrence, new Date());
      if (d) payload.nextDueDate = new Date(d).toISOString();
    }
    return payload;
  };

  const writeChore = async (payload: Record<string, unknown>, targetId?: string) =>
    targetId
      ? choresApi.update(targetId, await sealUpdate('Chore', targetId, payload, CHORE_ENC({ ...decryptedChore.current, ...payload })))
      : choresApi.create(await sealNew('Chore', payload, CHORE_ENC(payload)));

  const save = useMutation({
    // The scope picked in the save sheet. A create, a one-time chore, and an
    // edit made from the series' first occurrence all arrive as 'series'.
    mutationFn: async (scope: ItemScope = 'series') => {
      const editing = decryptedChore.current;
      // "Save for Future" chosen ON the series' first occurrence has nothing
      // behind it to preserve: truncating would leave an empty husk beside the
      // fork. The whole-series rewrite IS that outcome, so the choice resolves
      // to it here — the sheet still asked, because the user is applying a
      // change to every future occurrence either way.
      const futureIsWholeSeries =
        scope === 'future' && !!editing && isFirstItemOccurrence(editing, date);
      if (!isEdit || scope === 'series' || futureIsWholeSeries) {
        return writeChore(buildPayload('series'), isEdit ? id! : undefined);
      }

      const occDay = date || seriesAnchorRef.current;
      const payload = buildPayload('occurrence');

      if (scope === 'occurrence') {
        // "Save for This Chore Only": a standalone one-time chore on this day,
        // and the day struck out of the series. A detached override doesn't
        // repeat, so it carries no rule and no skips of its own.
        payload.recurrence = { type: 'one-time' };
        // Link back to the series so "Resume schedule" can tell this day already
        // has a standalone copy and leave it skipped rather than double-booking it.
        payload.detachedFrom = id!;
        payload.detachedDate = occDay;
        const created = await writeChore(payload);
        try {
          await choresApi.skipOccurrence(id!, occDay);
        } catch (e) {
          // The override exists but the series still shows this day — two chores
          // on one cell. Undo the half that landed.
          await choresApi.delete(created.data._id).catch(() => {});
          throw e;
        }
        return created;
      }

      // "Save for Future Chores": end the old series the day before this
      // occurrence and start a new one here carrying the edits. Skips from here
      // on ride along, moved by however far the occurrence was dragged.
      const rec = (payload.recurrence as Record<string, unknown>) ?? {};
      const oldSkips = ((decryptedChore.current?.recurrence as { skipDates?: string[] } | undefined)?.skipDates) ?? [];
      const delta = daysBetween(occDay, form.nextDueDate || occDay);
      payload.recurrence = {
        ...rec,
        skipDates: oldSkips.filter((d) => d >= occDay).map((d) => addDays(d, delta)),
      };
      // Link the fork to the series it truncates, so the Chores list can show
      // the pair as ONE chore (this record stands for both).
      payload.splitFrom = id!;
      const created = await writeChore(payload);
      try {
        await choresApi.truncateSeries(id!, occDay);
      } catch (e) {
        // Without the truncation the old series still covers these days, so the
        // fork would double every remaining occurrence.
        await choresApi.delete(created.data._id).catch(() => {});
        throw e;
      }
      return created;
    },
    onSuccess: (res, scope) => {
      qc.invalidateQueries({ queryKey: ['chores'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      // An occurrence override or a series fork wrote a NEW record and left the
      // original skipped/truncated, so the detail screen under this form is still
      // bound to the old id and day — going straight back would show the unedited
      // chore (and, after an override, a day the series no longer has). Rebind it
      // to what was just saved.
      // Keyed on the id actually written rather than the chosen scope, since
      // "future" from the first occurrence rewrites in place and creates nothing.
      if (isEdit && res?.data?._id && res.data._id !== id) {
        rebindDetailBelow(navigation, 'ChoreDetail', { id: res.data._id, date: form.nextDueDate });
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
    // A saved date becomes the series' pattern anchor, so a day the rule never
    // generates ("every week on Tuesday" due on a Wednesday) can't be saved —
    // except by "Save for This Chore Only", which detaches the day as a
    // one-time copy and so may land anywhere. That scope skips this check in
    // the prompt callback below.
    const mismatch = form.nextDueDate ? ruleDateMismatch(repeatRule, form.nextDueDate) : null;
    const original = decryptedChore.current;
    if (!isEdit || !original || !dirtyRef.current) {
      if (mismatch) {
        setError(mismatch);
        return;
      }
      save.mutate('series');
      return;
    }
    // The date field holds the occurrence's day, and the payload diff ignores
    // `nextDueDate` (the rule reseeds it), so a moved date is reported to the
    // decision explicitly — otherwise "do this one on Friday instead" saved
    // silently as a whole-series re-anchor.
    const occurrenceDateMoved = editingOccurrence && !!form.nextDueDate && form.nextDueDate !== date;
    const decision = itemSaveScopeDecision(original, buildPayload('series'), { occurrenceDateMoved });
    if (decision.kind === 'none') {
      if (mismatch) {
        setError(mismatch);
        return;
      }
      save.mutate('series');
      return;
    }
    // Cancel resolves to null: stay on the form with the edits intact.
    promptItemSaveScope('chore', decision, (scope) => {
      if (!scope) return;
      if (scope !== 'occurrence' && mismatch) {
        setError(mismatch);
        return;
      }
      save.mutate(scope);
    });
  };

  // Delete from the edit form — the same control the chore's detail page carries,
  // so the user who opened the form to change something and decided to bin it
  // instead doesn't have to back out first. A one-time chore confirms once; a
  // repeating one offers the "this chore" / "all future" choices against the
  // occurrence the form is showing. The chosen action is the mutation's argument,
  // so Delete keeps its pending state whichever scope is picked.
  const del = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chores'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      // Past the detail below, which is bound to what was just deleted.
      popPastDetail(navigation, 'ChoreDetail');
    },
    onError: (e: any) => Alert.alert("Couldn't delete chore", e?.response?.data?.error || 'Delete failed'),
  });

  const onDelete = () => {
    if (!decryptedChore.current) return;
    promptItemDelete('chore', decryptedChore.current, date, (perform) => del.mutate(perform));
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
  // `onSave` is declared above but only runs from a tap, by which point this
  // holds the current render's value.
  dirtyRef.current = dirty;

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
        accent={accent}
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
        {/* One self-labeled line ("Repeats every 1 week on Tue & Thu") — the
            whole rule stays readable at a glance without a left label
            competing for the row's width. */}
        <NavField
          value={repeatsLine(repeatRule)}
          onPress={openRepeatScreen}
          highlight={assist.changed.has('recurrence')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
        />
      </GroupCard>
      {/* Names the occurrence being edited. Without it the form looks like the
          whole chore, and the save sheet's "This … Only" choice has no
          visible referent. Pinned to the TAPPED day, not the live date field —
          moving the date must keep naming the occurrence being replaced. */}
      {editingOccurrence ? (
        <Hint>{`Editing the ${formatCalendarDate(date)} chore in this repeating series.`}</Hint>
      ) : null}

      <GroupCard>
        <Select
          inlineLabel="Assigned to"
          clearable
          placeholder="Unassigned"
          value={form.assignedTo ?? undefined}
          options={assigneeOptions}
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

      {isEdit ? (
        <View style={fs.footer}>
          <Button title="Delete Chore" variant="danger" loading={del.isPending} onPress={onDelete} />
        </View>
      ) : null}
    </Screen>
  );
}
