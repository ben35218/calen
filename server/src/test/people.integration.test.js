// Integration tests for the people/contacts server surface (spec:
// features/people-contacts.md). Person CRUD lives in the opaque record store
// (C3b — covered by records.integration.test.js); what this router owns is
// contact IMPORT (vCard parsing) and AI-assisted CLASSIFY. The classify tests
// capture the exact Anthropic payload (prototype stub at the network edge) to
// prove the name+company-only projection: phone/email/birthday merge back
// server-side, unseen by the model, and web-search enrichment runs only with
// the per-import opt-in.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser } = require('./harness');

const Anthropic = require('@anthropic-ai/sdk'); // same instance the route uses

before(startDb);
after(stopDb);

// ---------------------------------------------------------------------------
// Anthropic stub: capture messages.create params, play back scripted responses.
// ---------------------------------------------------------------------------

const createCalls = [];
let createQueue = [];

const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'stub' }).messages);
messagesProto.create = async function stubbedCreate(params) {
  createCalls.push(params);
  const resp = createQueue.shift();
  if (!resp) throw new Error('people stub: model called with no scripted response left');
  return resp;
};

beforeEach(() => {
  createCalls.length = 0;
  createQueue = [];
});

const classifyResponse = (results) => ({
  content: [{ type: 'tool_use', name: 'classify_contacts', input: { results } }],
  usage: { input_tokens: 20, output_tokens: 20 },
});

// ---------------------------------------------------------------------------
// vCard import
// ---------------------------------------------------------------------------

const VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Carol Chen',
  'TEL;TYPE=CELL:+1 555 010 2000',
  'TEL;TYPE=WORK:+1 555 010 2999', // second, labeled phone → multi-value
  'EMAIL;TYPE=HOME:carol@example.com',
  'EMAIL;TYPE=WORK:carol@work.example', // second, labeled email
  'URL;TYPE=WORK:https://carol.example',
  'BDAY:19840215',
  'ADR;TYPE=HOME:;;12 Oak Street;Springfield;IL;62704;USA',
  'NOTE:Loves gardening and long',
  ' walks', // folded continuation line (RFC 6350)
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Nguyen;Bao;;;', // no FN — name assembles from N (given + family)
  'BDAY:1990-06-01',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:No-Year Nelly',
  'BDAY:--0704', // month/day only — not a full date, must be dropped
  'END:VCARD',
].join('\r\n');

test('vCard import parses names, phones, emails, birthdays, addresses, folded notes', async () => {
  const u = await registerUser({ firstName: 'Importer' });

  const res = await request().post('/api/people/import')
    .set('Authorization', u.auth)
    .attach('file', Buffer.from(VCF), 'contacts.vcf');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [carol, bao, nelly] = res.body.contacts;

  assert.equal(carol.name, 'Carol Chen');
  // FN-only vCard: no structured N, so first/last are left for the client to split.
  assert.equal(carol.firstName, undefined);
  assert.equal(carol.lastName, undefined);
  assert.equal(carol.phone, '+1 555 010 2000', 'primary phone is the first TEL');
  assert.equal(carol.email, 'carol@example.com', 'primary email is the first EMAIL');
  // Labeled multi-value fields: every TEL/EMAIL/URL with its TYPE normalized.
  assert.deepEqual(carol.phones, [
    { label: 'mobile', value: '+1 555 010 2000' }, // CELL → mobile
    { label: 'work', value: '+1 555 010 2999' },
  ]);
  assert.deepEqual(carol.emails, [
    { label: 'home', value: 'carol@example.com' },
    { label: 'work', value: 'carol@work.example' },
  ]);
  assert.deepEqual(carol.urls, [{ label: 'work', value: 'https://carol.example' }]);
  assert.equal(carol.birthday, '1984-02-15', 'YYYYMMDD normalizes to dashed');
  assert.equal(carol.address, '12 Oak Street, Springfield, IL, 62704, USA');
  assert.equal(carol.notes, 'Loves gardening and longwalks', 'folded line is unfolded');

  assert.equal(bao.name, 'Bao Nguyen', 'assembled from N when FN is absent');
  // N present → structured first/last (given → first, family → last).
  assert.equal(bao.firstName, 'Bao');
  assert.equal(bao.lastName, 'Nguyen');
  assert.equal(bao.birthday, '1990-06-01', 'dashed birthday passes through');

  assert.equal(nelly.name, 'No-Year Nelly');
  assert.equal(nelly.birthday, '', 'a no-year --MMDD birthday is dropped');
});

