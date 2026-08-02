// Integration tests for the AI privacy invariants (spec: features/ai-assistant.md,
// the ai-data-minimization rules). These are the promises tested where they are
// ENFORCED — the server:
//
//   1. `User.aiEnabled === false` refuses every endpoint that would send content
//      to Anthropic or place a Vapi call (middleware/aiConsent.js), while
//      read-only AI bookkeeping stays available.
//   2. Friend/family personal-field VALUES never enter the model payload — the
//      household roster reaches the model only through get_household_members,
//      name-only; professionals share business details with phone/email as
//      "on file" flags, never values. Phone numbers ride as presence flags
//      (phoneOnFile) everywhere, including the focused event in the system prompt.
//   3. The user's contact details ride on an AI phone call only with the
//      per-call opt-in (`shareContact` / share-contact toggle), and nothing is
//      retained at Vapi (no recording, no stored transcript).
//
// The real app runs over in-memory MongoDB (harness). The ONLY fakes are at the
// network edge: the Anthropic SDK's `messages.stream` prototype method (so the
// exact payload each model call would send is captured) and `axios.post` for
// api.vapi.ai (capturing the exact call-placement body).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, fakeEnc } = require('./harness');

process.env.VAPI_API_KEY = process.env.VAPI_API_KEY || 'test-vapi-key';
process.env.VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || 'test-phone-id';

const Anthropic = require('@anthropic-ai/sdk'); // same instance the routes use
const axios = require('axios'); // same instance services/phoneCalls uses
const { AI_DISABLED_MESSAGE } = require('../middleware/aiConsent');

before(startDb);
after(stopDb);

// ---------------------------------------------------------------------------
// Network-edge stubs
// ---------------------------------------------------------------------------

// Every model call's request params, in order. `scriptedTurns` is the queue of
// assistant responses the fake stream plays back (one per model call).
const anthropicCalls = [];
let scriptedTurns = [];

const endTurn = (text = 'Done.') => ({
  text,
  final: {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 25, output_tokens: 10 },
  },
});
const toolTurn = (name, input = {}) => ({
  final: {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
    usage: { input_tokens: 25, output_tokens: 10 },
  },
});

const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'stub' }).messages);
messagesProto.stream = function stubbedStream(params) {
  anthropicCalls.push(params);
  const turn = scriptedTurns.shift();
  if (!turn) throw new Error('aiPrivacy stub: model called with no scripted turn left');
  return {
    on(event, cb) {
      if (event === 'text' && turn.text) cb(turn.text);
      return this;
    },
    async finalMessage() {
      return turn.final;
    },
  };
};

// Vapi: capture the call-placement body; answer like a queued call.
const vapiCalls = [];
let vapiCallSeq = 0; // never reset — callId is unique across the whole run
const realAxiosPost = axios.post.bind(axios);
axios.post = async (url, body, cfg) => {
  if (String(url).includes('api.vapi.ai')) {
    vapiCalls.push({ url, body });
    return { data: { id: `call_${++vapiCallSeq}`, status: 'queued' } };
  }
  return realAxiosPost(url, body, cfg);
};

beforeEach(() => {
  anthropicCalls.length = 0;
  vapiCalls.length = 0;
  scriptedTurns = [];
});

// Everything sent to the model across every call this test, as one string —
// the haystack for "this value must never reach Anthropic" assertions.
const allModelPayloads = () => JSON.stringify(anthropicCalls);

const chat = (auth, body) =>
  request().post('/api/calendar/chat').set('Authorization', auth).send(body);

// ---------------------------------------------------------------------------
// 1. Server-side aiEnabled gate
// ---------------------------------------------------------------------------

