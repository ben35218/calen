const PushTicket = require('../models/PushTicket');
const push = require('../services/push');
const { pruneSubscription } = require('../services/notify');

// Expo push RECEIPT pass. A send's immediate ticket only reports what Expo can
// see up front (bad token format, missing APNs credentials); the definitive
// delivery result — above all DeviceNotRegistered, the app-deleted / token-
// expired signal — lands in the receipt, fetched separately after the send.
// Without this pass those results were never read, so dead tokens accumulated
// on `User.pushSubscriptions` and every future fanout kept paying for them.
//
// Flow: notify.js persists each accepted native ticket as a `PushTicket` row
// (ticketId + owning userId + the exact expoToken, so the prune can target the
// right subscription). This job — cron'd every 15 min in scheduler.js — picks
// up rows old enough for their receipt to exist, batch-fetches the receipts,
// and:
//   - DeviceNotRegistered → prune that subscription, exactly like the
//     ticket-level 410 prune in services/notify.js;
//   - any other receipt error (MessageTooBig, MessageRateExceeded,
//     InvalidCredentials, …) → log only — none of them mean the DEVICE is
//     gone, so removing the subscription would be wrong;
//   - status ok → nothing to do.
// Processed rows are deleted; a row whose receipt isn't ready yet stays for
// the next run, and the model's 24h TTL bounds anything unfetchable.

// Expo recommends waiting ~15 minutes after the send before asking for
// receipts. Env-overridable so tests don't have to wait it out.
const receiptDelayMs = () => Number(process.env.PUSH_RECEIPT_DELAY_MS || 15 * 60 * 1000);

// getReceipts accepts at most 300 ids per request; one batch per run keeps the
// job trivially bounded (a backlog drains oldest-first across runs).
const BATCH = 300;

async function runPushReceiptCheck() {
  const cutoff = new Date(Date.now() - receiptDelayMs());
  const tickets = await PushTicket.find({ createdAt: { $lte: cutoff } })
    .sort({ createdAt: 1 }).limit(BATCH).lean();
  if (!tickets.length) return { checked: 0, pruned: 0 };

  let receipts;
  try {
    // Via the module object (not a destructured binding) so tests can stub it.
    receipts = await push.fetchExpoReceipts(tickets.map((t) => t.ticketId));
  } catch (err) {
    // Transient Expo/API failure: keep the rows, retry next run (TTL bounds them).
    console.error('[pushReceipts] getReceipts failed:', err.message);
    return { checked: 0, pruned: 0 };
  }

  const done = [];
  let pruned = 0;
  for (const t of tickets) {
    const receipt = receipts[t.ticketId];
    if (!receipt) continue; // not ready yet — stays for the next run
    done.push(t._id);
    if (receipt.status !== 'error') continue;
    if (receipt.details?.error === 'DeviceNotRegistered') {
      await pruneSubscription(t.userId, { expoToken: t.expoToken });
      pruned++;
      console.log(`[pushReceipts] pruned unregistered push token for user ${t.userId}`); // ids only (C5)
    } else {
      console.error(`[pushReceipts] receipt error for user ${t.userId}:`, receipt.details?.error || receipt.message);
    }
  }
  if (done.length) await PushTicket.deleteMany({ _id: { $in: done } });
  return { checked: done.length, pruned };
}

module.exports = { runPushReceiptCheck };
