// Integration tests for the maintenance server surface (spec:
// features/maintenance.md). Task/chore/item CONTENT moved to the opaque record
// store (C3b — records suite); what the server still owns is the content-blind
// completion ledger (facts + re-sealed task ciphertext), the odometer log rows,
// and the shared/seed template catalogs. Recurrence math is unit-tested in
// services/recurrence.test.js; client-side scheduling in the mobile libs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, fakeEnc } = require('./harness');

const Record = require('../models/Record');
const TaskCompletion = require('../models/TaskCompletion');
const Item = require('../models/Item');
const MaintenanceTask = require('../models/MaintenanceTask');
const User = require('../models/User');

before(startDb);
after(stopDb);

// A sealed task row in the opaque store, as the client creates one.
async function mkTaskRecord(auth) {
  const created = await request().post('/api/records').set('Authorization', auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(created.status, 201);
  return created.body._id;
}

test('content-blind completion: facts are recorded and the re-sealed task ciphertext is applied', async () => {
  const u = await registerUser({ firstName: 'Completer' });
  const taskId = await mkTaskRecord(u.auth);
  const before1 = await Record.findById(taskId).lean();

  const resealed = fakeEnc();
  const res = await request().post(`/api/tasks/${taskId}/complete`).set('Authorization', u.auth)
    .send({
      completedDate: '2026-07-20T12:00:00.000Z',
      cost: 42,
      notes: 'changed the filter',
      odometerReading: 120500,
      nextDueDate: '2026-10-20T12:00:00.000Z',
      enc: resealed,
      keyVersion: 1,
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.completion.cost, 42);
  assert.equal(res.body.completion.performedBy, 'self');
  assert.equal(res.body.completion.odometerReading, 120500);

  const ledger = await TaskCompletion.find({ taskId }).lean();
  assert.equal(ledger.length, 1, 'one ledger row');
  assert.equal(ledger[0].nextDueDateAfter.toISOString(), '2026-10-20T12:00:00.000Z');

  const after1 = await Record.findById(taskId).lean();
  assert.equal(after1.enc.ct, resealed.ct, 'the re-sealed ciphertext replaced the old blob');
  assert.notEqual(after1.enc.ct, before1.enc.ct);
});

test('completion validates scope and the envelope shape', async () => {
  const owner = await registerUser({ firstName: 'LedgerOwner' });
  const outsider = await registerUser({ firstName: 'LedgerOutsider' });
  const taskId = await mkTaskRecord(owner.auth);

  const foreign = await request().post(`/api/tasks/${taskId}/complete`)
    .set('Authorization', outsider.auth).send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(foreign.status, 404, 'another household cannot complete my task');

  const badEnc = await request().post(`/api/tasks/${taskId}/complete`)
    .set('Authorization', owner.auth).send({ enc: { alg: 'nope' } });
  assert.equal(badEnc.status, 400, 'a malformed envelope is rejected');
  assert.equal((await TaskCompletion.find({ taskId }).lean()).length, 0, 'no ledger row on failure');
});

test('the completion history filters by date range and stays household-scoped', async () => {
  const u = await registerUser({ firstName: 'Historian' });
  const other = await registerUser({ firstName: 'Nosy' });
  const taskId = await mkTaskRecord(u.auth);

  for (const completedDate of ['2026-06-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z']) {
    const res = await request().post(`/api/tasks/${taskId}/complete`).set('Authorization', u.auth)
      .send({ completedDate, enc: fakeEnc(), keyVersion: 1 });
    assert.equal(res.status, 200);
  }

  const all = await request().get('/api/tasks/completions').set('Authorization', u.auth);
  assert.equal(all.body.length, 2);
  const june = await request().get('/api/tasks/completions?from=2026-05-15&to=2026-06-15')
    .set('Authorization', u.auth);
  assert.equal(june.body.length, 1, 'the range filter excludes July');

  const foreign = await request().get('/api/tasks/completions').set('Authorization', other.auth);
  assert.equal(foreign.body.length, 0, 'completions are household-scoped');
});

test('odometer: readings log against an in-scope vehicle; raw rows + mileage tasks come back', async () => {
  const u = await registerUser({ firstName: 'Driver' });
  const other = await registerUser({ firstName: 'Passerby' });

  // The vehicle + its mileage task ride the legacy rows the odometer route
  // reads (no server create route — the client seeds them).
  const truck = await Item.create({ userId: u.user._id, name: 'Truck', type: 'vehicle' });
  await MaintenanceTask.create({ userId: u.user._id, itemId: truck._id, title: 'Oil change', type: 'interval', intervalKm: 8000 });
  await MaintenanceTask.create({ userId: u.user._id, itemId: truck._id, title: 'Wash', type: 'one-time' });

  const posted = await request().post(`/api/vehicles/${truck._id}/odometer`).set('Authorization', u.auth)
    .send({ reading: 120500, recordedAt: '2026-07-20T12:00:00.000Z', enc: fakeEnc(), keyVersion: 1 });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));

  const got = await request().get(`/api/vehicles/${truck._id}/odometer`).set('Authorization', u.auth);
  assert.equal(got.status, 200);
  assert.equal(got.body.logs.length, 1);
  assert.equal(got.body.mileageTasks.length, 1, 'only km-interval tasks count as mileage tasks');
  assert.equal(got.body.mileageTasks[0].title, 'Oil change');

  // Scope: an outsider can't see or log against the vehicle.
  const foreignGet = await request().get(`/api/vehicles/${truck._id}/odometer`).set('Authorization', other.auth);
  assert.equal(foreignGet.status, 404);
  const foreignPost = await request().post(`/api/vehicles/${truck._id}/odometer`)
    .set('Authorization', other.auth).send({ reading: 1, enc: fakeEnc(), keyVersion: 1 });
  assert.equal(foreignPost.status, 404);

  // Delete: wrong scope 404s, the owner's delete lands.
  const logId = posted.body._id;
  const foreignDel = await request().delete(`/api/vehicles/${truck._id}/odometer/${logId}`)
    .set('Authorization', other.auth);
  assert.equal(foreignDel.status, 404);
  const del = await request().delete(`/api/vehicles/${truck._id}/odometer/${logId}`)
    .set('Authorization', u.auth);
  assert.equal(del.status, 200);
  const emptied = await request().get(`/api/vehicles/${truck._id}/odometer`).set('Authorization', u.auth);
  assert.equal(emptied.body.logs.length, 0);
});

