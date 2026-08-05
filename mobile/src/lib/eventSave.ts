// Apple-style scoping for SAVING an edit to a repeating event — the counterpart
// to eventDelete's "Delete This Event Only / Delete All Future Events".
//
// A repeating event is one stored record, so an edit made from the third
// occurrence has to be resolved into one of three concrete writes:
//
//   'series'     rewrite the record in place (a one-off, or the first occurrence)
//   'occurrence' detach THIS day: create a standalone event, except the day out
//                of the series ("Save for This Event Only")
//   'future'     fork: end the series the day before, start a new one carrying
//                the edits ("Save for Future Events")
//
// Which choices the user is offered is not a free design decision — Apple splits
// on whether the edited field defines the SERIES or the OCCURRENCE. The repeat
// rule and the calendar an event lives on can't mean anything for a single day,
// so changing either offers "Save for Future Events" alone. Everything else —
// title, notes, date/time, location, alerts, travel time, URL, phone — offers
// both. Mixed edits take the most restrictive answer.
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import { ymd, addDays, daysBetween } from './calendar';

export type SaveScope = 'series' | 'occurrence' | 'future';

export interface EventRecurrenceShape {
  freq?: string;
  interval?: number;
  until?: string;
  daysOfWeek?: number[];
  daysOfMonth?: number[];
  months?: number[];
  weekOfMonth?: number;
  weekdayKind?: string;
}

export interface EventForSave {
  _id: string;
  startDate: string;
  allDay?: boolean;
  recurrence?: EventRecurrenceShape | null;
  exceptionDates?: string[];
  enc?: { ks?: string };
}

// Whether the event lives under an outside-shared calendar's own key rather than
// the household key. The occurrence-scoped writes honour that lane
// (api.resealInLane), so this no longer gates the prompts — it's kept because
// the lane is a real distinction callers may need to reason about.
export function isCalendarKeySealed(event: { enc?: { ks?: string } } | null | undefined): boolean {
  return event?.enc?.ks === 'cal';
}

type Rec = Record<string, unknown>;

// Fields that describe the repeating event as a whole. Editing one can only be
// applied forward — there is no such thing as "this occurrence repeats weekly"
// or "this occurrence lives on a different calendar".
const SERIES_FIELDS = ['recurrence', 'calendarType'] as const;

// Bookkeeping the form doesn't surface, so a difference here is never a user
// edit and must not drive the prompt.
const IGNORED_FIELDS = ['exceptionDates'] as const;

// Order-insensitive for arrays (weekday pickers emit whatever order was tapped)
// and undefined-tolerant, since the form drops empty fields rather than sending
// null. Without both, an untouched form would read as changed and prompt.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as Rec), ...Object.keys(b as Rec)]);
    for (const k of keys) {
      if (!sameValue((a as Rec)[k], (b as Rec)[k])) return false;
    }
    return true;
  }
  // Dates arrive as ISO strings on one side and Date objects on the other.
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as string).getTime() === new Date(b as string).getTime();
  }
  return false;
}

// Which payload fields differ from the stored event. `original` is the decrypted
// record; `payload` is what the form is about to seal, already expressed in the
// SERIES frame (see EventFormScreen.buildStartEnd) so an untouched occurrence
// edit compares equal instead of looking like a date change.
export function changedFields(original: Rec, payload: Rec): string[] {
  const ignored = new Set<string>(IGNORED_FIELDS);
  return Object.keys(payload)
    .filter((k) => !ignored.has(k))
    .filter((k) => !sameValue(original[k], payload[k]));
}

export type ScopeDecision =
  // Nothing to scope: save straight through with no prompt.
  | { kind: 'none' }
  // Both Apple choices.
  | { kind: 'both'; changed: string[] }
  // "Save for Future Events" alone — a series-defining field changed.
  | { kind: 'futureOnly'; changed: string[] };

// Whether saving this edit needs to ask, and which choices to offer.
//
// No prompt when: the event doesn't repeat; the occurrence was already detached
// (an override has no recurrence of its own, so it edits like any one-off); or
// nothing actually changed.
//
// Note what is NOT a reason to stay silent: being on the series' FIRST
// occurrence. A series-defining edit made there happens to resolve to the same
// write as "the whole series", but the user is still applying a change to every
// future event and Apple still asks. Which occurrence you're on decides how the
// chosen scope is CARRIED OUT (see the save mutation), never whether you're
// asked — conflating the two is what made a repeat-rule change save silently.
export function saveScopeDecision(
  original: EventForSave,
  payload: Rec,
): ScopeDecision {
  if (!original.recurrence?.freq) return { kind: 'none' };
  const changed = changedFields(original as unknown as Rec, payload);
  if (!changed.length) return { kind: 'none' };

  const seriesOnly = changed.some((f) => (SERIES_FIELDS as readonly string[]).includes(f));
  return seriesOnly ? { kind: 'futureOnly', changed } : { kind: 'both', changed };
}

// The day a stored event's series starts, keyed the way the calendar buckets an
// occurrence into a cell (all-day = UTC date, timed = local). Mirrors
// eventDelete.seriesStartDay — both must agree or a first-occurrence edit and a
// first-occurrence delete would disagree about what "first" means.
export function seriesStartDay(event: EventForSave): string {
  return event.allDay
    ? new Date(event.startDate).toISOString().slice(0, 10)
    : ymd(new Date(event.startDate));
}

export function isFirstOccurrence(event: EventForSave, occurrenceDate: string | undefined): boolean {
  const start = seriesStartDay(event);
  return !occurrenceDate || occurrenceDate <= start;
}

