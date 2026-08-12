// Pure grocery aggregation (no e2ee/native imports so it's unit-testable) —
// mirrors the retired server /grocery-list aggregation exactly. The fetching +
// decrypting wrapper lives in lib/groceryList.ts.
//
// Change-detection for a saved organized list lives in lib/groceryOrganize
// (groceryFingerprint / reconcileOrganizedList).

import type { Recipe, GroceryItem } from '../api';

export function aggregateGroceryList(
  schedules: Array<{ servings?: number | null; recipeId?: unknown; variation?: string | null }>,
  recipesById: Map<string, Recipe>,
): GroceryItem[] {
  const map = new Map<string, GroceryItem>();
  for (const s of schedules) {
    const rid = s.recipeId && typeof s.recipeId === 'object'
      ? String((s.recipeId as { _id: string })._id)
      : String(s.recipeId ?? '');
    const recipe = recipesById.get(rid);
    if (!recipe?.ingredients) continue;
    const multiplier = s.servings && recipe.servings ? s.servings / recipe.servings : 1;
    // Variation groups are mutually exclusive flavor kits: when the schedule
    // records a choice, buy only the chosen kit (base + component groups always
    // count). A schedule with no recorded choice buys everything, as before.
    const variationSet = new Set(recipe.variations ?? []);
    for (const ing of recipe.ingredients) {
      if (s.variation && ing.group && variationSet.has(ing.group) && ing.group !== s.variation) continue;
      const key = ing.name.toLowerCase().trim();
      let item = map.get(key);
      if (!item) {
        item = { name: ing.name, entries: [] };
        map.set(key, item);
      }
      item.entries!.push({
        recipeTitle: recipe.title,
        amount: ing.amount || '',
        unit: ing.unit || '',
        multiplier,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
