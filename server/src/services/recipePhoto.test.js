const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The module reads UPLOAD_DIR once, at require time (like the routes do), so the
// sandbox has to be in place before it loads.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-recipe-photo-'));
process.env.UPLOAD_DIR = SANDBOX;

const {
  RECIPES_DIR, publicUrl, storageKeyFromUrl, photoExists,
  storePhoto, deletePhoto, cropRectFor, storeCropOfPage, pageImageUrl,
} = require('./recipePhoto');

const sharp = require('sharp');
// A page-shaped image with a distinct block where the "photo" is, so a crop can
// be told apart from the whole page by its size.
const page = (width = 1000, height = 1400) =>
  sharp({ create: { width, height, channels: 3, background: '#cccccc' } }).jpeg().toBuffer();

test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test('cropRectFor: turns a fractional box into a pixel rect', () => {
  assert.deepEqual(
    cropRectFor({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, { width: 1000, height: 1400 }),
    { left: 100, top: 280, width: 500, height: 350 },
  );
});

test('cropRectFor: clamps a box that spills off the page instead of throwing', () => {
  // sharp.extract() throws on a rect past the edge, and a model's box routinely
  // is — the far edge is pulled back to the page rather than trusted.
  const rect = cropRectFor({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }, { width: 1000, height: 1400 });
  assert.equal(rect.left + rect.width, 1000);
  assert.equal(rect.top + rect.height, 1400);
});

test('cropRectFor: refuses anything that cannot be a photo', () => {
  const size = { width: 1000, height: 1400 };
  assert.equal(cropRectFor(null, size), null, 'no box = no photo on the page');
  assert.equal(cropRectFor({ x: 0, y: 0, w: 1, h: 1 }, null), null, 'no page size');
  assert.equal(cropRectFor({ x: 'a', y: 0, w: 1, h: 1 }, size), null, 'non-numeric');
  assert.equal(cropRectFor({ x: 0, y: 0, w: -0.5, h: 0.5 }, size), null, 'inverted');
  assert.equal(cropRectFor({ x: 0.1, y: 0.1, w: 0.02, h: 0.5 }, size), null, 'a sliver is a logo, not a dish');
  assert.equal(cropRectFor({ x: 0.99, y: 0.1, w: 0.5, h: 0.5 }, size), null, 'clamped down to a sliver');
  assert.equal(cropRectFor({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { width: 400, height: 400 }), null,
    'big enough as a fraction, too small in pixels');
});

test('storePhoto: normalizes into a downscaled jpeg under uploads/recipes', async () => {
  const key = await storePhoto(await page(3000, 2000));
  assert.match(key, /^[0-9a-f]{32}\.jpg$/, 'the basename is the only handle on the file, so it carries the entropy');
  assert.equal(publicUrl(key), `/uploads/recipes/${key}`);
  assert.equal(await photoExists(key), true);

  const meta = await sharp(path.join(RECIPES_DIR, key)).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(Math.max(meta.width, meta.height), 1200, 'downscaled to the stored max edge');

  assert.equal(await deletePhoto(key), true);
  assert.equal(await photoExists(key), false);
  assert.equal(await deletePhoto(key), false, 'deleting what is already gone is not an error');
});

test('storeCropOfPage: stores only the boxed photo, and nothing when there is no box', async () => {
  const pagePath = path.join(SANDBOX, 'page.jpg');
  fs.writeFileSync(pagePath, await page(1000, 1400));

  const key = await storeCropOfPage(pagePath, { page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.35 });
  const meta = await sharp(path.join(RECIPES_DIR, key)).metadata();
  assert.equal(meta.width, 500, 'the crop, not the page');
  assert.equal(meta.height, 490);

  assert.equal(await storeCropOfPage(pagePath, null), null, 'a text-only page yields no photo');
  assert.equal(await storeCropOfPage(pagePath, { x: 0, y: 0, w: 0.01, h: 0.01 }), null);
  assert.equal(await storeCropOfPage(path.join(SANDBOX, 'nope.jpg'), { x: 0, y: 0, w: 1, h: 1 }), null,
    'an unreadable page never fails the import');
});

test('storageKeyFromUrl: reads our own keys and refuses everything else', () => {
  assert.equal(storageKeyFromUrl('/uploads/recipes/abc123.jpg'), 'abc123.jpg');
  assert.equal(storageKeyFromUrl('https://api.example.com/uploads/recipes/abc123.jpg?v=2'), 'abc123.jpg');
  assert.equal(storageKeyFromUrl('/uploads/recipes/../../secrets.jpg'), null, 'no traversal');
  assert.equal(storageKeyFromUrl('/uploads/recipes/notes.txt'), null);
  assert.equal(storageKeyFromUrl('/uploads/other/abc123.jpg'), null);
  assert.equal(storageKeyFromUrl('https://elsewhere.example/hero.jpg'), null, 'someone else\'s host');
  assert.equal(storageKeyFromUrl(undefined), null);
});

test('pageImageUrl: takes the photo a recipe page advertises', () => {
  const at = 'https://food.example/recipes/soup';
  assert.equal(
    pageImageUrl('<meta property="og:image" content="https://cdn.example/soup.jpg">', at),
    'https://cdn.example/soup.jpg',
  );
  assert.equal(
    pageImageUrl('<meta content=\'/img/soup.jpg\' property=\'og:image\'>', at),
    'https://food.example/img/soup.jpg',
    'attribute order and quoting vary by site; a relative src resolves against the page',
  );
  assert.equal(
    pageImageUrl('<meta name="twitter:image" content="//cdn.example/t.jpg">', at),
    'https://cdn.example/t.jpg',
    'twitter:image is the fallback, protocol-relative included',
  );
  assert.equal(
    pageImageUrl('<script type="application/ld+json">{"@type":"Recipe","image":"https://cdn.example/ld.jpg"}</script>', at),
    'https://cdn.example/ld.jpg',
  );
  assert.equal(
    pageImageUrl('<script>{"image":["https://cdn.example/a.jpg","https://cdn.example/b.jpg"]}</script>', at),
    'https://cdn.example/a.jpg',
    'JSON-LD image as an array',
  );
  assert.equal(
    pageImageUrl('<script>{"image":{"@type":"ImageObject","url":"https://cdn.example/o.jpg"}}</script>', at),
    'https://cdn.example/o.jpg',
    'JSON-LD image as an ImageObject',
  );
  assert.equal(
    pageImageUrl('<meta property="og:image" content="https://cdn.example/a.jpg?w=1&amp;h=2">', at),
    'https://cdn.example/a.jpg?w=1&h=2',
    'the html entity in a query string is decoded',
  );
});

test('pageImageUrl: no image, or nothing fetchable, is a null rather than a guess', () => {
  const at = 'https://food.example/r';
  assert.equal(pageImageUrl('<html><body>just a recipe</body></html>', at), null);
  assert.equal(pageImageUrl('<meta property="og:image" content="javascript:alert(1)">', at), null);
  assert.equal(pageImageUrl('<meta property="og:image" content="">', at), null);
  assert.equal(pageImageUrl(null, at), null);
});
