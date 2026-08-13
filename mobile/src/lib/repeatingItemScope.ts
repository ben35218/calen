// Apple-style occurrence scoping for repeating CHORES and MAINTENANCE TASKS —
// the same "This Occurrence Only / All Future" split the calendar's events get
// (lib/eventDelete, lib/eventSave), applied to the other two things on the
// calendar that repeat.
//
// Chores and tasks share one recurrence shape ({type, intervalValue,
// intervalUnit, months, dayOfMonth, dayOfWeek, weekOfMonth} plus the skipDates /
// until this file drives), so one module serves both; the only per-domain
// difference is which api group performs the write and what the sheet calls the
// thing. `one-time` items don't repeat and get a plain confirm.
//
// Trips are deliberately absent: neither Trip nor TripItem has a recurrence
// field, and trip itinerary items never reach the calendar. See specs/features/trips.md.
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import { expandRecurringTaskChore } from '@household/calendar';
import { choresApi, tasksApi } from '../api';
import { ymd } from './calendar';

export type ItemDomain = 'chore' | 'task';
export type ItemScope = 'series' | 'occurrence' | 'future';

// Structural, and deliberately loose about null vs undefined: the api's
// `Recurrence` uses `number | null` for its anchors, and a chore or task read
// off the replica satisfies this without a cast.
export interface ItemRecurrenceShape {
  type?: string;
  intervalValue?: number;
  intervalUnit?: string;
  months?: number[];
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
  weekOfMonth?: number | null;
  skipDates?: string[];
  until?: string | Date | null;
}

export interface RepeatingItem {
  _id: string;
  title?: string;
  nextDueDate?: string | Date | null;
  recurrence?: ItemRecurrenceShape | null;
  // Present on a copy made by "Save for This … Only": the series it left and the
  // day it stands in for.
  detachedFrom?: string | null;
  detachedDate?: string | null;
  // Present on a series created by "Save for Future …": the truncated series it
  // forked from.
  splitFrom?: string | null;
}

type Rec = Record<string, unknown>;

// What the sheet calls the thing, per domain.
const NOUN: Record<ItemDomain, string> = { chore: 'Chore', task: 'Task' };

// Consequence of destroying the RECORD (as opposed to skipping an occurrence or
// truncating the series). A task's completion ledger is keyed on the task id, so
// it goes with the record; skipping or truncating leaves both in place. The note
// is therefore attached to the outcomes that actually cause it, not stated up
// front for a sheet whose choices mostly don't.
const WHOLE_RECORD_NOTE: Partial<Record<ItemDomain, string>> = {
  task: 'This also removes all completion history.',
};

// Resolved per call rather than snapshotted into a module-level map: the api
// module pulls in the record store and the replica, so binding it at load time
// makes this module's import order load-bearing.
function apiFor(domain: ItemDomain) {
  return domain === 'chore' ? choresApi : tasksApi;
}

// A one-time item has no series to scope against; neither does a record with no
// recurrence at all (older rows, or a template that never set one).
export function itemRepeats(item: RepeatingItem | null | undefined): boolean {
  const t = item?.recurrence?.type;
  return !!t && t !== 'one-time';
}

// The day the series is currently anchored on. Chores and tasks are date-only
// (no all-day/timed split), so this is always the local day of `nextDueDate` —
// the same key expandRecurringTaskChore stamps as `_instanceDate`.
export function itemStartDay(item: RepeatingItem): string | undefined {
  if (!item.nextDueDate) return undefined;
  const d = new Date(item.nextDueDate as string);
  return Number.isNaN(d.getTime()) ? undefined : ymd(d);
}

