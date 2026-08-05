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

// ── Calendar-level alert configs (Occasions + holidays) ─────────────────────
// These are ACCOUNT settings, not device ones: the mobile client caches them in
// AsyncStorage, but that cache is wiped at sign-out, so a user who set holiday
// alerts had them silently revert to the defaults on the next sign-in until the
// account started carrying them. See User.occasionAlerts / .holidayAlerts.
test('PUT /settings holidayAlerts: stores the config and echoes it back', async () => {
  const u = await registerUser();
  // Unset reads as null — "never configured", so the client's defaults apply.
  const initial = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(initial.body.holidayAlerts, null);
  assert.equal(initial.body.occasionAlerts, null);

  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ holidayAlerts: { offsets: [7, 0], time: '08:00' } });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  // Offsets come back deduped and sorted, ready for the scheduler.
  assert.deepEqual(got.body.holidayAlerts, { offsets: [0, 7], time: '08:00' });
});

test('PUT /settings: an empty offsets list means "alerts off", not "unset"', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ occasionAlerts: { offsets: [], time: '12:00' } });

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  // Must survive as a real value: null would put the client back on its
  // noon-day-of + 2-weeks-before default and re-notify a user who opted out.
  assert.deepEqual(got.body.occasionAlerts, { offsets: [], time: '12:00' });
});

test('PUT /settings: null clears an alert config back to unconfigured', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ holidayAlerts: { offsets: [1], time: '09:00' } });
  const clear = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ holidayAlerts: null });
  assert.equal(clear.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.holidayAlerts, null);
});

test('PUT /settings: rejects a malformed alert config without storing it', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ holidayAlerts: { offsets: [1], time: '09:00' } });

  for (const bad of [
    { offsets: [1], time: '25:00' },   // not a wall-clock time
    { offsets: 'soon', time: '09:00' }, // not a list
    { time: '09:00' },                  // no offsets at all
    'tomorrow',                         // not a config
  ]) {
    const put = await request().put('/api/settings').set('Authorization', u.auth)
      .send({ holidayAlerts: bad });
    assert.equal(put.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.deepEqual(got.body.holidayAlerts, { offsets: [1], time: '09:00' }, 'the good value stands');
});

// ── The calendar arrangement (colours, order, hidden, deleted, muted) ────────
// Account state for the same reason as the alert configs above: the mobile
// client caches it in AsyncStorage and that cache is wiped at sign-out, so
// every recolour, reorder, hide and delete silently reverted to the app
// defaults on the next sign-in. See User.calendarPrefs.
test('PUT /settings calendarPrefs: stores the arrangement and echoes it back', async () => {
  const u = await registerUser();
  // Unset reads as null — "never configured", so the device's own arrangement
  // stands (and seeds the account).
  const initial = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(initial.body.calendarPrefs, null);

  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: {
      colors: { chores: '#8E24AA' },
      order: ['chores', 'activities'],
      hidden: ['weather'],
      deletedDefaults: ['recipes'],
      alertsOff: ['trips'],
    } });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.deepEqual(got.body.calendarPrefs, {
    colors: { chores: '#8E24AA' },
    order: ['chores', 'activities'],
    hidden: ['weather'],
    deletedDefaults: ['recipes'],
    alertsOff: ['trips'],
  });
});

test('PUT /settings calendarPrefs: merges field-by-field instead of replacing', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: { colors: { chores: '#8E24AA' }, order: ['chores'] } });
  // A payload carrying only the field that changed must not blank the rest —
  // a client seeding one pref would otherwise wipe the user's saved order.
  const put = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: { hidden: ['weather'] } });
  assert.equal(put.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.deepEqual(got.body.calendarPrefs, {
    colors: { chores: '#8E24AA' },
    order: ['chores'],
    hidden: ['weather'],
  });
});

test('PUT /settings calendarPrefs: an empty value means "cleared", not "unset"', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: { colors: { chores: '#8E24AA' }, hidden: ['weather'] } });
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: { colors: {}, hidden: [] } });

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  // Must survive as real values: an absent field tells the client "adopt
  // whatever this device has", which would restore the overrides the user just
  // reset — and unhide the calendar they just hid.
  assert.deepEqual(got.body.calendarPrefs, { colors: {}, hidden: [] });
});

test('PUT /settings calendarPrefs: null clears the arrangement back to unconfigured', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: { colors: { chores: '#8E24AA' } } });
  const clear = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: null });
  assert.equal(clear.status, 200);

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.equal(got.body.calendarPrefs, null);
});

test('PUT /settings calendarPrefs: rejects a malformed arrangement without storing it', async () => {
  const u = await registerUser();
  await request().put('/api/settings').set('Authorization', u.auth)
    .send({ calendarPrefs: { colors: { chores: '#8E24AA' } } });

  for (const bad of [
    { colors: { chores: 'purple' } },        // not a hex colour
    { colors: { chores: '#8E24AAFF' } },     // not a 6-digit hex
    { colors: ['#8E24AA'] },                 // not an id → colour map
    { order: 'chores' },                     // not a list
    { hidden: [{ id: 'weather' }] },         // not a list of ids
    { alertsOff: Array.from({ length: 501 }, (_, i) => `c${i}`) }, // unbounded
    'purple',                                // not an arrangement
  ]) {
    const put = await request().put('/api/settings').set('Authorization', u.auth)
      .send({ calendarPrefs: bad });
    assert.equal(put.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }

  const got = await request().get('/api/settings').set('Authorization', u.auth);
  assert.deepEqual(got.body.calendarPrefs, { colors: { chores: '#8E24AA' } }, 'the good value stands');
});
