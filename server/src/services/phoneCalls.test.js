const test = require('node:test');
const assert = require('node:assert/strict');
const { hasFinalResult, applyVapiToRow, outcomeFrom, dncRequestedInAnalysis, toE164, meterCallSecondsUsage } = require('./phoneCalls');

// A minimal stand-in for a PhoneCall mongoose doc. No userId/householdId by
// default, so metering's counter writes are skipped (no DB in these unit tests).
function row(fields = {}) {
  return {
    status: 'queued',
    endedReason: undefined,
    summary: undefined,
    durationSeconds: undefined,
    dncCaptured: false, // schema default — a real row never has this undefined
    metered: false,
    saved: false,
    async save() { this.saved = true; },
    ...fields,
  };
}

test('hasFinalResult: pending calls are not final', () => {
  assert.equal(hasFinalResult(row({ status: 'queued' })), false);
  assert.equal(hasFinalResult(row({ status: 'in-progress' })), false);
});

test('hasFinalResult: an ended call needs its summary before it stops refreshing', () => {
  assert.equal(hasFinalResult(row({ status: 'ended' })), false); // analysis still pending
  assert.equal(hasFinalResult(row({ status: 'ended', summary: 'Cancelled.' })), true);
  assert.equal(hasFinalResult(row({ status: 'failed' })), true); // no summary coming
});

test('applyVapiToRow: copies new fields and saves', async () => {
  const r = row({ status: 'in-progress' });
  await applyVapiToRow(r, { status: 'ended', endedReason: 'customer-ended-call', summary: 'Done.', callLength: 62 });
  assert.equal(r.status, 'ended');
  assert.equal(r.endedReason, 'customer-ended-call');
  assert.equal(r.summary, 'Done.');
  assert.equal(r.durationSeconds, 62);
  assert.equal(r.saved, true);
});

test('applyVapiToRow: reads the summary from analysis.summary when top-level is absent', async () => {
  const r = row({ status: 'ended' });
  await applyVapiToRow(r, { status: 'ended', analysis: { summary: 'Rescheduled to Friday.' } });
  assert.equal(r.summary, 'Rescheduled to Friday.');
});

test('applyVapiToRow: no save when nothing changed (already metered)', async () => {
  const r = row({ status: 'ended', summary: 'Done.', endedReason: 'hangup', durationSeconds: 10, metered: true });
  await applyVapiToRow(r, { status: 'ended', summary: 'Done.', endedReason: 'hangup', callLength: 10 });
  assert.equal(r.saved, false);
});

test('meterCallSecondsUsage: charges once when the call is final, then no-ops', () => {
  const r = row({ status: 'ended', summary: 'Done.', durationSeconds: 71 });
  assert.equal(meterCallSecondsUsage(r), true);
  assert.equal(r.metered, true);
  // A second refresh doesn't re-charge.
  assert.equal(meterCallSecondsUsage(r), false);
});

test('meterCallSecondsUsage: does not charge a call that has no final result yet', () => {
  const r = row({ status: 'in-progress', durationSeconds: undefined });
  assert.equal(meterCallSecondsUsage(r), false);
  assert.equal(r.metered, false);
});

test('outcomeFrom: maps the PassFail success evaluation', () => {
  assert.equal(outcomeFrom({ analysis: { successEvaluation: 'true' } }), 'confirmed');
  assert.equal(outcomeFrom({ analysis: { successEvaluation: 'false' } }), 'unconfirmed');
  assert.equal(outcomeFrom({ analysis: {} }), undefined);
  assert.equal(outcomeFrom({}), undefined);
});

test('applyVapiToRow: captures the outcome', async () => {
  const r = row({ status: 'in-progress' });
  await applyVapiToRow(r, { status: 'ended', summary: 'Cancelled.', analysis: { successEvaluation: 'true' } });
  assert.equal(r.outcome, 'confirmed');
});

test('dncRequestedInAnalysis: true only when the analysis flag is exactly true', () => {
  assert.equal(dncRequestedInAnalysis({ analysis: { structuredData: { doNotCallRequested: true } } }), true);
  assert.equal(dncRequestedInAnalysis({ analysis: { structuredData: { doNotCallRequested: false } } }), false);
  assert.equal(dncRequestedInAnalysis({ analysis: { structuredData: {} } }), false);
  assert.equal(dncRequestedInAnalysis({ analysis: {} }), false);
  assert.equal(dncRequestedInAnalysis({}), false);
});

test('applyVapiToRow: flags dncCaptured when the analysis reports a do-not-call request', async () => {
  // No phone on the row, so the suppression backstop (which needs a DB) is
  // skipped — we're asserting only that the outcome view gets its notice flag.
  const r = row({ status: 'in-progress' });
  await applyVapiToRow(r, { status: 'ended', summary: 'They asked not to be called.', analysis: { structuredData: { doNotCallRequested: true } } });
  assert.equal(r.dncCaptured, true);
  assert.equal(r.saved, true);
});

test('applyVapiToRow: dncCaptured stays set even if a later refresh lacks the flag', async () => {
  const r = row({ status: 'ended', summary: 'Done.', dncCaptured: true });
  await applyVapiToRow(r, { status: 'ended', summary: 'Done.', analysis: { structuredData: {} } });
  assert.equal(r.dncCaptured, true);
});

test('toE164: normalizes US/CA numbers', () => {
  assert.equal(toE164('226-868-1262'), '+12268681262');
  assert.equal(toE164('1 (226) 868-1262'), '+12268681262');
  assert.equal(toE164('+44 20 7946 0000'), '+44 20 7946 0000');
});
