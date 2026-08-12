// Recipe flavor variations (specs/features/kitchen.md, "Variations").
//
// A recipe can carry ingredient groups (Ingredient.group) and name some of
// them as mutually exclusive flavor choices (Recipe.variations) — a shared
// base plus e.g. "Lemon Blueberry" / "Chocolate Peanut Butter" kits, common in
// baking. A meal is planned as ONE variation; the grocery list buys only the
// chosen kit (lib/groceryAggregate). The pure grouping/choosing logic lives
// here so every reader (detail, form, share text, planners) shares it.

import { Alert } from 'react-native';

// One rendered ingredient section: a consecutive run of the same group label,
// in the recipe's own order (never re-sorted — instructionIngredients links
// ingredients by index). `index` is each item's position in the flat array.
export interface IngredientRun<T> {
  group?: string;
  isVariation: boolean;
  items: { ing: T; index: number }[];
}

export function ingredientRuns<T extends { group?: string }>(
  ingredients: T[],
  variations?: string[] | null,
): IngredientRun<T>[] {
  const variationSet = new Set(variations ?? []);
  const runs: IngredientRun<T>[] = [];
  ingredients.forEach((ing, index) => {
    const last = runs[runs.length - 1];
    if (!last || (last.group ?? '') !== (ing.group ?? '')) {
      runs.push({ group: ing.group || undefined, isVariation: !!ing.group && variationSet.has(ing.group), items: [] });
    }
    runs[runs.length - 1].items.push({ ing, index });
  });
  return runs;
}

// Ask which variation a meal is being planned as (or cooked as, via `message`).
// Resolves the chosen name; `null` when the recipe has no variations (nothing
// to ask — proceed plain); `undefined` when the user cancels (callers decide
// whether that aborts or falls back to proceeding without a choice).
export function pickVariation(
  recipe: { title?: string; variations?: string[] | null },
  message?: string,
): Promise<string | null | undefined> {
  const options = (recipe.variations ?? []).filter(Boolean);
  if (!options.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    Alert.alert(
      'Which variation?',
      message ?? `${recipe.title || 'This recipe'} comes in ${options.length} variations — the grocery list will only include the one you pick.`,
      [
        ...options.map((v) => ({ text: v, onPress: () => resolve(v) })),
        { text: 'Cancel', style: 'cancel' as const, onPress: () => resolve(undefined) },
      ],
    );
  });
}

// Does one step apply to the kit being cooked? A step with no tags is shared
// by every variation; with no chosen kit, everything applies.
export function stepAppliesTo(tags: string[] | null | undefined, variation: string | null): boolean {
  return !tags?.length || !variation || tags.includes(variation);
}

// The instruction indices cooking mode shows for a chosen kit — positions in
// the FULL instructions array (never re-numbered), so the per-step ingredient
// tags and timers keep lining up.
export function visibleStepIndices(
  recipe: { instructions?: string[]; instructionVariations?: (string[] | null)[] },
  variation: string | null,
): number[] {
  return (recipe.instructions ?? [])
    .map((_, i) => i)
    .filter((i) => stepAppliesTo(recipe.instructionVariations?.[i], variation));
}

// Does an ingredient belong on screen for a chosen kit? Base and component
// groups always do; other kits' ingredients don't.
export function ingredientInKit(
  ing: { group?: string },
  variations: string[] | null | undefined,
  variation: string | null,
): boolean {
  if (!variation || !ing.group) return true;
  return !(variations ?? []).includes(ing.group) || ing.group === variation;
}
