jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// computeReminders is pure; stub the data loader so importing it doesn't pull in
// the native crypto adapter (react-native-libsodium) via lib/calendarData.
jest.mock('../calendarData', () => ({ loadCalendarData: jest.fn() }));

import type { CalendarData, CalendarOccasion } from '../../api';
import { computeReminders } from '../notifications';

// yyyy-mm-dd for `days` from local midnight today.
function dayStr(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
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
