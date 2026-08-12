// Deleting a recipe takes its planned meals with it — shared by the recipe
// library's swipe action and the edit form's Delete button so both cascade
// identically.
//
// The cascade is client-driven of necessity: a schedule's `recipeId` is sealed
// content, so the server can never find "the schedules of this recipe" to
// clean up after a `/records` tombstone. Left behind, a dangling schedule is
// pure debris — the planner and calendar render it as the literal word
// "Recipe" (no title to join), and the grocery aggregation skips it — so every
// schedule pointing at the recipe goes, past ones included.
//
// The grocery list needs no step of its own here: it is derived from
// schedules + recipes on every visit, and a saved organized list is reconciled
// against the current week by fingerprint (lib/groceryOrganize), which drops
// the removed items' rows while leaving the shopper's sections and checked
// state intact.
//
// Schedules are removed BEFORE the recipe: if the cascade dies partway, the
// recipe is still in the library and the user retries the delete — the reverse
// order would strand undeletable-by-cascade schedules behind a recipe that no
// longer exists.

import { recipesApi, recipeScheduleApi, RecipeSchedule } from '../api';
import { scheduleRecipeId } from './mealSchedule';

// Every schedule pointing at the recipe. Filtered here with scheduleRecipeId
// (not the store's `{ recipeId }` equality param) so legacy rows carrying the
// populated `{ _id, title }` ref shape are found too.
export function schedulesOfRecipe(schedules: RecipeSchedule[], recipeId: string): RecipeSchedule[] {
  return schedules.filter((s) => scheduleRecipeId(s) === String(recipeId));
}

export async function deleteRecipeWithSchedules(recipeId: string): Promise<{ removedMeals: number }> {
  const all = (await recipeScheduleApi.list()).data;
  const mine = schedulesOfRecipe(all, recipeId);
  for (const s of mine) await recipeScheduleApi.remove(s._id);
  await recipesApi.delete(recipeId);
  return { removedMeals: mine.length };
}

// How far the edit form pops after deleting its recipe. A single goBack lands
// on whatever pushed the form — which, from the pencil on the recipe view, is
// the RecipeDetail of the recipe that was just deleted: a dead screen whose
// query can only 404. When that detail is directly underneath, the pop takes
// it too, landing wherever the user opened the recipe from (library, planner,
// calendar). The form can also be reached without a detail underneath (the
// calendar's edit shortcut), where popping one is exactly right — hence the
// check rather than an unconditional pop(2).
export function popCountAfterDelete(
  routes: Array<{ name: string; params?: unknown }>,
  index: number,
  recipeId: string,
): number {
  const prev = routes[index - 1];
  return prev?.name === 'RecipeDetail' && (prev.params as { id?: string } | undefined)?.id === String(recipeId)
    ? 2
    : 1;
}
