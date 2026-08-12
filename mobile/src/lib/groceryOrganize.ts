// Reconciling a saved organized grocery list with the week it now describes.
//
// Organize is a billable AI call whose result is saved in the shopping session,
// and the meal plan keeps moving after it runs. Retiring the organized list on
// any change made every mid-week recipe add cost a credit to get sections back;
// leaving it alone showed a shopper an aisle plan missing half their
// ingredients. So the list is patched locally instead — deterministic, free,
// and honest — and re-filing the patched rows into real sections stays a
// user-triggered AI call.
//
// Matching hinges on both sides cleaning names identically: organized row names
// were produced by the server's normalizer, and the raw items are cleaned here
// with the SAME function (@household/grocery — one shared source, not a copy).

import { shopperName, shopperAmount } from '@household/grocery';
import type { GroceryItem, OrganizedGroceryList } from '../api';

// Section that collects ingredients added since the last Organize (and
// everything, when the user starts a manual sort). First in the list: the
// shopper has to notice them precisely because no aisle claims them.
export const NEW_ITEMS_SECTION = 'New Items';

// The standard supermarket walk, mirrored by the server's organize prompt and
// the Grocery List Sections settings screen.
export const DEFAULT_SECTIONS = ['Produce', 'Deli', 'Bakery', 'Meat & Seafood', 'Dairy', 'Frozen', 'Pantry', 'Other'];

const keyOf = (name: string) => shopperName(name).toLowerCase();

// Per-item portion signature: the entries, order-insensitively. Amounts are in
// it so a servings change reads as a change even though the name doesn't move.
const entriesSig = (i: GroceryItem) =>
  (i.entries ?? [])
    .map((e) => `${e.amount ?? ''} ${e.unit ?? ''} ${e.multiplier ?? 1}`)
    .sort()
    .join('+');

// What the week's raw items look like through the organizer's eyes: cleaned
// name -> portion signature. Saved to the session at organize time
// (`organizedFor`), recomputed on every visit; the diff of the two is the patch.
export function groceryFingerprint(items: GroceryItem[]): Record<string, string> {
  const sigs = new Map<string, string[]>();
  for (const i of items) {
    const k = keyOf(i.name);
    if (!k) continue;
    const list = sigs.get(k) ?? [];
    list.push(entriesSig(i));
    sigs.set(k, list);
  }
  return Object.fromEntries([...sigs].map(([k, v]) => [k, v.sort().join('|')]));
}

// The deterministic amount for a row this patch writes itself — the same
// entries join the organize route sends the model, short spoon units included.
// No AI consolidation ("1 cup, 1 cup" stays two amounts), but never wrong.
function amountFor(key: string, items: GroceryItem[]): string {
  const amounts = items
    .filter((i) => keyOf(i.name) === key)
    .flatMap((i) => i.entries ?? [])
    .map((e) => [e.amount, e.unit].filter(Boolean).join(' '))
    .filter(Boolean);
  return shopperAmount([...new Set(amounts)].join(', '));
}

// The sections an item can be filed into by hand: the household's own order
// when one is set (else the standard walk), plus any section the organized
// list already has that isn't in it — the AI can invent one when no household
// order constrains it, and a section that exists must be a valid target.
// New Items is never a target; things are moved *out* of it.
export function sectionChoices(
  organized: OrganizedGroceryList | null,
  householdSections?: string[] | null,
): string[] {
  const base = householdSections?.length ? householdSections : DEFAULT_SECTIONS;
  const extras = (organized?.categories ?? [])
    .map((c) => c.name)
    .filter((n) => n !== NEW_ITEMS_SECTION && !base.some((b) => b.toLowerCase() === n.toLowerCase()));
  return [...base, ...extras];
}

