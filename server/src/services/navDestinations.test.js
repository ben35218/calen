const test = require('node:test');
const assert = require('node:assert/strict');
const {
  navTool,
  navPromptSection,
  collectNav,
  ensureActionableNav,
  configDests,
  CONFIG_DESTINATIONS,
} = require('./navDestinations');

// Setup (config) destinations are a distinct class from the "go look at this"
// nav destinations: they're offered reactively to guide the user to configure a
// missing value, and must never be picked as the every-turn default.

test('navTool enum includes both nav and setup ids for the surface', () => {
  const enumIds = navTool('calendar').input_schema.properties.view.enum;
  assert.ok(enumIds.includes('view_calendar'), 'nav id present');
  assert.ok(enumIds.includes('setup_home_address'), 'calendar setup id present');
  assert.ok(enumIds.includes('setup_ai_personal_info'), 'shared setup id present');
});

test('configDests merges the shared `all` group into every surface', () => {
  for (const surface of ['calendar', 'chores', 'maintenance', 'trips']) {
    const ids = configDests(surface).map((d) => d.id);
    for (const shared of CONFIG_DESTINATIONS.all.map((d) => d.id)) {
      assert.ok(ids.includes(shared), `${surface} includes ${shared}`);
    }
  }
});

test('collectNav stamps kind:setup for a config id and kind:nav for a view id', () => {
  const acc = {};
  collectNav({ name: 'suggest_navigation', input: { view: 'setup_event_phone' } }, acc, 'calendar');
  collectNav({ name: 'suggest_navigation', input: { view: 'view_calendar' } }, acc, 'calendar');
  assert.deepEqual(acc.navSuggestions, [
    { view: 'setup_event_phone', label: 'Add business phone', kind: 'setup' },
    { view: 'view_calendar', label: 'View your calendar', kind: 'nav' },
  ]);
});

test('collectNav ignores ids not offered on the surface', () => {
  const acc = {};
  // setup_event_phone is calendar-only — not offered on trips.
  collectNav({ name: 'suggest_navigation', input: { view: 'setup_event_phone' } }, acc, 'trips');
  assert.equal(acc.navSuggestions, undefined);
});

test('collectNav dedupes by view id', () => {
  const acc = {};
  collectNav({ name: 'suggest_navigation', input: { view: 'setup_household' } }, acc, 'chores');
  collectNav({ name: 'suggest_navigation', input: { view: 'setup_household' } }, acc, 'chores');
  assert.equal(acc.navSuggestions.length, 1);
});

test('ensureActionableNav never falls back to a setup screen', () => {
  const acc = {};
  ensureActionableNav(acc, 'calendar', false);
  assert.equal(acc.navSuggestions.length, 1);
  assert.equal(acc.navSuggestions[0].kind, 'nav');
  assert.ok(!acc.navSuggestions[0].view.startsWith('setup_'));
});

test('ensureActionableNav leaves an already-offered setup chip alone', () => {
  const acc = {};
  collectNav({ name: 'suggest_navigation', input: { view: 'setup_reminders' } }, acc, 'calendar');
  ensureActionableNav(acc, 'calendar', false);
  assert.deepEqual(acc.navSuggestions.map((n) => n.view), ['setup_reminders']);
});

test('navPromptSection documents the setup shortcuts + the one-chip rule', () => {
  const section = navPromptSection('calendar');
  assert.match(section, /Setup shortcuts/);
  assert.match(section, /setup_home_address/);
  assert.match(section, /REPLACES the usual next-step/i);
});
