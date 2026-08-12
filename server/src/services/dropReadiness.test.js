const test = require('node:test');
const assert = require('node:assert');
const { computeReadiness, dropUnsetFor, DROP_FIELDS, compareVersions, versionSatisfied } = require('./dropReadiness');

const member = (id, email, pub, clientVersion) => ({ _id: id, email, identityPublicKey: pub, clientVersion });
const env = (userId, keyVersion) => ({ userId, keyVersion });

test('ready when every member is enrolled and holds a current-version envelope', () => {
  const r = computeReadiness({
    members: [member('a', 'a@x', 'PKa'), member('b', 'b@x', 'PKb')],
    envelopes: [env('a', 1), env('b', 1)],
    currentKeyVersion: 1,
  });
  assert.equal(r.ready, true);
  assert.equal(r.reasons.length, 0);
});

test('not ready when a member has not enrolled', () => {
  const r = computeReadiness({
    members: [member('a', 'a@x', 'PKa'), member('b', 'b@x', null)],
    envelopes: [env('a', 1)],
    currentKeyVersion: 1,
  });
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(' '), /b@x has not enrolled/);
});

test('not ready when a member lacks an envelope for the current version', () => {
  const r = computeReadiness({
    members: [member('a', 'a@x', 'PKa'), member('b', 'b@x', 'PKb')],
    envelopes: [env('a', 1), env('b', 1)],
    currentKeyVersion: 2, // rotated; b only has a v1 envelope
  });
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(' '), /no key envelope for v2/);
});

test('not ready when the HDK has never been minted', () => {
  const r = computeReadiness({ members: [member('a', 'a@x', 'PKa')], envelopes: [], currentKeyVersion: 0 });
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(' '), /no HDK yet/);
});

test('compareVersions handles multi-digit segments', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
});

test('versionSatisfied: unset min passes all; unset client fails a set min', () => {
  assert.equal(versionSatisfied('1.0.0', null), true);
  assert.equal(versionSatisfied(null, '1.2.0'), false);
  assert.equal(versionSatisfied('1.2.0', '1.2.0'), true);
  assert.equal(versionSatisfied('1.1.0', '1.2.0'), false);
});

test('min-app-version gate blocks a member on an old app', () => {
  const r = computeReadiness({
    members: [member('a', 'a@x', 'PKa', '1.2.0'), member('b', 'b@x', 'PKb', '1.0.0')],
    envelopes: [env('a', 1), env('b', 1)],
    currentKeyVersion: 1,
    minAppVersion: '1.2.0',
  });
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(' '), /b@x is on app 1\.0\.0 \(needs 1\.2\.0\)/);
});

test('min-app-version gate passes when all members meet it', () => {
  const r = computeReadiness({
    members: [member('a', 'a@x', 'PKa', '1.3.0'), member('b', 'b@x', 'PKb', '1.2.0')],
    envelopes: [env('a', 1), env('b', 1)],
    currentKeyVersion: 1,
    minAppVersion: '1.2.0',
  });
  assert.equal(r.ready, true);
  assert.equal(r.minAppVersion, '1.2.0');
});

test('dropUnsetFor builds a $unset spec from the content field list', () => {
  const unset = dropUnsetFor('Contact');
  assert.deepEqual(Object.keys(unset).sort(), [...DROP_FIELDS.Contact].sort());
  assert.equal(unset.name, '');
  assert.equal(dropUnsetFor('NopeCollection'), null);
});
