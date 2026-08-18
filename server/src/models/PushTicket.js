const mongoose = require('mongoose');

// One row per Expo push ticket awaiting its RECEIPT (jobs/pushReceipts.js).
//
// A send's immediate ticket only reports errors Expo can see up front; most
// DeviceNotRegistered results (app deleted, token expired) surface in the
// receipt, fetched ~15 minutes later. Each accepted native send therefore
// remembers its ticket id here, together with the owning user and the exact
// subscription token, so the receipt job can prune the right
// `User.pushSubscriptions` row when the receipt says the device is gone.
//
// Durable on purpose: an in-memory queue would lose pending receipts on every
// deploy/restart, which is precisely when a backlog exists.
const pushTicketSchema = new mongoose.Schema({
  ticketId:  { type: String, required: true, index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expoToken: { type: String, required: true },
}, { timestamps: true });

// Receipts are fetched once ready; processed rows are deleted by the job. The
// TTL reaps anything left behind (Expo drops receipts after ~a day anyway), so
// an outage can't grow an unbounded backlog. Mongoose auto-creates the index —
// no deploy-time migration needed.
pushTicketSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('PushTicket', pushTicketSchema);