// ── Re-anchoring a forked series ────────────────────────────────────────────
// "Save for Future Events" starts a NEW series on the day the user is now
// looking at. Where the old rule named its anchor explicitly — weekly on
// Thursday, monthly on the 6th, monthly on the first Thursday — that anchor
// still points at the old start, so the fork would repeat on a day the user
// never picked (move a Thursday event to Friday and it keeps landing Thursday).
//
// Only an anchor that MATCHED the old start is re-pointed. A rule the user
// authored by hand — Mon/Wed/Fri, or the 1st and the 15th — is a deliberate
// multi-day pattern and is left exactly as written.

const WEEKDAY_KINDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// Which "nth weekday of the month" a date is: 1..5, and -1 when it's also the
// last one of its kind in that month (Apple's "last Thursday").
function ordinalsOf(d: Date): number[] {
  const nth = Math.floor((d.getDate() - 1) / 7) + 1;
  const isLast = d.getDate() + 7 > daysInMonth(d);
  return isLast ? [nth, -1] : [nth];
}

export function reanchorRecurrence(
  recurrence: EventRecurrenceShape | null | undefined,
  oldStartDay: string,
  newStartDay: string,
): EventRecurrenceShape | undefined {
  if (!recurrence?.freq) return recurrence ?? undefined;
  if (oldStartDay === newStartDay) return recurrence;

  const oldD = new Date(`${oldStartDay}T12:00:00`);
  const newD = new Date(`${newStartDay}T12:00:00`);
  const out: EventRecurrenceShape = { ...recurrence };

  // Weekly "on Thursday" → "on Friday", only when Thursday was the sole day and
  // it was the old start's own weekday.
  if (out.daysOfWeek?.length === 1 && out.daysOfWeek[0] === oldD.getDay()) {
    out.daysOfWeek = [newD.getDay()];
  }
  // Monthly "on the 6th" → "on the 21st", same single-anchor rule.
  if (out.daysOfMonth?.length === 1 && out.daysOfMonth[0] === oldD.getDate()) {
    out.daysOfMonth = [newD.getDate()];
  }
  // Yearly "in August" → "in September".
  if (out.months?.length === 1 && out.months[0] === oldD.getMonth() + 1) {
    out.months = [newD.getMonth() + 1];
  }
  // Ordinal "the first Thursday" → "the third Friday". Both halves move
  // together, and only when both described the old start.
  if (out.weekOfMonth != null && out.weekdayKind) {
    const kindMatches = out.weekdayKind === WEEKDAY_KINDS[oldD.getDay()];
    if (kindMatches && ordinalsOf(oldD).includes(out.weekOfMonth)) {
      out.weekdayKind = WEEKDAY_KINDS[newD.getDay()];
      // Prefer the plain ordinal; keep "last" only if the old rule said last.
      out.weekOfMonth = out.weekOfMonth === -1 && ordinalsOf(newD).includes(-1)
        ? -1
        : Math.floor((newD.getDate() - 1) / 7) + 1;
    }
  }
  return out;
}

// The exceptions that still belong to each half of a split. The original keeps
// the days it already passed; the fork keeps the ones from its own start on.
// Without this the fork silently re-skips days the user excluded years ago in a
// stretch of calendar it no longer covers.
export function splitExceptionDates(
  exceptionDates: string[] | undefined,
  forkDay: string,
): { kept: string[]; forked: string[] } {
  const all = exceptionDates ?? [];
  return {
    kept: all.filter((d) => d < forkDay),
    forked: all.filter((d) => d >= forkDay),
  };
}

// Where an exception day lands after the user moved the occurrence. The fork
// starts on the moved day, so its inherited exceptions shift by the same delta
// or they'd point at days the new series doesn't land on.
export function shiftExceptionDates(days: string[], delta: number): string[] {
  return delta ? days.map((d) => addDays(d, delta)) : days;
}

export function exceptionShift(occurrenceDay: string, newStartDay: string): number {
  return daysBetween(occurrenceDay, newStartDay);
}

// ── The prompt ──────────────────────────────────────────────────────────────

export interface SaveChoice {
  text: string;
  scope: SaveScope;
}

// Apple's own wording, from the sheet this mirrors.
export const SAVE_PROMPT_TITLE = 'How should this change be applied?';

export function saveChoicesFor(decision: ScopeDecision): SaveChoice[] {
  if (decision.kind === 'none') return [];
  if (decision.kind === 'futureOnly') {
    return [{ text: 'Save for Future Events', scope: 'future' }];
  }
  return [
    { text: 'Save for This Event Only', scope: 'occurrence' },
    { text: 'Save for Future Events', scope: 'future' },
  ];
}

// Present the choices and hand back the scope the user picked. Cancelling
// resolves to null — the caller stays on the form with the edits intact.
//
// iOS gets the native action sheet (what the screenshots show); Android falls
// back to the equivalent alert, matching confirmDiscardChanges.
export function promptSaveScope(
  decision: ScopeDecision,
  onPick: (scope: SaveScope | null) => void,
): void {
  const choices = saveChoicesFor(decision);
  if (!choices.length) {
    onPick('series');
    return;
  }
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: SAVE_PROMPT_TITLE,
        options: [...choices.map((c) => c.text), 'Cancel'],
        cancelButtonIndex: choices.length,
      },
      (i) => onPick(i < choices.length ? choices[i].scope : null),
    );
  } else {
    Alert.alert(
      SAVE_PROMPT_TITLE,
      '',
      [
        ...choices.map((c) => ({ text: c.text, onPress: () => onPick(c.scope) })),
        { text: 'Cancel', style: 'cancel' as const, onPress: () => onPick(null) },
      ],
      { cancelable: true, onDismiss: () => onPick(null) },
    );
  }
}
