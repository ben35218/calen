const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRecipeDraft } = require('./recipeDraft');

const draft = (obj, { fenced = false } = {}) => {
  const json = JSON.stringify(obj);
  return parseRecipeDraft(fenced ? `\`\`\`json\n${json}\n\`\`\`` : json);
};

test('parseRecipeDraft: reads the model JSON fenced or bare', () => {
  assert.deepEqual(draft({ title: 'Soup' }), { title: 'Soup' });
  assert.deepEqual(draft({ title: 'Soup' }, { fenced: true }), { title: 'Soup' });
  assert.deepEqual(parseRecipeDraft('  {"title":"Soup"}  '), { title: 'Soup' });
});

test('parseRecipeDraft: title-cases ingredient names, leaving the rest alone', () => {
  const parsed = draft({
    title: 'pesto pasta',
    ingredients: [
      { amount: '2', unit: 'cups', name: 'fresh basil leaves', group: 'for the sauce' },
      { amount: '1/4', unit: 'cup', name: 'extra virgin olive oil' },
      { amount: '3', unit: '', name: 'garlic cloves, minced' },
      { amount: '1', unit: 'tbsp', name: 'BBQ sauce' },
    ],
    instructions: ['blend everything'],
  });

  assert.deepEqual(parsed.ingredients, [
    { amount: '2', unit: 'cups', name: 'Fresh Basil Leaves', group: 'for the sauce' },
    { amount: '1/4', unit: 'cup', name: 'Extra Virgin Olive Oil' },
    { amount: '3', unit: '', name: 'Garlic Cloves, Minced' },
    { amount: '1', unit: 'tbsp', name: 'BBQ Sauce' },
  ]);
  assert.equal(parsed.title, 'pesto pasta', 'only the ingredient names are re-cased');
  assert.deepEqual(parsed.instructions, ['blend everything']);
});

test('parseRecipeDraft: tolerates a draft missing or malforming its ingredients', () => {
  assert.deepEqual(draft({ title: 'Toast' }), { title: 'Toast' });
  assert.deepEqual(draft({ ingredients: [] }).ingredients, []);
  assert.deepEqual(draft({ ingredients: [{ amount: '1' }, null] }).ingredients, [{ amount: '1' }, null]);
  assert.deepEqual(draft({ ingredients: 'flour' }).ingredients, 'flour');
});

test('parseRecipeDraft: a non-JSON answer throws for the route to turn into a 422', () => {
  assert.throws(() => parseRecipeDraft('I could not find a recipe.'), SyntaxError);
});

test('parseRecipeDraft: surfaces stated wait times as instructionTimers on every draft', () => {
  const parsed = draft({
    title: 'Lasagna',
    instructions: [
      'Preheat the oven to 375°F.',
      'Simmer the sauce for 20 to 25 minutes.',
      'Sauté the onions 2 min, then braise 1 hour.',
      'Assemble the layers.',
      'Bake 45 minutes.',
    ],
  });
  // No time stated → null for that step; ranges take the upper bound; a step
  // with several times keeps the longest; hours convert to minutes.
  assert.deepEqual(parsed.instructionTimers, [null, 25, 60, null, 45]);
});

test('parseRecipeDraft: no stated times → no instructionTimers field at all', () => {
  const parsed = draft({ title: 'Toast', instructions: ['Toast the bread.', 'Butter it.'] });
  assert.equal('instructionTimers' in parsed, false);
});

test('parseRecipeDraft: leaves timers the draft already carries alone', () => {
  const parsed = draft({
    title: 'Soup',
    instructions: ['Simmer 10 minutes.'],
    instructionTimers: [99],
  });
  assert.deepEqual(parsed.instructionTimers, [99]);
});
