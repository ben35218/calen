const test = require('node:test');
const assert = require('node:assert');
const { streamChat } = require('./chatStream');

// Drives streamChat's agentic loop against a scripted fake Anthropic client —
// no network, no req (metering is skipped when req is falsy). Each script
// entry is one API response: { deltas: [text...], message: finalMessage }.
// The fake records every request's params so tests can assert call counts and
// payload shapes (cache markers, attachment stripping, …).

function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(JSON.parse(JSON.stringify(params)));
        const step = script[calls.length - 1];
        if (!step) throw new Error(`fake client: no scripted response for call #${calls.length}`);
        return {
          on(event, cb) {
            if (event === 'text') for (const d of step.deltas || []) cb(d);
          },
          async finalMessage() {
            return step.message;
          },
        };
      },
    },
  };
}

// Captures the SSE stream a fake Express response receives, parsed per event.
function fakeRes() {
  const events = [];
  return {
    events,
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      const m = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
    },
    end() {},
  };
}

const followupsUse = (suggestions) => ({
  type: 'tool_use', id: 'fu1', name: 'suggest_followups', input: { suggestions },
});

test('a followups-only tool_use ending short-circuits: one API call, chips harvested', async () => {
  const client = fakeClient([
    {
      deltas: ['Hi ', 'there'],
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Hi there' },
          followupsUse(['Do it', '  Also this  ', 'Third', 'Fourth']),
        ],
      },
    },
  ]);
  const res = fakeRes();
  await streamChat(res, {
    client, system: 'sys', tools: [], executeTool: () => { throw new Error('no tools should run'); },
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(client.calls.length, 1, 'no trailing acknowledgement call');
  const done = res.events.find((e) => e.event === 'done');
  assert.equal(done.data.reply, 'Hi there');
  assert.deepEqual(done.data.followups, ['Do it', 'Also this', 'Third']);
});

test('followups alongside a REAL tool call does not short-circuit (results matter)', async () => {
  const executed = [];
  const client = fakeClient([
    {
      deltas: ['Checking…'],
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Checking…' },
          { type: 'tool_use', id: 'w1', name: 'get_weather', input: { day: 'sat' } },
          followupsUse(['Plan it']),
        ],
      },
    },
    {
      deltas: [' Sunny on Saturday.'],
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: ' Sunny on Saturday.' }] },
    },
  ]);
  const res = fakeRes();
  await streamChat(res, {
    client, system: 'sys', tools: [],
    executeTool: (name, input) => { executed.push({ name, input }); return { forecast: 'sunny' }; },
    messages: [{ role: 'user', content: 'weather?' }],
  });

  assert.equal(client.calls.length, 2, 'tool round trip still happens');
  assert.deepEqual(executed, [{ name: 'get_weather', input: { day: 'sat' } }]);
  // The second request carries the tool results back, including followups' ok.
  const toolResultMsg = client.calls[1].messages.at(-1);
  assert.equal(toolResultMsg.role, 'user');
  assert.deepEqual(
    toolResultMsg.content.map((r) => r.tool_use_id).sort(),
    ['fu1', 'w1']
  );
  const done = res.events.find((e) => e.event === 'done');
  assert.equal(done.data.reply, 'Checking… Sunny on Saturday.');
  assert.deepEqual(done.data.followups, ['Plan it']);
});

test('every request carries exactly one conversation cache marker, on the last user message', async () => {
  const client = fakeClient([
    {
      deltas: ['One sec.'],
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'One sec.' },
          { type: 'tool_use', id: 'w1', name: 'get_weather', input: {} },
        ],
      },
    },
    {
      deltas: ['Sunny.'],
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sunny.' }] },
    },
  ]);
  const res = fakeRes();
  await streamChat(res, {
    client, system: 'sys', tools: [], executeTool: () => ({ forecast: 'sunny' }),
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'weather?' },
    ],
  });

  assert.equal(client.calls.length, 2);
  for (const call of client.calls) {
    const marked = [];
    for (const msg of call.messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) if (b.cache_control) marked.push({ role: msg.role, block: b });
    }
    assert.equal(marked.length, 1, 'exactly one marked block per request');
    assert.equal(marked[0].role, 'user', 'marker rides a user message');
    // The marker is on the LAST user message's LAST block.
    const lastUser = call.messages.filter((m) => m.role === 'user').at(-1);
    assert.ok(lastUser.content.at(-1).cache_control, 'last block of the last user message');
  }
  // Call 1 marks the user's question; call 2 marks the tool_result message.
  assert.equal(client.calls[0].messages.at(-1).content.at(-1).type, 'text');
  assert.equal(client.calls[1].messages.at(-1).content.at(-1).type, 'tool_result');
});

test('history attachments are stripped to notes; only the latest user message keeps bytes', async () => {
  const client = fakeClient([
    {
      deltas: ['Done.'],
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
    },
  ]);
  const res = fakeRes();
  await streamChat(res, {
    client, system: 'sys', tools: [], executeTool: () => ({}),
    messages: [
      {
        role: 'user', content: 'scan this',
        attachments: [{ kind: 'image', name: 'old.jpg', type: 'image/jpeg', data: 'T0xE' }],
      },
      { role: 'assistant', content: 'Scanned.' },
      {
        role: 'user', content: 'and this one',
        attachments: [{ kind: 'image', name: 'new.jpg', type: 'image/jpeg', data: 'TkVX' }],
      },
    ],
  });

  const sent = client.calls[0].messages;
  const oldBlocks = sent[0].content;
  assert.equal(oldBlocks[0].type, 'text');
  assert.match(oldBlocks[0].text, /old\.jpg/);
  const newBlocks = sent[2].content;
  assert.equal(newBlocks[0].type, 'image');
  assert.equal(newBlocks[0].source.data, 'TkVX');
  assert.ok(!JSON.stringify(sent).includes('T0xE'), 'old bytes never leave the server');
});

test('followups called BEFORE any reply text does not short-circuit (the reply must still come)', async () => {
  const client = fakeClient([
    {
      deltas: [],
      message: { stop_reason: 'tool_use', content: [followupsUse(['Chip'])] },
    },
    {
      deltas: ['The actual reply.'],
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The actual reply.' }] },
    },
  ]);
  const res = fakeRes();
  await streamChat(res, {
    client, system: 'sys', tools: [], executeTool: () => ({}),
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(client.calls.length, 2, 'loop continues until the reply text exists');
  const done = res.events.find((e) => e.event === 'done');
  assert.equal(done.data.reply, 'The actual reply.');
  assert.deepEqual(done.data.followups, ['Chip']);
});
