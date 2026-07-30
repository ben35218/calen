// Admin portal server surfaces (specs/features/admin-portal.md): the
// requireAdmin gate across every admin router, and the audited admin actions —
// role changes, unlock/credit overrides, monetization-config saves (validated
// + diffed), and moderation triage. Real app + in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

const User = require('../models/User');
const Household = require('../models/Household');
const AuditLog = require('../models/AuditLog');
const ContentReport = require('../models/ContentReport');
const CreditLedger = require('../models/CreditLedger');

let admin; // role: 'admin'
let plain; // role: 'user'

before(async () => {
  await startDb();
  admin = await registerUser({ firstName: 'Ada' });
  plain = await registerUser({ firstName: 'Bob' });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'admin' } });
});
after(stopDb);

test('every admin surface 403s for non-admins and answers for admins', async () => {
  const surfaces = [
    '/api/admin/users',
    '/api/admin/e2ee',
    '/api/admin/audit',
    '/api/admin/moderation',
    '/api/admin/feedback',
    '/api/admin/dnc',
    '/api/admin/analytics/overview',
    '/api/admin/email/log',
    '/api/monetization-config',
  ];
  for (const path of surfaces) {
    const denied = await request().get(path).set('Authorization', plain.auth);
    assert.equal(denied.status, 403, `${path} must 403 for role=user`);
    const ok = await request().get(path).set('Authorization', admin.auth);
    assert.equal(ok.status, 200, `${path} must 200 for role=admin`);
  }
});

test('role change: audited, self-demotion blocked, non-admin denied', async () => {
  const target = await registerUser({ firstName: 'Cy' });

  // Non-admin can't grant roles.
  const denied = await request().post(`/api/admin/users/${target.user._id}/role`)
    .set('Authorization', plain.auth).send({ role: 'admin' });
  assert.equal(denied.status, 403);

  // Admin grants, and the change is audited with from/to.
  const grant = await request().post(`/api/admin/users/${target.user._id}/role`)
    .set('Authorization', admin.auth).send({ role: 'admin' });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.role, 'admin');
  const row = await AuditLog.findOne({ event: 'admin_role_changed' }).sort({ at: -1 }).lean();
  assert.ok(row, 'role change must write an audit row');
  assert.equal(row.meta.target, target.user.email);
  assert.equal(row.meta.to, 'admin');

  // Self-demotion is blocked.
  const self = await request().post(`/api/admin/users/${admin.user._id}/role`)
    .set('Authorization', admin.auth).send({ role: 'user' });
  assert.ok(self.status >= 400, 'self-demotion must be rejected');

  // Cleanup so later assertions about admin count stay sane.
  await User.updateOne({ _id: target.user._id }, { $set: { role: 'user' } });
});