// Whether the item still has an occurrence today or later.
//
// "Delete All Future" ends the series with `recurrence.until` rather than
// destroying the record, precisely so the days already behind it keep their
// occurrences — that is what distinguishes it from deleting the whole thing. But
// the Chores and Maintenance lists exist to show **outstanding work**, and a
// series with nothing left ahead of it is finished: leaving it listed (still
// advertising its old anchor as a "next due date") is how a chore the user just
// ended goes on looking live.
//
// An unbounded series always qualifies, so this costs nothing for the common
// case. When there IS an `until`, the expansion window is bounded by it, so the
// check is cheap and exact rather than a guess from `nextDueDate`.
export function hasUpcomingOccurrence(item: RepeatingItem, now: Date = new Date()): boolean {
  const until = item.recurrence?.until;
  if (!until) return true;
  const end = new Date(until as string);
  if (Number.isNaN(end.getTime())) return true;
  const from = new Date(now);
  from.setHours(0, 0, 0, 0); // an item due TODAY is still outstanding
  if (end < from) return false;
  return expandRecurringTaskChore(item, from, end).length > 0;
}

// One card per chore: which records a management list (the Chores list) shows.
//
// Occurrence scoping works by writing NEW records — "Save for This … Only"
// leaves a detached one-time copy beside the series, and "Save for Future …"
// leaves the truncated old series beside its fork — but to the user those are
// still ONE chore, and a list that shows every record advertises the plumbing:
// the moved occurrence turns up as a second "one-time" card, and a forked
// series lists twice (old version and new). A record is therefore hidden when
// another record in the list already stands for it:
//   - a detached copy hides behind the series it left (`detachedFrom`) — the
//     occurrence still renders on its calendar day, which is where a single
//     day's override belongs;
//   - a truncated predecessor hides behind the fork that carries the chore
//     forward (the successor's `splitFrom` names it).
// Both rules require the OTHER record to actually be present: if the series (or
// the fork) has since been deleted, the survivor is all that's left of the
// chore and lists normally.
export function collapseScopedRecords<T extends RepeatingItem>(items: T[]): T[] {
  const present = new Set(items.map((i) => String(i._id)));
  const superseded = new Set(
    items.filter((i) => i.splitFrom != null).map((i) => String(i.splitFrom)),
  );
  return items.filter(
    (i) =>
      !(i.detachedFrom && present.has(String(i.detachedFrom))) &&
      !superseded.has(String(i._id)),
  );
}

// The series' real next due day — the first occurrence on or after `now`, as
// yyyy-MM-dd. The stored `nextDueDate` anchor can't answer this: nothing
// advances it as time passes (chores don't track completion), so it goes stale
// the moment its first occurrence is behind us. Expanding forward from today
// honours `skipDates` and `until` for free. Returns null when nothing lies
// ahead (a past one-time item, an ended series).
export function nextOccurrenceFrom(item: RepeatingItem, now: Date = new Date()): string | null {
  const from = startOfToday(now);
  const horizon = new Date(from);
  horizon.setFullYear(horizon.getFullYear() + 10);
  return (expandRecurringTaskChore(item, from, horizon)[0]?._instanceDate as string) ?? null;
}

// ── Resume schedule ─────────────────────────────────────────────────────────
// Undoing accumulated scoping, for the user who skipped a run of occurrences (or
// ended the series) and wants the chore back.
//
// The semantics are **forward-only**: the schedule resumes from today, and the
// past is left exactly as it looks. That is a deliberate choice over a literal
// undo — days you already skipped stay skipped, so resuming can never repopulate
// weeks of history you'd deliberately cleared.
//
// Forward-only is also what makes the anchor's one-way drift irrelevant.
// `skipItemOccurrence` advances `nextDueDate` past a skipped anchor day, and an
// interval series can never expand earlier than its anchor — but everything lost
// that way is in the past, which resume doesn't touch anyway.

const dayKey = (d: Date): string => ymd(d);

function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface ResumeState {
  // Something is actually holding the series back.
  canResume: boolean;
  // The day the series was ended on, if it was (yyyy-MM-dd).
  endedOn?: string;
  // Skipped days from today onward — the ones resuming would bring back.
  skipsAhead: number;
}

