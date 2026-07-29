// In-app feedback (spec: features/feedback.md). Covers the user-facing submit
// endpoint (POST /api/feedback) and the admin triage surface (GET
// /api/admin/feedback + POST /api/admin/feedback/:id/status) against the real
// app + in-memory MongoDB.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

const User = require('../models/User');
const Feedback = require('../models/Feedback');
const AuditLog = require('../models/AuditLog');

let admin; // role: 'admin'
let alice; // role: 'user'
let bob;   // role: 'user'

before(async () => {
  await startDb();
  admin = await registerUser({ firstName: 'Ada' });
  alice = await registerUser({ firstName: 'Alice' });
  bob = await registerUser({ firstName: 'Bob' });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'admin' } });
});
after(stopDb);

test('POST /feedback creates a row scoped to the caller and coerces fields', async () => {
  const res = await request().post('/api/feedback').set('Authorization', alice.auth).send({
    type: 'bug',
    message: '  The day view crashes on rotate  ',
    contactEmail: 'reply@here.test',
    diagnostics: { appVersion: '1.2.3', platform: 'ios', osVersion: '17.5', route: 'CalendarDay' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);

  const row = await Feedback.findById(res.body.id).lean();
  assert.equal(String(row.userId), String(alice.user._id));
  assert.equal(row.type, 'bug');
  assert.equal(row.message, 'The day view crashes on rotate'); // trimmed
  assert.equal(row.contactEmail, 'reply@here.test');
  assert.equal(row.status, 'new');
  assert.equal(row.diagnostics.appVersion, '1.2.3');
  assert.equal(row.diagnostics.route, 'CalendarDay');
});

test('POST /feedback rejects an empty message', async () => {
  const res = await request().post('/api/feedback').set('Authorization', alice.auth).send({
    type: 'question',
    message: '   ',
  });
  assert.equal(res.status, 400);
});

test('POST /feedback coerces an unknown type to question', async () => {
  const res = await request().post('/api/feedback').set('Authorization', alice.auth).send({
    type: 'rant',
    message: 'Just a thought',
  });
  assert.equal(res.status, 201);
  const row = await Feedback.findById(res.body.id).lean();
  assert.equal(row.type, 'question');
});

test('POST /feedback requires auth', async () => {
  const res = await request().post('/api/feedback').send({ message: 'hi' });
  assert.equal(res.status, 401);
});

test('POST /feedback is rate-limited per user (20 / window)', async () => {
  // bob is isolated: the limiter is keyed per user id, so alice's/admin's
  // submissions above don't count against him.
  for (let i = 0; i < 20; i++) {
    const ok = await request().post('/api/feedback').set('Authorization', bob.auth).send({ message: `note ${i}` });
    assert.equal(ok.status, 201);
  }
  const limited = await request().post('/api/feedback').set('Authorization', bob.auth).send({ message: 'one too many' });
  assert.equal(limited.status, 429);
});

test('GET /admin/feedback is admin-only, newest-first, filterable, with reporter email', async () => {
  // Non-admin is refused.
  const forbidden = await request().get('/api/admin/feedback').set('Authorization', alice.auth);
  assert.equal(forbidden.status, 403);

  const all = await request().get('/api/admin/feedback').set('Authorization', admin.auth);
  assert.equal(all.status, 200);
  assert.ok(all.body.total >= 1);
  assert.equal(typeof all.body.newCount, 'number');
  // Newest first.
  const times = all.body.items.map((i) => new Date(i.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  // Reporter email is resolved for follow-up.
  const bug = all.body.items.find((i) => i.type === 'bug');
  assert.equal(bug.reporterEmail, alice.user.email);

  // Status filter narrows the set.
  const onlyNew = await request().get('/api/admin/feedback?status=new').set('Authorization', admin.auth);
  assert.ok(onlyNew.body.items.every((i) => i.status === 'new'));
});

test('POST /admin/feedback/:id/status triages and audits the change', async () => {
  const one = await Feedback.findOne({ userId: alice.user._id }).lean();

  const res = await request()
    .post(`/api/admin/feedback/${one._id}/status`)
    .set('Authorization', admin.auth)
    .send({ status: 'resolved' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'resolved');

  const audit = await AuditLog.findOne({ event: 'feedback_status_changed', 'meta.feedbackId': one._id }).lean();
  assert.ok(audit, 'expected an audit entry for the status change');
  assert.equal(audit.meta.to, 'resolved');

  // Bad status is rejected; a non-admin cannot triage.
  const bad = await request().post(`/api/admin/feedback/${one._id}/status`).set('Authorization', admin.auth).send({ status: 'nope' });
  assert.equal(bad.status, 400);
  const forbidden = await request().post(`/api/admin/feedback/${one._id}/status`).set('Authorization', alice.auth).send({ status: 'new' });
  assert.equal(forbidden.status, 403);
});
