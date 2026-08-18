// Recipe photos: where the picture on a recipe card comes from (spec:
// features/kitchen.md, "The photo on a recipe").
//
// Three sources, one destination — a downscaled JPEG under uploads/recipes
// whose basename is the storage key an owning `RecipePhoto` row is written for:
//   - the user picks one (camera/library) for a recipe they're writing;
//   - a URL import lifts the page's own hero image (og:image and friends);
//   - a photo import crops the finished-dish photograph out of the scanned page
//     — and only that: a scan of a page with no food photo on it gets none,
//     because a picture of a cookbook page is not a picture of the dish.
//
// Everything here is deliberately defensive. Two of the three sources are
// attacker-influenced (a webpage the user pasted, a model's bounding box), so
// each is treated as a suggestion to validate rather than a value to use.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchPublicUrl } = require('./urlGuard');

const RECIPES_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads', 'recipes');

// Big enough for the detail screen's hero on a 3× display, small enough that a
// library of them stays cheap to store and quick to paint in a list.
const MAX_EDGE = 1200;
const JPEG_QUALITY = 82;

// A remote image that isn't one of these, or is bigger than this, isn't worth
// the round trip — recipe sites serve hero JPEGs, not 40MB TIFFs.
const REMOTE_TIMEOUT_MS = 10_000;
const REMOTE_MAX_BYTES = 8 * 1024 * 1024;

const publicUrl = (storageKey) => `/uploads/recipes/${storageKey}`;

// The basename is the only handle on the file, and `/uploads` is served
// unauthenticated (as it has been for every attachment), so it carries the
// entropy: guessing one is guessing 128 bits.
const newStorageKey = () => `${crypto.randomBytes(16).toString('hex')}.jpg`;