test('vCard import rejects a missing file and a file with no contacts', async () => {
  const u = await registerUser({ firstName: 'NoFile' });

  const missing = await request().post('/api/people/import').set('Authorization', u.auth);
  assert.equal(missing.status, 400);

  const empty = await request().post('/api/people/import')
    .set('Authorization', u.auth)
    .attach('file', Buffer.from('not a vcard at all'), 'contacts.vcf');
  assert.equal(empty.status, 422);
});

// ---------------------------------------------------------------------------
// AI-assisted classify
// ---------------------------------------------------------------------------

const contacts = [
  { key: 'a', name: 'Mimi Example', company: '', phone: '+15550104000', email: 'mimi@example.com', birthday: '1955-03-09' },
  { key: 'b', name: 'Jo Plumber', company: 'DrainRight LLC', phone: '+15550105000' },
];

test('classify sends the model names + companies only; contact details merge back server-side', async () => {
  const u = await registerUser({ firstName: 'Classifier' });

  createQueue = [classifyResponse([
    // `interests` is a retired field — even if the model volunteers it, the
    // route must not echo it back.
    { key: 'a', type: 'family', name: 'Mimi Example', relationship: 'grandmother', interests: ['bridge'] },
    { key: 'b', type: 'service', name: 'Jo Plumber', businessName: 'DrainRight LLC', relationship: 'plumber' },
    { key: 'zz-not-sent', type: 'friend', name: 'Phantom' }, // unknown key — must be dropped
  ])];

  const res = await request().post('/api/people/classify')
    .set('Authorization', u.auth)
    .send({ contacts });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // The model saw exactly one call, carrying names + companies and nothing else.
  assert.equal(createCalls.length, 1, 'no enrichment without the opt-in');
  const modelPayload = JSON.stringify(createCalls[0]);
  assert.match(modelPayload, /Mimi Example/);
  assert.match(modelPayload, /DrainRight LLC/);
  for (const secret of ['+15550104000', 'mimi@example.com', '1955-03-09', '+15550105000']) {
    assert.ok(!modelPayload.includes(secret), `"${secret}" must not reach the model`);
  }

  // The response merges the withheld details back from the original request.
  const [mimi, jo] = res.body.results;
  assert.equal(mimi.type, 'family');
  assert.equal(mimi.phone, '+15550104000');
  assert.equal(mimi.email, 'mimi@example.com');
  assert.equal(mimi.birthday, '1955-03-09');
  assert.ok(!('interests' in mimi), 'retired interests field never appears in classify results');
  assert.equal(jo.type, 'service');
  assert.equal(jo.businessName, 'DrainRight LLC');
  assert.equal(jo.phone, '+15550105000');
  assert.equal(res.body.results.length, 2, 'results echo only the keys that were sent');
});

test('classify validates input and coerces unknown types to friend', async () => {
  const u = await registerUser({ firstName: 'Coercer' });

  const bad = await request().post('/api/people/classify')
    .set('Authorization', u.auth).send({ contacts: [] });
  assert.equal(bad.status, 400);

  createQueue = [classifyResponse([{ key: 'a', type: 'alien', name: 'Mimi Example' }])];
  const res = await request().post('/api/people/classify')
    .set('Authorization', u.auth)
    .send({ contacts: [contacts[0]] });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].type, 'friend', 'an unrecognized type falls back to friend');
});

test('web-search enrichment runs only with the per-import opt-in, professionals only', async () => {
  const u = await registerUser({ firstName: 'Enricher' });

  createQueue = [
    classifyResponse([
      { key: 'a', type: 'family', name: 'Mimi Example' },
      { key: 'b', type: 'service', name: 'Jo Plumber', businessName: 'DrainRight LLC' },
    ]),
    // One enrichment call for the single professional.
    {
      content: [{ type: 'tool_use', name: 'business_details', input: { address: '400 Pipe Ave, Springfield', phone: '+15550109000' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  ];

  const res = await request().post('/api/people/classify')
    .set('Authorization', u.auth)
    .send({ contacts, enrich: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(createCalls.length, 2, 'classification + one lookup for the one professional');

  // The lookup is scoped to the business (its saved details), never the family contact.
  const lookupPayload = JSON.stringify(createCalls[1]);
  assert.match(lookupPayload, /DrainRight LLC/);
  assert.match(lookupPayload, /web_search/, 'the lookup carries the web-search tool');
  assert.ok(!lookupPayload.includes('Mimi Example'), 'family contacts never enter the web lookup');

  const jo = res.body.results.find((r) => r.key === 'b');
  assert.equal(jo.address, '400 Pipe Ave, Springfield', 'the found address merges in');
  assert.equal(jo.phone, '+15550109000', 'the found phone merges in');
});
