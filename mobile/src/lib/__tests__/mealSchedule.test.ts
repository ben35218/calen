// The meal planner's week window (lib/mealSchedule).
//
// Regression: the planner asked the record store for `{ start, end }`, which
// filters by field equality — no schedule carries a `start` field, so every row
// was filtered out and a just-added meal never appeared on the day it was
// scheduled to. The range filter and the recipe-title join now run here, over
// the decrypted replica rows, and this suite pins both.

jest.mock('../../api', () => ({
  recipeScheduleApi: { list: jest.fn() },
  recipesApi: { list: jest.fn() },
}));
jest.mock('../e2ee', () => ({ openRecord: jest.fn(async (_c: string, r: unknown) => r) }));

const { recipeScheduleApi, recipesApi } = require('../../api');
const { loadPlannerMeals, loadSchedulesInRange, scheduleDay, scheduleRecipeId, featuredSchedule, populateRecipeRefs } = require('../mealSchedule');

const SCHEDULES = [
  { _id: 's1', recipeId: 'r1', scheduledDate: '2026-08-12' },              // in window
  { _id: 's2', recipeId: 'r2', scheduledDate: '2026-08-10' },              // window start
  { _id: 's3', recipeId: 'r1', scheduledDate: '2026-08-16' },              // window end
  { _id: 's4', recipeId: 'r1', scheduledDate: '2026-08-17' },              // next week
  { _id: 's5', recipeId: 'r2', scheduledDate: '2026-08-09T00:00:00.000Z' },// pre-C3b ISO, before
];

beforeEach(() => {
  jest.clearAllMocks();
  recipeScheduleApi.list.mockResolvedValue({ data: SCHEDULES });
  recipesApi.list.mockResolvedValue({ data: [{ _id: 'r1', title: 'Soup' }, { _id: 'r2', title: 'Stir fry' }] });
});

test('the range is filtered client-side, inclusive of both ends, sorted by day', async () => {
  const rows = await loadSchedulesInRange('2026-08-10', '2026-08-16');
  expect(rows.map((r: { _id: string }) => r._id)).toEqual(['s2', 's1', 's3']);
  // No params reach the store — a range param would match no field and empty the list.
  expect(recipeScheduleApi.list).toHaveBeenCalledWith();
});

test('planner meals carry their day and their recipe title (the store populates no ref)', async () => {
  const meals = await loadPlannerMeals('2026-08-10', '2026-08-16');
  expect(meals.map((m: { day: string; title: string }) => [m.day, m.title])).toEqual([
    ['2026-08-10', 'Stir fry'],
    ['2026-08-12', 'Soup'],
    ['2026-08-16', 'Soup'],
  ]);
});

test('a schedule pointing at a missing recipe still renders a row', async () => {
  recipeScheduleApi.list.mockResolvedValue({ data: [{ _id: 's9', recipeId: 'gone', scheduledDate: '2026-08-11' }] });
  const [meal] = await loadPlannerMeals('2026-08-10', '2026-08-16');
  expect(meal).toMatchObject({ _id: 's9', title: 'Recipe' });
});

// RecipeDetail's schedule card. The store returns rows in no guaranteed order,
// and the "Next scheduled" date is a tap target that opens the meal planner on
// that day — so the pick must be the genuinely soonest one, not the first row.
describe('featuredSchedule', () => {
  const UNSORTED = [
    { _id: 'a', scheduledDate: '2026-08-20' },
    { _id: 'b', scheduledDate: '2026-08-14' },
    { _id: 'c', scheduledDate: '2026-08-02' },
  ];

  test('picks the soonest still-to-come day regardless of row order', () => {
    expect(featuredSchedule(UNSORTED, '2026-08-10')).toMatchObject({ day: '2026-08-14', upcoming: true });
  });

  test('today itself counts as upcoming', () => {
    expect(featuredSchedule(UNSORTED, '2026-08-14')).toMatchObject({ day: '2026-08-14', upcoming: true });
  });

  test('falls back to the most recent past day when nothing is coming up', () => {
    expect(featuredSchedule(UNSORTED, '2026-09-01')).toMatchObject({ day: '2026-08-20', upcoming: false });
  });

  test('normalizes the pre-C3b ISO date and skips dateless rows; no schedules is null', () => {
    expect(featuredSchedule([{ _id: 'x' }, { _id: 'y', scheduledDate: '2026-08-14T00:00:00.000Z' }], '2026-08-10'))
      .toMatchObject({ day: '2026-08-14', upcoming: true });
    expect(featuredSchedule([], '2026-08-10')).toBeNull();
    expect(featuredSchedule([{ _id: 'x' }], '2026-08-10')).toBeNull();
  });
});

// What the calendar surfaces (month grid, list, day view, search) read. The
// opaque store returns a bare `recipeId` string, so without this join every
// scheduled meal rendered as the literal word "Recipe".
describe('populateRecipeRefs', () => {
  const RECIPES = [{ _id: 'r1', title: 'Soup' }, { _id: 'r2', title: 'Stir fry' }];

  test('re-attaches the recipe as a populated {_id,title} ref', () => {
    const [a, b] = populateRecipeRefs([{ _id: 's1', recipeId: 'r1' }, { _id: 's2', recipeId: 'r2' }], RECIPES);
    expect(a.recipeId).toEqual({ _id: 'r1', title: 'Soup' });
    expect(b.recipeId).toEqual({ _id: 'r2', title: 'Stir fry' });
  });

  test('an unknown recipe leaves the title unset, so the reader\'s own fallback applies', () => {
    const [row] = populateRecipeRefs([{ _id: 's9', recipeId: 'gone' }], RECIPES);
    expect(row.recipeId).toEqual({ _id: 'gone', title: undefined });
  });

  test('an already-populated ref and a schedule with no recipe both survive', () => {
    const [populated, none] = populateRecipeRefs(
      [{ _id: 's1', recipeId: { _id: 'r1', title: 'stale' } }, { _id: 's2' }],
      RECIPES,
    );
    expect(populated.recipeId).toEqual({ _id: 'r1', title: 'Soup' });
    expect(none).toEqual({ _id: 's2' });
  });

  test('other fields are preserved and the input is not mutated', () => {
    const input = [{ _id: 's1', recipeId: 'r1', scheduledDate: '2026-08-12', servings: 4 }];
    const [row] = populateRecipeRefs(input, RECIPES);
    expect(row).toMatchObject({ scheduledDate: '2026-08-12', servings: 4 });
    expect(input[0].recipeId).toBe('r1');
  });
});

test('the day and id readers tolerate the pre-C3b ISO date and populated ref', () => {
  expect(scheduleDay({ scheduledDate: '2026-08-12' })).toBe('2026-08-12');
  expect(scheduleDay({ scheduledDate: new Date('2026-08-12T00:00:00.000Z') })).toBe('2026-08-12');
  expect(scheduleDay({})).toBe('');
  expect(scheduleRecipeId({ recipeId: { _id: 'r1', title: 'Soup' } })).toBe('r1');
  expect(scheduleRecipeId({ recipeId: 'r1' })).toBe('r1');
});