// Normalize whatever arrived — a phone's 12MP HEIC, a site's 3000px hero, a
// crop — into the one stored shape. `sharp` is required lazily: it's a native
// module, and nothing else in this file needs it.
async function toStoredJpeg(input, cropRect) {
  const sharp = require('sharp');
  let img = sharp(input, { failOn: 'none' }).rotate(); // honour EXIF orientation
  if (cropRect) img = img.extract(cropRect);
  return img
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

// Write a normalized copy into uploads/recipes and hand back its storage key.
// `input` is a buffer or a path; `cropRect` (pixels) narrows it first.
async function storePhoto(input, cropRect) {
  await fs.promises.mkdir(RECIPES_DIR, { recursive: true });
  const storageKey = newStorageKey();
  await fs.promises.writeFile(path.join(RECIPES_DIR, storageKey), await toStoredJpeg(input, cropRect));
  return storageKey;
}

// The storage key inside a recipe-photo URL, or null when the URL isn't one of
// ours. `path.basename` equality is the traversal guard — a key is a filename,
// never a path — and the extension list keeps this to the files this module
// writes. Deliberately looser than `newStorageKey`'s shape so that a photo
// imported before this ownership tracking existed can still be adopted by name.
function storageKeyFromUrl(imageUrl) {
  if (typeof imageUrl !== 'string') return null;
  const [, tail] = imageUrl.split(/\/uploads\/recipes\//);
  if (!tail) return null;
  const key = tail.split(/[?#]/)[0];
  if (!key || key !== path.basename(key) || key.startsWith('.')) return null;
  return /\.(?:jpe?g|png|gif|webp|heic)$/i.test(key) ? key : null;
}

// Whether a storage key names a file we actually hold.
async function photoExists(storageKey) {
  if (!storageKey || storageKey !== path.basename(storageKey)) return false;
  try {
    return (await fs.promises.stat(path.join(RECIPES_DIR, storageKey))).isFile();
  } catch {
    return false;
  }
}

// Delete a stored photo. Best-effort by design: a missing file is the state we
// wanted anyway, and a failed unlink must never fail the request that asked.
async function deletePhoto(storageKey) {
  if (!storageKey || storageKey !== path.basename(storageKey)) return false;
  try {
    await fs.promises.unlink(path.join(RECIPES_DIR, storageKey));
    return true;
  } catch {
    return false;
  }
}

// A model's bounding box (fractions of the page, as it sees them) turned into a
// pixel rectangle — or null, meaning "don't crop anything".
//
// The box is a guess, and a vision model's guesses are approximate and
// occasionally nonsense, so every way it can be wrong is a null rather than a
// mangled image: missing numbers, a box that is inverted, off the page, or so
// small it can only be a logo or a stray thumbnail. The rest is clamped to the
// page rather than trusted, since `sharp.extract` throws on a rect that spills
// over the edge.
const MIN_FRACTION = 0.08;   // < 8% of an edge is not the dish photo
const MIN_PIXELS = 120;      // …and neither is anything this small on the page

function cropRectFor(box, size) {
  if (!box || !size?.width || !size?.height) return null;
  const nums = [box.x, box.y, box.w, box.h].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let [x, y, w, h] = nums;
  if (w <= 0 || h <= 0) return null;
  if (w < MIN_FRACTION || h < MIN_FRACTION) return null;
  // Clamp the origin onto the page, then the extent to what's left of it.
  x = Math.min(Math.max(x, 0), 1);
  y = Math.min(Math.max(y, 0), 1);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w < MIN_FRACTION || h < MIN_FRACTION) return null;

  const rect = {
    left: Math.round(x * size.width),
    top: Math.round(y * size.height),
    width: Math.round(w * size.width),
    height: Math.round(h * size.height),
  };
  if (rect.width < MIN_PIXELS || rect.height < MIN_PIXELS) return null;
  // Rounding can push the far edge one pixel past the image; pull it back.
  rect.width = Math.min(rect.width, size.width - rect.left);
  rect.height = Math.min(rect.height, size.height - rect.top);
  return rect;
}

// Crop the dish photo out of a scanned page and store it. Returns the storage
// key, or null when the page has no usable photo on it — the common, correct
// outcome for a plain text recipe card.
async function storeCropOfPage(filePath, box) {
  if (!box) return null;
  try {
    const sharp = require('sharp');
    const { width, height } = await sharp(filePath).metadata();
    const rect = cropRectFor(box, { width, height });
    if (!rect) return null;
    return await storePhoto(filePath, rect);
  } catch (err) {
    console.error('[recipePhoto] crop failed:', err.message);
    return null;
  }
}

// The page's own photo of the dish, as the page advertises it to link previews:
// og:image first (what the site chose to represent the recipe), then Twitter's
// equivalent, then schema.org's `image` — which is where a recipe site that
// bothers with structured data puts the real dish shot. Attribute order and
// quoting vary wildly across sites, so each is matched both ways round rather
// than assuming one house style.
function pageImageUrl(html, pageUrl) {
  if (typeof html !== 'string') return null;
  const metaContent = (name) => {
    const attr = `(?:property|name)\\s*=\\s*["']${name}["']`;
    const content = 'content\\s*=\\s*["\']([^"\']+)["\']';
    return (
      html.match(new RegExp(`<meta[^>]+${attr}[^>]+${content}`, 'i'))?.[1] ??
      html.match(new RegExp(`<meta[^>]+${content}[^>]+${attr}`, 'i'))?.[1] ??
      null
    );
  };

  // JSON-LD writes `image` as a string, an array, or an ImageObject — and a page
  // usually carries several blocks (breadcrumbs, org, recipe). Take the first
  // `image` that yields a URL.
  const fromJsonLd = () => {
    for (const m of html.matchAll(/"image"\s*:\s*(?:\{[^{}]*?"url"\s*:\s*)?("[^"]+"|\[)/gi)) {
      if (m[1] === '[') {
        const rest = html.slice(m.index + m[0].length);
        const first = rest.match(/\s*(?:\{[^{}]*?"url"\s*:\s*)?"([^"]+)"/);
        if (first) return first[1];
        continue;
      }
      return m[1].slice(1, -1);
    }
    return null;
  };

  const raw = metaContent('og:image') || metaContent('twitter:image') || fromJsonLd();
  if (!raw) return null;
  try {
    // Resolves a protocol-relative or site-root src against the page it came
    // from; also rejects anything that isn't really a URL.
    const url = new URL(raw.replace(/&amp;/g, '&').trim(), pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// Download a remote image and store it. Returns null on anything unexpected —
// the import must still succeed with the recipe it extracted; a missing picture
// is a smaller loss than a failed import.
//
// The fetch is SSRF-guarded (services/urlGuard): the og:image URL comes off an
// attacker-authored page, so a perfectly public recipe page could otherwise
// point this download at cloud metadata or the private network — and axios's
// own redirect following re-resolved each hop unguarded. The guard vets the
// URL and every redirect hop, and pins the socket to the vetted address; a
// blocked image URL is just "no picture", never a failed import.
async function storeRemoteImage(url) {
  if (!url) return null; // the page advertised no image — not an error
  try {
    const res = await fetchPublicUrl(url, {
      responseType: 'arraybuffer',
      timeout: REMOTE_TIMEOUT_MS,
      maxBytes: REMOTE_MAX_BYTES,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HouseholdCalendar/1.0)' },
    });
    if (!String(res.headers['content-type'] || '').startsWith('image/')) return null;
    return await storePhoto(Buffer.from(res.data));
  } catch (err) {
    console.error('[recipePhoto] remote image failed:', err.message);
    return null;
  }
}

module.exports = {
  RECIPES_DIR,
  publicUrl,
  storageKeyFromUrl,
  photoExists,
  storePhoto,
  deletePhoto,
  cropRectFor,
  storeCropOfPage,
  pageImageUrl,
  storeRemoteImage,
};
