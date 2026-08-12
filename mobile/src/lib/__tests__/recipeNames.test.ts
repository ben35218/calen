// Ingredient names read as labels (specs/features/kitchen.md, "Ingredient
// names are title-cased"). Imports arrive however the source wrote them, so the
// casing is applied on the way in — at every read and every keystroke — which
// is also what makes recipes stored before this shipped display correctly.

import { ingredientName, withIngredientNames, openRecipe } from '../recipeNames';

const mockOpenRecord = jest.fn(async (_collection: string, record: unknown) => record);
jest.mock('../e2ee', () => ({ openRecord: (...args: unknown[]) => mockOpenRecord(...(args as [string, unknown])) }));

describe('ingredientName', () => {
  it('title-cases an all-lowercase import', () => {
    expect(ingredientName('extra virgin olive oil')).toBe('Extra Virgin Olive Oil');
    expect(ingredientName('cream of mushroom soup')).toBe('Cream of Mushroom Soup');
    expect(ingredientName('salt and pepper to taste')).toBe('Salt and Pepper to Taste');
  });

  it('leaves what the writer capitalized alone', () => {
    expect(ingredientName('BBQ sauce')).toBe('BBQ Sauce');
    expect(ingredientName('San Marzano tomatoes')).toBe('San Marzano Tomatoes');
  });

  it('keeps the prep clause — the cook needs it, unlike the shopping row', () => {
    expect(ingredientName('garlic cloves, minced')).toBe('Garlic Cloves, Minced');
  });

  it('never changes the length, so a typed value keeps its caret', () => {
    for (const typed of ['olive o', 'salt and p', '  parsley ']) {
      expect(ingredientName(typed)).toHaveLength(typed.length);
    }
  });
});

describe('withIngredientNames', () => {
  it('re-cases only the names', () => {
    const recipe = {
      title: 'pesto',
      ingredients: [
        { amount: '2', unit: 'cups', name: 'fresh basil leaves', group: 'base' },
        { amount: '1/2', unit: 'cup', name: 'parmesan' },
      ],
    };
    expect(withIngredientNames(recipe)).toEqual({
      title: 'pesto',
      ingredients: [
        { amount: '2', unit: 'cups', name: 'Fresh Basil Leaves', group: 'base' },
        { amount: '1/2', unit: 'cup', name: 'Parmesan' },
      ],
    });
  });

  it('tolerates a recipe with no ingredients yet (a draft mid-review)', () => {
    expect(withIngredientNames({ ingredients: [] })).toEqual({ ingredients: [] });
    expect(withIngredientNames({})).toEqual({});
  });
});

describe('openRecipe', () => {
  it('decrypts, then cases — so a recipe stored lowercase still reads right', async () => {
    mockOpenRecord.mockResolvedValueOnce({ _id: 'r1', ingredients: [{ name: 'olive oil' }] });
    await expect(openRecipe({ _id: 'r1' })).resolves.toEqual({ _id: 'r1', ingredients: [{ name: 'Olive Oil' }] });
    expect(mockOpenRecord).toHaveBeenCalledWith('Recipe', { _id: 'r1' });
  });
});
