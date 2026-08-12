// Reconciling a saved organized list with the week's current items
// (specs/features/kitchen.md, "Organize renames items for the aisle"). The
// organized list survives view flips and plan edits, so the patch is what keeps
// it honest without an AI call: added ingredients surface, removed ones drop,
// re-portioned ones get a truthful amount.

import {
  DEFAULT_SECTIONS, NEW_ITEMS_SECTION,
  groceryFingerprint, moveItemToSection, reconcileOrganizedList, sectionChoices,
} from '../groceryOrganize';
import type { GroceryItem, OrganizedGroceryList } from '../../api';

const item = (name: string, amount: string, unit = 'cup', multiplier = 1): GroceryItem =>
  ({ name, entries: [{ recipeTitle: 'Soup', amount, unit, multiplier }] });

// The week Organize ran over, in raw recipe spelling…
const week: GroceryItem[] = [
  item('garlic cloves, minced', '3', 'cloves'),
  item('fresh basil leaves', '2', 'tbsp'),
  item('whole milk, chilled', '2', 'cups'),
];
// …and the organized result the server returned for it (normalized names).
const organized: OrganizedGroceryList = {
  store_known: false,
  categories: [
    { name: 'Produce', aisle: '', items: [{ name: 'Garlic Cloves', amount: '3 cloves' }, { name: 'Basil', amount: '2 tbsp' }] },
    { name: 'Dairy', aisle: '', items: [{ name: 'Whole Milk', amount: '2 cups' }] },
  ],
};
const fingerprint = groceryFingerprint(week);

describe('groceryFingerprint', () => {
  it('keys by the cleaned name the server would produce', () => {
    expect(Object.keys(fingerprint).sort()).toEqual(['basil', 'garlic cloves', 'whole milk']);
  });

  it('is stable across raw spelling and ordering', () => {
    const reordered = [item('Basil, chopped', '2', 'tbsp'), week[2], week[0]];
    const again = groceryFingerprint(reordered);
    expect(Object.keys(again).sort()).toEqual(Object.keys(fingerprint).sort());
    expect(again['basil']).toBe(fingerprint['basil']);
  });
});

describe('reconcileOrganizedList', () => {
  it('returns the list untouched while the plan has not moved', () => {
    const r = reconcileOrganizedList(organized, fingerprint, week);
    expect(r.changed).toBe(false);
    expect(r.list).toBe(organized);
  });

  it('surfaces an added recipe as a New Items section, first', () => {
    const r = reconcileOrganizedList(organized, fingerprint, [...week, item('pine nuts, toasted', '1/4')]);

    expect(r.changed).toBe(true);
    expect(r.list.categories[0].name).toBe(NEW_ITEMS_SECTION);
    expect(r.list.categories[0].items).toEqual([{ name: 'Pine Nuts', amount: '1/4 cup' }]);
    // The already-filed rows are untouched.
    expect(r.list.categories.slice(1)).toEqual(organized.categories);
  });

  it('drops rows whose ingredient left the plan, and empty sections with them', () => {
    const r = reconcileOrganizedList(organized, fingerprint, [week[0], week[1]]); // milk removed

    expect(r.changed).toBe(true);
    expect(r.list.categories.map((c) => c.name)).toEqual(['Produce']);
  });

  it('rewrites the amount of a re-portioned item with the deterministic join', () => {
    const doubled = [item('garlic cloves, minced', '6', 'cloves'), week[1], week[2]];
    const r = reconcileOrganizedList(organized, fingerprint, doubled);

    expect(r.changed).toBe(true);
    const produce = r.list.categories.find((c) => c.name === 'Produce')!;
    expect(produce.items).toEqual([
      { name: 'Garlic Cloves', amount: '6 cloves' },
      { name: 'Basil', amount: '2 tbsp' },
    ]);
  });

  it('abbreviates spoon units in the amounts it writes itself', () => {
    const r = reconcileOrganizedList(organized, fingerprint, [...week, item('capers, drained', '2', 'Tablespoons')]);
    expect(r.list.categories[0].items).toEqual([{ name: 'Capers', amount: '2 tbsp' }]);
  });

  it('leaves an AI-renamed row alone rather than guessing it was removed', () => {
    // "Green Onions" matches no raw key on either side (the AI translated
    // "scallions"), so the patch must not touch it.
    const renamed: OrganizedGroceryList = {
      categories: [{ name: 'Produce', aisle: '', items: [{ name: 'Green Onions', amount: '2' }] }],
    };
    const scallions = [item('scallions, sliced', '2', '')];
    const r = reconcileOrganizedList(renamed, groceryFingerprint(scallions), [...scallions, item('kale', '1', 'bunch')]);

    expect(r.list.categories.map((c) => c.name)).toEqual([NEW_ITEMS_SECTION, 'Produce']);
    expect(r.list.categories[1].items).toEqual([{ name: 'Green Onions', amount: '2' }]);
    // …and scallions is still tracked, so it is not resurfaced as new.
    expect(r.list.categories[0].items).toEqual([{ name: 'Kale', amount: '1 bunch' }]);
  });

  it('surfaces what a pre-fingerprint list does not cover, without dropping its rows', () => {
    // The organized view is the only view, so an item a stale legacy list
    // doesn't mention has nowhere else to appear — it must land in New Items.
    const r = reconcileOrganizedList(organized, null, [...week, item('kale', '1', 'bunch')]);

    expect(r.changed).toBe(true);
    expect(r.list.categories[0].name).toBe(NEW_ITEMS_SECTION);
    expect(r.list.categories[0].items).toEqual([{ name: 'Kale', amount: '1 bunch' }]);
    // Nothing is ever removed on the strength of a missing fingerprint.
    expect(r.list.categories.slice(1)).toEqual(organized.categories);
  });
});

