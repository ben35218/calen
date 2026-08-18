const mongoose = require('mongoose');

const shoppingSessionSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Household routing so the shared scopeClause ($or householdId/userId) can
  // match — and upsert — a session; without this field in the schema a strict
  // upsert through req.scopeFilter is rejected outright. One session per week
  // is shared by the household (the grocery list is household-level).
  householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  weekStart: { type: String, required: true }, // 'YYYY-MM-DD'
  // Legacy plaintext shopping state. Transition-only: current clients seal the
  // whole blob into `enc` (which clears this); it is still accepted from old
  // builds until the sealed rollout completes (spec: features/kitchen.md,
  // "Encryption boundary").
  state: { type: mongoose.Schema.Types.Mixed, default: {} },
  // The sealed session blob — client-encrypted under the household key with
  // AAD id = the weekStart string (there is no client-minted _id; one session
  // per household × week makes weekStart the stable identity). Server-opaque.
  enc: { type: mongoose.Schema.Types.Mixed, default: null },
  keyVersion: { type: Number },
  // Optimistic-concurrency counter: GET returns it, PUT requires the base it
  // read and 409s on mismatch, every accepted write $incs it. What stops two
  // concurrent shoppers from whole-blob clobbering each other's checks/extras
  // (the merge on conflict is client-side — the server can't see inside enc).
  version: { type: Number, default: 0 },
}, { timestamps: true });

shoppingSessionSchema.index({ userId: 1, weekStart: 1 }, { unique: true });

module.exports = mongoose.model('ShoppingSession', shoppingSessionSchema);
