// Delivery-reconciliation tests (spec: features/email-lifecycle.md → Delivery
// ledger + outbox, Reconciliation). Two layers:
//   • pure classification/backoff helpers (no DB, no transport);
//   • runEmailReconcile over seeded EmailLog outbox rows, with the mailer's raw
//     send stubbed so we can force success / transient / permanent outcomes
//     (SMTP is unconfigured in tests, so real sends never fail — we monkeypatch
//     mailer.attemptSend/isConfigured, which emailReconcile reads at call time).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./harness');

const mailer = require('../services/mailer');
const EmailLog = require('../models/EmailLog');
const EmailSuppression = require('../models/EmailSuppression');
const { runEmailReconcile } = require('../jobs/emailReconcile');

const origAttempt = mailer.attemptSend;
const origConfigured = mailer.isConfigured;

before(async () => {
  await startDb();
  mailer.isConfigured = () => true; // pretend a transport exists so reconcile runs
});
after(async () => {
  mailer.attemptSend = origAttempt;
  mailer.isConfigured = origConfigured;
  await stopDb();
});
beforeEach(async () => {
  await EmailLog.deleteMany({});
  await EmailSuppression.deleteMany({});
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('classifyFailure: 4xx/transient-net → transient, 5xx/envelope → permanent', () => {
  assert.equal(mailer.classifyFailure({ responseCode: 421 }), 'transient'); // throttle
  assert.equal(mailer.classifyFailure({ responseCode: 451 }), 'transient'); // greylist
  assert.equal(mailer.classifyFailure({ code: 'ETIMEDOUT' }), 'transient');
  assert.equal(mailer.classifyFailure({ code: 'ECONNREFUSED' }), 'transient');
  assert.equal(mailer.classifyFailure({}), 'transient'); // unknown → prefer retry
  assert.equal(mailer.classifyFailure({ responseCode: 550 }), 'permanent');
  assert.equal(mailer.classifyFailure({ responseCode: 554 }), 'permanent');
  assert.equal(mailer.classifyFailure({ code: 'EENVELOPE' }), 'permanent');
});

test('isHardBounce only for address-invalid codes; backoff doubles and caps', () => {
  assert.equal(mailer.isHardBounce(550), true);
  assert.equal(mailer.isHardBounce(553), true);
  assert.equal(mailer.isHardBounce(452), false);
  // default policy base 5, cap 240.
  assert.equal(mailer.backoffMinutes(1), 5);
  assert.equal(mailer.backoffMinutes(2), 10);
  assert.equal(mailer.backoffMinutes(3), 20);
  assert.equal(mailer.backoffMinutes(20), 240); // capped
});

// ── Outbox reconciliation ────────────────────────────────────────────────────

function queuedRow(over = {}) {
  return EmailLog.create({
    to: 'q@example.com', subject: 'Queued', kind: 'welcome', status: 'queued',
    attempts: 1, failureKind: 'transient', nextAttemptAt: new Date(Date.now() - 1000),
    payload: { from: 'Calen <no-reply@x>', text: 'hi', html: '<p>hi</p>' },
    ...over,
  });
}

test('a due queued row that now succeeds → sent, payload cleared', async () => {
  const row = await queuedRow();
  mailer.attemptSend = async () => ({ ok: true });

  const summary = await runEmailReconcile({ now: new Date() });
  assert.deepEqual(summary, { processed: 1, sent: 1, failed: 0, requeued: 0 });

  const after = await EmailLog.findById(row._id).lean();
  assert.equal(after.status, 'sent');
  assert.equal(after.attempts, 2);
  assert.equal(after.payload, undefined);
  assert.equal(after.nextAttemptAt, undefined);
});

test('transient failure with attempts remaining → requeued with longer backoff', async () => {
  const row = await queuedRow({ attempts: 1 });
  mailer.attemptSend = async () => ({ ok: false, err: { responseCode: 421, message: 'slow down' } });

  const now = new Date();
  const summary = await runEmailReconcile({ now });
  assert.deepEqual(summary, { processed: 1, sent: 0, failed: 0, requeued: 1 });

  const after = await EmailLog.findById(row._id).lean();
  assert.equal(after.status, 'queued');
  assert.equal(after.attempts, 2);
  assert.ok(after.payload, 'payload retained while queued');
  // attempts=2 → backoff 10 min from now.
  assert.ok(after.nextAttemptAt.getTime() > now.getTime() + 9 * 60_000);
});

test('transient failure at maxAttempts → failed, payload cleared', async () => {
  const row = await queuedRow({ attempts: 4 }); // default maxAttempts 5 → this attempt is #5
  mailer.attemptSend = async () => ({ ok: false, err: { responseCode: 451, message: 'try later' } });

  const summary = await runEmailReconcile({ now: new Date() });
  assert.equal(summary.failed, 1);

  const after = await EmailLog.findById(row._id).lean();
  assert.equal(after.status, 'failed');
  assert.equal(after.attempts, 5);
  assert.equal(after.payload, undefined);
});

test('permanent hard-bounce → failed and recipient suppressed', async () => {
  const row = await queuedRow({ to: 'bounce@example.com' });
  mailer.attemptSend = async () => ({ ok: false, err: { responseCode: 550, message: 'no such user' } });

  const summary = await runEmailReconcile({ now: new Date() });
  assert.equal(summary.failed, 1);

  const after = await EmailLog.findById(row._id).lean();
  assert.equal(after.status, 'failed');
  assert.equal(after.failureKind, 'permanent');
  assert.equal(after.payload, undefined);
  assert.equal(await EmailSuppression.isSuppressed('bounce@example.com'), true);
});

test('a not-yet-due queued row is left untouched', async () => {
  const row = await queuedRow({ nextAttemptAt: new Date(Date.now() + 60 * 60_000) });
  mailer.attemptSend = async () => { throw new Error('should not be called'); };

  const summary = await runEmailReconcile({ now: new Date() });
  assert.equal(summary.processed, 0);
  const after = await EmailLog.findById(row._id).lean();
  assert.equal(after.status, 'queued');
});
