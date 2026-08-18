// Pins the client-side grocery aggregation (Signal-parity D5) to the retired
// server /grocery-list behavior: same keying, servings multiplier, and sort.
import { aggregateGroceryList } from '../groceryAggregate';
import type { Recipe } from '../../api';

const soup: Recipe = {
  _id: 'r1', title: 'Soup', servings: 4,
  ingredients: [
    { name: 'Onion', amount: '1', unit: '' },
    { name: 'Garlic', amount: '2', unit: 'cloves' },
  ],
};
const stirFry: Recipe = {
  _id: 'r2', title: 'Stir fry', servings: 2,
  ingredients: [
    { name: 'garlic ', amount: '1', unit: 'clove' }, // case/space-insensitive merge
    { name: 'Broccoli', amount: '300', unit: 'g' },
  ],
};

const recipes = new Map<string, Recipe>([['r1', soup], ['r2', stirFry]]);

test('aggregates ingredients across the week, merging by normalized name', () => {
  const list = aggregateGroceryList(
    [
      { recipeId: 'r1', servings: 8 },          // doubled soup
      { recipeId: { _id: 'r2' }, servings: 2 }, // populated ref shape
    ],
    recipes,
  );
  expect(list.map((g) => g.name)).toEqual(['Broccoli', 'Garlic', 'Onion']); // sorted
  const garlic = list.find((g) => g.name === 'Garlic')!;
  expect(garlic.entries).toHaveLength(2); // merged from both recipes
  expect(garlic.entries![0]).toMatchObject({ recipeTitle: 'Soup', multiplier: 2 });
});

test('a scheduled variation buys base + component groups + only the chosen kit', () => {
  const energyBalls: Recipe = {
    _id: 'r3', title: 'Energy Balls',
    variations: ['Lemon Blueberry', 'Chocolate PB'],
    ingredients: [
      { name: 'Oats', amount: '2', unit: 'cups' },                       // base
      { name: 'Drizzle', amount: '1', unit: 'tbsp', group: 'Topping' },  // component group ≠ variation
      { name: 'Blueberries', amount: '1', unit: 'cup', group: 'Lemon Blueberry' },
      { name: 'Peanut butter', amount: '2', unit: 'tbsp', group: 'Chocolate PB' },
    ],
  };
  const byId = new Map([['r3', energyBalls]]);

  const chosen = aggregateGroceryList([{ recipeId: 'r3', variation: 'Lemon Blueberry' }], byId);
  expect(chosen.map((g) => g.name)).toEqual(['Blueberries', 'Drizzle', 'Oats']);

  // No recorded choice (legacy schedule) fails open: everything is bought.
  const unchosen = aggregateGroceryList([{ recipeId: 'r3' }], byId);
  expect(unchosen.map((g) => g.name)).toEqual(['Blueberries', 'Drizzle', 'Oats', 'Peanut butter']);

  // A DANGLING choice (the kit was deleted or renamed after scheduling) also
  // fails open — it must behave exactly like no choice, not exclude every
  // surviving kit and quietly buy base ingredients only.
  const dangling = aggregateGroceryList([{ recipeId: 'r3', variation: 'Matcha' }], byId);
  expect(dangling.map((g) => g.name)).toEqual(['Blueberries', 'Drizzle', 'Oats', 'Peanut butter']);

  // …while a valid choice keeps excluding the other kits (existing behavior).
  const stillChosen = aggregateGroceryList([{ recipeId: 'r3', variation: 'Chocolate PB' }], byId);
  expect(stillChosen.map((g) => g.name)).toEqual(['Drizzle', 'Oats', 'Peanut butter']);
});

test('schedules pointing at unknown or ingredient-less recipes are skipped', () => {
  const list = aggregateGroceryList(
    [{ recipeId: 'missing' }, { recipeId: 'r1' }],
    new Map([['r1', { _id: 'r1', title: 'Bare' } as Recipe]]),
  );
  expect(list).toEqual([]);
});