describe('sectionChoices', () => {
  it('offers the household order when set, else the standard walk — never New Items', () => {
    expect(sectionChoices(organized, ['Dairy', 'Produce'])).toEqual(['Dairy', 'Produce']);
    expect(sectionChoices(null, null)).toEqual(DEFAULT_SECTIONS);
  });

  it('keeps a section the AI invented as a valid target', () => {
    const withCustom: OrganizedGroceryList = {
      categories: [
        { name: NEW_ITEMS_SECTION, items: [{ name: 'Kale' }] },
        { name: 'International', items: [{ name: 'Miso' }] },
      ],
    };
    expect(sectionChoices(withCustom, ['Produce'])).toEqual(['Produce', 'International']);
  });
});

describe('moveItemToSection', () => {
  it('files a row into an existing section and drops the section it emptied', () => {
    const withNew: OrganizedGroceryList = {
      categories: [
        { name: NEW_ITEMS_SECTION, items: [{ name: 'Kale', amount: '1 bunch' }] },
        ...organized.categories,
      ],
    };
    const moved = moveItemToSection(withNew, 'Kale', 'Produce', DEFAULT_SECTIONS);

    expect(moved.categories.map((c) => c.name)).toEqual(['Produce', 'Dairy']);
    expect(moved.categories[0].items.map((i) => i.name)).toEqual(['Garlic Cloves', 'Basil', 'Kale']);
  });

  it('creates a missing section at its place in the walking order', () => {
    // Frozen sits between Dairy and Pantry in the walk, and the list has both.
    const withPantry: OrganizedGroceryList = {
      categories: [...organized.categories, { name: 'Pantry', items: [{ name: 'Flour', amount: '2 cups' }] }],
    };
    const moved = moveItemToSection(withPantry, 'Whole Milk', 'Frozen', DEFAULT_SECTIONS);

    expect(moved.categories.map((c) => c.name)).toEqual(['Produce', 'Frozen', 'Pantry']);
    expect(moved.categories[1].items).toEqual([{ name: 'Whole Milk', amount: '2 cups' }]);
  });

  it('is a no-op for an unknown item or a move onto its own section', () => {
    expect(moveItemToSection(organized, 'Nope', 'Dairy', DEFAULT_SECTIONS)).toBe(organized);
    const same = moveItemToSection(organized, 'Whole Milk', 'Dairy', DEFAULT_SECTIONS);
    expect(same.categories).toEqual(organized.categories);
  });
});
