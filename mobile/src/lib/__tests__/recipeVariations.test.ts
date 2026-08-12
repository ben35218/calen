// Variation helpers (specs/features/kitchen.md, "Variations"): section runs
// preserve the flat ingredient order (index-linked elsewhere), and the
// schedule-time picker resolves chosen / none-needed / cancelled distinctly.

import { Alert } from 'react-native';
import { ingredientRuns, pickVariation, stepAppliesTo, visibleStepIndices, ingredientInKit } from '../recipeVariations';

describe('ingredientRuns', () => {
  const ings = [
    { name: 'Oats' },
    { name: 'Honey' },
    { name: 'Lemon zest', group: 'Lemon Blueberry' },
    { name: 'Blueberries', group: 'Lemon Blueberry' },
    { name: 'Cocoa', group: 'Chocolate PB' },
    { name: 'Glaze', group: 'For the glaze' },
  ];

  it('splits consecutive group runs, flags variation groups, keeps flat indices', () => {
    const runs = ingredientRuns(ings, ['Lemon Blueberry', 'Chocolate PB']);
    expect(runs.map((r) => r.group)).toEqual([undefined, 'Lemon Blueberry', 'Chocolate PB', 'For the glaze']);
    expect(runs.map((r) => r.isVariation)).toEqual([false, true, true, false]);
    // Indices stay positions in the original flat array.
    expect(runs[1].items.map((x) => x.index)).toEqual([2, 3]);
    expect(runs[0].items.map((x) => x.ing.name)).toEqual(['Oats', 'Honey']);
  });

  it('is one ungrouped run when nothing carries a group', () => {
    const bare: { name: string; group?: string }[] = [{ name: 'A' }, { name: 'B' }];
    const runs = ingredientRuns(bare);
    expect(runs).toHaveLength(1);
    expect(runs[0].group).toBeUndefined();
  });
});

describe('step + ingredient applicability', () => {
  const recipe = {
    instructions: ['Mix base', 'Fold blueberries', 'Fold peanut butter', 'Roll'],
    instructionVariations: [null, ['Lemon Blueberry'], ['Chocolate PB'], null] as (string[] | null)[],
  };

  it('untagged steps apply to everyone; tagged steps only to their kits', () => {
    expect(stepAppliesTo(null, 'Lemon Blueberry')).toBe(true);
    expect(stepAppliesTo([], 'Lemon Blueberry')).toBe(true);
    expect(stepAppliesTo(['Lemon Blueberry'], 'Lemon Blueberry')).toBe(true);
    expect(stepAppliesTo(['Chocolate PB'], 'Lemon Blueberry')).toBe(false);
    // No chosen kit — everything applies.
    expect(stepAppliesTo(['Chocolate PB'], null)).toBe(true);
  });

  it('visibleStepIndices keeps REAL instruction indices for the chosen kit', () => {
    expect(visibleStepIndices(recipe, 'Lemon Blueberry')).toEqual([0, 1, 3]);
    expect(visibleStepIndices(recipe, 'Chocolate PB')).toEqual([0, 2, 3]);
    expect(visibleStepIndices(recipe, null)).toEqual([0, 1, 2, 3]);
  });

  it('ingredientInKit hides other kits, keeps base and component groups', () => {
    const variations = ['Lemon Blueberry', 'Chocolate PB'];
    expect(ingredientInKit({ name: 'Oats' } as any, variations, 'Lemon Blueberry')).toBe(true);
    expect(ingredientInKit({ group: 'Topping' } as any, variations, 'Lemon Blueberry')).toBe(true);
    expect(ingredientInKit({ group: 'Lemon Blueberry' } as any, variations, 'Lemon Blueberry')).toBe(true);
    expect(ingredientInKit({ group: 'Chocolate PB' } as any, variations, 'Lemon Blueberry')).toBe(false);
    expect(ingredientInKit({ group: 'Chocolate PB' } as any, variations, null)).toBe(true);
  });
});

describe('pickVariation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves null without asking when the recipe has no variations', async () => {
    const spy = jest.spyOn(Alert, 'alert');
    await expect(pickVariation({ title: 'Soup' })).resolves.toBeNull();
    await expect(pickVariation({ title: 'Soup', variations: [] })).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves the tapped variation, and undefined on cancel', async () => {
    const answers: Array<string> = ['Lemon Blueberry', 'Cancel'];
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const want = answers.shift();
      (buttons || []).find((b) => b.text === want)?.onPress?.();
    });
    const recipe = { title: 'Energy Balls', variations: ['Lemon Blueberry', 'Chocolate PB'] };
    await expect(pickVariation(recipe)).resolves.toBe('Lemon Blueberry');
    await expect(pickVariation(recipe)).resolves.toBeUndefined();
  });
});
