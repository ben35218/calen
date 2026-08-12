const mongoose = require('mongoose');

// Ownership of a recipe photo file on disk (uploads/recipes/<storageKey>).
//
// The photo's URL lives INSIDE the recipe's ciphertext (Signal-parity C3b —
// recipes are opaque records), so the server cannot ask "is this file still
// referenced?" by reading recipes. It has to be told, and this row is the
// telling: the upload/import that produced the file writes one, and the client
// claims it to a recipe id once that recipe is actually saved.
//
// Without it the daily orphan sweep has no notion of "in use" and deletes every
// recipe photo a day after it was uploaded.
const recipePhotoSchema = new mongoose.Schema({
  householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', index: true },
  // Ids of the household members at write time, so a solo user (no household)
  // is still scoped — mirrors `services/scope.scopeClause`.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The recipe record this photo belongs to. Null while it belongs to a draft
  // the user is still reviewing — an import writes the file before the recipe
  // it illustrates exists. An unclaimed row is what the sweep reaps.
  recipeId: { type: mongoose.Schema.Types.ObjectId, index: true, default: null },
  // Basename under uploads/recipes. The whole path is never stored: the
  // directory is the route's business, and a stored path is a traversal waiting
  // to happen.
  storageKey: { type: String, required: true, unique: true },
}, { timestamps: true });

module.exports = mongoose.model('RecipePhoto', recipePhotoSchema);
