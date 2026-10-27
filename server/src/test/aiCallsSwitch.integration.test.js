// Assistant phone calls are a deployment switch (ai-assistant.md → Phone calls
// → "Production switch"): with AI_CALLS_ENABLED unset — the production state —
// the feature must be absent end to end, not merely refused:
//   • every /api/calls path answers 404 (the Vapi webhook included);
//   • the calendar chat never offers call_business / check_call_status and its
//     prompt stops advertising calls (so the model can't promise one);
//   • /billing/status withholds the callPerMinute price and reports
//     features.aiCalls=false, which is what hides every client call surface.
// Flipping the switch on restores all three — the harness runs the rest of the
// suite with it on, so this file is the only place the off state is exercised.

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys } = require('./harness');
const Anthropic = require('@anthropic-ai/sdk');

before(startDb);
after(stopDb);

const anthropicCalls = [];
let scriptedTurns = [];
const endTurn = (text = 'Done.') => ({
  text,
  final: { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 25, output_tokens: 10 } },
});
const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'stub' }).messages);
messagesProto.stream = function stubbedStream(params) {
  anthropicCalls.push(params);
  const turn = scriptedTurns.shift();
  if (!turn) throw new Error('aiCallsSwitch stub: model called with no scripted turn left');
  return {
    on(event, cb) { if (event === 'text' && turn.text) cb(turn.text); return this; },
    async finalMessage() { return turn.final; },
  };
};

const saved = process.env.AI_CALLS_ENABLED;
beforeEach(() => { anthropicCalls.length = 0; scriptedTurns = []; });
afterEach(() => { process.env.AI_CALLS_ENABLED = saved; });

// The model call's params, with the system prompt flattened to one string
// (it's sent as an array of cache-controlled text blocks).
async function chat(auth) {
  scriptedTurns = [endTurn()];
  const res = await request().post('/api/calendar/chat').set('Authorization', auth)
    .send({ messages: [{ role: 'user', content: 'Cancel my dentist appointment' }], includePersonalInfo: true });
  assert.equal(res.status, 200);
  const params = anthropicCalls[anthropicCalls.length - 1];
  const system = Array.isArray(params.system) ? params.system.map((b) => b.text || '').join('\n') : String(params.system);
  return { ...params, system };
}

test('with AI_CALLS_ENABLED unset, every /api/calls path is 404 — the webhook too', async () => {
  const u = await registerUser({ firstName: 'Off' });
  await enrollKeys(u.auth);
  delete process.env.AI_CALLS_ENABLED;

  for (const [method, path] of [
    ['get', '/api/calls'],
    ['post', '/api/calls/event-action'],
    ['post', '/api/calls/cancel-event'],
    ['get', '/api/calls/suppressed'],
    ['post', '/api/calls/vapi/webhook'],
  ]) {
    const res = await request()[method](path).set('Authorization', u.auth).send({});
    assert.equal(res.status, 404, `${method.toUpperCase()} ${path} must not exist when calls are off (got ${res.status})`);
    assert.equal(res.body.error, 'Assistant phone calls are not available.');
  }

  // On: the list route is back (read-only bookkeeping, 200 with an empty list).
  process.env.AI_CALLS_ENABLED = 'true';
  const on = await request().get('/api/calls').set('Authorization', u.auth);
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, []);
});

test('the calendar chat withdraws the call tools and the calling prompt text when calls are off', async () => {
  const u = await registerUser({ firstName: 'Chat' });
  await enrollKeys(u.auth);

  process.env.AI_CALLS_ENABLED = 'true';
  const withCalls = await chat(u.auth);
  const onNames = withCalls.tools.map((t) => t.name);
  assert.ok(onNames.includes('call_business') && onNames.includes('check_call_status'), 'switch on → call tools offered');
  assert.match(withCalls.system, /call_business/);
  assert.match(withCalls.system, /setup_event_phone/);

  delete process.env.AI_CALLS_ENABLED;
  const noCalls = await chat(u.auth);
  const offNames = noCalls.tools.map((t) => t.name);
  assert.ok(!offNames.includes('call_business'), 'call_business must not be offered');
  assert.ok(!offNames.includes('check_call_status'), 'check_call_status must not be offered');
  // The rest of the record tools are untouched — this is the call switch, not
  // the privacy toggle.
  for (const kept of ['list_events', 'get_event_details', 'open_edit_event_form', 'delete_event', 'get_availability']) {
    assert.ok(offNames.includes(kept), `${kept} stays available`);
  }
  assert.doesNotMatch(noCalls.system, /call_business|check_call_status|place AI phone calls|setup_event_phone/i, 'prompt stops advertising calls (the "Add business phone" setup shortcut included)');
  assert.match(noCalls.system, /cannot place phone calls/i, 'prompt tells the model calling is unavailable');
});

test('/billing/status withholds the call price and reports features.aiCalls', async () => {
  const u = await registerUser({ firstName: 'Bill' });

  delete process.env.AI_CALLS_ENABLED;
  let res = await request().get('/api/billing/status').set('Authorization', u.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.features.aiCalls, false);
  assert.equal('callPerMinute' in res.body.actionCosts, false, 'no call price on the rate card');
  assert.equal(res.body.actionCosts.chat, 5, 'the other prices are untouched');

  process.env.AI_CALLS_ENABLED = 'true';
  res = await request().get('/api/billing/status').set('Authorization', u.auth);
  assert.equal(res.body.features.aiCalls, true);
  assert.equal(res.body.actionCosts.callPerMinute, 20);
});
