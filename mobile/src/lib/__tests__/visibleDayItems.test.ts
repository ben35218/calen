// Calendar visibility is a display filter that must hold on EVERY surface — the
// month grid, the month's List mode, and all three day-view modes. They all go
// through visibleDayItems, so this pins the collection → calendar-id mapping.

import { itemsForDate, visibleDayItems, type DayItems } from '../calendar';

const DATE = '2026-08-12';

const day = (): DayItems =>
  itemsForDate(
    {
      events: [
        { _id: 'e1', title: 'Dentist', calendarType: 'appointments', startDate: `${DATE}T15:00:00.000Z` },
        { _id: 'e2', title: 'Soccer', calendarType: 'activities', startDate: `${DATE}T22:00:00.000Z` },
      ],
      tasks: [{ _id: 't1', title: 'Furnace filter', nextDueDate: `${DATE}T12:00:00.000Z` }],
      chores: [{ _id: 'c1', title: 'Dishes', nextDueDate: `${DATE}T12:00:00.000Z` }],
      recipes: [{ recipeId: { _id: 'r1', title: 'Chili' }, scheduledDate: `${DATE}T12:00:00.000Z` }],
      trips: [{ id: 'tr1', name: 'Banff', color: '#5E35B1', ranges: [{ start: DATE, end: DATE }] }],
      occasions: [{ id: 'o1', name: 'Dee', kind: 'birthday', date: DATE }],
      groceryShopping: [{ date: DATE }],
    } as any,
    DATE,
  );

const all = () => true;
const hide = (hidden: string[]) => (id: string) => !hidden.includes(id);

describe('visibleDayItems', () => {
  it('passes everything through when no calendar is hidden', () => {
    expect(visibleDayItems(day(), all)).toEqual(day());
  });

  it('drops only the hidden calendar’s events, leaving the others', () => {
    const out = visibleDayItems(day(), hide(['appointments']));
    expect(out.events.map((e) => e._id)).toEqual(['e2']);
  });

  it('maps each collection to the calendar that owns it', () => {
    expect(visibleDayItems(day(), hide(['maintenance'])).tasks).toEqual([]);
    expect(visibleDayItems(day(), hide(['chores'])).chores).toEqual([]);
    expect(visibleDayItems(day(), hide(['trips'])).trips).toEqual([]);
    expect(visibleDayItems(day(), hide(['birthdays'])).occasions).toEqual([]);
    // Meals owns both the scheduled recipes and the shopping-day marker.
    const noMeals = visibleDayItems(day(), hide(['recipes']));
    expect(noMeals.recipes).toEqual([]);
    expect(noMeals.grocery).toBe(false);
  });

  it('leaves the other collections untouched when one calendar is hidden', () => {
    const out = visibleDayItems(day(), hide(['chores']));
    expect(out.tasks).toHaveLength(1);
    expect(out.recipes).toHaveLength(1);
    expect(out.trips).toHaveLength(1);
    expect(out.occasions).toHaveLength(1);
    expect(out.grocery).toBe(true);
    expect(out.events).toHaveLength(2);
  });

  it('empties the day when every calendar is hidden', () => {
    const out = visibleDayItems(day(), () => false);
    expect(out).toEqual({ events: [], tasks: [], chores: [], recipes: [], trips: [], occasions: [], grocery: false });
  });
});
