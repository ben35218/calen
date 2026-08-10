jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// computeReminders is pure; stub the data loader so importing it doesn't pull in
// the native crypto adapter (react-native-libsodium) via lib/calendarData.
jest.mock('../calendarData', () => ({ loadCalendarData: jest.fn() }));

import type { CalendarData, CalendarOccasion } from '../../api';
import { computeReminders, durationPhrase, timedEventBody, dayLeadPhrase } from '../notifications';

// yyyy-mm-dd for `days` from local midnight today.
function dayStr(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A reminder's local calendar day, in the same yyyy-mm-dd shape as dayStr.
function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function baseData(occasions: CalendarOccasion[]): CalendarData {
  return { tasks: [], chores: [], events: [], occasions, recipes: [], groceryShopping: [], trips: [] };
}

const occ = (over: Partial<CalendarOccasion> = {}): CalendarOccasion => ({
  id: 'birthday-p1-x', kind: 'birthday', name: 'Sam', label: 'Birthday',
  date: dayStr(20), personId: 'p1', ...over,
});

describe('computeReminders — occasions', () => {
  it('schedules noon on the day AND two weeks before with default prefs', () => {
    const data = baseData([occ()]);
    const reminders = computeReminders(data, new Set(), { offsets: [0, 14], time: '12:00' });

    // One occasion → two reminders (day-of + 14 days before), both at local noon.
    expect(reminders).toHaveLength(2);
    for (const r of reminders) {
      expect(r.at.getHours()).toBe(12);
      expect(r.at.getMinutes()).toBe(0);
    }
    const dates = reminders.map((r) =>
      `${r.at.getFullYear()}-${String(r.at.getMonth() + 1).padStart(2, '0')}-${String(r.at.getDate()).padStart(2, '0')}`
    );
    expect(dates).toContain(dayStr(20)); // the day of
    expect(dates).toContain(dayStr(6));  // two weeks before

    // The day-of reminder announces the occasion; the earlier one is a heads-up.
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayOf = reminders.find((r) => fmt(r.at) === dayStr(20));
    expect(dayOf?.title).toBe("Sam's Birthday");
  });

  it('respects a custom time and a single offset', () => {
    const reminders = computeReminders(baseData([occ()]), new Set(), { offsets: [0], time: '09:30' });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].at.getHours()).toBe(9);
    expect(reminders[0].at.getMinutes()).toBe(30);
  });

  it('is suppressed when the Occasions calendar (id "birthdays") is muted', () => {
    const reminders = computeReminders(baseData([occ()]), new Set(['birthdays']), { offsets: [0, 14], time: '12:00' });
    expect(reminders).toHaveLength(0);
  });

  it('titles non-birthday kinds by their occasion', () => {
    const reminders = computeReminders(
      baseData([occ({ id: 'occ-anniversary-p1-x', kind: 'anniversary', label: 'anniversary' })]),
      new Set(),
      { offsets: [0], time: '12:00' },
    );
    expect(reminders[0].title).toBe("Sam's Anniversary");
  });
});

describe('computeReminders — holidays', () => {
  const hol = (over: Partial<{ calendarId: string; date: string; name: string }> = {}) => ({
    calendarId: 'hol-ca', date: dayStr(10), name: 'Canada Day', ...over,
  });
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  it('schedules nothing until the user picks an alert (the default is off)', () => {
    const none = computeReminders(baseData([]), new Set(), undefined, null, { prefs: { offsets: [], time: '09:00' }, items: [hol()] });
    expect(none).toHaveLength(0);
    // …and an absent config behaves the same as an empty one.
    expect(computeReminders(baseData([]), new Set(), undefined, null)).toHaveLength(0);
  });

  it('fires both slots at the shared time, day-of and days before', () => {
    const reminders = computeReminders(baseData([]), new Set(), undefined, null, {
      prefs: { offsets: [0, 7], time: '08:15' }, items: [hol()],
    });

    expect(reminders).toHaveLength(2);
    for (const r of reminders) {
      expect(r.at.getHours()).toBe(8);
      expect(r.at.getMinutes()).toBe(15);
    }
    const dayOf = reminders.find((r) => fmt(r.at) === dayStr(10));
    const early = reminders.find((r) => fmt(r.at) === dayStr(3));
    expect(dayOf?.title).toBe('Canada Day');
    expect(early?.title).toBe('Upcoming: Canada Day');
  });

  it('covers every holiday calendar, and is suppressed per-calendar by its Alerts switch', () => {
    const items = [hol(), hol({ calendarId: 'hol-us', date: dayStr(12), name: 'Independence Day' })];
    const all = computeReminders(baseData([]), new Set(), undefined, null, { prefs: { offsets: [0], time: '09:00' }, items });
    expect(all.map((r) => r.title).sort()).toEqual(['Canada Day', 'Independence Day']);

    const muted = computeReminders(baseData([]), new Set(['hol-us']), undefined, null, { prefs: { offsets: [0], time: '09:00' }, items });
    expect(muted.map((r) => r.title)).toEqual(['Canada Day']);
  });

  it('skips alert times that have already passed', () => {
    // A holiday 3 days out with a "1 week before" alert — that alert was due
    // four days ago, so nothing is scheduled for it.
    const reminders = computeReminders(baseData([]), new Set(), undefined, null, {
      prefs: { offsets: [7], time: '09:00' }, items: [hol({ date: dayStr(3) })],
    });
    expect(reminders).toHaveLength(0);
  });
});