test('aiEnabled off: every model/call endpoint refuses; read-only bookkeeping does not', async () => {
  const u = await registerUser({ firstName: 'Gate' });
  await enrollKeys(u.auth);

  const off = await request().put('/api/settings').set('Authorization', u.auth).send({ aiEnabled: false });
  assert.equal(off.status, 200);

  const gated = [
    ['/api/calendar/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/chores/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/maintenance/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/maintenance/plan-chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/trips/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/form-assist', { field: 'title', text: 'hi' }],
    ['/api/people/classify', { contacts: [] }],
    ['/api/recipes/suggest-recipes', {}],
    ['/api/calls/cancel-event', {}],
    ['/api/calls/event-action', {}],
  ];
  for (const [path, body] of gated) {
    const res = await request().post(path).set('Authorization', u.auth).send(body);
    assert.equal(res.status, 403, `${path} must refuse when aiEnabled is off (got ${res.status})`);
    assert.equal(res.body.error, AI_DISABLED_MESSAGE, `${path} returns the AI-disabled message`);
  }

  // No refusal path may have touched Anthropic or Vapi.
  assert.equal(anthropicCalls.length, 0, 'nothing reached the model');
  assert.equal(vapiCalls.length, 0, 'nothing reached Vapi');

  // Read-only AI bookkeeping (call list) is deliberately not gated.
  const calls = await request().get('/api/calls').set('Authorization', u.auth);
  assert.equal(calls.status, 200);

  // Flipping the toggle back on restores chat.
  const on = await request().put('/api/settings').set('Authorization', u.auth).send({ aiEnabled: true });
  assert.equal(on.status, 200);
  scriptedTurns = [endTurn('Hello!')];
  const res = await chat(u.auth, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  assert.match(res.text, /event: done/, 'the chat streams to completion');
  assert.equal(anthropicCalls.length, 1);
});

// ---------------------------------------------------------------------------
// 2. Data minimization in the model payload
// ---------------------------------------------------------------------------

// A roster as a worst-case client would send it: full personal fields on
// family/friends, real phone/email values on a professional. The server must
// forward names (and professional business details) only.
const roster = [
  {
    name: 'Avery Example', type: 'family', isSelf: true,
    birthday: '1990-04-05', address: '123 Secret Lane',
    phone: '+15550001111', email: 'avery@example.com', notes: 'allergic to penicillin',
  },
  {
    name: 'Bram Friendly', type: 'friend',
    birthday: '1985-12-01', notes: 'poker buddies',
  },
  {
    name: 'Dr. Molar', type: 'service', service: 'dentist',
    businessName: 'Bright Smiles', address: '9 Main St',
    phoneOnFile: true, emailOnFile: true,
    phone: '+15550002222', email: 'front@brightsmiles.example',
  },
];
const rosterSecrets = [
  '+15550001111', 'avery@example.com', '1990-04-05', '123 Secret Lane', 'penicillin',
  '1985-12-01', 'poker buddies',
  '+15550002222', 'front@brightsmiles.example',
];

test('household roster reaches the model name-only, via the tool, never the system prompt', async () => {
  const u = await registerUser({ firstName: 'Roster' });

  scriptedTurns = [toolTurn('get_household_members'), endTurn('Your household is small.')];
  const res = await chat(u.auth, {
    messages: [{ role: 'user', content: 'Who is in my household?' }],
    people: roster,
  });
  assert.equal(res.status, 200);
  assert.equal(anthropicCalls.length, 2, 'initial call + tool round-trip');

  // Names never ride in the system prompt — only through the tool result.
  const systemText = JSON.stringify(anthropicCalls[0].system);
  for (const name of ['Avery', 'Bram', 'Molar']) {
    assert.ok(!systemText.includes(name), `system prompt must not carry the roster (${name})`);
  }

  // The tool result carries names + professional business details...
  const toolResult = JSON.stringify(anthropicCalls[1].messages.at(-1));
  assert.match(toolResult, /Avery Example/, 'family name is shared');
  assert.match(toolResult, /Bram Friendly/, 'friend name is shared');
  assert.match(toolResult, /Dr\. Molar/, 'professional name is shared');
  assert.match(toolResult, /Bright Smiles/, 'professional business name is shared');
  assert.match(toolResult, /9 Main St/, 'professional business address is shared');
  assert.match(toolResult, /phone & email on file/, 'contact channels are flags, not values');

  // ...and no personal-field VALUE appears in anything sent to the model.
  const payloads = allModelPayloads();
  for (const secret of rosterSecrets) {
    assert.ok(!payloads.includes(secret), `"${secret}" must never enter a model payload`);
  }
});

test('includePersonalInfo:false withholds the roster from the model entirely', async () => {
  const u = await registerUser({ firstName: 'Withheld' });

  scriptedTurns = [toolTurn('get_household_members'), endTurn()];
  const res = await chat(u.auth, {
    messages: [{ role: 'user', content: 'Who is in my household?' }],
    people: roster,
    includePersonalInfo: false,
  });
  assert.equal(res.status, 200);

  const payloads = allModelPayloads();
  for (const needle of ['Avery Example', 'Bram Friendly', 'Dr. Molar', ...rosterSecrets]) {
    assert.ok(!payloads.includes(needle), `"${needle}" must not reach the model with the toggle off`);
  }
  const toolResult = JSON.stringify(anthropicCalls[1].messages.at(-1));
  assert.match(toolResult, /No household members are shared/, 'the tool explains the absence');
});

test('includePersonalInfo:false hides calendar records — availability is the only calendar lens', async () => {
  const u = await registerUser({ firstName: 'FreeBusy' });

  // With the toggle off, the device sends title-stripped free/busy (never the
  // records) as `availability`; the server must serve that and withdraw the
  // record/edit/call tools entirely.
  const availability = [
    {
      date: '2026-07-25', weekday: 'Sat', status: 'partial',
      busy: [{ start: '10:00', end: '11:00' }], free: [{ start: '11:00', end: '22:00' }],
    },
    { date: '2026-07-26', weekday: 'Sun', status: 'free' },
  ];

  scriptedTurns = [toolTurn('get_availability', { from: '2026-07-25', to: '2026-07-26' }), endTurn()];
  const res = await chat(u.auth, {
    messages: [{ role: 'user', content: 'When am I free this weekend?' }],
    includePersonalInfo: false,
    availability,
  });
  assert.equal(res.status, 200);

  // The record/edit/call tools are not even offered to the model.
  const toolNames = anthropicCalls[0].tools.map((t) => t.name);
  for (const gone of [
    'list_events', 'get_event_details', 'open_edit_event_form',
    'delete_event', 'call_business', 'check_call_status',
  ]) {
    assert.ok(!toolNames.includes(gone), `${gone} must not be offered with the toggle off`);
  }
  assert.ok(toolNames.includes('get_availability'), 'the availability lens stays available');
  assert.ok(toolNames.includes('open_create_event_form'), 'creating a brand-new event stays available');

  // The reduced system prompt states the free/busy-only scope.
  const systemText = JSON.stringify(anthropicCalls[0].system);
  assert.match(systemText, /free\/busy availability only/i, 'the prompt explains the restricted mode');

  // get_availability returns exactly the device-computed free/busy, flagged hidden.
  const toolResult = JSON.stringify(anthropicCalls[1].messages.at(-1));
  assert.match(toolResult, /2026-07-25/, 'the device availability flows back through the tool');
  assert.match(toolResult, /detailsHidden/, 'the result is flagged as details-hidden');
});

test('includePersonalInfo:false refuses a record tool even if the model calls it anyway', async () => {
  const u = await registerUser({ firstName: 'Bypass' });

  // Defense-in-depth: the tool is withheld from the list, but a bypassed client
  // could still script a call — executeTool must refuse, never returning records.
  scriptedTurns = [toolTurn('list_events', { from: '2026-07-01', to: '2026-07-31' }), endTurn()];
  const res = await chat(u.auth, {
    messages: [{ role: 'user', content: 'What appointments do I have?' }],
    includePersonalInfo: false,
    calendarSources: {
      events: [{ _id: 'ev1', title: 'Confidential meeting', calendarType: 'appointments', startDate: '2026-07-10T15:00:00.000Z', allDay: false }],
      tasks: [], chores: [], people: [], trips: [], recipeSchedules: [],
    },
  });
  assert.equal(res.status, 200);

  const toolResult = JSON.stringify(anthropicCalls[1].messages.at(-1));
  assert.match(toolResult, /Calendar details are hidden/, 'the record tool refuses');
  const payloads = allModelPayloads();
  assert.ok(!payloads.includes('Confidential meeting'), 'no event title reaches the model with the toggle off');
});

test('phone numbers are presence flags: focused event and list_events never leak the number', async () => {
  const u = await registerUser({ firstName: 'Presence' });

  const focusEvent = {
    _id: '6650a0a0a0a0a0a0a0a0a0a0',
    title: 'Dentist checkup',
    startDate: '2026-07-24T15:00:00.000Z',
    allDay: false,
    calendarType: 'appointments',
    phone: '+15550009999',
  };
  const calendarSources = {
    events: [
      {
        _id: 'ev-vet', title: 'Vet visit', calendarType: 'appointments',
        startDate: '2026-07-28T10:00:00.000Z', allDay: false,
        phone: '+15550008888', description: 'Bring vaccination records',
      },
    ],
    tasks: [], chores: [], people: [], trips: [], recipeSchedules: [],
  };

  scriptedTurns = [toolTurn('list_events', { from: '2026-07-20', to: '2026-07-31' }), endTurn()];
  const res = await chat(u.auth, {
    messages: [{ role: 'user', content: 'What appointments do I have?' }],
    focusEvent,
    calendarSources,
  });
  assert.equal(res.status, 200);

  const systemText = JSON.stringify(anthropicCalls[0].system);
  assert.match(systemText, /Dentist checkup/, 'the focused event is pinned in the prompt');
  assert.match(systemText, /Business phone on file: yes/, 'phone rides as a presence flag');

  const toolResult = JSON.stringify(anthropicCalls[1].messages.at(-1));
  assert.match(toolResult, /Vet visit/, 'the client-supplied event flowed through list_events');
  // The tool result is a JSON string inside a JSON message, so quotes are escaped.
  assert.ok(toolResult.includes('phoneOnFile\\":true'), 'list_events exposes presence only');

  const payloads = allModelPayloads();
  assert.ok(!payloads.includes('+15550009999'), 'the focused event number never reaches the model');
  assert.ok(!payloads.includes('+15550008888'), 'list_events never carries the number');
});

// ---------------------------------------------------------------------------
// 3. AI phone calls: per-call contact opt-in + nothing retained at Vapi
// ---------------------------------------------------------------------------

test('event-action call: contact details ride only with the per-call opt-in', async () => {
  const u = await registerUser({ firstName: 'Caller', lastName: 'One' });
  await enrollKeys(u.auth);
  const set = await request().put('/api/settings').set('Authorization', u.auth)
    .send({ phone: '+12025550123' });
  assert.equal(set.status, 200);
  const email = u.user.email;

  // Two sealed events in the caller's scope (one per call — a second call on
  // the same event would 409 as an active duplicate).
  const mkEvent = async (title) => {
    const created = await request().post('/api/records').set('Authorization', u.auth)
      .send({ enc: fakeEnc(), keyVersion: 1 });
    assert.equal(created.status, 201);
    return { _id: created.body._id, title, startDate: '2026-08-03T14:00:00.000Z', phone: '+13015550100' };
  };

  // Without opt-in: name only; the prompt must say so and carry no phone/email.
  const noShare = await request().post('/api/calls/event-action').set('Authorization', u.auth)
    .send({ event: await mkEvent('Dentist'), action: 'cancel' });
  assert.equal(noShare.status, 201, JSON.stringify(noShare.body));
  assert.equal(vapiCalls.length, 1);
  const promptNoShare = vapiCalls[0].body.assistant.model.messages[0].content;
  assert.match(promptNoShare, /name only — no phone number or email/, 'the caller is told it has no contact details');
  assert.ok(!promptNoShare.includes('+12025550123'), 'user phone withheld without opt-in');
  assert.ok(!promptNoShare.includes(email), 'user email withheld without opt-in');

  // With opt-in: the details ride, framed as share-if-asked.
  const share = await request().post('/api/calls/event-action').set('Authorization', u.auth)
    .send({ event: await mkEvent('Physio'), action: 'cancel', shareContact: true });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  assert.equal(vapiCalls.length, 2);
  const promptShare = vapiCalls[1].body.assistant.model.messages[0].content;
  assert.match(promptShare, /Only share these when asked/, 'opt-in details are share-if-asked');
  assert.ok(promptShare.includes('+12025550123'), 'opted-in phone rides on the call');
  assert.ok(promptShare.includes(email), 'opted-in email rides on the call');

  // Nothing retained at Vapi, on every call: no recording, no stored
  // transcript, and the outcome summary is PII-constrained.
  for (const { body } of vapiCalls) {
    assert.equal(body.assistant.artifactPlan.recordingEnabled, false, 'no audio recording');
    assert.equal(body.assistant.artifactPlan.transcriptPlan.enabled, false, 'no stored transcript');
    const summaryPrompt = body.assistant.analysisPlan.summaryPlan.messages[0].content;
    assert.match(summaryPrompt, /NEVER include identity details/, 'summary prompt bars identity details');
  }
});

test('legacy cancel-event call never carries contact details (predates the toggle)', async () => {
  const u = await registerUser({ firstName: 'Legacy' });
  await enrollKeys(u.auth);
  await request().put('/api/settings').set('Authorization', u.auth).send({ phone: '+12025550188' });

  const created = await request().post('/api/records').set('Authorization', u.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(created.status, 201);

  const res = await request().post('/api/calls/cancel-event').set('Authorization', u.auth)
    .send({ event: { _id: created.body._id, title: 'Haircut', startDate: '2026-08-05T09:00:00.000Z', phone: '+13015550101' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const prompt = vapiCalls[0].body.assistant.model.messages[0].content;
  assert.ok(!prompt.includes('+12025550188'), 'user phone never rides the legacy route');
  assert.match(prompt, /name only — no phone number or email/);
});

test('call placement verifies the event belongs to the caller before dialing', async () => {
  const owner = await registerUser({ firstName: 'Owner' });
  await enrollKeys(owner.auth);
  const outsider = await registerUser({ firstName: 'Outsider' });
  await enrollKeys(outsider.auth);

  const created = await request().post('/api/records').set('Authorization', owner.auth)
    .send({ enc: fakeEnc(), keyVersion: 1 });
  assert.equal(created.status, 201);

  const res = await request().post('/api/calls/event-action').set('Authorization', outsider.auth)
    .send({ event: { _id: created.body._id, title: 'Not yours', startDate: '2026-08-06T09:00:00.000Z', phone: '+13015550102' }, action: 'cancel' });
  assert.equal(res.status, 404, 'another household\'s event id is refused');
  assert.equal(vapiCalls.length, 0, 'no call is placed');
});
