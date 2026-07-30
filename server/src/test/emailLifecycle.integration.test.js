// Email lifecycle integration tests (spec: features/email-lifecycle.md). Real
// app + in-memory MongoDB, SMTP unconfigured so every send is a dry no-op that
// still writes an EmailLog row — exactly what the gates/overrides are asserted
// on. Covers: welcome-on-register, account-deleted template, the config gate
// (disabled optional → canceled; required can't be disabled), the suppression
// gate (non-required skipped; required bypasses), subject override, and the
// admin catalog/preview/suppression surfaces + audit rows + requireAdmin gate.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

const User = require('../models/User');
const EmailLog = require('../models/EmailLog');
const EmailSuppression = require('../models/EmailSuppression');
const AuditLog = require('../models/AuditLog');
const mailer = require('../services/mailer');

let admin; // role: 'admin'
let plain; // role: 'user'

before(async () => {
  await startDb();
  admin = await registerUser({ firstName: 'Ada' });
  plain = await registerUser({ firstName: 'Bob' });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'admin' } });
});
after(stopDb);

// Reset the admin overlay to defaults between tests (via the route, so the
// mailer's config cache is invalidated too).
beforeEach(async () => {
  await request().put('/api/admin/email/catalog').set('Authorization', admin.auth).send({
    templates: {
      welcome: { enabled: true, subjectOverride: '', note: '' },
      recipe_share: { enabled: true, subjectOverride: '', note: '' },
    },
  });
  await EmailSuppression.deleteMany({});
});

const latest = (filter) => EmailLog.findOne(filter).sort({ at: -1 }).lean();

test('registration sends a welcome email (dry-logged)', async () => {
  const u = await registerUser({ firstName: 'Wendy' });
  const row = await latest({ to: u.user.email, kind: 'welcome' });
  assert.ok(row, 'a welcome EmailLog row exists');
  assert.equal(row.status, 'dry');
  assert.match(row.subject, /Welcome to Calen/);
});

test('account-deleted confirmation renders and logs (dry)', async () => {
  await mailer.sendAccountDeletedConfirmation({ email: 'gone@example.com', firstName: 'Gwen' });
  const row = await latest({ to: 'gone@example.com', kind: 'account_deleted' });
  assert.ok(row);
  assert.equal(row.status, 'dry');
  assert.match(row.subject, /deleted/i);
});

test('config gate: a disabled optional template is canceled, not sent', async () => {
  await request().put('/api/admin/email/catalog').set('Authorization', admin.auth)
    .send({ templates: { recipe_share: { enabled: false } } });

  await mailer.sendRecipeShare({
    toEmail: 'foodie@example.com', fromName: 'Ada',
    recipe: { title: 'Soup', ingredients: [], instructions: [] },
  });
  const row = await latest({ to: 'foodie@example.com', kind: 'recipe_share' });
  assert.equal(row.status, 'canceled');

  // Re-enable → it sends (dry) again.
  await request().put('/api/admin/email/catalog').set('Authorization', admin.auth)
    .send({ templates: { recipe_share: { enabled: true } } });
  await mailer.sendRecipeShare({
    toEmail: 'foodie2@example.com', fromName: 'Ada',
    recipe: { title: 'Soup', ingredients: [], instructions: [] },
  });
  assert.equal((await latest({ to: 'foodie2@example.com', kind: 'recipe_share' })).status, 'dry');
});

test('a required template cannot be disabled (server-validated)', async () => {
  const res = await request().put('/api/admin/email/catalog').set('Authorization', admin.auth)
    .send({ templates: { password_reset: { enabled: false } } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /required/i);
});

test('suppression gate: non-required skipped; required bypasses', async () => {
  const addr = 'stop@example.com';
  const added = await request().post('/api/admin/email/suppressions').set('Authorization', admin.auth).send({ email: addr });
  assert.equal(added.status, 200);

  // Optional welcome is suppressed…
  await mailer.sendWelcome({ email: addr, firstName: 'Sy' });
  assert.equal((await latest({ to: addr, kind: 'welcome' })).status, 'suppressed');

  // …but a required password reset still goes through (dry).
  await mailer.sendPasswordResetCode({ email: addr, firstName: 'Sy' }, '481920');
  assert.equal((await latest({ to: addr, kind: 'password_reset' })).status, 'dry');

  // Audit row for the manual suppression.
  assert.ok(await AuditLog.findOne({ event: 'email_suppressed' }).lean());
});

test('releasing a suppression lets optional mail send again', async () => {
  const addr = 'back@example.com';
  const added = await request().post('/api/admin/email/suppressions').set('Authorization', admin.auth).send({ email: addr });
  await request().delete(`/api/admin/email/suppressions/${added.body._id}`).set('Authorization', admin.auth);

  await mailer.sendWelcome({ email: addr, firstName: 'Ray' });
  assert.equal((await latest({ to: addr, kind: 'welcome' })).status, 'dry');
  assert.ok(await AuditLog.findOne({ event: 'email_released' }).lean());
});

test('subject override replaces the built-in subject', async () => {
  await request().put('/api/admin/email/catalog').set('Authorization', admin.auth)
    .send({ templates: { welcome: { subjectOverride: 'A warm hello from Calen' } } });

  await mailer.sendWelcome({ email: 'ovr@example.com', firstName: 'Ola' });
  assert.equal((await latest({ to: 'ovr@example.com', kind: 'welcome' })).subject, 'A warm hello from Calen');

  const audit = await AuditLog.findOne({ event: 'email_config_changed' }).lean();
  assert.ok(audit, 'saving the config is audited');
});

test('GET /catalog returns stages + templates with config overlay', async () => {
  const res = await request().get('/api/admin/email/catalog').set('Authorization', admin.auth);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.stages) && res.body.stages.length);
  const welcome = res.body.templates.find((t) => t.key === 'welcome');
  assert.ok(welcome && welcome.config, 'each template carries its config');
  assert.equal(welcome.required, false);
  assert.equal(res.body.templates.find((t) => t.key === 'password_reset').required, true);
});

test('preview renders an implemented template and 404s a planned one', async () => {
  const ok = await request().get('/api/admin/email/catalog/welcome/preview').set('Authorization', admin.auth);
  assert.equal(ok.status, 200);
  assert.match(ok.body.subject, /Welcome/);
  assert.match(ok.body.html, /<html/i);

  const planned = await request().get('/api/admin/email/catalog/deletion_scheduled/preview').set('Authorization', admin.auth);
  assert.equal(planned.status, 404);

  // event_invitation was RETIRED 2026-07-29 (event invites are device-composed
  // now) — the entry stays in the catalog so historical EmailLog rows resolve,
  // but it's implemented:false and no longer previewable.
  const retired = await request().get('/api/admin/email/catalog/event_invitation/preview').set('Authorization', admin.auth);
  assert.equal(retired.status, 404);
  const cat = await request().get('/api/admin/email/catalog').set('Authorization', admin.auth);
  assert.equal(cat.body.templates.find((t) => t.key === 'event_invitation').implemented, false);
});

test('email surfaces are requireAdmin-gated', async () => {
  for (const path of ['/api/admin/email/catalog', '/api/admin/email/suppressions', '/api/admin/email/log/stats']) {
    assert.equal((await request().get(path).set('Authorization', plain.auth)).status, 403, path);
    assert.equal((await request().get(path).set('Authorization', admin.auth)).status, 200, path);
  }
});
