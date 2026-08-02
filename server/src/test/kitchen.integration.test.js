// Integration tests for the kitchen server surface (spec: features/kitchen.md):
// the meal planner (RecipeSchedule CRUD + the week-move grocery invalidation),
// per-week ShoppingSession persistence, household scoping, and the AI
// organize-grocery-list pass (Anthropic stubbed at the network edge; only item
// names reach it). Recipe content itself lives in the opaque record store
// (records suite); the born-encrypted write-guard is exercised in
// e2eeMandate.integration.test.js — this suite runs with the mandate off, like
// the other feature suites, so the dual-write lane stays covered too.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startDb, stopDb, request, registerUser, fakeEnc } = require('./harness');

const Anthropic = require('@anthropic-ai/sdk');

before(startDb);
after(stopDb);

const createCalls = [];
let createQueue = [];
const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'stub' }).messages);
messagesProto.create = async function stubbedCreate(params) {
  createCalls.push(params);
  const resp = createQueue.shift();
  if (!resp) throw new Error('kitchen stub: model called with no scripted response left');
  return resp;
};
beforeEach(() => {
  createCalls.length = 0;
  createQueue = [];
});

const oid = () => crypto.randomBytes(12).toString('hex');

// Grocery weeks, mirroring the server's bucketing (routes/recipeSchedule.js):
// local midnight, wound back to the household's shopping day (default Saturday).
const SHOPPING_DAY = 6;
const weekStartFor = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - SHOPPING_DAY + 7) % 7));
  return d.toISOString().slice(0, 10);
};
// The first shopping day at least a week out, so every meal below — and both
// grocery weeks they fall in — stays comfortably in the future whenever this
// suite runs.
const weekA = new Date();
weekA.setHours(0, 0, 0, 0);
weekA.setDate(weekA.getDate() + 7);
weekA.setDate(weekA.getDate() + ((SHOPPING_DAY - weekA.getDay() + 7) % 7));
const mealOn = (weekStart, dayOffset) => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(19, 0, 0, 0);
  return d;
};
const firstMeal = mealOn(weekA, 2);   // week A
const secondMeal = mealOn(weekA, 9);  // week B (A + 7 days)
const nudgedMeal = mealOn(weekA, 10); // still week B — a same-week edit

const mkSchedule = (auth, body) =>
  request().post('/api/recipe-schedule').set('Authorization', auth).send({ enc: fakeEnc(), ...body });

test('planner CRUD: create, date-range list, for-recipe, delete', async () => {
  const u = await registerUser({ firstName: 'Planner' });
  const recipeId = oid();

  const early = await mkSchedule(u.auth, { recipeId, scheduledDate: '2026-08-05T19:00:00.000Z', servings: 4 });
  assert.equal(early.status, 201, JSON.stringify(early.body));
  const late = await mkSchedule(u.auth, { recipeId: oid(), scheduledDate: '2026-08-19T19:00:00.000Z' });
  assert.equal(late.status, 201);

  const all = await request().get('/api/recipe-schedule').set('Authorization', u.auth);
  assert.equal(all.status, 200);
  assert.equal(all.body.length, 2, 'both scheduled meals list');

  const ranged = await request().get('/api/recipe-schedule?start=2026-08-01&end=2026-08-10')
    .set('Authorization', u.auth);
  assert.equal(ranged.body.length, 1, 'the range filter excludes the later meal');
  assert.equal(ranged.body[0]._id, early.body._id);

  const forRecipe = await request().get(`/api/recipe-schedule/for-recipe/${recipeId}`)
    .set('Authorization', u.auth);
  assert.equal(forRecipe.body.length, 1, 'for-recipe returns only that recipe\'s slots');

  const del = await request().delete(`/api/recipe-schedule/${late.body._id}`).set('Authorization', u.auth);
  assert.equal(del.status, 200);
  const after1 = await request().get('/api/recipe-schedule').set('Authorization', u.auth);
  assert.equal(after1.body.length, 1);
});

