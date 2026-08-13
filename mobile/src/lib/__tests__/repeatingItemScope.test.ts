// Occurrence scoping for repeating CHORES and MAINTENANCE TASKS — the same
// Apple split the calendar's events get, on the other two things that repeat on
// the calendar.
//
// The api group is mocked: these pin the DECISIONS (which choices a sheet
// offers, which write each one maps to), not the network.
process.env.TZ = 'America/New_York';

// The api group is mocked so these pin the DECISIONS, not the network. The
// factory builds the mocks inline: `jest.mock` is hoisted above every import,
// so a factory that closed over consts declared below would run before they
// initialise and hand back `undefined` for both groups.
jest.mock('../../api', () => ({
  choresApi: {
    delete: jest.fn(async () => 'chore:delete'),
    skipOccurrence: jest.fn(async () => 'chore:skip'),
    truncateSeries: jest.fn(async () => 'chore:truncate'),
  },
  tasksApi: {
    delete: jest.fn(async () => 'task:delete'),
    skipOccurrence: jest.fn(async () => 'task:skip'),
    truncateSeries: jest.fn(async () => 'task:truncate'),
  },
}));

import { choresApi, tasksApi } from '../../api';

const mockChoresApi = choresApi as jest.Mocked<typeof choresApi>;
const mockTasksApi = tasksApi as jest.Mocked<typeof tasksApi>;

import {
  itemRepeats, itemStartDay, isFirstItemOccurrence, itemDeletePrompt, hasUpcomingOccurrence,
  nextOccurrenceFrom, resumeState, resumeSubtitle, buildResumedRecurrence,
  changedItemFields, itemSaveScopeDecision, itemSaveChoices, collapseScopedRecords,
  RepeatingItem,
} from '../repeatingItemScope';

// The content shared by the stored record and the payload an untouched load
// rebuilds from it — the two must agree field for field, or every save would
// look like an edit.
const CONTENT = {
  title: 'Change the filter',
  instructions: '',
  icon: 'mdi-broom',
  recurrence: { type: 'interval', intervalUnit: 'months', intervalValue: 1 },
};

// A chore due every month, anchored Jan 1 2026.
const chore = (o: Partial<RepeatingItem> = {}): RepeatingItem => ({
  _id: 'c1',
  ...CONTENT,
  nextDueDate: '2026-01-01T12:00:00.000Z',
  ...o,
});

const payload = (o: Record<string, unknown> = {}) => ({ ...CONTENT, ...o });

beforeEach(() => jest.clearAllMocks());

describe('itemRepeats', () => {
  it('is false for a one-time item and for a record with no recurrence', () => {
    expect(itemRepeats(chore({ recurrence: { type: 'one-time' } }))).toBe(false);
    expect(itemRepeats(chore({ recurrence: null }))).toBe(false);
    expect(itemRepeats(undefined)).toBe(false);
  });

  it('is true for interval and calendar series', () => {
    expect(itemRepeats(chore())).toBe(true);
    expect(itemRepeats(chore({ recurrence: { type: 'calendar', months: [3] } }))).toBe(true);
  });
});

// "Delete All Future" ends the series rather than destroying the record, so the
// days behind it keep their occurrences. The to-do lists must still drop it —
// otherwise a chore the user just ended goes on advertising its old anchor as a
// live "next due date", which is what was reported.
describe('hasUpcomingOccurrence', () => {
  const NOW = new Date('2026-06-15T09:00:00');

  it('keeps an unbounded series', () => {
    expect(hasUpcomingOccurrence(chore(), NOW)).toBe(true);
  });

  it('keeps a series whose end is still ahead', () => {
    const c = chore({ recurrence: { ...CONTENT.recurrence, until: '2026-09-01T23:59:59' } });
    expect(hasUpcomingOccurrence(c, NOW)).toBe(true);
  });

  it('drops a series ended before today', () => {
    const c = chore({ recurrence: { ...CONTENT.recurrence, until: '2026-02-28T23:59:59' } });
    expect(hasUpcomingOccurrence(c, NOW)).toBe(false);
  });

  // The `until` is ahead, but every remaining occurrence of this monthly series
  // falls behind it — a date compare alone would wrongly keep it.
  it('drops a series whose end leaves no occurrence left', () => {
    const c = chore({
      nextDueDate: '2026-01-01T12:00:00.000Z',
      recurrence: { type: 'interval', intervalUnit: 'years', intervalValue: 5, until: '2026-06-20T23:59:59' },
    });
    expect(hasUpcomingOccurrence(c, NOW)).toBe(false);
  });

  it('keeps an item due today', () => {
    const c = chore({
      nextDueDate: '2026-06-15T12:00:00.000Z',
      recurrence: { type: 'interval', intervalUnit: 'months', intervalValue: 1, until: '2026-06-15T23:59:59' },
    });
    expect(hasUpcomingOccurrence(c, NOW)).toBe(true);
  });

  it('keeps an item with an unparseable end rather than hiding it', () => {
    const c = chore({ recurrence: { ...CONTENT.recurrence, until: 'not-a-date' } });
    expect(hasUpcomingOccurrence(c, NOW)).toBe(true);
  });
});

