// Client-side grocery list (Signal-parity D5). The server used to aggregate
// Recipe.ingredients for the week, but ingredients are sealed content it can't
// read post-drop — so the aggregation now runs here, over the decrypted recipes
// + schedules. Only the resulting item names leave the device (to the AI
// organize endpoint, with explicit consent, exactly as before).

import { recipesApi, Recipe, GroceryItem } from '../api';
import { openRecord } from './e2ee';
import * as replica from './replica';
import { loadSchedulesInRange } from './mealSchedule';
import { aggregateGroceryList } from './groceryAggregate';

export { aggregateGroceryList };

const iso = (d: Date) => d.toISOString().slice(0, 10);

// Fetch + decrypt the week's schedules and recipes, then aggregate. Biweekly
// shoppers get the full two weeks until the next trip (same rule the server
// applied from household settings).
export async function loadGroceryList(
  weekStart: string,
  frequency: 'weekly' | 'biweekly' = 'weekly',
): Promise<GroceryItem[]> {
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + (frequency === 'biweekly' ? 13 : 6));

  const [schedules, recipes] = await Promise.all([
    loadSchedulesInRange(iso(start), iso(end)),
    replica
      .syncedList<Recipe>('Recipe', async () => (await recipesApi.list()).data)
      .then((rows) => Promise.all(rows.map((r) => openRecord('Recipe', r)))),
  ]);

  return aggregateGroceryList(schedules, new Map(recipes.map((r) => [String(r._id), r])));
}
