const fs = require('fs');
const path = require('path');
const RecipePhoto = require('../models/RecipePhoto');

const recipesDir = path.resolve(process.env.UPLOAD_DIR || './uploads', 'recipes');

// Files younger than this are spared — they may belong to an in-progress import
// that hasn't been saved yet (e.g. user still reviewing the extracted recipe).
const GRACE_MS = 24 * 60 * 60 * 1000;

// Delete recipe photo files that no saved recipe references and that are older
// than the grace window: an import the user abandoned, or a photo picked in a
// form that was never saved.
//
// "Referenced" cannot be read off the recipes themselves — a recipe's imageUrl
// is sealed inside its record (Signal-parity C3b), so the server cannot see it.
// It is the `RecipePhoto` rows that say what is in use: a row with a `recipeId`
// was claimed by a save. This job previously asked the (now empty) plaintext
// `Recipe` collection, which answered "nothing is referenced" and so deleted
// every recipe photo in the household a day after it was uploaded.
async function cleanupOrphanUploads() {
  let files;
  try {
    files = await fs.promises.readdir(recipesDir);
  } catch (err) {
    if (err.code === 'ENOENT') return; // nothing uploaded yet
    console.error('[cleanupOrphanUploads] readdir failed:', err.message);
    return;
  }
  if (!files.length) return;

  // Storage keys claimed by a saved recipe. An unclaimed row is a draft that
  // was never saved — it ages out with its file, below.
  const claimed = await RecipePhoto.find({ recipeId: { $ne: null } }, 'storageKey').lean();
  const referenced = new Set(claimed.map((p) => p.storageKey));

  const cutoff = Date.now() - GRACE_MS;
  let removed = 0;
  const goneKeys = [];

  for (const name of files) {
    if (referenced.has(name)) continue;
    const filePath = path.join(recipesDir, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      await fs.promises.unlink(filePath);
      goneKeys.push(name);
      removed++;
    } catch (err) {
      console.error(`[cleanupOrphanUploads] ${name}:`, err.message);
    }
  }

  // Drop the rows whose bytes just went, so an unclaimed draft row doesn't
  // outlive its file forever.
  if (goneKeys.length) {
    await RecipePhoto.deleteMany({ storageKey: { $in: goneKeys } }).catch((err) =>
      console.error('[cleanupOrphanUploads] row cleanup failed:', err.message));
  }

  if (removed) console.log(`[cleanupOrphanUploads] Removed ${removed} orphaned upload(s)`);
}

module.exports = { cleanupOrphanUploads };