// One card per chore: scoping writes NEW records (a detached one-off, a forked
// series beside its truncated predecessor), and a list that shows every record
// shows the plumbing — the reported bug was a moved occurrence appearing as a
// second "one-time" chore card, and a "Save for Future" edit listing the chore
// twice (old version and new).
describe('collapseScopedRecords', () => {
  it('hides a detached copy behind the series it left', () => {
    const series = chore();
    const copy = chore({
      _id: 'c2', recurrence: { type: 'one-time' }, detachedFrom: 'c1', detachedDate: '2026-02-01',
    });
    expect(collapseScopedRecords([series, copy])).toEqual([series]);
  });

  // The series is gone: the copy is all that's left of the chore, so hiding it
  // would make the record unreachable from the list.
  it('keeps a detached copy whose series was deleted', () => {
    const copy = chore({
      _id: 'c2', recurrence: { type: 'one-time' }, detachedFrom: 'c1', detachedDate: '2026-02-01',
    });
    expect(collapseScopedRecords([copy])).toEqual([copy]);
  });

  it('hides a truncated predecessor behind its fork', () => {
    const old = chore({ recurrence: { ...CONTENT.recurrence, until: '2026-03-31T23:59:59' } });
    const fork = chore({ _id: 'c2', splitFrom: 'c1', nextDueDate: '2026-04-01T12:00:00.000Z' });
    expect(collapseScopedRecords([old, fork])).toEqual([fork]);
  });

  it('keeps a predecessor whose fork was deleted', () => {
    const old = chore({ recurrence: { ...CONTENT.recurrence, until: '2026-03-31T23:59:59' } });
    expect(collapseScopedRecords([old])).toEqual([old]);
  });

  // Fork of a fork: every superseded generation hides, and only the record
  // carrying the chore forward lists. The middle link still hides the first
  // even though it is itself hidden — presence in the DATA is what counts.
  it('collapses a chain of forks to the latest', () => {
    const a = chore({ recurrence: { ...CONTENT.recurrence, until: '2026-02-28T23:59:59' } });
    const b = chore({ _id: 'c2', splitFrom: 'c1', recurrence: { ...CONTENT.recurrence, until: '2026-04-30T23:59:59' } });
    const c = chore({ _id: 'c3', splitFrom: 'c2' });
    expect(collapseScopedRecords([a, b, c])).toEqual([c]);
  });

  it('leaves unrelated records — including genuinely one-time chores — alone', () => {
    const series = chore();
    const oneTime = chore({ _id: 'c9', title: 'Wash the car', recurrence: { type: 'one-time' } });
    expect(collapseScopedRecords([series, oneTime])).toEqual([series, oneTime]);
  });
});

