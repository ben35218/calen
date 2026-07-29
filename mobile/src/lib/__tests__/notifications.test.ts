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
