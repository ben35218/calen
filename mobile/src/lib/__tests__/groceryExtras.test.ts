// Hand-added grocery rows (specs/features/kitchen.md, "The list is not only what
// the plan implies"). What matters here is that an extra behaves like any other
// item downstream — same key space as the organized list, an amount that
// survives an Organize, and no duplicate row when the plan already buys it.

import type { GroceryItem } from '../../api';
import {
  addExtraItem, extraKey, mergeExtraItems, normalizeExtra, removeExtraItem,
} from '../groceryExtras';
import { groceryFingerprint, reconcileOrganizedList } from '../groceryOrganize';

const item = (name: string): GroceryItem => ({ name, entries: [{ amount: '1', unit: 'cup' }] });

describe('normalizeExtra', () => {
  it('title-cases the typed name and trims the amount', () => {
    expect(normalizeExtra('  paper   towels ', ' 2 rolls ')).toEqual({ name: 'Paper Towels', amount: '2 rolls' });
  });

  it('keeps a name the user capitalized their own way', () => {
    expect(normalizeExtra('BBQ sauce')).toEqual({ name: 'BBQ Sauce' });
  });

  it('has no row to add when the name is blank', () => {
    expect(normalizeExtra('   ', '2')).toBeNull();
  });
});

describe('addExtraItem / removeExtraItem', () => {
  it('updates an item already added instead of stacking a second row', () => {
    const once = addExtraItem([], 'coffee', '1 bag');
    const twice = addExtraItem(once, 'Coffee', '2 bags');
    expect(twice).toEqual([{ name: 'Coffee', amount: '2 bags' }]);
  });

  it('removes by cleaned name, which is what the organized row carries', () => {
    const extras = addExtraItem([], 'fresh basil leaves');
    // The row the shopper swipes says "Basil" — the normalizer got to it on the
    // way into a section.
    expect(removeExtraItem(extras, 'Basil')).toEqual([]);
  });

  it('drops a blank add', () => {
    expect(addExtraItem([], '  ')).toEqual([]);
  });
});

describe('mergeExtraItems', () => {
  it('merges extras into the derived list alphabetically', () => {
    const { items, extraKeys } = mergeExtraItems([item('Basil'), item('Whole Milk')], [
      { name: 'Paper Towels', amount: '2 rolls' },
    ]);
    expect(items.map((i) => i.name)).toEqual(['Basil', 'Paper Towels', 'Whole Milk']);
    expect(extraKeys.has(extraKey('Paper Towels'))).toBe(true);
  });

  it('gives a typed amount a source entry so an Organize keeps it', () => {
    const { items } = mergeExtraItems([], [{ name: 'Coffee', amount: '1 bag' }]);
    const coffee = items[0];
    expect(coffee.amount).toBe('1 bag');

    // The reconcile patch rebuilds amounts from `entries`; a row carrying only
    // its display amount would come back blank under New Items.
    const { list } = reconcileOrganizedList({ store_known: false, categories: [] }, {}, items);
    expect(list.categories[0].items).toEqual([{ name: 'Coffee', amount: '1 bag' }]);
  });

  it('does not duplicate a row the meal plan already buys', () => {
    const { items, extraKeys } = mergeExtraItems([item('Whole Milk')], [{ name: 'whole milk' }]);
    expect(items.map((i) => i.name)).toEqual(['Whole Milk']);
    // …and the surviving row belongs to the recipe, so it isn't deletable.
    expect(extraKeys.size).toBe(0);
  });

  it('leaves the derived list untouched when there is nothing to add', () => {
    const derived = [item('Basil')];
    expect(mergeExtraItems(derived, []).items).toBe(derived);
  });

  it('fingerprints an extra like any other item, so removing it drops its row', () => {
    const { items } = mergeExtraItems([item('Basil')], [{ name: 'Coffee' }]);
    const organized = {
      store_known: false,
      categories: [{ name: 'Produce', items: [{ name: 'Basil' }] }, { name: 'Pantry', items: [{ name: 'Coffee' }] }],
    };
    const after = reconcileOrganizedList(organized, groceryFingerprint(items), [item('Basil')]);
    expect(after.list.categories.map((c) => c.name)).toEqual(['Produce']);
  });
});
