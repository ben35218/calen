const mongoose = require('mongoose');

// Append-only record of AI-credit GRANTS and ADJUSTMENTS (pack purchases,
// starter grants, refunds, admin corrections). Usage debits are NOT ledgered —
// they are high-volume fire-and-forget $inc's on User.creditBalanceMc; this
// collection stays low-volume so it can double as the purchase history the
// Credits screen shows.
//
// `deltaMc` is signed integer MILLICREDITS (1 credit = $0.01 retail = 1000 Mc):
// positive for grants, negative for refunds / downward admin adjustments.
//
// `transactionId` is THE webhook idempotency gate: the unique sparse index
// makes re-delivered RevenueCat events (or a re-run starter grant) insert-fail
// before the balance is touched. Rows without one (admin adjustments) are
// intentionally not deduped.
const creditLedgerSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deltaMc:       { type: Number, required: true },
  kind:          { type: String, enum: ['purchase', 'starter', 'refund', 'admin'], required: true },
  productId:     { type: String },
  transactionId: { type: String },
  // Best-effort snapshot of the balance after this row's $inc applied (from the
  // findOneAndUpdate result). Display/debug only — never used for enforcement.
  balanceAfterMc: { type: Number },
  note:          { type: String },
}, { timestamps: true });

creditLedgerSchema.index({ transactionId: 1 }, { unique: true, sparse: true });

// Apply a grant/adjustment: insert the ledger row FIRST (the unique index is
// the idempotency gate), then $inc the user's materialized balance. A duplicate
// transactionId returns { duplicate: true } without touching the balance.
creditLedgerSchema.statics.grant = async function grant({ userId, deltaMc, kind, productId, transactionId, note }) {
  // The unique index IS the idempotency guard — make sure it exists before the
  // insert (index builds are async at startup; init() resolves once built and
  // is cached, so this is a one-time cost).
  await this.init();
  let row;
  try {
    row = await this.create({ userId, deltaMc, kind, productId, transactionId, note });
  } catch (err) {
    if (err && err.code === 11000) return { duplicate: true };
    throw err;
  }
  const User = mongoose.model('User');
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { creditBalanceMc: deltaMc } },
    { new: true, projection: { creditBalanceMc: 1 } }
  );
  if (user) {
    row.balanceAfterMc = user.creditBalanceMc;
    await row.save().catch(() => {});
  }
  return { duplicate: false, row, balanceMc: user ? user.creditBalanceMc : null };
};

module.exports = mongoose.model('CreditLedger', creditLedgerSchema);
