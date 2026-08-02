// Integration tests for the settings route's household-timezone handling
// (spec: platform/api-reference.md → PUT /settings). The client derives the
// household's default zone from the home location (keyless, client-side — so it
// also works for E2EE households) and writes it via the `householdTimezone`
// key; the server validates it as a real IANA id and stores it on the
// Household, where the reminder scheduler uses it as the fallback for members
// with no personal zone.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

before(startDb);
after(stopDb);

test('PUT /settings householdTimezone: stores a valid IANA zone on the household', async () => {
  const u = await registerUser();
  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ householdTimezone: 'Europe/Rome' });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.status, 200);
  assert.equal(got.body.householdTimezone, 'Europe/Rome');
});

test('PUT /settings householdTimezone: rejects a bogus zone id', async () => {
  const u = await registerUser();
  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ householdTimezone: 'Not/AZone' });
  assert.equal(put.status, 400);
  assert.match(put.body.error, /timezone/i);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.notEqual(got.body.householdTimezone, 'Not/AZone');
});

test('householdTimezone is independent of the personal timezone', async () => {
  const u = await registerUser();
  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ timezone: 'America/Vancouver', householdTimezone: 'Asia/Tokyo' });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.timezone, 'America/Vancouver');
  assert.equal(got.body.householdTimezone, 'Asia/Tokyo');
});

test('PUT /settings homeCity: stores the coarse home area on the household and echoes it', async () => {
  const u = await registerUser();
  // Unset defaults to an empty string.
  const initial = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(initial.body.homeCity, '');

  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ homeCity: 'Ottawa, Ontario, Canada' });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.homeCity, 'Ottawa, Ontario, Canada');
});

test('PUT /settings dayAlertTime: stores a valid HH:mm and echoes it', async () => {
  const u = await registerUser();
  // Unset defaults to null (the 9am default is applied client/cron-side).
  const initial = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(initial.body.dayAlertTime, null);

  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ dayAlertTime: '08:30' });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.dayAlertTime, '08:30');
});

test('PUT /settings dayAlertTime: rejects a malformed time', async () => {
  const u = await registerUser();
  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ dayAlertTime: '25:99' });
  assert.equal(put.status, 400);
  assert.match(put.body.error, /time/i);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.dayAlertTime, null, 'the bad value was not stored');
});

test('PUT /settings dayAlertTime: an empty string resets to the 9am default (null)', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth).send({ dayAlertTime: '07:15' });
  const reset = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ dayAlertTime: '' });
  assert.equal(reset.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.dayAlertTime, null);
});
