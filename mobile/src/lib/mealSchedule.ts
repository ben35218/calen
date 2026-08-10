// The meal planner's week window, read client-side.
//
// Pre-C3b `GET /recipe-schedule?start=&end=` was a server-side date-range query
// that also populated `recipeId` with its Recipe. Both went away when the
// collection moved onto the opaque record store: the server is content-blind,
// and `recordStore.list` filters the decrypted replica by **field equality**
// only. Passing `{ start, end }` therefore matched no row at all (no record has
// a `start` field), so the planner and the grocery list silently came back
// empty — a scheduled meal was written correctly and then never displayed.
//
// Range selection and the recipe-title join both belong here, over the
// decrypted replica, so every reader (PlannerPane, lib/groceryList) shares one
// implementation instead of re-rolling the filter.

import { recipeScheduleApi, recipesApi, Recipe, RecipeSchedule } from '../api';
import { openRecord } from './e2ee';

// Schedules are created with a plain `YYYY-MM-DD` scheduledDate; rows written
// before C3b carry a full ISO timestamp at UTC midnight. Both reduce to the day.
export function scheduleDay(s: { scheduledDate?: string | Date | null }): string {
  const d = s.scheduledDate;
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

// The id a schedule points at, tolerating the legacy populated-ref shape.
export function scheduleRecipeId(s: RecipeSchedule): string {
  return typeof s.recipeId === 'object' && s.recipeId ? s.recipeId._id : String(s.recipeId ?? '');
}

// The one schedule worth surfacing on a recipe's detail card: the soonest
// still-to-come meal, else the most recent past one. `today` is the caller's
// local `YYYY-MM-DD` (lib/calendar `ymd`), so "upcoming" includes today itself.
//
// The sort is load-bearing, not tidiness: the record store returns rows in no
// guaranteed order, and RecipeDetail's date is a tappable link into the meal
// planner — "next scheduled" has to actually be next or the tap lands the user
// on the wrong week.
export function featuredSchedule(
  schedules: RecipeSchedule[],
  today: string,
): { s: RecipeSchedule; day: string; upcoming: boolean } | null {
  const days = schedules
    .map((s) => ({ s, day: scheduleDay(s) }))
    .filter((x) => !!x.day)
    .sort((a, b) => a.day.localeCompare(b.day));
  if (!days.length) return null;
  const next = days.find((x) => x.day >= today);
  return next ? { ...next, upcoming: true } : { ...days[days.length - 1], upcoming: false };
}

// Re-attach each schedule's recipe as a populated `{ _id, title }` ref — the
// shape the shared calendar engine and `lib/calendar`'s itemsForDate still read,
// and the one the opaque store can never return (it's content-blind, so a
// schedule comes back with a bare `recipeId` string). Without this every meal on
// every calendar surface renders as the literal word "Recipe".
//
// An unknown id keeps `title` undefined so the reader's own "Recipe" fallback
// still applies; a schedule with no recipe at all passes through untouched.
export function populateRecipeRefs<T extends { recipeId?: unknown }>(
  schedules: T[],
  recipes: { _id?: unknown; title?: string }[],
): T[] {
  const titles = new Map<string, string | undefined>(recipes.map((r) => [String(r._id), r.title]));
  return schedules.map((s) => {
    const id = scheduleRecipeId(s as unknown as RecipeSchedule);
    return id ? { ...s, recipeId: { _id: id, title: titles.get(id) } } : s;
  });
}

export type PlannerMeal = RecipeSchedule & { day: string; title: string };

// Every schedule whose day falls in [start, end] (inclusive `YYYY-MM-DD`),
// sorted by day. Offline-first: `recipeScheduleApi.list()` syncs best-effort and
// then reads the replica.
export async function loadSchedulesInRange(start: string, end: string): Promise<RecipeSchedule[]> {
  const rows = (await recipeScheduleApi.list()).data;
  return rows
    .filter((r) => {
      const day = scheduleDay(r);
      return !!day && day >= start && day <= end;
    })
    .sort((a, b) => scheduleDay(a).localeCompare(scheduleDay(b)));
}

// The same window, each row carrying its day and its recipe's title (the store
// returns no populated ref, so the title is joined from the Recipe replica).
export async function loadPlannerMeals(start: string, end: string): Promise<PlannerMeal[]> {
  const [schedules, recipes] = await Promise.all([
    loadSchedulesInRange(start, end),
    recipesApi.list().then(({ data }) => Promise.all(data.map((r) => openRecord('Recipe', r)))),
  ]);
  const titles = new Map<string, string>(recipes.map((r: Recipe) => [String(r._id), r.title]));
  return schedules.map((s) => ({
    ...s,
    day: scheduleDay(s),
    title: titles.get(scheduleRecipeId(s)) ?? 'Recipe',
  }));
}