// The detail screen's series-frame due row asks for the next REAL occurrence
// from today, because the stored anchor never advances on its own — a chore
// created in the past (or simply older than one cycle) has a permanently stale
// `nextDueDate`.
describe('nextOccurrenceFrom', () => {
  const NOW = new Date('2026-06-15T09:00:00');

  it('walks a stale past anchor forward to the next occurrence', () => {
    // Monthly, anchored Jan 1 → the June 1 occurrence is behind NOW; July 1 is next.
    expect(nextOccurrenceFrom(chore(), NOW)).toBe('2026-07-01');
  });

  it('returns a today occurrence as today', () => {
    const c = chore({ nextDueDate: '2026-06-15T12:00:00.000Z' });
    expect(nextOccurrenceFrom(c, NOW)).toBe('2026-06-15');
  });

  it('returns a future anchor unchanged', () => {
    const c = chore({ nextDueDate: '2026-08-20T12:00:00.000Z' });
    expect(nextOccurrenceFrom(c, NOW)).toBe('2026-08-20');
  });

  it('skips past a skipped day', () => {
    const c = chore({ recurrence: { ...CONTENT.recurrence, skipDates: ['2026-07-01'] } });
    expect(nextOccurrenceFrom(c, NOW)).toBe('2026-08-01');
  });

  it('is null for a one-time item whose day has passed', () => {
    const c = chore({ recurrence: { type: 'one-time' } });
    expect(nextOccurrenceFrom(c, NOW)).toBeNull();
  });

  it('is null for an ended series', () => {
    const c = chore({ recurrence: { ...CONTENT.recurrence, until: '2026-02-28T23:59:59' } });
    expect(nextOccurrenceFrom(c, NOW)).toBeNull();
  });
});

// Resuming a chore the user had skipped down or ended. The semantics are
// FORWARD-ONLY by explicit choice: the schedule restarts from today and the past
// is left exactly as it looks. A literal undo would repopulate weeks of history
// the user had deliberately cleared, which is the opposite of what they asked
// for — so every assertion here is really about what does NOT come back.
describe('resume schedule', () => {
  // Today is Jun 15 2026; the fixture chore is monthly from Jan 1 2026.
  const NOW = new Date('2026-06-15T09:00:00');
  const monthly = (rec: Record<string, unknown>) =>
    chore({ nextDueDate: '2026-01-01T12:00:00.000Z', recurrence: { type: 'interval', intervalUnit: 'months', intervalValue: 1, ...rec } });

  describe('resumeState — whether there is anything to resume', () => {
    it('is false for an untouched series', () => {
      expect(resumeState(chore(), NOW).canResume).toBe(false);
    });

    it('is false for a one-time item', () => {
      expect(resumeState(chore({ recurrence: { type: 'one-time' } }), NOW).canResume).toBe(false);
    });

    // Past skips are history the user chose; nothing to put back.
    it('is false when every skip is already behind us', () => {
      const c = monthly({ skipDates: ['2026-02-01', '2026-03-01'] });
      expect(resumeState(c, NOW).canResume).toBe(false);
    });

    it('is true when a skip lies ahead, and counts only those', () => {
      const c = monthly({ skipDates: ['2026-02-01', '2026-07-01', '2026-08-01'] });
      const st = resumeState(c, NOW);
      expect(st.canResume).toBe(true);
      expect(st.skipsAhead).toBe(2);
    });

    it('is true when the series was ended, and names the day', () => {
      const c = monthly({ until: '2026-04-30T23:59:59' });
      const st = resumeState(c, NOW);
      expect(st.canResume).toBe(true);
      expect(st.endedOn).toBe('2026-04-30');
      expect(resumeSubtitle(st)).toContain('Ended');
    });
  });

  describe('buildResumedRecurrence', () => {
    it('drops skips from today onward and keeps the ones behind', () => {
      const c = monthly({ skipDates: ['2026-02-01', '2026-07-01'] });
      expect(buildResumedRecurrence(c, [], NOW).skipDates).toEqual(['2026-02-01']);
    });

    it('clears the end date', () => {
      const c = monthly({ until: '2026-08-30T23:59:59' });
      expect(buildResumedRecurrence(c, [], NOW).until).toBeUndefined();
    });

    // THE load-bearing case. Clearing an end date that is already in the PAST
    // would expose May 1 and Jun 1 — days the user has been looking at as empty.
    // They are frozen into skipDates as the end date is lifted.
    it('freezes the stretch between a past end date and today', () => {
      const c = monthly({ until: '2026-03-31T23:59:59' });
      const out = buildResumedRecurrence(c, [], NOW);
      expect(out.until).toBeUndefined();
      // Apr 1, May 1, Jun 1 were hidden by the end date and are now past.
      expect(out.skipDates).toEqual(['2026-04-01', '2026-05-01', '2026-06-01']);
    });

    it('leaves the future alone when the end date is still ahead', () => {
      const c = monthly({ until: '2026-09-30T23:59:59' });
      expect(buildResumedRecurrence(c, [], NOW).skipDates).toEqual([]);
    });

    // A day with a standalone copy from "Save for This Chore Only" must stay
    // skipped, or that day shows the copy AND the series occurrence.
    it('keeps an upcoming day skipped when a detached copy already covers it', () => {
      const c = monthly({ skipDates: ['2026-07-01', '2026-08-01'] });
      const out = buildResumedRecurrence(c, ['2026-08-01'], NOW);
      expect(out.skipDates).toEqual(['2026-08-01']);
    });

    it('ignores a detached copy for a day that was never skipped', () => {
      const c = monthly({ skipDates: ['2026-07-01'] });
      expect(buildResumedRecurrence(c, ['2026-12-25'], NOW).skipDates).toEqual([]);
    });

    it('preserves the rest of the rule', () => {
      const c = monthly({ until: '2026-08-30T23:59:59', skipDates: ['2026-07-01'] });
      const out = buildResumedRecurrence(c, [], NOW);
      expect(out.type).toBe('interval');
      expect(out.intervalUnit).toBe('months');
      expect(out.intervalValue).toBe(1);
    });

    // Resuming twice must not accumulate or re-expose anything.
    it('is idempotent', () => {
      const c = monthly({ until: '2026-03-31T23:59:59' });
      const once = buildResumedRecurrence(c, [], NOW);
      const twice = buildResumedRecurrence({ ...c, recurrence: once }, [], NOW);
      expect(twice.skipDates).toEqual(once.skipDates);
      expect(twice.until).toBeUndefined();
    });
  });
});

