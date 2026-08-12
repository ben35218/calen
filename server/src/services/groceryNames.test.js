const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCase, shopperName, shopperAmount, normalizeOrganizedList } = require('./groceryNames');

test('titleCase: capitalizes every word except the minor ones', () => {
  assert.equal(titleCase('extra virgin olive oil'), 'Extra Virgin Olive Oil');
  assert.equal(titleCase('cream of mushroom soup'), 'Cream of Mushroom Soup');
  assert.equal(titleCase('salt and pepper to taste'), 'Salt and Pepper to Taste');
  assert.equal(titleCase('the works'), 'The Works', 'a minor word still leads');
  assert.equal(titleCase('half-and-half'), 'Half-and-Half');
});

test('titleCase: leaves anything the writer already capitalized alone', () => {
  assert.equal(titleCase('BBQ sauce'), 'BBQ Sauce');
  assert.equal(titleCase('McCormick chili powder'), 'McCormick Chili Powder');
  assert.equal(titleCase('San Marzano tomatoes'), 'San Marzano Tomatoes');
});

test('titleCase: keeps the text otherwise identical', () => {
  assert.equal(titleCase('garlic cloves, minced'), 'Garlic Cloves, Minced', 'the prep clause is kept, unlike shopperName');
  assert.equal(titleCase('olive oil (extra virgin)'), 'Olive Oil (Extra Virgin)');
  assert.equal(titleCase("confectioner's sugar"), "Confectioner's Sugar");
  assert.equal(titleCase('2% milk'), '2% Milk');
  assert.equal(titleCase('  parsley  flakes '), '  Parsley  Flakes ', 'spacing survives, so a typed value keeps its caret');
  assert.equal(titleCase(titleCase('brown sugar')), 'Brown Sugar', 're-applying changes nothing');
  assert.equal(titleCase(''), '');
  assert.equal(titleCase(undefined), '');
});

test('shopperName: title-cases the name', () => {
  assert.equal(shopperName('garlic cloves'), 'Garlic Cloves');
  assert.equal(shopperName('extra virgin olive oil'), 'Extra Virgin Olive Oil');
  assert.equal(shopperName('BBQ sauce'), 'BBQ Sauce');
  assert.equal(shopperName('half-and-half'), 'Half-and-Half');
  assert.equal(shopperName('cream of mushroom soup'), 'Cream of Mushroom Soup');
});

test('shopperName: drops the prep clause after a comma, dash, or parenthesis', () => {
  assert.equal(shopperName('garlic cloves, minced'), 'Garlic Cloves');
  assert.equal(shopperName('onion, finely diced'), 'Onion');
  assert.equal(shopperName('carrots - peeled and chopped'), 'Carrots');
  assert.equal(shopperName('parsley (chopped)'), 'Parsley');
});

test('shopperName: drops filler descriptors and herb form words', () => {
  assert.equal(shopperName('fresh basil leaves'), 'Basil');
  assert.equal(shopperName('freshly grated parmesan'), 'Parmesan');
  assert.equal(shopperName('chopped walnuts'), 'Walnuts');
  assert.equal(shopperName('thyme sprigs'), 'Thyme');
  assert.equal(shopperName('butter, divided'), 'Butter');
});

test('shopperName: keeps words that change what gets bought', () => {
  assert.equal(shopperName('ground beef'), 'Ground Beef');
  assert.equal(shopperName('smoked paprika'), 'Smoked Paprika');
  assert.equal(shopperName('unsalted butter'), 'Unsalted Butter');
  assert.equal(shopperName('boneless skinless chicken thighs'), 'Boneless Skinless Chicken Thighs');
  assert.equal(shopperName('whole milk'), 'Whole Milk');
});

test('shopperName: never strips a name to nothing', () => {
  assert.equal(shopperName('leaves'), 'Leaves');
  assert.equal(shopperName('fresh'), 'Fresh');
  assert.equal(shopperName(', minced'), 'Minced');
  assert.equal(shopperName(''), '');
  assert.equal(shopperName(undefined), '');
});

test('shopperAmount: abbreviates every spelling of tablespoon and teaspoon', () => {
  assert.equal(shopperAmount('2 tablespoons'), '2 tbsp');
  assert.equal(shopperAmount('1 Tablespoon'), '1 tbsp');
  assert.equal(shopperAmount('3 Tbsp.'), '3 tbsp');
  assert.equal(shopperAmount('1 tbs'), '1 tbsp');
  assert.equal(shopperAmount('1/2 teaspoon'), '1/2 tsp');
  assert.equal(shopperAmount('2 Teaspoons'), '2 tsp');
  assert.equal(shopperAmount('1 tsp.'), '1 tsp');
  assert.equal(shopperAmount('2 tablespoons, 1 teaspoon'), '2 tbsp, 1 tsp');
});

test('shopperAmount: leaves other units and the ambiguous single letters alone', () => {
  assert.equal(shopperAmount('3 cloves'), '3 cloves');
  assert.equal(shopperAmount('2 cups'), '2 cups');
  assert.equal(shopperAmount('1 lb'), '1 lb');
  assert.equal(shopperAmount('1 T'), '1 T', 'T vs t is ambiguous — never guessed');
  assert.equal(shopperAmount('1 t'), '1 t');
  assert.equal(shopperAmount(''), '');
  assert.equal(shopperAmount(undefined), '');
});

test('normalizeOrganizedList: cleans every item name and merges collapsed duplicates', () => {
  const organized = normalizeOrganizedList({
    store_known: false,
    categories: [
      {
        name: 'Produce',
        aisle: '',
        items: [
          { name: 'garlic cloves, minced', amount: '3 cloves' },
          { name: 'fresh basil leaves', amount: '2 Tablespoons' },
          { name: 'garlic cloves', amount: '1 clove' },
          // Same measure, spelled the other way — the short form makes the
          // merge see them as one amount instead of listing both.
          { name: 'basil, chopped', amount: '2 tbsp' },
        ],
      },
    ],
  });

  assert.equal(organized.store_known, false);
  assert.deepEqual(organized.categories[0].items, [
    { name: 'Garlic Cloves', amount: '3 cloves, 1 clove' },
    { name: 'Basil', amount: '2 tbsp' },
  ]);
  assert.equal(organized.categories[0].name, 'Produce', 'section names are left alone');
});

test('normalizeOrganizedList: drops sections with nothing in them', () => {
  const organized = normalizeOrganizedList({
    categories: [
      { name: 'Produce', aisle: '', items: [{ name: 'kale', amount: '1 bunch' }] },
      { name: 'Bakery', aisle: '', items: [] },
      { name: 'Deli', aisle: '' },
      { name: 'Frozen', aisle: '', items: [{ name: '   ', amount: '1' }] },
    ],
  });

  assert.deepEqual(organized.categories.map((c) => c.name), ['Produce'],
    'the household section order lists sections this week never filled');
});

test('normalizeOrganizedList: tolerates a malformed model payload', () => {
  assert.deepEqual(normalizeOrganizedList(null), null);
  assert.deepEqual(normalizeOrganizedList({ categories: 'nope' }), { categories: 'nope' });
  assert.deepEqual(normalizeOrganizedList({ categories: [{ name: 'Other' }] }), { categories: [] });
});