describe('computeReminders — day-based default (dayAlertTime)', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: 't1', title: 'Furnace filter', nextDueDate: `${dayStr(3)}T12:00:00Z`,
    reminderDaysBefore: 0, alert2DaysBefore: null, reminderTime: null, ...over,
  });
  const tasksData = (tasks: any[]): CalendarData =>
    ({ tasks, chores: [], events: [], occasions: [], recipes: [], groceryShopping: [], trips: [] } as any);

  it('fires a task with no reminderTime at 9am when no default is set', () => {
    const reminders = computeReminders(tasksData([task()]), new Set(), undefined, null);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].at.getHours()).toBe(9);
    expect(reminders[0].at.getMinutes()).toBe(0);
  });

  it('honors the account-level dayAlertTime for items without their own time', () => {
    const reminders = computeReminders(tasksData([task()]), new Set(), undefined, '08:30');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].at.getHours()).toBe(8);
    expect(reminders[0].at.getMinutes()).toBe(30);
  });

  it('a per-item reminderTime still overrides the account default', () => {
    const reminders = computeReminders(tasksData([task({ reminderTime: '18:45' })]), new Set(), undefined, '08:30');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].at.getHours()).toBe(18);
    expect(reminders[0].at.getMinutes()).toBe(45);
  });
});

// An all-day event has no start time, so its alerts count back from its own
// date at the day-alert hour — NOT from the noon-UTC instant it stores, which
// lands at a different local hour for every UTC offset (5am in Los Angeles, 8am
// in New York, 2pm in Berlin). See lib/calendar `eventAlertAnchor`.
describe('computeReminders — all-day events', () => {
  const allDayEvent = (over: Record<string, unknown> = {}) => ({
    _id: 'e1', title: 'Trip departs', calendarType: 'activities', allDay: true,
    startDate: `${dayStr(5)}T12:00:00.000Z`, reminderMinutes: 0, alert2Minutes: null, ...over,
  });
  const eventsData = (events: any[]): CalendarData =>
    ({ tasks: [], chores: [], events, occasions: [], recipes: [], groceryShopping: [], trips: [] } as any);

  it('fires "on the day" at 9am local when no day-alert default is set', () => {
    const reminders = computeReminders(eventsData([allDayEvent()]), new Set(), undefined, null);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].at.getHours()).toBe(9);
    expect(reminders[0].at.getMinutes()).toBe(0);
    expect(fmtLocal(reminders[0].at)).toBe(dayStr(5)); // the event's own day
  });

  it('honors the account-level dayAlertTime', () => {
    const reminders = computeReminders(eventsData([allDayEvent()]), new Set(), undefined, '07:30');
    expect([reminders[0].at.getHours(), reminders[0].at.getMinutes()]).toEqual([7, 30]);
  });

  it('places a whole-day offset on the earlier day at that same hour', () => {
    const reminders = computeReminders(
      eventsData([allDayEvent({ startDate: `${dayStr(10)}T12:00:00.000Z`, reminderMinutes: 1440, alert2Minutes: 10080 })]),
      new Set(), undefined, '09:00',
    );
    const byDay = reminders.map((r) => `${fmtLocal(r.at)}@${r.at.getHours()}`);
    expect(byDay).toContain(`${dayStr(9)}@9`); // 1 day before
    expect(byDay).toContain(`${dayStr(3)}@9`); // 1 week before
  });

  it('phrases the body in days, never minutes', () => {
    const bodies = computeReminders(
      eventsData([allDayEvent({ reminderMinutes: 0, alert2Minutes: 1440 })]),
      new Set(), undefined, null,
    ).map((r) => r.body);
    expect(bodies.sort()).toEqual(['Today', 'Tomorrow']);
  });

  // A timed event on the same data must keep counting from its own start.
  it('leaves timed events anchored on their start instant', () => {
    const start = new Date(Date.now() + 3 * 3600_000);
    const reminders = computeReminders(
      eventsData([{ _id: 'e2', title: 'Dentist', calendarType: 'activities', allDay: false, startDate: start.toISOString(), reminderMinutes: 30 }]),
      new Set(), undefined, '09:00',
    );
    expect(reminders[0].at.getTime()).toBe(start.getTime() - 30 * 60000);
    expect(reminders[0].body).toBe('Starts in 30 minutes');
  });

  it('is suppressed when the event\'s calendar is muted', () => {
    expect(computeReminders(eventsData([allDayEvent()]), new Set(['activities']), undefined, null)).toHaveLength(0);
  });
});

