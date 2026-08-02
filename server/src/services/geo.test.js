const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { verifyPlaceStatus } = require('./geo');

// geo.js does `const axios = require('axios')`, so overriding axios.post on the
// shared cached module object stubs the network call. apiKey() reads
// process.env at call time, so the key can be toggled per test.
const KEY = 'GOOGLE_PLACES_API_KEY';
function withKey(fn) {
  const prev = process.env[KEY];
  process.env[KEY] = 'test-key';
  return fn().finally(() => { if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev; });
}
function stubOnce(data) {
  const prev = axios.post;
  axios.post = async () => ({ data });
  return () => { axios.post = prev; };
}

test('verifyPlaceStatus: OPERATIONAL maps to operational with name/address/phone', async () => {
  await withKey(async () => {
    const restore = stubOnce({ places: [{
      id: 'abc', displayName: { text: 'Republica Café' },
      formattedAddress: '123 Main St, Ottawa ON', businessStatus: 'OPERATIONAL',
      nationalPhoneNumber: '613-555-0101',
    }] });
    try {
      assert.deepEqual(await verifyPlaceStatus('Republica Café, Ottawa ON'), {
        status: 'operational', name: 'Republica Café',
        address: '123 Main St, Ottawa ON', phone: '613-555-0101', placeId: 'abc',
      });
    } finally { restore(); }
  });
});

test('verifyPlaceStatus: CLOSED_PERMANENTLY maps so the model can drop it', async () => {
  await withKey(async () => {
    const restore = stubOnce({ places: [{ displayName: { text: 'Old Diner' }, businessStatus: 'CLOSED_PERMANENTLY' }] });
    try {
      assert.equal((await verifyPlaceStatus('Old Diner, Ottawa')).status, 'closed_permanently');
    } finally { restore(); }
  });
});

test('verifyPlaceStatus: absent businessStatus is unknown (Google publishes none), not a drop', async () => {
  await withKey(async () => {
    const restore = stubOnce({ places: [{ displayName: { text: 'Corner Shop' } }] });
    try {
      assert.equal((await verifyPlaceStatus('Corner Shop, Ottawa')).status, 'unknown');
    } finally { restore(); }
  });
});

test('verifyPlaceStatus: no match returns not_found', async () => {
  await withKey(async () => {
    const restore = stubOnce({ places: [] });
    try {
      assert.deepEqual(await verifyPlaceStatus('Nowhere at all'), { status: 'not_found' });
    } finally { restore(); }
  });
});

test('verifyPlaceStatus: an API error fails open to null (caller treats as unknown)', async () => {
  await withKey(async () => {
    const prev = axios.post;
    axios.post = async () => { throw new Error('places api down'); };
    try {
      assert.equal(await verifyPlaceStatus('Anywhere'), null);
    } finally { axios.post = prev; }
  });
});

test('verifyPlaceStatus: no API key returns null without calling out', async () => {
  const prev = process.env[KEY];
  delete process.env[KEY];
  try {
    assert.equal(await verifyPlaceStatus('Somewhere'), null);
  } finally { if (prev !== undefined) process.env[KEY] = prev; }
});

test('verifyPlaceStatus: blank query returns null', async () => {
  await withKey(async () => {
    assert.equal(await verifyPlaceStatus(''), null);
  });
});
