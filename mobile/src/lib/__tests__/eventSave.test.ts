// Apple's save-scope rules for a repeating event. Two things are pinned here:
// WHICH choices the sheet offers (the series/occurrence split), and what a fork
// carries with it — the re-anchored repeat rule and the inherited exceptions.
//
// The re-anchoring is the sharp edge. Move a weekly Thursday event to Friday,
// pick "Save for Future Events", and a rule that still names Thursday puts every
// future occurrence back on the day the user just moved away from.
process.env.TZ = 'America/New_York';

import {
  changedFields, saveScopeDecision, saveChoicesFor, reanchorRecurrence,
  splitExceptionDates, shiftExceptionDates, exceptionShift,
  seriesStartDay, isFirstOccurrence, EventForSave,
} from '../eventSave';

// The content shared by the stored record and the payload an untouched load
// rebuilds from it — the two must agree field for field, or every save would
// look like an edit.
const CONTENT = {
  title: 'Aqua Tots Swimming',
  calendarType: 'activities',
  allDay: false,
  startDate: '2026-08-06T14:30:00.000Z',
  location: '110 Place-D’orleans Dr',
  recurrence: { freq: 'weekly', interval: 1 },
};

// A weekly Thursday series starting Aug 6 2026, 10:30am EDT.
const series = (o: Partial<EventForSave> = {}): EventForSave => ({
  _id: 'e1',
  ...CONTENT,
  ...o,
});

// What the form builds on the way out, in the series frame.
const payload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...CONTENT,
  ...o,
});

describe('changedFields', () => {
  it('sees no change in an untouched payload', () => {
    expect(changedFields(series() as never, payload())).toEqual([]);
  });

  // The form drops empty fields rather than sending null, and the stored record
  // simply omits them. Treating those as different would prompt on every save.
  it('treats undefined and null as the same absence', () => {
    expect(changedFields({ travelMinutes: null } as never, { travelMinutes: undefined })).toEqual([]);
    expect(changedFields({} as never, { travelMinutes: null })).toEqual([]);
  });

  // Weekday pickers emit whatever order the user tapped.
  it('compares arrays without regard to order', () => {
    const a = { recurrence: { freq: 'weekly', daysOfWeek: [1, 3, 5] } };
    const b = { recurrence: { freq: 'weekly', daysOfWeek: [5, 1, 3] } };
    expect(changedFields(a as never, b)).toEqual([]);
  });

  it('reports a real edit', () => {
    expect(changedFields(series() as never, payload({ title: 'Swim class' }))).toEqual(['title']);
  });

  // exceptionDates is bookkeeping the form never surfaces; a difference there is
  // never a user edit and must not drive the prompt.
  it('ignores exceptionDates', () => {
    const orig = series({ exceptionDates: ['2026-08-13'] });
    expect(changedFields(orig as never, payload({ exceptionDates: [] }))).toEqual([]);
  });
});

