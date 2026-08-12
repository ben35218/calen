// Ingredient names, written the way a label is (specs/features/kitchen.md).
//
// An ingredient name is read as a name — in the recipe's list, in Cooking Mode,
// on the grocery list, in the shared text — so it is title-cased: every word
// capitalized except the minor ones convention leaves lowercase ("cream of
// mushroom soup" -> "Cream of Mushroom Soup"). Sources don't agree: an imported
// recipe usually arrives all-lowercase, hand entry is whatever the keyboard
// did, and one recipe mixing both looks broken.
//
// The casing is the SAME function the grocery list cleans its names with
// (@household/grocery), so a recipe and its shopping row can't disagree.
//
// Recipes are sealed, so the server can never re-case what is already stored:
// this runs on the client, and it runs on the way *in* (every read + every
// keystroke in the editor) rather than at each render, so every reader gets it
// and a recipe saved after this ships is stored correctly too.

import { titleCase } from '@household/grocery';
import { openRecord } from './e2ee';
import type { Ingredient } from '../api';

// Casing only — the prep clause a recipe writes into the name ("garlic cloves,
// minced") is part of the cooking instruction and stays. (The grocery list
// strips it with `shopperName`; that's a shopping-row concern, not this one.)
export const ingredientName = (raw: string): string => titleCase(raw);

// Re-case a recipe's ingredient names in place-safe fashion; everything else
// about the recipe rides through untouched. Safe on a partial (an AI draft
// mid-review) and safe to re-apply.
export function withIngredientNames<T extends { ingredients?: Ingredient[] }>(recipe: T): T {
  if (!recipe?.ingredients?.length) return recipe;
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ing) => ({ ...ing, name: ingredientName(ing.name ?? '') })),
  };
}

// The one door recipes are read through: decrypt, then normalize the names.
// Every reader (list, detail, cooking mode, planner, grocery, editor) uses this
// instead of `openRecord('Recipe', …)` so recipes stored before the casing
// existed still display correctly.
export async function openRecipe<T extends { _id: string; ingredients?: Ingredient[] }>(row: T): Promise<T> {
  return withIngredientNames(await openRecord('Recipe', row));
}
