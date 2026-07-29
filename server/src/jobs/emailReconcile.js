// Email delivery reconciliation — the retry half of the outbox.
//
// services/mailer.js parks transient / provider-blocked sends as EmailLog rows
// with status:'queued' + a stored payload + a due time (nextAttemptAt). This job
// (cron every 10 min, and on-demand from the admin console) re-sends the due
// ones with exponential backoff, and resolves each to a terminal state:
//   • success                → sent, payload cleared
//   • transient again        → requeued with a longer backoff, until maxAttempts
//   • permanent / exhausted  → failed, payload cleared (hard bounce also suppresses)
// "Automatic where possible" (throttle/greylist heals itself on retry); what
// can't be auto-resolved lands as `failed` for the admin to handle by hand.

const EmailLog = require('../models/EmailLog');
const EmailSuppression = require('../models/EmailSuppression');
const EmailLifecycleConfig = require('../models/EmailLifecycleConfig');
const { DEFAULT_RETRY } = require('../services/emailCatalog');
const mailer = require('../services/mailer');

const BATCH_LIMIT = 100; // bound work per pass; the next tick picks up the rest

// Retry one queued row. Returns the outcome bucket for the run summary.
async function retryRow(row, retry, now) {
  const p = row.payload || {};
  const { ok, err } = await mailer.attemptSend({
    from: p.from, to: row.to, subject: row.subject, text: p.text, html: p.html, attachments: p.attachments,
  });
  const attempts = (row.attempts || 1) + 1;

  if (ok) {
    await EmailLog.updateOne(
      { _id: row._id },
      { $set: { status: 'sent', attempts, failureKind: null }, $unset: { payload: '', nextAttemptAt: '', lastError: '' } }
    );
    return 'sent';
  }

  const failureKind = mailer.classifyFailure(err);
  const responseCode = Number(err && err.responseCode) || undefined;
  const exhausted = attempts >= (retry.maxAttempts || DEFAULT_RETRY.maxAttempts);

  if (failureKind === 'permanent' || exhausted) {
    if (failureKind === 'permanent' && mailer.isHardBounce(responseCode)) {
      try { await EmailSuppression.suppress({ email: row.to, reason: 'hard_bounce', source: 'delivery' }); } catch { /* best-effort */ }
    }
    await EmailLog.updateOne(
      { _id: row._id },
      { $set: { status: 'failed', attempts, failureKind, responseCode, lastError: err.message, error: err.message }, $unset: { payload: '', nextAttemptAt: '' } }
    );
    return 'failed';
  }

  // Still transient and attempts remain — requeue with a longer backoff.
  const nextAttemptAt = new Date(now.getTime() + mailer.backoffMinutes(attempts, retry) * 60_000);
  await EmailLog.updateOne(
    { _id: row._id },
    { $set: { attempts, failureKind, responseCode, lastError: err.message, error: err.message, nextAttemptAt } }
  );
  return 'requeued';
}

// Process every queued row that is due. `now`/`limit` are injectable for tests.
async function runEmailReconcile({ now = new Date(), limit = BATCH_LIMIT } = {}) {
  const summary = { processed: 0, sent: 0, failed: 0, requeued: 0 };
  // Nothing to (re)send without a transport — dry environments never queue.
  if (!mailer.isConfigured()) return summary;

  let retry = DEFAULT_RETRY;
  try {
    const cfg = await EmailLifecycleConfig.getSingleton();
    retry = cfg.retry || DEFAULT_RETRY;
  } catch { /* fall back to defaults */ }

  const due = await EmailLog.find({ status: 'queued', nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .lean();

  for (const row of due) {
    let outcome;
    try {
      outcome = await retryRow(row, retry, now);
    } catch (e) {
      console.error('[emailReconcile] retry failed for', row._id, e.message);
      continue;
    }
    summary.processed += 1;
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else summary.requeued += 1;
  }
  return summary;
}

module.exports = { runEmailReconcile };