test('unlock override flips state and is audited', async () => {
  const res = await request().post('/api/monetization-config/unlock')
    .set('Authorization', admin.auth).send({ userId: plain.user._id, unlocked: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.appUnlocked, true);

  const listed = await request().get('/api/monetization-config/users').set('Authorization', admin.auth);
  const row = listed.body.find((u) => String(u._id) === String(plain.user._id));
  assert.equal(row.appUnlocked, true);
  assert.equal(row.billingSource, 'manual');

  const audit = await AuditLog.findOne({ event: 'unlock_changed' }).lean();
  assert.ok(audit);
  assert.equal(String(audit.meta.targetUserId), String(plain.user._id));
  assert.equal(audit.meta.unlocked, true);
});

// Add-ons are owned household-wide (Household.addons); both admin list
// surfaces carry the owned set so the portal can answer "which users have
// which add-ons".
test('billing and household lists carry the household add-on set', async () => {
  await Household.updateOne(
    { _id: plain.user.householdId },
    { $set: { addons: ['trips', 'birthdays'] } }
  );

  const users = await request().get('/api/monetization-config/users').set('Authorization', admin.auth);
  const row = users.body.find((u) => String(u._id) === String(plain.user._id));
  assert.deepEqual(row.addons, ['trips', 'birthdays']);
  const adminRow = users.body.find((u) => String(u._id) === String(admin.user._id));
  assert.deepEqual(adminRow.addons, [], 'households owning nothing list an empty set');

  const hhs = await request().get('/api/monetization-config/households').set('Authorization', admin.auth);
  const hh = hhs.body.find((h) => String(h._id) === String(plain.user.householdId));
  assert.deepEqual(hh.addons, ['trips', 'birthdays']);
});

test('credit adjustment is ledgered and audited', async () => {
  const res = await request().post('/api/monetization-config/credits')
    .set('Authorization', admin.auth)
    .send({ userId: plain.user._id, credits: 50, note: 'test grant' });
  assert.equal(res.status, 200);
  assert.ok(res.body.creditBalance >= 50, `balance should include the grant, got ${res.body.creditBalance}`);

  const ledger = await CreditLedger.findOne({ userId: plain.user._id, kind: 'admin' }).lean();
  assert.ok(ledger, 'adjustment must be ledgered with kind admin');

  const audit = await AuditLog.findOne({ event: 'credits_adjusted' }).lean();
  assert.ok(audit);
  assert.equal(audit.meta.credits, 50);
  assert.equal(audit.meta.note, 'test grant');

  // Zero / missing amounts are rejected.
  const bad = await request().post('/api/monetization-config/credits')
    .set('Authorization', admin.auth).send({ userId: plain.user._id, credits: 0 });
  assert.equal(bad.status, 400);
});

test('config save: validated, and audited with the leaf diff', async () => {
  const { body: cfg } = await request().get('/api/monetization-config').set('Authorization', admin.auth);

  // Broken numbers are rejected before touching the doc.
  const invalid = await request().put('/api/monetization-config')
    .set('Authorization', admin.auth)
    .send({ credits: { ...cfg.credits, margin: -1 } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /margin/);
  assert.equal(await AuditLog.countDocuments({ event: 'config_changed' }), 0,
    'a rejected save must not audit');

  // A real change saves and audits exactly what moved.
  const saved = await request().put('/api/monetization-config')
    .set('Authorization', admin.auth)
    .send({ credits: { ...cfg.credits, margin: 2.5 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.credits.margin, 2.5);

  const audit = await AuditLog.findOne({ event: 'config_changed' }).lean();
  assert.ok(audit, 'config save must write an audit row');
  assert.ok(audit.meta.changed.some((c) => c.startsWith('credits.margin:')),
    `diff should name credits.margin, got ${JSON.stringify(audit.meta.changed)}`);

  // A no-op save (same values) must not add another audit row.
  const noop = await request().put('/api/monetization-config')
    .set('Authorization', admin.auth)
    .send({ credits: saved.body.credits });
  assert.equal(noop.status, 200);
  assert.equal(await AuditLog.countDocuments({ event: 'config_changed' }), 1);
});

test('moderation triage updates status and is audited', async () => {
  const report = await ContentReport.create({
    userId: plain.user._id,
    surface: 'chat',
    content: 'flagged assistant message',
    reason: 'inappropriate',
  });

  const list = await request().get('/api/admin/moderation?status=open').set('Authorization', admin.auth);
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((r) => String(r._id) === String(report._id)));
  assert.equal(list.body.openCount, 1);

  const bad = await request().post(`/api/admin/moderation/${report._id}/status`)
    .set('Authorization', admin.auth).send({ status: 'nonsense' });
  assert.equal(bad.status, 400);

  const ok = await request().post(`/api/admin/moderation/${report._id}/status`)
    .set('Authorization', admin.auth).send({ status: 'reviewed' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'reviewed');

  const audit = await AuditLog.findOne({ event: 'moderation_status_changed' }).lean();
  assert.ok(audit);
  assert.equal(audit.meta.from, 'open');
  assert.equal(audit.meta.to, 'reviewed');

  // Re-posting the same status is a no-op for the audit trail.
  await request().post(`/api/admin/moderation/${report._id}/status`)
    .set('Authorization', admin.auth).send({ status: 'reviewed' });
  assert.equal(await AuditLog.countDocuments({ event: 'moderation_status_changed' }), 1);
});

test('households payload carries identity + members, no usage counters', async () => {
  const res = await request().get('/api/monetization-config/households').set('Authorization', admin.auth);
  assert.equal(res.status, 200);
  const hh = res.body.find((h) => h.members.some((m) => m.email === plain.user.email));
  assert.ok(hh, "plain user's household should be listed with its members");
  assert.ok(hh.ownerEmail, 'ownerEmail is the durable display handle for encrypted names');
  const member = hh.members.find((m) => m.email === plain.user.email);
  assert.equal(typeof member.appUnlocked, 'boolean');
  assert.equal(typeof member.creditBalance, 'number');
  assert.equal(hh.usageThisWeek, undefined, 'household AI usage is retired from the payload');
  assert.equal(hh.usageHistory, undefined, 'household AI usage is retired from the payload');
});

test('audit endpoint filters by event and paginates', async () => {
  const filtered = await request().get('/api/admin/audit?event=unlock_changed')
    .set('Authorization', admin.auth);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.items.length >= 1);
  assert.ok(filtered.body.items.every((l) => l.event === 'unlock_changed'));
  assert.ok(filtered.body.items[0].userEmail, 'actor email should be resolved');

  const paged = await request().get('/api/admin/audit?page=1&pageSize=2').set('Authorization', admin.auth);
  assert.equal(paged.status, 200);
  assert.ok(paged.body.items.length <= 2);
  assert.equal(paged.body.pageSize, 2);
});

test('user search finds by email fragment and paginates', async () => {
  const q = plain.user.email.slice(0, 10);
  const res = await request().get(`/api/admin/users?q=${encodeURIComponent(q)}`)
    .set('Authorization', admin.auth);
  assert.equal(res.status, 200);
  assert.ok(res.body.items.some((u) => u.email === plain.user.email));
  assert.ok(res.body.total >= 1);
});

test('config save validates flat action prices and the AI plan; reconciliation answers', async () => {
  const { body: cfg } = await request().get('/api/monetization-config').set('Authorization', admin.auth);

  // Fractional/negative flat prices and a broken plan are rejected.
  const badAction = await request().put('/api/monetization-config')
    .set('Authorization', admin.auth)
    .send({ credits: { ...cfg.credits, actionCosts: { ...cfg.credits.actionCosts, chat: 1.5 } } });
  assert.equal(badAction.status, 400);
  assert.match(badAction.body.error, /actionCosts\.chat/);

  const badPlan = await request().put('/api/monetization-config')
    .set('Authorization', admin.auth)
    .send({ aiPlan: { ...cfg.aiPlan, monthlyCredits: -1 } });
  assert.equal(badPlan.status, 400);
  assert.match(badPlan.body.error, /monthlyCredits/);

  // Valid edits to both new sections round-trip.
  const saved = await request().put('/api/monetization-config')
    .set('Authorization', admin.auth)
    .send({
      credits: { ...cfg.credits, actionCosts: { ...cfg.credits.actionCosts, chat: 3 } },
      aiPlan: { ...cfg.aiPlan, monthlyCredits: 700 },
    });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.credits.actionCosts.chat, 3);
  assert.equal(saved.body.aiPlan.monthlyCredits, 700);

  // Reconciliation: admin-only, answers with the revenue/cost/margin shape.
  const rec = await request().get('/api/monetization-config/reconciliation').set('Authorization', admin.auth);
  assert.equal(rec.status, 200);
  assert.ok(rec.body.period);
  assert.ok(rec.body.revenue && typeof rec.body.revenue.mc === 'number');
  assert.ok(rec.body.cost && typeof rec.body.cost.mc === 'number');
  assert.ok('marginMultiple' in rec.body);
  const denied = await request().get('/api/monetization-config/reconciliation').set('Authorization', plain.auth);
  assert.equal(denied.status, 403);

  const badPeriod = await request().get('/api/monetization-config/reconciliation?period=nope').set('Authorization', admin.auth);
  assert.equal(badPeriod.status, 400);
});
