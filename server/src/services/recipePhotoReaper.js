const RecipePhoto = require('../models/RecipePhoto');
const { deletePhoto } = require('./recipePhoto');

// Signal-parity C3b: deleting a recipe is a /records tombstone — the server
// never learns that the record was a recipe. So this runs on every record
// delete and removes any RecipePhoto keyed by that id, which is a no-op for the
// other 99% of records (they have none). Exactly how `reapEventAttachments`
// handles event attachments; the two sit side by side in the delete path.
//
// Best-effort: a failed unlink is swallowed so the delete still succeeds.
// Returns the number of photo rows removed.
async function reapRecipePhotos(recordId) {
  const photos = await RecipePhoto.find({ recipeId: recordId }, 'storageKey').lean();
  if (!photos.length) return 0;
  for (const photo of photos) await deletePhoto(photo.storageKey);
  await RecipePhoto.deleteMany({ recipeId: recordId });
  return photos.length;
}

module.exports = { reapRecipePhotos };