describe('itemStartDay / isFirstItemOccurrence', () => {
  it('reads the anchor as a local day', () => {
    expect(itemStartDay(chore())).toBe('2026-01-01');
  });

  it('is undefined with no due date', () => {
    expect(itemStartDay(chore({ nextDueDate: null }))).toBeUndefined();
  });

  // Truncating before the anchor would leave an empty series, so the first
  // occurrence takes the whole-record path instead.
  it('treats the anchor day and a missing occurrence as first', () => {
    expect(isFirstItemOccurrence(chore(), '2026-01-01')).toBe(true);
    expect(isFirstItemOccurrence(chore(), undefined)).toBe(true);
  });

  it('recognises a later occurrence', () => {
    expect(isFirstItemOccurrence(chore(), '2026-03-01')).toBe(false);
  });
});

describe('delete prompt', () => {
  it('offers a single confirm for a one-time chore', async () => {
    const { title, choices } = itemDeletePrompt('chore', chore({ recurrence: { type: 'one-time' } }), undefined);
    expect(title).toBe('Are you sure you want to delete this chore?');
    expect(choices.map((c) => c.text)).toEqual(['Delete Chore', 'Cancel']);
    await choices[0].perform!();
    expect(mockChoresApi.delete).toHaveBeenCalledWith('c1');
  });

  it('offers both scopes for a repeating chore, in Apple order', () => {
    const { title, choices } = itemDeletePrompt('chore', chore(), '2026-03-01');
    expect(title).toBe('Are you sure you want to delete this chore? This is a repeating chore.');
    expect(choices.map((c) => c.text)).toEqual([
      'Delete This Chore Only',
      'Delete All Future Chores',
      'Cancel',
    ]);
  });

  it('maps "this only" to a skip and "all future" to a truncation', async () => {
    const { choices } = itemDeletePrompt('chore', chore(), '2026-03-01');
    await choices[0].perform!();
    expect(mockChoresApi.skipOccurrence).toHaveBeenCalledWith('c1', '2026-03-01');
    await choices[1].perform!();
    expect(mockChoresApi.truncateSeries).toHaveBeenCalledWith('c1', '2026-03-01');
  });

  // Ending the series before its own anchor would leave nothing behind, so the
  // whole record goes instead of being truncated to empty.
  it('deletes the record outright for "all future" on the first occurrence', async () => {
    const { choices } = itemDeletePrompt('chore', chore(), '2026-01-01');
    await choices[1].perform!();
    expect(mockChoresApi.truncateSeries).not.toHaveBeenCalled();
    expect(mockChoresApi.delete).toHaveBeenCalledWith('c1');
  });

  it('uses the task nouns and the task api', async () => {
    const { choices } = itemDeletePrompt('task', { ...chore(), _id: 't1' }, '2026-03-01');
    expect(choices.map((c) => c.text)).toEqual([
      'Delete This Task Only',
      'Delete All Future Tasks',
      'Cancel',
    ]);
    await choices[0].perform!();
    expect(mockTasksApi.skipOccurrence).toHaveBeenCalledWith('t1', '2026-03-01');
  });

  // The completion ledger is keyed on the task id, so only outcomes that destroy
  // the RECORD destroy history. Warning about it on a sheet whose choices leave
  // the record standing would be false.
  it('warns about completion history only when the record itself is at stake', () => {
    const oneTime = itemDeletePrompt('task', { ...chore(), recurrence: { type: 'one-time' } }, undefined);
    expect(oneTime.title).toContain('This also removes all completion history.');

    const firstOccurrence = itemDeletePrompt('task', chore(), '2026-01-01');
    expect(firstOccurrence.title).toContain('This also removes all completion history.');

    const laterOccurrence = itemDeletePrompt('task', chore(), '2026-03-01');
    expect(laterOccurrence.title).not.toContain('completion history');
  });

  it('never warns about completion history for a chore, which keeps none', () => {
    expect(itemDeletePrompt('chore', chore(), '2026-01-01').title).not.toContain('completion history');
  });
});

