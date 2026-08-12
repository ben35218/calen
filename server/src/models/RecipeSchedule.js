const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const recipeScheduleSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed },
  recipeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', required: true },
  scheduledDate: { type: Date, required: true },
  servings:      Number,
  // Content (sealed into `enc`, nulled at the §9 drop); refs/dates/servings
  // stay plaintext routing metadata.
  notes:         String,
  // The flavor variation this meal is planned as (one of the recipe's variations).
  variation:     String,
  // E2EE dual-write ciphertext: see models/encFields.js.
  ...encFields,
}, { timestamps: true });

module.exports = mongoose.model('RecipeSchedule', recipeScheduleSchema);
