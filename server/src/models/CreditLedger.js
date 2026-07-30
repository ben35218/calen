const mongoose = require('mongoose');

// Append-only record of every AI-credit movement: GRANTS (pack purchases, the
// starter grant, monthly plan periods, admin corrections), REFUNDS, and USAGE
// DEBITS. Debits are ledgered (one row per completed action, kind 'usage' +
// `action`) so the Credits screen's History can answer "where did my credits
// go?" and margin reconciliation can sum debited revenue per action — flat
// per-action prices keep the volume to one row per user-visible AI action.
//
// `deltaMc` is signed integer MILLICREDITS (1 credit = $0.01 retail = 1000 Mc):
// positive for grants, negative for usage/refunds/downward admin adjustments.
//
// `transactionId` is THE webhook idempotency gate: the unique sparse index
// makes re-delivered RevenueCat events (or a re-run starter grant) insert-fail
// before the balance is touched. Rows without one (admin adjustments, usage
// debits) are intentionally not deduped.
const creditLedgerSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deltaMc:       { type: Number, required: true },
  kind:          { type: String, enum: ['purchase', 'starter', 'refund', 'admin', 'plan', 'usage'], required: true },
  productId:     { type: String },
  // The metered action a 'usage' row paid for (chat/scan/…/call) — feeds the
  // History display and per-action reconciliation.
  action:        { type: String },
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
creditLedgerSchema.statics.grant = async function grant({ userId, deltaMc, kind, productId, action, transactionId, note }) {
  // The unique index IS the idempotency guard — make sure it exists before the
  // insert (index builds are async at startup; init() resolves once built and
  // is cached, so this is a one-time cost).
  await this.init();
  let row;
  try {
    row = await this.create({ userId, deltaMc, kind, productId, action, transactionId, note });
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

// Record a usage debit: one row per completed metered action (kind 'usage',
// negative deltaMc), then $inc the materialized balance. No idempotency gate —
// each action is a distinct spend. Callers fire-and-forget (services/credits
// .debitUsageMc), so a throw here must not reach a request path.
creditLedgerSchema.statics.debit = async function debit({ userId, mc, action }) {
  const row = await this.create({ userId, deltaMc: -mc, kind: 'usage', action: action || undefined });
  const User = mongoose.model('User');
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { creditBalanceMc: -mc } },
    { new: true, projection: { creditBalanceMc: 1 } }
  );
  if (user) {
    row.balanceAfterMc = user.creditBalanceMc;
    await row.save().catch(() => {});
  }
  return { row, balanceMc: user ? user.creditBalanceMc : null };
};

module.exports = mongoose.model('CreditLedger', creditLedgerSchema);
