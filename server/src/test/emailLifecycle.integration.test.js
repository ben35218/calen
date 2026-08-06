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
      ecard: { enabled: true, subjectOverride: '', note: '' },
    },
  });
  await EmailSuppression.deleteMany({});
});

const latest = (filter) => EmailLog.findOne(filter).sort({ at: -1 }).lean();

// Registration fires the welcome email off without awaiting it (auth.js), so the
// response can beat the EmailLog write. Poll rather than assert on the first read.
const latestEventually = async (filter, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    const row = await latest(filter);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test('registration sends a welcome email (dry-logged)', async () => {
  const u = await registerUser({ firstName: 'Wendy' });
  const row = await latestEventually({ to: u.user.email, kind: 'welcome' });
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

test('account-deleted email carries the keeps-billing reminder only when the plan was active', () => {
  // Deleting the account can't cancel the Apple-billed Calen AI plan
  // (billing-plans.md "Account deletion × billing") — this email is the last
  // place the cancel-it-in-Apple-settings pointer can live.
  const withPlan = mailer.buildAccountDeletedConfirmation({ firstName: 'Gwen', hadActiveAiPlan: true });
  assert.match(withPlan.text, /NOT cancelled by deleting your account/);
  assert.match(withPlan.text, /apps\.apple\.com\/account\/subscriptions/);
  assert.match(withPlan.html, /apps\.apple\.com\/account\/subscriptions/);

  const without = mailer.buildAccountDeletedConfirmation({ firstName: 'Gwen' });
  assert.doesNotMatch(without.text, /subscription/i);
  assert.doesNotMatch(without.html, /subscription/i);
});

test('config gate: a disabled optional template is canceled, not sent', async () => {
  await request().put('/api/admin/email/catalog').set('Authorization', admin.auth)
    .send({ templates: { ecard: { enabled: false } } });

  await mailer.sendECard({
    toEmail: 'foodie@example.com', fromName: 'Ada', kind: 'birthday', occasionLabel: 'Birthday', message: 'Hi',
  });
  const row = await latest({ to: 'foodie@example.com', kind: 'ecard' });
  assert.equal(row.status, 'canceled');

  // Re-enable → it sends (dry) again.
  await request().put('/api/admin/email/catalog').set('Authorization', admin.auth)
    .send({ templates: { ecard: { enabled: true } } });
  await mailer.sendECard({
    toEmail: 'foodie2@example.com', fromName: 'Ada', kind: 'birthday', occasionLabel: 'Birthday', message: 'Hi',
  });
  assert.equal((await latest({ to: 'foodie2@example.com', kind: 'ecard' })).status, 'dry');
});

test('e-card photos are downscaled to email size at send time', async () => {
  // A full-resolution phone photo (~3MB) makes Apple Mail defer the card's
  // inline images into "Tap to Download" tiles. sendECard runs every photo
  // through emailSizedPhoto: fit within 1280px, re-encoded — small enough to
  // render inline. GIFs pass through untouched (resizing drops the animation).
  const sharp = require('sharp');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const big = path.join(os.tmpdir(), `ecard-test-big-${process.pid}.jpg`);
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3366aa' } })
    .jpeg().toFile(big);

  const sized = await mailer.emailSizedPhoto(big, 'image/jpeg');
  const meta = await sharp(sized).metadata();
  assert.ok(meta.width <= 1280 && meta.height <= 1280, `downscaled (got ${meta.width}x${meta.height})`);
  assert.ok(sized.length < fs.statSync(big).size, 'smaller than the original');

  // Already-small photos are not upscaled.
  const small = path.join(os.tmpdir(), `ecard-test-small-${process.pid}.jpg`);
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#aa6633' } })
    .jpeg().toFile(small);
  const kept = await sharp(await mailer.emailSizedPhoto(small, 'image/jpeg')).metadata();
  assert.equal(kept.width, 400);

  // GIF bytes pass through identically.
  const gif = path.join(os.tmpdir(), `ecard-test-${process.pid}.gif`);
  fs.writeFileSync(gif, Buffer.from('GIF89a-not-really-a-gif'));
  assert.deepEqual(await mailer.emailSizedPhoto(gif, 'image/gif'), fs.readFileSync(gif));

  for (const f of [big, small, gif]) fs.unlinkSync(f);
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

  // recipe_share was RETIRED 2026-08-01 (recipe sharing is device-composed now,
  // via the OS share sheet) — same treatment: entry kept, implemented:false,
  // no longer previewable.
  const recipeRetired = await request().get('/api/admin/email/catalog/recipe_share/preview').set('Authorization', admin.auth);
  assert.equal(recipeRetired.status, 404);
  assert.equal(cat.body.templates.find((t) => t.key === 'recipe_share').implemented, false);
});

test('email surfaces are requireAdmin-gated', async () => {
  for (const path of ['/api/admin/email/catalog', '/api/admin/email/suppressions', '/api/admin/email/log/stats']) {
    assert.equal((await request().get(path).set('Authorization', plain.auth)).status, 403, path);
    assert.equal((await request().get(path).set('Authorization', admin.auth)).status, 200, path);
  }
});