// File one displayed row into a section, by hand — the free alternative to the
// AI call. Returns a new list: the row leaves its current section (an emptied
// section disappears), and the target is created if the list doesn't have it
// yet, inserted to keep the household's walking order rather than appended
// wherever. Moving onto its own section is a no-op.
export function moveItemToSection(
  list: OrganizedGroceryList,
  itemName: string,
  target: string,
  orderedSections: string[],
): OrganizedGroceryList {
  let moved: GroceryItem | undefined;
  const categories = list.categories
    .map((cat) => {
      if (cat.name === target) return cat;
      const hit = (cat.items ?? []).find((it) => it.name === itemName);
      if (!hit) return cat;
      moved = hit;
      return { ...cat, items: (cat.items ?? []).filter((it) => it !== hit) };
    })
    .filter((cat) => (cat.items ?? []).length > 0);
  if (!moved) return list;

  const existing = categories.find((c) => c.name === target);
  if (existing) {
    return {
      ...list,
      categories: categories.map((c) => (c === existing ? { ...c, items: [...(c.items ?? []), moved!] } : c)),
    };
  }

  // Insert the new section where the walking order says it goes: before the
  // first present section that comes after it in `orderedSections`. New Items
  // is pinned first and unknown sections ride at the end.
  const rank = (name: string) => {
    if (name === NEW_ITEMS_SECTION) return -1;
    const i = orderedSections.findIndex((s) => s.toLowerCase() === name.toLowerCase());
    return i < 0 ? orderedSections.length : i;
  };
  const next = { name: target, items: [moved] };
  const at = categories.findIndex((c) => rank(c.name) > rank(target));
  const out = [...categories];
  out.splice(at < 0 ? categories.length : at, 0, next);
  return { ...list, categories: out };
}

export function reconcileOrganizedList(
  organized: OrganizedGroceryList,
  organizedFor: Record<string, string> | null | undefined,
  items: GroceryItem[],
): { list: OrganizedGroceryList; changed: boolean } {
  // No fingerprint = a list saved before fingerprints shipped. It diffs against
  // an empty one rather than being trusted: nothing is ever dropped from it,
  // but any item its rows don't cover surfaces under New Items. The organized
  // view is the ONLY view, so an item a stale legacy list doesn't mention has
  // nowhere else to be seen — invisible groceries are worse than a duplicate
  // row on a list one Re-organize (or manual move) fixes for good.
  const saved = organizedFor && typeof organizedFor === 'object' ? organizedFor : {};

  const current = groceryFingerprint(items);
  const currentKeys = Object.keys(current);
  const savedKeys = Object.keys(saved);
  const unchanged =
    currentKeys.length === savedKeys.length && currentKeys.every((k) => saved[k] === current[k]);
  if (unchanged) return { list: organized, changed: false };

  // An organized row is matched to the plan by its cleaned name. A row the AI
  // renamed beyond the normalizer (so its name matches no key on either side)
  // is left untouched — a lingering row beats deleting one that's still real.
  const removed = new Set(savedKeys.filter((k) => !(k in current)));
  const placed = new Set<string>();
  const categories = organized.categories
    .map((cat) => ({
      ...cat,
      items: (cat.items ?? [])
        .filter((it) => !removed.has(it.name.toLowerCase()))
        .map((it) => {
          const k = it.name.toLowerCase();
          placed.add(k);
          // Same item, different portions (servings changed, a second recipe
          // now needs it): the saved AI-consolidated amount quotes the old
          // plan, so it's replaced with the deterministic join.
          return k in current && k in saved && current[k] !== saved[k]
            ? { ...it, amount: amountFor(k, items) }
            : it;
        }),
    }))
    .filter((cat) => cat.items.length > 0);

  const newKeys = currentKeys.filter((k) => !(k in saved) && !placed.has(k));
  if (newKeys.length) {
    categories.unshift({
      name: NEW_ITEMS_SECTION,
      items: newKeys.map((k) => {
        const raw = items.find((i) => keyOf(i.name) === k);
        return { name: shopperName(raw?.name ?? k), amount: amountFor(k, items) };
      }),
    });
  }

  return { list: { ...organized, categories }, changed: true };
}
