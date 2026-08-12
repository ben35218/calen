const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const ingredientSchema = new mongoose.Schema({
  name:   { type: String, required: true },
  amount: String,
  unit:   String,
  // Section label ("Base", "For the sauce", or a variation name); absent = ungrouped.
  group:  String,
}, { _id: false });

const recipeSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed },
  title:        { type: String, required: requiredUntilSealed },
  description:  String,
  source:       { type: String, enum: ['url', 'ai', 'manual', 'photo'], default: 'manual' },
  sourceUrl:    String,
  imageUrl:     String,
  servings:     Number,
  prepTimeMins: Number,
  cookTimeMins: Number,
  ingredients:  [ingredientSchema],
  instructions:            [String],
  instructionIngredients:  { type: [[Number]], default: undefined },
  // Per-step timer in minutes (parallel to instructions); null/absent = no timer.
  instructionTimers:       { type: [Number], default: undefined },
  // Per-step variation tags (parallel to instructions): null = shared by every
  // variation; else the variation names the step is only for.
  instructionVariations:   { type: [[String]], default: undefined },
  tags:                    [String],
  // Ingredient-group names that are mutually exclusive flavor variations
  // (a meal is scheduled as one of them; grocery buys only the chosen one).
  variations:              { type: [String], default: undefined },
  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

module.exports = mongoose.model('Recipe', recipeSchema);
