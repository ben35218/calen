// Integration tests for scheduled occasion e-cards (spec: features/calendar.md
// "Occasions" + the crypto-e2ee deliberate-plaintext exception). Covers the CRUD
// route (validation, author-only edits), that creation is NOT blocked under an
// E2EE-active household (e-cards are the plaintext exception), and the scheduler
// send pass (fires on the occasion's month/day/hour in the author's timezone,
// records a dry EmailLog per recipient with kind 'ecard', and is idempotent
// within the same year via lastSentYear).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

// SMTP intentionally unconfigured → sendECard is a dry no-op that still logs an
// EmailLog row (status 'dry'), which is what we assert on.
const User = require('../models/User');
const Household = require('../models/Household');
const ECard = require('../models/ECard');
const EmailLog = require('../models/EmailLog');
const { runECardCheck, localHour, localDateStr } = require('../jobs/scheduler');

before(startDb);
after(stopDb);

const validBody = (over = {}) => ({
  kind: 'birthday', occasionLabel: 'Birthday', month: 6, day: 15,
  sendTime: '09:00', message: 'Happy birthday!',
  recipients: [{ email: 'friend@example.com', name: 'Friend' }],
  ...over,
});

test('POST validates month/day/recipients and rejects bad input', async () => {
  const u = await registerUser({ firstName: 'Author' });

  const badMonth = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody({ month: 13 }));
  assert.equal(badMonth.status, 400);

  const noRecipients = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody({ recipients: [] }));
  assert.equal(noRecipients.status, 400);

  const badEmail = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody({ recipients: [{ email: 'nope' }] }));
  assert.equal(badEmail.status, 400);

  const ok = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.recipients[0].email, 'friend@example.com');
  assert.equal(ok.body.lastSentYear, null);
});

test('the chosen card style (template key) persists through create and edit', async () => {
  const u = await registerUser({ firstName: 'Stylist' });

  const created = await request().post('/api/ecards').set('Authorization', u.auth)
    .send(validBody({ template: 'birthday-gold' }));
  assert.equal(created.status, 201);
  assert.equal(created.body.template, 'birthday-gold');

  const patched = await request().patch(`/api/ecards/${created.body._id}`).set('Authorization', u.auth)
    .send({ template: 'birthday-balloons' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.template, 'birthday-balloons');
});

test('framing overrides + font persist; unknown font keys fall back to the template default', async () => {
  const u = await registerUser({ firstName: 'Wordsmith' });

  const created = await request().post('/api/ecards').set('Authorization', u.auth)
    .send(validBody({ greeting: 'Hey Sammy!', signoff: 'Big hugs,', signature: 'The Polks', font: 'script' }));
  assert.equal(created.status, 201);
  assert.equal(created.body.greeting, 'Hey Sammy!');
  assert.equal(created.body.signoff, 'Big hugs,');
  assert.equal(created.body.signature, 'The Polks');
  assert.equal(created.body.font, 'script');

  const bogus = await request().post('/api/ecards').set('Authorization', u.auth)
    .send(validBody({ font: 'comic-sans' }));
  assert.equal(bogus.body.font, '', 'unknown font key stored as template-default');

  // Blanking an override via PATCH restores the defaults.
  const patched = await request().patch(`/api/ecards/${created.body._id}`).set('Authorization', u.auth)
    .send({ greeting: '' });
  assert.equal(patched.body.greeting, '');
});

test('photo lifecycle: author-only capped uploads, household-scoped serving, files removed with the card', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const u = await registerUser({ firstName: 'Shutterbug' });
  const stranger = await registerUser({ firstName: 'Stranger' });

  const created = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody());
  const id = created.body._id;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  // Author uploads; a non-author (different household) cannot.
  const up = await request().post(`/api/ecards/${id}/photos`).set('Authorization', u.auth)
    .attach('photo', png, { filename: 'p.png', contentType: 'image/png' });
  assert.equal(up.status, 201);
  assert.equal(up.body.photos.length, 1);
  const forb = await request().post(`/api/ecards/${id}/photos`).set('Authorization', stranger.auth)
    .attach('photo', png, { filename: 'p.png', contentType: 'image/png' });
  assert.equal(forb.status, 403);

  // Non-image mimetypes are rejected by the filter.
  const notImg = await request().post(`/api/ecards/${id}/photos`).set('Authorization', u.auth)
    .attach('photo', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' });
  assert.equal(notImg.status, 400);

  // The cap: 3 photos max.
  for (let i = 0; i < 2; i++) {
    await request().post(`/api/ecards/${id}/photos`).set('Authorization', u.auth)
      .attach('photo', png, { filename: `p${i}.png`, contentType: 'image/png' });
  }
  const overCap = await request().post(`/api/ecards/${id}/photos`).set('Authorization', u.auth)
    .attach('photo', png, { filename: 'p3.png', contentType: 'image/png' });
  assert.equal(overCap.status, 400);

  // Serving: the author (household scope) can read; the stranger cannot.
  const photoId = up.body.photos[0]._id;
  const got = await request().get(`/api/ecards/${id}/photos/${photoId}`).set('Authorization', u.auth);
  assert.equal(got.status, 200);
  assert.match(got.headers['content-type'], /image\/png/);
  const notYours = await request().get(`/api/ecards/${id}/photos/${photoId}`).set('Authorization', stranger.auth);
  assert.equal(notYours.status, 404);

  // Removing one photo unlinks its file; deleting the card unlinks the rest.
  const uploadDir = path.resolve(process.env.UPLOAD_DIR);
  const card = await ECard.findById(id).lean();
  const files = card.photos.map((p) => path.join(uploadDir, p.storageKey));
  assert.ok(files.every((f) => fs.existsSync(f)), 'uploaded files exist on disk');

  const afterRemove = await request().delete(`/api/ecards/${id}/photos/${photoId}`).set('Authorization', u.auth);
  assert.equal(afterRemove.status, 200);
  assert.equal(afterRemove.body.photos.length, 2);
  assert.ok(!fs.existsSync(files[0]), 'removed photo file unlinked');

  await request().delete(`/api/ecards/${id}`).set('Authorization', u.auth);
  assert.ok(files.slice(1).every((f) => !fs.existsSync(f)), 'card deletion unlinks the remaining files');
});

