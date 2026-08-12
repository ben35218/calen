// Items the shopper adds by hand — the half of the list that no recipe implies.
//
// The week's list is *derived* from the meal plan (lib/groceryAggregate), which
// left no way to buy paper towels. Hand-added rows live in the shopping session
// (`state.extras`, per shopping period, shared by the household like the rest of
// the session) and are merged into the derived list here, as ordinary
// `GroceryItem`s — so they check off, substitute, file into sections, organize,
// and reconcile through exactly the same code paths as an ingredient. Nothing
// downstream knows the difference; only the row's delete affordance does.
//
// Keys are the SAME cleaned name the organized list matches on
// (`@household/grocery` shopperName, lowercased) — an extra that reaches a
// section has been through the normalizer, so anything less would fail to match
// its own row back.

import { shopperName, titleCase } from '@household/grocery';
import type { GroceryItem, GroceryExtra } from '../api';

export type { GroceryExtra };

export const extraKey = (name: string) => shopperName(name).toLowerCase();

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

// Title-cased on the way in, like every other name on the list (a recipe's
// ingredients are cased on read, the AI's organize response server-side), so a
// typed "paper towels" doesn't sit under "Whole Milk" in lowercase. Casing only:
// unlike `shopperName`, nothing is stripped from what the user actually wrote.
export function normalizeExtra(name: string, amount?: string): GroceryExtra | null {
  const clean = titleCase(squash(name));
  if (!clean) return null;
  const amt = squash(amount ?? '');
  return amt ? { name: clean, amount: amt } : { name: clean };
}

// Adding a name that's already on the extras list updates it rather than
// stacking a second row — the shopper is correcting the amount, not buying
// milk twice.
export function addExtraItem(extras: GroceryExtra[], name: string, amount?: string): GroceryExtra[] {
  const item = normalizeExtra(name, amount);
  if (!item) return extras;
  const key = extraKey(item.name);
  const at = extras.findIndex((e) => extraKey(e.name) === key);
  if (at < 0) return [...extras, item];
  const next = [...extras];
  next[at] = item;
  return next;
}

export function removeExtraItem(extras: GroceryExtra[], name: string): GroceryExtra[] {
  const key = extraKey(name);
  return extras.filter((e) => extraKey(e.name) !== key);
}

// The list the pane actually renders: the derived items plus the hand-added
// ones, alphabetical like the aggregation's own output. Returns the set of keys
// that are extras *and nothing else*, which is what the row-level delete keys
// off — an extra the meal plan also calls for is dropped as a duplicate, and the
// surviving row belongs to the recipe, so it must not be swipe-deletable.
export function mergeExtraItems(
  items: GroceryItem[],
  extras: GroceryExtra[],
): { items: GroceryItem[]; extraKeys: Set<string> } {
  const planned = new Set(items.map((i) => extraKey(i.name)));
  const extraKeys = new Set<string>();
  const rows: GroceryItem[] = [];
  for (const e of extras) {
    const key = extraKey(e.name);
    if (!key || planned.has(key) || extraKeys.has(key)) continue;
    extraKeys.add(key);
    // A typed amount becomes a single source entry, not just the display
    // `amount`: the fingerprint and the reconcile patch both read `entries`, so
    // an amount that lives only on the row would be blanked the first time the
    // list is organized (and an edit to it wouldn't register as a change).
    rows.push({
      name: e.name,
      amount: e.amount,
      entries: e.amount ? [{ amount: e.amount, unit: '', multiplier: 1 }] : [],
    });
  }
  if (!rows.length) return { items, extraKeys };
  return { items: [...items, ...rows].sort((a, b) => a.name.localeCompare(b.name)), extraKeys };
}