test('the server-sent recipe email-share route is retired (sharing is device-composed)', async () => {
  // Recipe sharing moved to the OS share sheet (mobile RecipeDetail) on
  // 2026-08-01, so the decrypted recipe no longer round-trips through the
  // server. The route must be gone — no plaintext recipe-share endpoint remains.
  const u = await registerUser({ firstName: 'Sharer' });
  const res = await request().post(`/api/recipes/${oid()}/share-email`)
    .set('Authorization', u.auth)
    .send({ email: 'friend@example.com', recipe: { title: 'Soup', ingredients: [], instructions: [] } });
  assert.equal(res.status, 404, 'POST /recipes/:id/share-email is no longer routed');
});

test('create validates the ciphertext envelope shape', async () => {
  const u = await registerUser({ firstName: 'BadEnc' });
  const res = await request().post('/api/recipe-schedule').set('Authorization', u.auth)
    .send({ recipeId: oid(), scheduledDate: '2026-08-05T19:00:00.000Z', enc: { alg: 'nope' } });
  assert.equal(res.status, 400, 'a malformed enc envelope is rejected');
});

test('moving a meal across weeks reports weekChanged and invalidates both weeks\' organized lists', async () => {
  const u = await registerUser({ firstName: 'Mover' });

  // Dates are derived from today, not hardcoded: the old week's list is only
  // invalidated while its shopping day is still ahead, so a fixed date would
  // silently flip this test's outcome once it passed.
  const sched = await mkSchedule(u.auth, { recipeId: oid(), scheduledDate: firstMeal.toISOString() });
  assert.equal(sched.status, 201);

  const oldWeekStart = weekStartFor(firstMeal);
  const newWeekStart = weekStartFor(secondMeal);
  assert.notEqual(oldWeekStart, newWeekStart, 'the two meals must sit in different grocery weeks');

  for (const weekStart of [oldWeekStart, newWeekStart]) {
    const put = await request().put('/api/recipe-schedule/session').set('Authorization', u.auth)
      .send({ weekStart, state: { organizedList: { categories: [] }, checked: { milk: true } } });
    assert.equal(put.status, 200);
  }

  const moved = await request().put(`/api/recipe-schedule/${sched.body._id}`)
    .set('Authorization', u.auth)
    .send({ scheduledDate: secondMeal.toISOString() });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.weekChanged, true);
  assert.equal(moved.body.oldWeekStart, oldWeekStart);
  assert.equal(moved.body.newWeekStart, newWeekStart);

  // Both weeks are in the future, so both organized lists are invalidated —
  // but the rest of the session state (checked items) survives.
  for (const weekStart of [oldWeekStart, newWeekStart]) {
    const state = await request().get(`/api/recipe-schedule/session?weekStart=${weekStart}`)
      .set('Authorization', u.auth);
    assert.equal(state.status, 200);
    assert.equal(state.body.organizedList, undefined, `${weekStart} organized list cleared`);
    assert.deepEqual(state.body.checked, { milk: true }, `${weekStart} progress survives`);
  }

  // A same-week edit does not invalidate.
  const nudged = await request().put(`/api/recipe-schedule/${sched.body._id}`)
    .set('Authorization', u.auth)
    .send({ scheduledDate: nudgedMeal.toISOString(), servings: 2 });
  assert.equal(nudged.body.weekChanged, false);
});

test('shopping session: weekStart is required; state upserts and round-trips', async () => {
  const u = await registerUser({ firstName: 'Shopper' });

  const noWeekPut = await request().put('/api/recipe-schedule/session').set('Authorization', u.auth)
    .send({ state: {} });
  assert.equal(noWeekPut.status, 400);
  const noWeekGet = await request().get('/api/recipe-schedule/session').set('Authorization', u.auth);
  assert.equal(noWeekGet.status, 400);

  const empty = await request().get('/api/recipe-schedule/session?weekStart=2026-08-01')
    .set('Authorization', u.auth);
  assert.deepEqual(empty.body, {}, 'an unknown week reads as empty state');

  await request().put('/api/recipe-schedule/session').set('Authorization', u.auth)
    .send({ weekStart: '2026-08-01', state: { checked: { eggs: true } } });
  await request().put('/api/recipe-schedule/session').set('Authorization', u.auth)
    .send({ weekStart: '2026-08-01', state: { checked: { eggs: true, milk: true } } });

  const state = await request().get('/api/recipe-schedule/session?weekStart=2026-08-01')
    .set('Authorization', u.auth);
  assert.deepEqual(state.body.checked, { eggs: true, milk: true }, 'the upsert replaced the state');
});