// What (if anything) there is to resume, for the detail row's subtitle.
export function resumeState(item: RepeatingItem, now: Date = new Date()): ResumeState {
  if (!itemRepeats(item)) return { canResume: false, skipsAhead: 0 };
  const today = dayKey(startOfToday(now));
  const until = item.recurrence?.until;
  const endedOn = until ? dayKey(new Date(until as string)) : undefined;
  const skipsAhead = (item.recurrence?.skipDates ?? []).filter((d) => d >= today).length;
  return { canResume: !!endedOn || skipsAhead > 0, endedOn, skipsAhead };
}

// The recurrence a resume writes.
//
// Three things happen, and the middle one is the subtle one:
//   1. Skips from today onward are dropped — those occurrences come back.
//   2. Clearing `until` would ALSO expose the stretch between the end day and
//      today, which is past and must not change. Those occurrences are therefore
//      enumerated into `skipDates` as the end date is cleared, so the past keeps
//      rendering exactly as it does now. (Bounded by the expander's own emit cap,
//      and in practice by how long ago the series was ended.)
//   3. Upcoming days that already have a standalone copy (from "Save for This …
//      Only") stay skipped, or the day would show the copy AND the series
//      occurrence.
export function buildResumedRecurrence(
  item: RepeatingItem,
  overrideDays: string[] = [],
  now: Date = new Date(),
): ItemRecurrenceShape {
  const rec = { ...(item.recurrence ?? {}) };
  const from = startOfToday(now);
  const today = dayKey(from);
  const protectedDays = new Set(overrideDays);

  const past = (rec.skipDates ?? []).filter((d) => d < today);
  const keptAhead = (rec.skipDates ?? []).filter((d) => d >= today && protectedDays.has(d));

  // (2) Freeze the now-past tail the end date had been hiding.
  const gap: string[] = [];
  if (rec.until) {
    const end = new Date(rec.until as string);
    if (!Number.isNaN(end.getTime()) && end < from) {
      for (const inst of expandRecurringTaskChore({ ...item, recurrence: { ...rec, until: null } }, end, from)) {
        const key = (inst as { _instanceDate?: string })._instanceDate;
        // The end day itself already rendered; only what came after it is new.
        if (key && key > (rec.until ? dayKey(end) : today) && key < today) gap.push(key);
      }
    }
  }

  const skipDates = Array.from(new Set([...past, ...keptAhead, ...gap])).sort();
  delete rec.until;
  return { ...rec, skipDates };
}

// Truncating before the anchor would leave an empty series, so "all future"
// from the first occurrence deletes the whole record instead — the same rule
// eventDelete applies.
export function isFirstItemOccurrence(item: RepeatingItem, occurrenceDate: string | undefined): boolean {
  const start = itemStartDay(item);
  if (!occurrenceDate || !start) return true;
  return occurrenceDate <= start;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export interface ItemChoice {
  text: string;
  style?: 'cancel' | 'destructive';
  perform?: () => Promise<unknown>;
}

export function itemDeletePrompt(
  domain: ItemDomain,
  item: RepeatingItem,
  occurrenceDate: string | undefined,
): { title: string; choices: ItemChoice[] } {
  const noun = NOUN[domain];
  const api = apiFor(domain);
  const lower = noun.toLowerCase();
  const note = WHOLE_RECORD_NOTE[domain];
  const withNote = (s: string) => (note ? `${s} ${note}` : s);

  if (!itemRepeats(item)) {
    return {
      // A one-time item has only one outcome, and it takes the record with it.
      title: withNote(`Are you sure you want to delete this ${lower}?`),
      choices: [
        { text: `Delete ${noun}`, style: 'destructive', perform: () => api.delete(item._id) },
        { text: 'Cancel', style: 'cancel' },
      ],
    };
  }

  const occ = occurrenceDate || itemStartDay(item)!;
  const isFirst = isFirstItemOccurrence(item, occ);

  return {
    // From a later occurrence both choices leave the record standing (skip one
    // day, or end the series here), so the note would be false. From the first
    // occurrence "all future" has nothing to truncate to and deletes the record,
    // so it earns the warning.
    title: isFirst
      ? withNote(`Are you sure you want to delete this ${lower}? This is a repeating ${lower}.`)
      : `Are you sure you want to delete this ${lower}? This is a repeating ${lower}.`,
    choices: [
      {
        text: `Delete This ${noun} Only`,
        style: 'destructive',
        perform: () => api.skipOccurrence(item._id, occ),
      },
      {
        text: `Delete All Future ${noun}s`,
        style: 'destructive',
        perform: () => (isFirst ? api.delete(item._id) : api.truncateSeries(item._id, occ)),
      },
      { text: 'Cancel', style: 'cancel' },
    ],
  };
}

// ── Save ────────────────────────────────────────────────────────────────────
// Same split as events: a field that describes the SERIES can only be applied
// forward. For a chore or task that means the repeat rule and — for a task —
// the mileage lane, which is a second recurrence schedule in disguise.
const SERIES_FIELDS = ['recurrence', 'intervalKm'] as const;

// Bookkeeping the forms never surface, so a difference is never a user edit.
const IGNORED_FIELDS = ['nextDueDate', 'nextDueKm', 'lastCompletedAt', 'lastServiceKm'] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  // A missing list and an empty one say the same thing — the rule builders
  // emit `months: []` where records written by other paths omit the key.
  if (a == null || b == null) {
    const other = a ?? b;
    return Array.isArray(other) && other.length === 0;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as string).getTime() === new Date(b as string).getTime();
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as Rec), ...Object.keys(b as Rec)]);
    for (const k of keys) if (!sameValue((a as Rec)[k], (b as Rec)[k])) return false;
    return true;
  }
  return false;
}