test('creation is NOT blocked when the household is E2EE-active (deliberate plaintext exception)', async () => {
  const u = await registerUser({ firstName: 'Sealed' });
  await Household.updateOne({ _id: u.user.householdId }, { $set: { e2eeActive: true } });

  const res = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody());
  assert.equal(res.status, 201, 'e-cards bypass the plaintext-create guard by design');
});

test('list + author-only patch/delete', async () => {
  const author = await registerUser({ firstName: 'Owner' });
  const other = await registerUser({ firstName: 'Other' });

  const created = await request().post('/api/ecards').set('Authorization', author.auth).send(validBody());
  const id = created.body._id;

  const list = await request().get('/api/ecards').set('Authorization', author.auth);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((c) => c._id === id));

  // A non-author can't edit or delete.
  const forbidden = await request().patch(`/api/ecards/${id}`).set('Authorization', other.auth).send({ active: false });
  assert.equal(forbidden.status, 403);

  const patched = await request().patch(`/api/ecards/${id}`).set('Authorization', author.auth).send({ message: 'Updated!' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.message, 'Updated!');

  const del = await request().delete(`/api/ecards/${id}`).set('Authorization', author.auth);
  assert.equal(del.status, 200);
  assert.equal((await ECard.findById(id)), null);
});

test('scheduler sends on the occasion date/hour, logs one dry EmailLog per recipient, and is idempotent', async () => {
  const u = await registerUser({ firstName: 'Sender' });
  // Pin the author to UTC so we can align the card to "now" deterministically.
  await User.updateOne({ _id: u.user._id }, { $set: { timezone: 'UTC' } });

  const today = localDateStr('UTC');            // YYYY-MM-DD, matches scheduler logic
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const hour = localHour('UTC');
  const sendTime = `${String(hour).padStart(2, '0')}:00`;
  const thisYear = Number(today.slice(0, 4));

  await request().post('/api/ecards').set('Authorization', u.auth).send(validBody({
    month, day, sendTime,
    recipients: [{ email: 'a@example.com', name: 'A' }, { email: 'b@example.com', name: 'B' }],
  }));

  const before = await EmailLog.countDocuments({ kind: 'ecard' });
  await runECardCheck();

  const logs = await EmailLog.find({ kind: 'ecard' }).lean();
  assert.equal(logs.length - before, 2, 'one email per recipient');
  assert.ok(logs.every((l) => l.status === 'dry'), 'SMTP unset → dry sends');

  const card = await ECard.findOne({ userId: u.user._id }).lean();
  assert.equal(card.lastSentYear, thisYear, 'lastSentYear armed after send');

  // Second run the same day must not re-send.
  await runECardCheck();
  assert.equal(await EmailLog.countDocuments({ kind: 'ecard' }), before + 2, 'idempotent within the year');
});

test('a card whose send hour already passed today still goes out (catch-up, not next year)', async () => {
  const u = await registerUser({ firstName: 'Catchup' });
  await User.updateOne({ _id: u.user._id }, { $set: { timezone: 'UTC' } });

  const today = localDateStr('UTC');
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const thisYear = Number(today.slice(0, 4));

  // Send time at the very start of the day → its hour is already in the past for
  // any current hour, yet the occasion is today, so it must still send.
  const res = await request().post('/api/ecards').set('Authorization', u.auth).send(validBody({
    month, day, sendTime: '00:00', recipients: [{ email: 'late@example.com', name: 'Late' }],
  }));
  const id = res.body._id;

  await runECardCheck();
  const card = await ECard.findById(id).lean();
  assert.equal(card.lastSentYear, thisYear, 'past-hour card on the occasion day still sends');
});