test('scope: another household sees none of my planner or session', async () => {
  const mine = await registerUser({ firstName: 'Mine' });
  const other = await registerUser({ firstName: 'Other' });

  const sched = await mkSchedule(mine.auth, { recipeId: oid(), scheduledDate: '2026-08-05T19:00:00.000Z' });
  await request().put('/api/recipe-schedule/session').set('Authorization', mine.auth)
    .send({ weekStart: '2026-08-01', state: { checked: { milk: true } } });

  const list = await request().get('/api/recipe-schedule').set('Authorization', other.auth);
  assert.equal(list.body.length, 0, 'planner is household-scoped');

  const session = await request().get('/api/recipe-schedule/session?weekStart=2026-08-01')
    .set('Authorization', other.auth);
  assert.deepEqual(session.body, {}, 'session is household-scoped');

  const put = await request().put(`/api/recipe-schedule/${sched.body._id}`)
    .set('Authorization', other.auth).send({ scheduledDate: '2026-08-06T19:00:00.000Z' });
  assert.equal(put.status, 404, 'cannot edit another household\'s meal');
  const del = await request().delete(`/api/recipe-schedule/${sched.body._id}`)
    .set('Authorization', other.auth);
  assert.equal(del.status, 404, 'cannot delete another household\'s meal');
});

test('organize-grocery-list: item names go to the model, the organized JSON comes back', async () => {
  const u = await registerUser({ firstName: 'Organizer' });

  const noItems = await request().post('/api/recipe-schedule/organize-grocery-list')
    .set('Authorization', u.auth).send({ items: [] });
  assert.equal(noItems.status, 400);

  const organized = {
    store_known: false,
    categories: [{ name: 'Dairy', aisle: '', items: [{ name: 'milk', amount: '2 cups' }] }],
  };
  createQueue = [{
    content: [{ type: 'text', text: JSON.stringify(organized) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }];

  const res = await request().post('/api/recipe-schedule/organize-grocery-list')
    .set('Authorization', u.auth)
    .send({
      items: [
        { name: 'milk', entries: [{ amount: '1', unit: 'cup', recipeTitle: 'Pancakes' }, { amount: '1', unit: 'cup' }] },
        { name: 'flour', entries: [] },
      ],
      sectionOrder: ['Dairy', 'Pantry'],
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The usage meter appends tokensUsed; the organized payload rides unchanged.
  assert.equal(res.body.store_known, organized.store_known);
  assert.deepEqual(res.body.categories, organized.categories);

  const prompt = JSON.stringify(createCalls[0]);
  assert.match(prompt, /milk: 1 cup, 1 cup/, 'items ride as name + amounts');
  assert.match(prompt, /flour/);
  assert.match(prompt, /1\. Dairy, 2\. Pantry/, 'the household section order constrains the model');

  // A non-JSON model reply degrades to a retryable 422, not a 500.
  createQueue = [{ content: [{ type: 'text', text: 'sorry, no can do' }], usage: { input_tokens: 1, output_tokens: 1 } }];
  const bad = await request().post('/api/recipe-schedule/organize-grocery-list')
    .set('Authorization', u.auth)
    .send({ items: [{ name: 'milk', entries: [] }] });
  assert.equal(bad.status, 422);
});

test('organize-grocery-list refuses when AI is turned off', async () => {
  const u = await registerUser({ firstName: 'AiOff' });
  await request().put('/api/settings').set('Authorization', u.auth).send({ aiEnabled: false });
  const res = await request().post('/api/recipe-schedule/organize-grocery-list')
    .set('Authorization', u.auth).send({ items: [{ name: 'milk', entries: [] }] });
  assert.equal(res.status, 403);
  assert.equal(createCalls.length, 0, 'nothing reached the model');
});