// `skipDates` and `until` live INSIDE the sealed recurrence object (events keep
// exceptionDates beside their rule, where IGNORED_FIELDS can reach it). The
// Repeat screen edits neither, so a difference there is scoping bookkeeping,
// never a user edit — without this, one skipped day made every later edit read
// as a rule change and collapsed the sheet to "Save for Future" alone.
function ruleOnly(rec: unknown): unknown {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const { skipDates, until, ...rest } = rec as Rec;
  return rest;
}

export function changedItemFields(original: Rec, payload: Rec): string[] {
  const ignored = new Set<string>(IGNORED_FIELDS);
  return Object.keys(payload)
    .filter((k) => !ignored.has(k))
    .filter((k) =>
      k === 'recurrence'
        ? !sameValue(ruleOnly(original[k]), ruleOnly(payload[k]))
        : !sameValue(original[k], payload[k]),
    );
}

export type ItemScopeDecision =
  | { kind: 'none' }
  | { kind: 'both'; changed: string[] }
  | { kind: 'futureOnly'; changed: string[] };

// As with events, being on the series' FIRST occurrence is not a reason to stay
// silent. It decides how the chosen scope is carried out (the forms resolve
// "future"-from-the-first into a whole-series rewrite), never whether the user
// is asked.
//
// `occurrenceDateMoved` is the form saying the user picked a different day for
// the occurrence it is showing. The payload diff cannot see that edit on its
// own: `nextDueDate` is in IGNORED_FIELDS because the due-date lifecycle
// rewrites it whenever the repeat rule changes, so only the form can tell a
// user-picked day from a rule-derived reseed. A moved date is an
// occurrence-level change — "do the Aug 20 chore on Aug 22 instead" — and
// offers both scopes, exactly as an event's date/time does.
export function itemSaveScopeDecision(
  original: RepeatingItem,
  payload: Rec,
  opts?: { occurrenceDateMoved?: boolean },
): ItemScopeDecision {
  if (!itemRepeats(original)) return { kind: 'none' };
  const changed = changedItemFields(original as unknown as Rec, payload);
  if (opts?.occurrenceDateMoved) changed.push('nextDueDate');
  if (!changed.length) return { kind: 'none' };
  const seriesOnly = changed.some((f) => (SERIES_FIELDS as readonly string[]).includes(f));
  return seriesOnly ? { kind: 'futureOnly', changed } : { kind: 'both', changed };
}