// The fixtures above hand-build tasks with STRING nextDueDates, which is only
// one of the two shapes the real engine produces — expandRecurringTaskChore sets
// a Date object on every instance it generates for recurring items. Feeding it
// hand-made strings is exactly why a `.slice()` on a Date shipped: it threw
// "undefined is not a function" and, since the whole window is one pass, took
// every other reminder (events included) down with it. So drive this suite from
// the engine's actual output.
describe('computeReminders — over real engine output', () => {
  const { assembleCalendarData } = require('@household/calendar');

  // A chore recurring every 3 days, starting tomorrow, alerting on the day.
  const chore = {
    _id: 'c1', title: 'Water plants', active: true,
    nextDueDate: `${dayStr(1)}T12:00:00`,
    recurrence: { type: 'interval', intervalUnit: 'days', intervalValue: 3 },
    reminderDaysBefore: 0, alert2DaysBefore: null, reminderTime: null,
  };

  function assemble(over: Record<string, unknown> = {}) {
    return assembleCalendarData({
      events: [], tasks: [], chores: [chore], people: [], recipeSchedules: [], trips: [],
      fromDate: new Date(), toDate: new Date(Date.now() + 21 * 86400000),
      ...over,
    }) as CalendarData;
  }

  it('schedules day alerts for recurring chores (Date-valued nextDueDate)', () => {
    const data = assemble();
    // Guard the premise: if the engine ever switches to strings, this test stops
    // covering the shape it exists for.
    expect(data.chores.length).toBeGreaterThan(1);
    expect(data.chores[0].nextDueDate).toBeInstanceOf(Date);

    const reminders = computeReminders(data, new Set(), undefined, null);
    expect(reminders.length).toBe(data.chores.length);
    for (const r of reminders) {
      expect(r.title).toBe('Water plants');
      expect(r.at.getHours()).toBe(9); // the 9am day-based default
    }
  });

  it('fires each occurrence on its own local due date', () => {
    const reminders = computeReminders(assemble(), new Set(), undefined, null);
    const dates = reminders.map((r) => `${r.at.getFullYear()}-${String(r.at.getMonth() + 1).padStart(2, '0')}-${String(r.at.getDate()).padStart(2, '0')}`);
    expect(dates).toContain(dayStr(1));
    expect(dates).toContain(dayStr(4));
    expect(new Set(dates).size).toBe(dates.length); // no duplicate days
  });

  it('does not let a recurring chore take the rest of the window down', () => {
    const start = new Date(Date.now() + 2 * 3600_000);
    const data = assemble({
      events: [{ _id: 'e1', title: 'Dentist', startDate: start.toISOString(), reminderMinutes: 30, calendarType: 'personal' }],
    });
    const titles = computeReminders(data, new Set(), undefined, null).map((r) => r.title);
    expect(titles).toContain('Dentist');
    expect(titles).toContain('Water plants');
  });
});