describe('saveScopeDecision — which choices the sheet offers', () => {

  it('does not prompt for a one-off event', () => {
    const d = saveScopeDecision(series({ recurrence: null }), payload({ title: 'x' }));
    expect(d.kind).toBe('none');
  });

  // An override created by a previous "Save for This Event Only" has no
  // recurrence of its own, so it edits like any one-off.
  it('does not prompt for an already-detached occurrence', () => {
    const d = saveScopeDecision(series({ recurrence: undefined }), payload({ title: 'x' }));
    expect(d.kind).toBe('none');
  });

  it('does not prompt when nothing changed', () => {
    expect(saveScopeDecision(series(), payload()).kind).toBe('none');
  });

  it.each([
    ['title', { title: 'Swim class' }],
    ['notes', { description: 'bring goggles' }],
    ['date/time', { startDate: '2026-08-06T13:00:00.000Z' }],
    ['location', { location: 'Somewhere else' }],
    ['alerts', { reminderMinutes: 30 }],
    ['travel time', { travelMinutes: 45 }],
  ])('offers both choices for an occurrence-level change (%s)', (_label, patch) => {
    const d = saveScopeDecision(series(), payload(patch));
    expect(d.kind).toBe('both');
    expect(saveChoicesFor(d).map((c) => c.text)).toEqual([
      'Save for This Event Only',
      'Save for Future Events',
    ]);
  });

  it.each([
    ['the repeat rule', { recurrence: { freq: 'monthly', interval: 1 } }],
    ['turning repeat off', { recurrence: undefined }],
    ['end repeat', { recurrence: { freq: 'weekly', interval: 1, until: '2027-01-01T00:00:00.000Z' } }],
    ['the calendar', { calendarType: 'appointments' }],
  ])('offers only "Save for Future Events" for a series-level change (%s)', (_label, patch) => {
    const d = saveScopeDecision(series(), payload(patch));
    expect(d.kind).toBe('futureOnly');
    expect(saveChoicesFor(d).map((c) => c.text)).toEqual(['Save for Future Events']);
  });

  // The whole point of the restrictive rule: a title edit riding along with a
  // repeat-rule edit can't be applied to one day either.
  it('takes the most restrictive answer for a mixed edit', () => {
    const d = saveScopeDecision(
      series(),
      payload({ title: 'Swim class', recurrence: { freq: 'monthly', interval: 1 } }),
    );
    expect(d.kind).toBe('futureOnly');
  });

  // REGRESSION: changing only the repeat rule saved silently. The decision used
  // to go quiet when the edit was made from the series' first occurrence, on the
  // reasoning that "future" and "the whole series" are the same WRITE there —
  // true, but the user is still applying a change to every future event and must
  // still be asked. Which occurrence you're on belongs to the write, not the
  // prompt; the form resolves future-from-the-first into a whole-series rewrite.
  it('prompts for a repeat-rule change no matter which occurrence it was made from', () => {
    const d = saveScopeDecision(series(), payload({ recurrence: { freq: 'monthly' } }));
    expect(d.kind).toBe('futureOnly');
    expect(saveChoicesFor(d).map((c) => c.text)).toEqual(['Save for Future Events']);
  });

  it('offers both choices for an occurrence-level change, first occurrence or not', () => {
    expect(saveScopeDecision(series(), payload({ title: 'x' })).kind).toBe('both');
  });

  // Occurrence-scoped writes re-seal in whichever key lane the event already
  // lives under (api.resealInLane), so an outside-shared calendar's event is no
  // longer withheld from scoping — the earlier suppression traded the capability
  // away to avoid flipping the record out from under its collaborators.
  it('prompts for an event sealed under a shared calendar key, like any other', () => {
    const shared = series({ enc: { ks: 'cal' } });
    expect(saveScopeDecision(shared, payload({ title: 'x' })).kind).toBe('both');
  });

  it('prompts the same for an ordinary household-sealed event', () => {
    const own = series({ enc: { ks: undefined } });
    expect(saveScopeDecision(own, payload({ title: 'x' })).kind).toBe('both');
  });
});

describe('seriesStartDay / isFirstOccurrence', () => {
  it('keys a timed event on its local day', () => {
    // 14:30Z on Aug 6 is 10:30am EDT the same day.
    expect(seriesStartDay(series())).toBe('2026-08-06');
  });

  it('keys an all-day event on its UTC day', () => {
    expect(seriesStartDay(series({ allDay: true, startDate: '2026-08-06T12:00:00.000Z' })))
      .toBe('2026-08-06');
  });

  it('treats a missing occurrence day as the first (opened from search)', () => {
    expect(isFirstOccurrence(series(), undefined)).toBe(true);
  });

  it('recognises a later occurrence', () => {
    expect(isFirstOccurrence(series(), '2026-08-20')).toBe(false);
  });
});