export function itemSaveChoices(domain: ItemDomain, decision: ItemScopeDecision): { text: string; scope: ItemScope }[] {
  const noun = NOUN[domain];
  if (decision.kind === 'none') return [];
  if (decision.kind === 'futureOnly') {
    return [{ text: `Save for Future ${noun}s`, scope: 'future' }];
  }
  return [
    { text: `Save for This ${noun} Only`, scope: 'occurrence' },
    { text: `Save for Future ${noun}s`, scope: 'future' },
  ];
}

// ── Presentation ────────────────────────────────────────────────────────────
// Both sheets are ActionSheetIOS on iOS (what Apple shows for a scope choice)
// with the equivalent Alert on Android, matching confirmDiscardChanges and the
// event prompts.

export function promptItemDelete(
  domain: ItemDomain,
  item: RepeatingItem,
  occurrenceDate: string | undefined,
  run: (perform: () => Promise<unknown>) => void,
): void {
  const { title, choices } = itemDeletePrompt(domain, item, occurrenceDate);
  const actions = choices.filter((c) => c.perform);
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...actions.map((c) => c.text), 'Cancel'],
        destructiveButtonIndex: actions.map((_, i) => i),
        cancelButtonIndex: actions.length,
      },
      (i) => {
        const picked = actions[i];
        if (picked?.perform) run(picked.perform);
      },
    );
  } else {
    Alert.alert(title, '', [
      ...actions.map((c) => ({ text: c.text, style: c.style, onPress: () => c.perform && run(c.perform) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }
}

// The Resume row's subtitle: why the series is held back, in the user's terms.
export function resumeSubtitle(state: ResumeState): string {
  const parts: string[] = [];
  if (state.endedOn) parts.push(`Ended ${formatDay(state.endedOn)}`);
  if (state.skipsAhead) parts.push(`${state.skipsAhead} skipped ahead`);
  return parts.join(' · ');
}

function formatDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Confirm, then resume. The sheet spells out both halves of the deal — what
// comes back, and what deliberately doesn't — because "resume" could equally
// mean a full undo, and the user can't see the difference until it's done.
export function promptResumeSchedule(
  domain: ItemDomain,
  item: RepeatingItem,
  run: (perform: () => Promise<unknown>) => void,
  now: Date = new Date(),
): void {
  const noun = NOUN[domain].toLowerCase();
  const state = resumeState(item, now);
  const api = apiFor(domain);
  const perform = async () => {
    const overrideDays = await api.detachedCopies(item._id).catch(() => [] as string[]);
    return api.resumeSeries(item._id, buildResumedRecurrence(item, overrideDays, now) as Record<string, unknown>);
  };

  const title = `Resume this ${noun}?`;
  const body = state.skipsAhead
    ? `It will repeat again from today, including ${state.skipsAhead} upcoming ${state.skipsAhead === 1 ? 'day' : 'days'} you skipped. Days already past stay as they are.`
    : `It will repeat again from today. Days already past stay as they are.`;

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, message: body, options: ['Resume Schedule', 'Cancel'], cancelButtonIndex: 1 },
      (i) => { if (i === 0) run(perform); },
    );
  } else {
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Resume Schedule', onPress: () => run(perform) },
    ]);
  }
}

export const ITEM_SAVE_PROMPT_TITLE = 'How should this change be applied?';

export function promptItemSaveScope(
  domain: ItemDomain,
  decision: ItemScopeDecision,
  onPick: (scope: ItemScope | null) => void,
): void {
  const choices = itemSaveChoices(domain, decision);
  if (!choices.length) {
    onPick('series');
    return;
  }
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: ITEM_SAVE_PROMPT_TITLE,
        options: [...choices.map((c) => c.text), 'Cancel'],
        cancelButtonIndex: choices.length,
      },
      (i) => onPick(i < choices.length ? choices[i].scope : null),
    );
  } else {
    Alert.alert(
      ITEM_SAVE_PROMPT_TITLE,
      '',
      [
        ...choices.map((c) => ({ text: c.text, onPress: () => onPick(c.scope) })),
        { text: 'Cancel', style: 'cancel' as const, onPress: () => onPick(null) },
      ],
      { cancelable: true, onDismiss: () => onPick(null) },
    );
  }
}
