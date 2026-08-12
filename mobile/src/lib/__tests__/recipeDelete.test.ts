// The recipe-delete cascade (lib/recipeDelete): a deleted recipe takes every
// schedule pointing at it off the meal plan. The cascade is client-driven —
// `recipeId` is sealed content, so the server can't clean up after the
// tombstone — and the ordering is load-bearing: schedules go first, so a
// cascade that dies partway leaves the recipe in the library to retry, never a
// deleted recipe with orphaned meals behind it.

jest.mock('../../api', () => ({
  recipesApi: { delete: jest.fn() },
  recipeScheduleApi: { list: jest.fn(), remove: jest.fn() },
}));
jest.mock('../e2ee', () => ({ openRecord: jest.fn(async (_c: string, r: unknown) => r) }));

const { recipesApi, recipeScheduleApi } = require('../../api');
const { deleteRecipeWithSchedules, schedulesOfRecipe, popCountAfterDelete } = require('../recipeDelete');

const SCHEDULES = [
  { _id: 's1', recipeId: 'r1', scheduledDate: '2026-08-12' },
  { _id: 's2', recipeId: 'r2', scheduledDate: '2026-08-13' },        // another recipe — stays
  { _id: 's3', recipeId: { _id: 'r1' }, scheduledDate: '2026-08-01' }, // legacy populated-ref shape, past
];

beforeEach(() => {
  jest.clearAllMocks();
  recipeScheduleApi.list.mockResolvedValue({ data: SCHEDULES });
  recipeScheduleApi.remove.mockResolvedValue({ data: { message: 'Deleted' } });
  recipesApi.delete.mockResolvedValue({ data: { message: 'Deleted' } });
});

test('deletes every schedule of the recipe — legacy ref shape and past meals included — then the recipe', async () => {
  const ops: string[] = [];
  recipeScheduleApi.remove.mockImplementation(async (id: string) => { ops.push(`schedule:${id}`); });
  recipesApi.delete.mockImplementation(async (id: string) => { ops.push(`recipe:${id}`); });

  const { removedMeals } = await deleteRecipeWithSchedules('r1');

  expect(removedMeals).toBe(2);
  // s2 belongs to another recipe and is untouched; the recipe goes last.
  expect(ops).toEqual(['schedule:s1', 'schedule:s3', 'recipe:r1']);
});

test('a recipe with no planned meals deletes without touching the schedule store', async () => {
  const { removedMeals } = await deleteRecipeWithSchedules('r9');
  expect(removedMeals).toBe(0);
  expect(recipeScheduleApi.remove).not.toHaveBeenCalled();
  expect(recipesApi.delete).toHaveBeenCalledWith('r9');
});

test('a failed schedule removal keeps the recipe (retryable), never the reverse', async () => {
  recipeScheduleApi.remove.mockRejectedValueOnce(new Error('offline'));
  await expect(deleteRecipeWithSchedules('r1')).rejects.toThrow('offline');
  expect(recipesApi.delete).not.toHaveBeenCalled();
});

test('schedulesOfRecipe matches both id shapes', () => {
  expect(schedulesOfRecipe(SCHEDULES, 'r1').map((s: { _id: string }) => s._id)).toEqual(['s1', 's3']);
  expect(schedulesOfRecipe(SCHEDULES, 'r2').map((s: { _id: string }) => s._id)).toEqual(['s2']);
});

// The edit form's post-delete pop: past the deleted recipe's own detail screen
// when it sits directly underneath, a single step everywhere else.
describe('popCountAfterDelete', () => {
  const detail = (id: string) => ({ name: 'RecipeDetail', params: { id } });

  test('pops the dead detail screen too when it is directly underneath', () => {
    const routes = [{ name: 'Recipes' }, detail('r1'), { name: 'RecipeForm', params: { id: 'r1' } }];
    expect(popCountAfterDelete(routes, 2, 'r1')).toBe(2);
  });

  test('a detail of a DIFFERENT recipe underneath is not popped', () => {
    const routes = [detail('r2'), { name: 'RecipeForm', params: { id: 'r1' } }];
    expect(popCountAfterDelete(routes, 1, 'r1')).toBe(1);
  });

  test('a form reached without a detail underneath (calendar edit shortcut) pops once', () => {
    const routes = [{ name: 'CalendarHome' }, { name: 'RecipeForm', params: { id: 'r1' } }];
    expect(popCountAfterDelete(routes, 1, 'r1')).toBe(1);
    expect(popCountAfterDelete([{ name: 'RecipeForm' }], 0, 'r1')).toBe(1); // nothing underneath at all
  });
});