describe('changedItemFields', () => {
  it('sees no change in an untouched payload', () => {
    expect(changedItemFields(chore() as never, payload())).toEqual([]);
  });

  // nextDueDate is recomputed by the due-date lifecycle rather than typed, so a
  // difference there is not by itself a user edit.
  it('ignores the derived due-date/mileage bookkeeping', () => {
    const changed = changedItemFields(
      chore() as never,
      payload({ nextDueDate: '2026-09-09', nextDueKm: 500, lastCompletedAt: '2026-02-02' }),
    );
    expect(changed).toEqual([]);
  });

  it('reports a real edit', () => {
    expect(changedItemFields(chore() as never, payload({ title: 'Swap the filter' }))).toEqual(['title']);
  });
});

describe('save scope decision', () => {

  it('does not prompt for a one-time chore', () => {
    const c = chore({ recurrence: { type: 'one-time' } });
    expect(itemSaveScopeDecision(c, payload({ title: 'x' })).kind).toBe('none');
  });

  it('does not prompt when nothing changed', () => {
    expect(itemSaveScopeDecision(chore(), payload()).kind).toBe('none');
  });

  it.each([
    ['title', { title: 'Swap the filter' }],
    ['instructions', { instructions: 'use the 20x25' }],
    ['icon', { icon: 'mdi-air-filter' }],
    ['assignee', { assignedTo: 'p1' }],
    ['alerts', { reminderDaysBefore: 3 }],
  ])('offers both choices for an occurrence-level change (%s)', (_l, patch) => {
    const d = itemSaveScopeDecision(chore(), payload(patch));
    expect(d.kind).toBe('both');
    expect(itemSaveChoices('chore', d).map((c) => c.text)).toEqual([
      'Save for This Chore Only',
      'Save for Future Chores',
    ]);
  });

  it('offers only "Save for Future" when the repeat rule changed', () => {
    const d = itemSaveScopeDecision(
      chore(),
      payload({ recurrence: { type: 'interval', intervalUnit: 'weeks', intervalValue: 2 } }));
    expect(d.kind).toBe('futureOnly');
    expect(itemSaveChoices('chore', d).map((c) => c.text)).toEqual(['Save for Future Chores']);
  });

  // A task's mileage interval is a second recurrence schedule in disguise, so it
  // scopes like the repeat rule rather than like an ordinary field.
  it('treats a task mileage interval as series-defining', () => {
    const d = itemSaveScopeDecision(chore(), payload({ intervalKm: 8000 }));
    expect(d.kind).toBe('futureOnly');
  });

  it('takes the most restrictive answer for a mixed edit', () => {
    const d = itemSaveScopeDecision(
      chore(),
      payload({ title: 'Swap it', recurrence: { type: 'interval', intervalUnit: 'weeks', intervalValue: 2 } }));
    expect(d.kind).toBe('futureOnly');
  });

  // Same regression events hit: the decision used to go quiet when the edit was
  // made from the series' first occurrence, so changing only the repeat rule
  // saved silently. Which occurrence you're on decides how the chosen scope is
  // CARRIED OUT (the forms resolve future-from-the-first into a whole-series
  // rewrite), never whether the user is asked.
  it('prompts for a repeat-rule change no matter which occurrence it was made from', () => {
    const d = itemSaveScopeDecision(
      chore(),
      payload({ recurrence: { type: 'interval', intervalUnit: 'weeks', intervalValue: 2 } }));
    expect(d.kind).toBe('futureOnly');
  });

  it('offers both choices for an occurrence-level change, first occurrence or not', () => {
    expect(itemSaveScopeDecision(chore(), payload({ title: 'x' })).kind).toBe('both');
  });

  // The payload diff ignores `nextDueDate` (the rule reseeds it), so the form
  // reports a user-moved occurrence date explicitly. "Do the Aug 20 chore on
  // Aug 22 instead" is an occurrence-level change and must offer This … Only —
  // without the signal it saved silently as a whole-series re-anchor.
  it('offers both choices when the occurrence date was moved', () => {
    const d = itemSaveScopeDecision(chore(), payload(), { occurrenceDateMoved: true });
    expect(d.kind).toBe('both');
    expect(itemSaveChoices('chore', d).map((c) => c.text)).toEqual([
      'Save for This Chore Only',
      'Save for Future Chores',
    ]);
  });

  it('a moved date plus a repeat-rule change still resolves to future-only', () => {
    const d = itemSaveScopeDecision(
      chore(),
      payload({ recurrence: { type: 'interval', intervalUnit: 'weeks', intervalValue: 2 } }),
      { occurrenceDateMoved: true },
    );
    expect(d.kind).toBe('futureOnly');
  });

  it('a moved date on a one-time item stays silent', () => {
    const c = chore({ recurrence: { type: 'one-time' } });
    expect(itemSaveScopeDecision(c, payload(), { occurrenceDateMoved: true }).kind).toBe('none');
  });

  // skipDates/until live INSIDE the sealed recurrence, and the form rebuilds
  // the rule from the Repeat screen without them — one previously skipped day
  // must not make every later edit read as a rule change (reported: a date-only
  // move on a weekly chore offered only "Save for Future Chores").
  it('ignores skip/until bookkeeping inside the recurrence', () => {
    const c = chore({
      recurrence: { ...CONTENT.recurrence, skipDates: ['2026-02-01'], until: '2026-12-31' },
    });
    expect(itemSaveScopeDecision(c, payload(), { occurrenceDateMoved: true }).kind).toBe('both');
    expect(itemSaveScopeDecision(c, payload({ title: 'x' })).kind).toBe('both');
    expect(itemSaveScopeDecision(c, payload()).kind).toBe('none');
  });

  it('still sees a real rule change under the bookkeeping', () => {
    const c = chore({ recurrence: { ...CONTENT.recurrence, skipDates: ['2026-02-01'] } });
    const d = itemSaveScopeDecision(
      c,
      payload({ recurrence: { type: 'interval', intervalUnit: 'weeks', intervalValue: 2 } }));
    expect(d.kind).toBe('futureOnly');
  });

  // The rule builders emit `months: []` where records written by other paths
  // (templates, assistant drafts, older rows) omit the key entirely — shape
  // noise, not an edit.
  it('treats an absent list and an empty one as the same rule', () => {
    const p = payload({ recurrence: { ...CONTENT.recurrence, months: [] } });
    expect(itemSaveScopeDecision(chore(), p).kind).toBe('none');
  });

  it('uses task nouns in its choices', () => {
    const d = itemSaveScopeDecision(chore(), payload({ title: 'x' }));
    expect(itemSaveChoices('task', d).map((c) => c.text)).toEqual([
      'Save for This Task Only',
      'Save for Future Tasks',
    ]);
  });
});