describe('reanchorRecurrence', () => {
  // Aug 6 2026 is a Thursday (4); Aug 7 is a Friday (5).
  it('re-points a weekly rule that named the old start weekday', () => {
    const r = reanchorRecurrence({ freq: 'weekly', daysOfWeek: [4] }, '2026-08-06', '2026-08-07');
    expect(r?.daysOfWeek).toEqual([5]);
  });

  // Mon/Wed/Fri is a pattern the user authored; moving one occurrence must not
  // silently rewrite it.
  it('leaves a hand-authored multi-day weekly rule alone', () => {
    const r = reanchorRecurrence({ freq: 'weekly', daysOfWeek: [1, 3, 5] }, '2026-08-06', '2026-08-07');
    expect(r?.daysOfWeek).toEqual([1, 3, 5]);
  });

  it('leaves a weekly rule alone when its single day was never the start weekday', () => {
    const r = reanchorRecurrence({ freq: 'weekly', daysOfWeek: [1] }, '2026-08-06', '2026-08-07');
    expect(r?.daysOfWeek).toEqual([1]);
  });

  it('re-points a monthly "on the 6th" to the new day of month', () => {
    const r = reanchorRecurrence({ freq: 'monthly', daysOfMonth: [6] }, '2026-08-06', '2026-09-21');
    expect(r?.daysOfMonth).toEqual([21]);
  });

  it('re-points a yearly rule to the new month', () => {
    const r = reanchorRecurrence({ freq: 'yearly', months: [8] }, '2026-08-06', '2026-09-21');
    expect(r?.months).toEqual([9]);
  });

  // Aug 6 2026 is the FIRST Thursday; Sep 21 2026 is the THIRD Monday.
  it('re-points an ordinal rule, moving both the ordinal and the weekday', () => {
    const r = reanchorRecurrence(
      { freq: 'monthly', weekOfMonth: 1, weekdayKind: 'thu' },
      '2026-08-06',
      '2026-09-21',
    );
    expect(r?.weekdayKind).toBe('mon');
    expect(r?.weekOfMonth).toBe(3);
  });

  // Aug 27 2026 is the LAST Thursday of August; Sep 24 2026 is the last Thursday
  // of September, so "last" survives the move.
  it('keeps "last <weekday>" when the new day is also the last of its kind', () => {
    const r = reanchorRecurrence(
      { freq: 'monthly', weekOfMonth: -1, weekdayKind: 'thu' },
      '2026-08-27',
      '2026-09-24',
    );
    expect(r?.weekOfMonth).toBe(-1);
    expect(r?.weekdayKind).toBe('thu');
  });

  // Moving off the last slot has to fall back to a plain ordinal, or the rule
  // would claim a "last Thursday" that isn't one.
  it('downgrades "last" to a plain ordinal when the new day is not the last', () => {
    const r = reanchorRecurrence(
      { freq: 'monthly', weekOfMonth: -1, weekdayKind: 'thu' },
      '2026-08-27',
      '2026-09-10',
    );
    expect(r?.weekOfMonth).toBe(2);
  });

  it('leaves an ordinal rule alone when it never described the old start', () => {
    const r = reanchorRecurrence(
      { freq: 'monthly', weekOfMonth: 2, weekdayKind: 'mon' },
      '2026-08-06',
      '2026-09-21',
    );
    expect(r?.weekOfMonth).toBe(2);
    expect(r?.weekdayKind).toBe('mon');
  });

  it('is a no-op when the day did not move', () => {
    const rule = { freq: 'weekly', daysOfWeek: [4] };
    expect(reanchorRecurrence(rule, '2026-08-06', '2026-08-06')).toBe(rule);
  });

  it('passes a non-repeating rule straight through', () => {
    expect(reanchorRecurrence(null, '2026-08-06', '2026-08-07')).toBeUndefined();
  });
});

describe('exceptions across a split', () => {
  const ex = ['2026-07-30', '2026-08-13', '2026-08-27'];

  it('gives the past to the old series and the rest to the fork', () => {
    expect(splitExceptionDates(ex, '2026-08-20')).toEqual({
      kept: ['2026-07-30', '2026-08-13'],
      forked: ['2026-08-27'],
    });
  });

  it('handles an event with no exceptions', () => {
    expect(splitExceptionDates(undefined, '2026-08-20')).toEqual({ kept: [], forked: [] });
  });

  // A skipped day is relative to the series it belongs to: fork on Aug 20 but
  // move the occurrence to Aug 21 and every inherited exception slides a day,
  // or it points at a date the new series never lands on.
  it('slides inherited exceptions by however far the occurrence moved', () => {
    const delta = exceptionShift('2026-08-20', '2026-08-21');
    expect(delta).toBe(1);
    expect(shiftExceptionDates(['2026-08-27'], delta)).toEqual(['2026-08-28']);
  });

  it('leaves exceptions untouched when the occurrence did not move', () => {
    const days = ['2026-08-27'];
    expect(shiftExceptionDates(days, exceptionShift('2026-08-20', '2026-08-20'))).toBe(days);
  });
});