test('template catalogs serve the shared seed with category filtering', async () => {
  const u = await registerUser({ firstName: 'Templater' });

  const tasks = await request().get('/api/task-templates').set('Authorization', u.auth);
  assert.equal(tasks.status, 200);
  assert.ok(tasks.body.length > 0, 'the task-template catalog is non-empty');
  assert.ok(tasks.body.every((t) => t.id && t.title && t.recurrence), 'templates carry id/title/recurrence');

  const hvac = await request().get('/api/task-templates?category=HVAC%20%26%20Heating')
    .set('Authorization', u.auth);
  assert.ok(hvac.body.length > 0);
  assert.ok(hvac.body.every((t) => t.defaultCategoryName === 'HVAC & Heating'), 'category filter applies');

  const one = await request().get('/api/task-templates/hvac-01').set('Authorization', u.auth);
  assert.equal(one.status, 200);
  assert.equal(one.body.id, 'hvac-01');
  const missing = await request().get('/api/task-templates/nope-99').set('Authorization', u.auth);
  assert.equal(missing.status, 404);

  const chores = await request().get('/api/chore-templates').set('Authorization', u.auth);
  assert.equal(chores.status, 200);
  assert.ok(chores.body.length > 0, 'the chore-template catalog is non-empty');
});

// Storing a manual is not a cost-bearing AI action (billing-plans.md: only
// auto-lookup and extract-tasks spend model tokens), so the upload route must
// not be credit-metered. Regression: upload/from-url previously carried
// meter('manualParse') — an out-of-credits user got a 402 and a paying one a
// 40-credit debit for a plain file save.
test('manual upload is free and unmetered: works at zero balance, debits nothing', async () => {
  const u = await registerUser({ firstName: 'Uploader' });
  await User.updateOne({ _id: u.user._id }, { $set: { creditBalanceMc: 0 } });
  const fridge = await Item.create({ userId: u.user._id, name: 'Fridge', type: 'appliance' });

  const res = await request().post(`/api/manuals/items/${fridge._id}/upload`)
    .set('Authorization', u.auth)
    .field('title', 'Fridge manual')
    .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'fridge.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const after = await User.findById(u.user._id).lean();
  assert.equal(after.creditBalanceMc, 0, 'no debit for a non-AI file save');
});
