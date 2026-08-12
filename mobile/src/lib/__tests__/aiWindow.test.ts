// Signal-parity G4 — query-scoped AI context. Pins the two pure functions so a
// regression in the windowing (which trades assistant context breadth for privacy)
// is caught: the window derivation from conversation text, and the recurrence-safe
// source filter.

import { deriveAiWindow, scopeCalendarSources, availabilityForWindow } from '../aiWindow';

const NOW = new Date('2026-07-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const days = (d: Date) => Math.round((d.getTime() - NOW.getTime()) / DAY);

describe('deriveAiWindow', () => {
  it('defaults to a modest span around now with no date hints', () => {
    const w = deriveAiWindow(['what should I do this weekend?'], NOW);
    expect(days(w.from)).toBe(-45);
    expect(days(w.to)).toBe(183);
  });

  it('widens forward for "next year"', () => {
    const w = deriveAiWindow(['am I free anytime next year?'], NOW);
    expect(w.to.getFullYear()).toBe(2027);
    expect(w.to >= new Date('2027-12-30')).toBe(true);
  });

  it('covers an explicit calendar year', () => {
    const w = deriveAiWindow(['what happens in 2028?'], NOW);
    expect(w.from <= new Date('2028-01-01')).toBe(true);
    expect(w.to >= new Date('2028-12-30')).toBe(true);
  });

  it('extends forward for a future duration', () => {
    const w = deriveAiWindow(['find a dentist slot in the next 12 months'], NOW);
    expect(days(w.to)).toBeGreaterThan(360);
  });

  it('extends backward for history intent', () => {
    const w = deriveAiWindow(['when did I last visit the dentist?'], NOW);
    expect(days(w.from)).toBeLessThanOrEqual(-360);
  });

  it('covers a named month', () => {
    const w = deriveAiWindow(['anything in December?'], NOW);
    expect(w.to >= new Date('2026-12-01')).toBe(true);
  });

  it('clamps an absurd future duration to the 3-year cap', () => {
    const w = deriveAiWindow(['plan the next 40 years'], NOW);
    expect(days(w.to)).toBeLessThanOrEqual(1095);
  });

  it('keeps a focused event in scope', () => {
    const focus = new Date('2027-05-10T00:00:00Z');
    const w = deriveAiWindow(['reschedule this'], NOW, focus);
    expect(w.from <= focus).toBe(true);
    expect(w.to >= focus).toBe(true);
  });
});

describe('scopeCalendarSources', () => {
  const window = { from: new Date('2026-07-01'), to: new Date('2026-09-01') };
  const sources = {
    events: [
      { _id: 'inA', title: 'in-window', startDate: '2026-08-01T10:00:00Z' },
      { _id: 'outA', title: 'far-future one-off', startDate: '2027-08-01T10:00:00Z' },
      { _id: 'outB', title: 'far-past one-off', startDate: '2024-01-01T10:00:00Z' },
      { _id: 'recA', title: 'weekly standup', startDate: '2024-01-01T10:00:00Z', recurrence: { freq: 'weekly' } },
      { _id: 'undated', title: 'no date' },
    ],
    tasks: [
      { _id: 't1', title: 'due soon', nextDueDate: '2026-08-15', recurrence: { type: 'one-time' } },
      { _id: 't2', title: 'due far', nextDueDate: '2028-01-01', recurrence: { type: 'one-time' } },
      { _id: 't3', title: 'recurring maint', nextDueDate: '2020-01-01', recurrence: { type: 'interval', intervalValue: 3, intervalUnit: 'months' } },
    ],
    chores: [],
    trips: [
      { _id: 'tr1', name: 'in range', startDate: '2026-08-10', endDate: '2026-08-20' },
      { _id: 'tr2', name: 'out of range', startDate: '2027-01-01', endDate: '2027-01-10' },
    ],
    contacts: [{ _id: 'p1', name: 'Ada' }],
    recipeSchedules: [{ _id: 'rs1', date: '2029-01-01' }],
  };

  const scoped = scopeCalendarSources(sources as any, window);

  it('keeps in-window and recurring events, drops far one-offs, keeps undated', () => {
    const ids = scoped.events.map((e: any) => e._id).sort();
    expect(ids).toEqual(['inA', 'recA', 'undated']);
  });

  it('keeps due-soon and recurring tasks, drops far one-off tasks', () => {
    expect(scoped.tasks.map((t: any) => t._id).sort()).toEqual(['t1', 't3']);
  });

  it('filters trips by date-range overlap', () => {
    expect(scoped.trips.map((t: any) => t._id)).toEqual(['tr1']);
  });

  it('leaves the roster and recipe schedules untouched (birthdays span the year)', () => {
    expect(scoped.contacts).toEqual(sources.contacts);
    expect(scoped.recipeSchedules).toEqual(sources.recipeSchedules);
  });
});

// The availability-only projection used when "Use personal & contact info in
// prompts" is off: the calendar records must be reduced to free/busy time with
// NO record-identifying detail leaving the device.
describe('availabilityForWindow (privacy toggle off)', () => {
  const window = { from: new Date('2026-07-20T00:00:00Z'), to: new Date('2026-07-22T23:59:59Z') };

  it('reduces sources to title-stripped free/busy days', () => {
    const sources = {
      events: [
        {
          _id: 'e1', title: 'Secret therapy session', calendarType: 'appointments', allDay: false,
          startDate: '2026-07-20T14:00:00.000Z', endDate: '2026-07-20T15:00:00.000Z',
        },
      ],
      tasks: [], chores: [], contacts: [], trips: [], recipeSchedules: [], selfId: 'me',
    };
    const days = availabilityForWindow(sources as any, window, 'UTC');
    const json = JSON.stringify(days);

    // No title, description, or id may survive into the availability payload.
    expect(json).not.toContain('Secret therapy session');
    expect(json).not.toContain('e1');

    const busyDay = days.find((d) => d.date === '2026-07-20');
    expect(busyDay?.status).toBe('partial');
    expect(busyDay?.busy).toEqual([{ start: '14:00', end: '15:00' }]);
  });

  it('drops the trip name from an away day', () => {
    const sources = {
      events: [], tasks: [], chores: [], contacts: [], recipeSchedules: [], selfId: 'me',
      trips: [{ _id: 'tr1', name: 'Anniversary getaway', startDate: '2026-07-21', endDate: '2026-07-21' }],
    };
    const days = availabilityForWindow(sources as any, window, 'UTC');
    const awayDay = days.find((d) => d.date === '2026-07-21');
    expect(awayDay?.status).toBe('away');
    expect(JSON.stringify(days)).not.toContain('Anniversary getaway');
  });
});
