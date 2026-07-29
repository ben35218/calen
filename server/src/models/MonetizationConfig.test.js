const test = require('node:test');
const assert = require('node:assert');
const MonetizationConfig = require('./MonetizationConfig');

const { normalizeAddonItems, DEFAULTS } = MonetizationConfig;

// A deep-ish clone of the shipped catalog items, so a mutation in one test can't
// leak into another.
const freshItems = () => JSON.parse(JSON.stringify(DEFAULTS.addons.items));

test('a stored "Birthdays" label is upgraded to the current "Occasions" name', () => {
  const items = freshItems();
  items.birthdays.label = 'Birthdays'; // the retired name a pre-rename doc still holds
  const changed = normalizeAddonItems(items);
  assert.equal(changed, true);
  assert.equal(items.birthdays.label, 'Occasions');
});

test('an admin-customized label is preserved (only the exact retired string is repaired)', () => {
  const items = freshItems();
  items.birthdays.label = 'Special Days';
  const changed = normalizeAddonItems(items);
  assert.equal(changed, false);
  assert.equal(items.birthdays.label, 'Special Days');
});

test('a now-free add-on carrying a stale paid price is reset to the free default', () => {
  const items = freshItems();
  items.birthdays.price = 2.99; // would block /billing/addons/claim (validates price === 0)
  const changed = normalizeAddonItems(items);
  assert.equal(changed, true);
  assert.equal(items.birthdays.price, 0);
  assert.equal(items.birthdays.label, 'Occasions');
});

test('a missing catalog item is backfilled from DEFAULTS', () => {
  const items = freshItems();
  delete items.trips;
  const changed = normalizeAddonItems(items);
  assert.equal(changed, true);
  assert.deepEqual(items.trips, DEFAULTS.addons.items.trips);
});

test('an already-current catalog needs no changes', () => {
  const items = freshItems();
  assert.equal(normalizeAddonItems(items), false);
});