// A day-based reminder's body is the lead time and nothing else — bare
// "Tomorrow"/"2 weeks", no verb phrase and no record-kind label, both of which
// spent the line on words the banner already implies. A TIMED EVENT's body
// names what that lead time is until, because the same number means two
// different things depending on the alert's anchor.
describe('reminder lead-time wording', () => {
  it('spells an exact duration, never rounding and never using calendar words', () => {
    expect(durationPhrase(1)).toBe('1 minute');
    expect(durationPhrase(15)).toBe('15 minutes');
    expect(durationPhrase(60)).toBe('1 hour');
    expect(durationPhrase(120)).toBe('2 hours');
    // The Custom sheet's minutes wheel reaches 180, so mixed values are real:
    // the old rounding read this back as "2 hours".
    expect(durationPhrase(90)).toBe('1 hour 30 minutes');
    expect(durationPhrase(97)).toBe('1 hour 37 minutes');
    expect(durationPhrase(1440)).toBe('1 day');   // NOT "Tomorrow"
    expect(durationPhrase(2880)).toBe('2 days');
    expect(durationPhrase(10080)).toBe('1 week');
  });

  it('names what a timed event\'s lead time counts down to', () => {
    expect(timedEventBody(60, 'event')).toBe('Starts in 1 hour');
    expect(timedEventBody(23, null)).toBe('Starts in 23 minutes');       // absent anchor = event
    expect(timedEventBody(0, 'event')).toBe('Starting now');
    expect(timedEventBody(1440, 'event')).toBe('Starts in 1 day');
  });

  // A departure-anchored alert stores minutes before the EVENT (drive + buffer),
  // so the body has to subtract the drive back out: "23 min before leaving" on a
  // 40-minute drive is stored as 63 and must never read as "Leave in 63 minutes".
  it('counts a departure-anchored alert down to leaving, not to the start', () => {
    expect(timedEventBody(63, 'leave', 40)).toBe('Leave in 23 minutes');
    expect(timedEventBody(40, 'leave', 40)).toBe('Leave now');
    expect(timedEventBody(30, 'leave', 40)).toBe('Leave now'); // buffer can't go negative
    expect(timedEventBody(100, 'leave', 40)).toBe('Leave in 1 hour');
  });

  // Dropping the location leaves `alertAnchor: 'leave'` on a record with no
  // drive time; the alert falls back to what the stored number literally is.
  it('falls back to start wording when the drive time is gone', () => {
    expect(timedEventBody(63, 'leave', null)).toBe('Starts in 1 hour 3 minutes');
    expect(timedEventBody(63, 'leave', 0)).toBe('Starts in 1 hour 3 minutes');
  });

  it('phrases whole-day offsets, collapsing multiples of a week', () => {
    expect(dayLeadPhrase(0)).toBe('Today');
    expect(dayLeadPhrase(1)).toBe('Tomorrow');
    expect(dayLeadPhrase(3)).toBe('3 days');
    expect(dayLeadPhrase(7)).toBe('1 week');
    expect(dayLeadPhrase(14)).toBe('2 weeks');
  });

  const data = (over: Partial<CalendarData>): CalendarData =>
    ({ tasks: [], chores: [], events: [], occasions: [], recipes: [], groceryShopping: [], trips: [], ...over } as any);

  it('tells an event how long until it starts', () => {
    const start = new Date(Date.now() + 3 * 3600_000);
    const reminders = computeReminders(
      data({ events: [{ _id: 'e1', title: 'Dentist', startDate: start.toISOString(), reminderMinutes: 15, alert2Minutes: 60, calendarType: 'personal' }] as any }),
      new Set(), undefined, null,
    );
    expect(reminders.map((r) => r.body)).toEqual(['Starts in 1 hour', 'Starts in 15 minutes']);
  });

  // The two slots hold their own anchors, so one event's pair can word itself
  // two different ways — the normal shape for an event with a drive time.
  it('words each alert slot by its own anchor', () => {
    const start = new Date(Date.now() + 3 * 3600_000);
    const reminders = computeReminders(
      data({ events: [{
        _id: 'e1', title: 'Dentist', startDate: start.toISOString(), calendarType: 'personal',
        travelMinutes: 23,
        reminderMinutes: 60, alertAnchor: 'event',   // an hour before the appointment
        alert2Minutes: 23, alert2Anchor: 'leave',    // and the moment to walk out
      }] as any }),
      new Set(), undefined, null,
    );
    expect(reminders.map((r) => r.body)).toEqual(['Starts in 1 hour', 'Leave now']);
  });

  it('gives day-based alerts their own lead time per offset', () => {
    const tasks = [{ id: 't1', title: 'Furnace filter', nextDueDate: `${dayStr(10)}T12:00:00Z`, reminderDaysBefore: 0, alert2DaysBefore: 7, reminderTime: null }];
    const chores = [{ id: 'c1', title: 'Water plants', nextDueDate: `${dayStr(2)}T12:00:00Z`, reminderDaysBefore: 1, alert2DaysBefore: null, reminderTime: null }];
    const bodies = computeReminders(data({ tasks, chores } as any), new Set(), undefined, null).map((r) => r.body);
    expect(bodies).toContain('Today');    // task, on the due date
    expect(bodies).toContain('1 week');   // task, second alert
    expect(bodies).toContain('Tomorrow'); // chore, one day before
  });

  it('gives occasions and holidays the same bare lead time', () => {
    const occasions = computeReminders(baseData([occ()]), new Set(), { offsets: [0, 14], time: '12:00' });
    expect(occasions.map((r) => r.body).sort()).toEqual(['2 weeks', 'Today']);

    const holidays = computeReminders(baseData([]), new Set(), undefined, null, {
      prefs: { offsets: [0, 7], time: '09:00' }, items: [{ calendarId: 'hol-ca', date: dayStr(10), name: 'Canada Day' }],
    });
    expect(holidays.map((r) => r.body).sort()).toEqual(['1 week', 'Today']);
  });
});
