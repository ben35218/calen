// The canonical Recipe enc subset (specs/features/kitchen.md, "Recipes").
// Only enc/keyVersion reach the opaque store — a field left out of the subset
// is silently dropped on every save. The recipe form used to seal with a stale
// local copy that omitted the per-step ingredient tags, timers, and the
// image/source URLs, so recipes lost them the moment they synced.

import { RECIPE_ENC } from '../encSubsets';

describe('RECIPE_ENC', () => {
  it('carries every persisted recipe content field', () => {
    const full = {
      title: 'Chicken Parm',
      description: 'd',
      source: 'manual',
      sourceUrl: 'https://example.com',
      imageUrl: 'https://example.com/img.jpg',
      servings: 4,
      prepTimeMins: 10,
      cookTimeMins: 20,
      ingredients: [{ name: 'Garlic', amount: '2', unit: 'cloves' }],
      instructions: ['Chop', 'Cook'],
      instructionIngredients: [[0], []],
      instructionTimers: [null, 10],
      tags: ['Dinner'],
      variations: ['Lemon Blueberry'],
      instructionVariations: [null, ['Lemon Blueberry']],
    };
    expect(RECIPE_ENC(full)).toEqual(full);
  });
});
