const test = require('node:test');
const assert = require('node:assert');
const { RESPONSE_FORMAT_NOTE, buildCachedSystem, toApiContent } = require('./chatStream');

// The mobile app renders assistant replies as plain text (no markdown-table
// support), so every chat surface's system prompt must steer the model off
// tables. See specs/features/ai-assistant.md ("Plain-text replies, no tables").

test('RESPONSE_FORMAT_NOTE forbids markdown tables and offers a line-oriented alternative', () => {
  assert.match(RESPONSE_FORMAT_NOTE, /never use them/i);
  assert.match(RESPONSE_FORMAT_NOTE, /table/i);
  // Points the model at the flattener-friendly formats instead.
  assert.match(RESPONSE_FORMAT_NOTE, /bulleted list|Label: value/i);
});

test('buildCachedSystem appends the format note to a string system prompt', () => {
  const blocks = buildCachedSystem('You are Calen.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.ok(blocks[0].text.startsWith('You are Calen.'));
  assert.ok(
    blocks[0].text.endsWith(RESPONSE_FORMAT_NOTE),
    'note is appended to the end of the system prompt',
  );
});

test('buildCachedSystem passes non-string / empty system through unchanged', () => {
  const prebuilt = [{ type: 'text', text: 'x' }];
  assert.strictEqual(buildCachedSystem(prebuilt), prebuilt);
  assert.strictEqual(buildCachedSystem(''), '');
  assert.strictEqual(buildCachedSystem(undefined), undefined);
});

// Only the latest user message carries raw attachment bytes — older
// attachments are replaced with a text note so they aren't re-uploaded (and
// re-tokenized) on every turn. See specs/features/ai-assistant.md.

const imageMsg = {
  role: 'user',
  content: 'what is this?',
  attachments: [{ kind: 'image', name: 'photo.jpg', type: 'image/jpeg', data: 'aGVsbG8=' }],
};

test('toApiContent keeps raw attachment bytes on the latest user message', () => {
  const blocks = toApiContent(imageMsg, true);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.data, 'aGVsbG8=');
  assert.deepEqual(blocks[1], { type: 'text', text: 'what is this?' });
});

test('toApiContent replaces historical attachments with a text note (no base64)', () => {
  const blocks = toApiContent(imageMsg, false);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /photo\.jpg/);
  assert.match(blocks[0].text, /sent earlier/i);
  assert.ok(!JSON.stringify(blocks).includes('aGVsbG8='), 'no attachment bytes survive');
  assert.deepEqual(blocks[1], { type: 'text', text: 'what is this?' });
});

test('toApiContent leaves text-only messages untouched either way', () => {
  const msg = { role: 'user', content: 'plain text' };
  assert.equal(toApiContent(msg, true), 'plain text');
  assert.equal(toApiContent(msg, false), 'plain text');
});
