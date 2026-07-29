// Do-not-call suppression for outbound AI calls (spec: features/ai-assistant.md
// "Phone calls" → do-not-call). Covers the whole opt-out lifecycle against the
// real app + in-memory MongoDB: the pre-call choke point in placeCall, the
// unauthenticated Vapi opt-out webhook (shared-secret), the post-call analysis
// backstop, and the audited admin add/release surface.

// Must be set before the app (and its webhook handler) load.
process.env.VAPI_WEBHOOK_SECRET = 'test-vapi-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb, request, registerUser } = require('./harness');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const DncEntry = require('../models/DncEntry');
const { numberHash, isSuppressed, suppress } = require('../services/dnc');
const { placeCall, applyVapiToRow } = require('../services/phoneCalls');

let admin; // role: 'admin'
let plain; // role: 'user'

before(async () => {
  await startDb();
  admin = await registerUser({ firstName: 'Ada' });
  plain = await registerUser({ firstName: 'Bob' });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'admin' } });
});
after(stopDb);

// A stand-in event snapshot (shape placeCall expects).
function event(phone) {
  return { _id: new mongoose.Types.ObjectId(), title: 'Dentist', startDate: '2026-08-01T10:00:00Z', phone };
}

test('numberHash is deterministic, keyed, and normalizes formatting', () => {
  assert.equal(numberHash('226-868-1262'), numberHash('+12268681262'));
  assert.equal(numberHash('(226) 868-1262'), numberHash('12268681262'));
  assert.notEqual(numberHash('2268681262'), numberHash('2268681263'));
  assert.match(numberHash('2268681262'), /^[0-9a-f]{64}$/); // HMAC-SHA256 hex
});

test('a suppressed number is refused by placeCall before any Vapi work', async () => {
  const phone = '+15550001111';
  await suppress(phone, { source: 'callee-request' });
  assert.equal(await isSuppressed(phone), true);

  await assert.rejects(
    () => placeCall({ userId: plain.user._id, event: event(phone), action: 'cancel' }),
    (e) => e.code === 'DNC_SUPPRESSED' && e.status === 403,
  );

  // A different (non-suppressed) number passes the gate — it fails later on the
  // missing Vapi config, NOT with a do-not-call error.
  await assert.rejects(
    () => placeCall({ userId: plain.user._id, event: event('+15559998888'), action: 'cancel' }),
    (e) => e.code !== 'DNC_SUPPRESSED',
  );
});

test('suppress is idempotent and audits only on a state change', async () => {
  const phone = '+15550002222';
  await DncEntry.deleteMany({ numberHash: numberHash(phone) });
  await AuditLog.deleteMany({ event: 'dnc_suppressed' });

  const first = await suppress(phone, { source: 'support' });
  const second = await suppress(phone, { source: 'support' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false); // already active — no new audit
  assert.equal(await DncEntry.countDocuments({ numberHash: numberHash(phone) }), 1);
  assert.equal(await AuditLog.countDocuments({ event: 'dnc_suppressed' }), 1);
});

test('Vapi opt-out webhook suppresses the dialed number; bad secret is rejected', async () => {
  const dialed = '+15550003333';
  const payload = {
    message: {
      type: 'tool-calls',
      toolCallList: [{ id: 'call_1', function: { name: 'record_do_not_call', arguments: {} } }],
      call: { customer: { number: dialed } },
    },
  };

  const denied = await request().post('/api/calls/vapi/webhook').set('X-Vapi-Secret', 'wrong').send(payload);
  assert.equal(denied.status, 401);
  assert.equal(await isSuppressed(dialed), false);

  const ok = await request().post('/api/calls/vapi/webhook').set('X-Vapi-Secret', 'test-vapi-secret').send(payload);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.results[0].toolCallId, 'call_1');
  assert.equal(await isSuppressed(dialed), true);
});

test('post-call analysis backstop suppresses on doNotCallRequested', async () => {
  const dialed = '+15550004444';
  const row = {
    userId: plain.user._id, callId: 'c-backstop', phone: dialed, status: 'queued',
    metered: false, async save() {},
  };
  await applyVapiToRow(row, {
    status: 'ended', summary: 'They asked not to be called again.',
    analysis: { structuredData: { doNotCallRequested: true } },
  });
  assert.equal(await isSuppressed(dialed), true);
});

test('admin add → list (masked) → release, all audited; non-admin denied', async () => {
  // Non-admin can't add.
  const denied = await request().post('/api/admin/dnc').set('Authorization', plain.auth).send({ phone: '+15550005555' });
  assert.equal(denied.status, 403);

  // Admin adds.
  const added = await request().post('/api/admin/dnc')
    .set('Authorization', admin.auth).send({ phone: '226-868-9999', note: 'Support request #42' });
  assert.equal(added.status, 201);
  assert.equal(added.body.last4, '9999');
  assert.equal(await isSuppressed('2268689999'), true);

  const auditAdd = await AuditLog.findOne({ event: 'dnc_suppressed', 'meta.source': 'support' }).sort({ at: -1 }).lean();
  assert.ok(auditAdd, 'admin add writes a dnc_suppressed audit row');
  assert.equal(auditAdd.meta.last4, '9999');

  // List never exposes the raw number — only last4.
  const listed = await request().get('/api/admin/dnc').set('Authorization', admin.auth);
  assert.equal(listed.status, 200);
  const entry = listed.body.items.find((i) => i.last4 === '9999');
  assert.ok(entry, 'the added number appears in the list');
  assert.equal(JSON.stringify(entry).includes('2268689999'), false);

  // Release re-enables calling and audits.
  const released = await request().delete(`/api/admin/dnc/${entry._id}`).set('Authorization', admin.auth);
  assert.equal(released.status, 200);
  assert.equal(released.body.active, false);
  assert.equal(await isSuppressed('2268689999'), false);
  assert.ok(await AuditLog.findOne({ event: 'dnc_released' }).lean(), 'release writes a dnc_released audit row');
});
