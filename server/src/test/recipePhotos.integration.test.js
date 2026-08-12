// The life of a recipe photo (spec: features/kitchen.md, "The photo on a
// recipe"). A recipe's imageUrl is sealed inside its record, so the server can
// never look at a recipe to decide whether a file is still wanted — ownership is
// tracked by `RecipePhoto` rows, claimed by the client once the recipe is saved.
// These tests cover the whole of that: upload, claim, replace, remove, the
// cascade when the recipe is deleted, and the nightly sweep — which, before the
// rows existed, asked the (empty, post-C3b) plaintext Recipe collection and
// therefore deleted every household's recipe photos a day after upload.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startDb, stopDb, request, registerUser, fakeEnc } = require('./harness');

const RecipePhoto = require('../models/RecipePhoto');
const { RECIPES_DIR } = require('../services/recipePhoto');
const { cleanupOrphanUploads } = require('../jobs/cleanupOrphanUploads');

before(startDb);
after(stopDb);

const sharp = require('sharp');
const jpeg = (width = 800, height = 600) =>
  sharp({ create: { width, height, channels: 3, background: '#b5651d' } }).jpeg().toBuffer();

const uploadPhoto = async (auth) =>
  request().post('/api/recipes/photo')
    .set('Authorization', auth)
    .attach('photo', await jpeg(), { filename: 'dish.jpg', contentType: 'image/jpeg' });

const keyOf = (imageUrl) => path.basename(imageUrl);
const onDisk = (imageUrl) => fs.existsSync(path.join(RECIPES_DIR, keyOf(imageUrl)));

// A saved recipe, as the client writes one: an opaque record. The photo's URL
// rides inside `enc` where the server can't read it — the whole reason the claim
// below has to exist.
const saveRecipe = async (auth) => {
  const res = await request().post('/api/records').set('Authorization', auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body._id;
};

test('a picked photo uploads without AI, and belongs to nothing until a recipe claims it', async () => {
  const u = await registerUser({ firstName: 'Cook' });

  const up = await uploadPhoto(u.auth);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.match(up.body.imageUrl, /^\/uploads\/recipes\/[0-9a-f]{32}\.jpg$/);
  assert.equal(onDisk(up.body.imageUrl), true);

  const row = await RecipePhoto.findOne({ storageKey: keyOf(up.body.imageUrl) }).lean();
  assert.ok(row, 'the file is owned from the moment it exists');
  assert.equal(row.recipeId, null, '…but attached to no recipe: the user is still writing it');

  const recipeId = await saveRecipe(u.auth);
  const claim = await request().put(`/api/recipes/${recipeId}/photo`)
    .set('Authorization', u.auth).send({ imageUrl: up.body.imageUrl });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.claimed, keyOf(up.body.imageUrl));

  const claimed = await RecipePhoto.findOne({ storageKey: keyOf(up.body.imageUrl) }).lean();
  assert.equal(String(claimed.recipeId), recipeId);
});

test('replacing a photo drops the old bytes; removing one drops them all', async () => {
  const u = await registerUser({ firstName: 'Swap' });
  const recipeId = await saveRecipe(u.auth);

  const first = (await uploadPhoto(u.auth)).body.imageUrl;
  await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', u.auth).send({ imageUrl: first });

  const second = (await uploadPhoto(u.auth)).body.imageUrl;
  const swap = await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', u.auth).send({ imageUrl: second });
  assert.equal(swap.body.removed, 1);
  assert.equal(onDisk(first), false, 'the replaced photo does not sit on disk forever');
  assert.equal(onDisk(second), true);

  const cleared = await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', u.auth).send({ imageUrl: null });
  assert.equal(cleared.body.claimed, null);
  assert.equal(onDisk(second), false);
  assert.equal(await RecipePhoto.countDocuments({ recipeId }), 0);
});

test('deleting the recipe reaps its photo, without the server learning it was a recipe', async () => {
  const u = await registerUser({ firstName: 'Gone' });
  const recipeId = await saveRecipe(u.auth);
  const imageUrl = (await uploadPhoto(u.auth)).body.imageUrl;
  await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', u.auth).send({ imageUrl });

  const del = await request().delete(`/api/records/${recipeId}`).set('Authorization', u.auth);
  assert.equal(del.status, 200);
  assert.equal(onDisk(imageUrl), false);
  assert.equal(await RecipePhoto.countDocuments({ recipeId }), 0);
});

test('another household can neither claim nor unclaim your photo', async () => {
  const mine = await registerUser({ firstName: 'Mine' });
  const theirs = await registerUser({ firstName: 'Theirs' });
  const recipeId = await saveRecipe(mine.auth);
  const imageUrl = (await uploadPhoto(mine.auth)).body.imageUrl;

  const stolen = await request().put(`/api/recipes/${await saveRecipe(theirs.auth)}/photo`)
    .set('Authorization', theirs.auth).send({ imageUrl });
  assert.equal(stolen.status, 404, 'a photo can only be claimed by the household that uploaded it');
  assert.equal(onDisk(imageUrl), true);

  await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', mine.auth).send({ imageUrl });
  const swept = await request().put(`/api/recipes/${recipeId}/photo`)
    .set('Authorization', theirs.auth).send({ imageUrl: null });
  assert.equal(swept.body.removed, 0, 'nor can someone else clear it');
  assert.equal(onDisk(imageUrl), true);
});

test('a claim rejects a path that is not a recipe photo', async () => {
  const u = await registerUser({ firstName: 'Sneaky' });
  const recipeId = await saveRecipe(u.auth);
  for (const imageUrl of ['/uploads/recipes/../../etc/passwd', '/etc/passwd', 'https://elsewhere.example/a.jpg']) {
    const res = await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', u.auth).send({ imageUrl });
    assert.equal(res.status, 400, imageUrl);
  }
});

test('the nightly sweep keeps claimed photos and reaps abandoned drafts', async () => {
  const u = await registerUser({ firstName: 'Sweep' });
  const recipeId = await saveRecipe(u.auth);

  const kept = (await uploadPhoto(u.auth)).body.imageUrl;
  await request().put(`/api/recipes/${recipeId}/photo`).set('Authorization', u.auth).send({ imageUrl: kept });
  const abandoned = (await uploadPhoto(u.auth)).body.imageUrl;
  const fresh = (await uploadPhoto(u.auth)).body.imageUrl;

  // Age the abandoned draft past the 24h grace window; the third upload stays
  // "in progress" (someone reviewing an import right now) and must survive.
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(path.join(RECIPES_DIR, keyOf(abandoned)), old, old);

  await cleanupOrphanUploads();

  assert.equal(onDisk(kept), true, 'a saved recipe keeps its photo — the bug this job used to have');
  assert.equal(onDisk(fresh), true, 'an import still under review is inside the grace window');
  assert.equal(onDisk(abandoned), false);
  assert.equal(await RecipePhoto.countDocuments({ storageKey: keyOf(abandoned) }), 0,
    'the row goes with the bytes');
});
