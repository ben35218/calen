const test = require('node:test');
const assert = require('node:assert');
const { autocompleteBody } = require('./places');

// `includedPrimaryTypes` filters predictions rather than ranking them, so these
// tests pin which field types may narrow it — an over-narrow list is invisible
// in the UI except as an empty dropdown.

test('an untyped field (business OR address) sets no primary-type filter', () => {
  const body = autocompleteBody({ query: '2571 St Joseph Blvd', biasLat: 45.4, biasLon: -75.6, region: 'CA' });
  assert.equal(body.includedPrimaryTypes, undefined,
    'filtering to establishment would drop every street address');
});

test('an untyped field falls back to the region only when there is no location bias', () => {
  const biased = autocompleteBody({ query: 'beach', biasLat: 45.4, biasLon: -75.6, region: 'CA' });
  assert.equal(biased.includedRegionCodes, undefined);
  assert.ok(biased.locationBias.circle.center.latitude === 45.4);

  const unbiased = autocompleteBody({ query: 'beach', region: 'CA' });
  assert.deepEqual(unbiased.includedRegionCodes, ['CA']);
  assert.equal(unbiased.locationBias, undefined);
});

test('the address field keeps its street-level filter', () => {
  const body = autocompleteBody({ query: '123 Main', type: 'address', region: 'US' });
  assert.deepEqual(body.includedPrimaryTypes, ['street_address', 'route', 'premise', 'subpremise']);
  assert.deepEqual(body.includedRegionCodes, ['US']);
});

test('the business field matches businesses and addresses alike, region-restricted', () => {
  const body = autocompleteBody({ query: 'plumber', type: 'business', region: null });
  assert.equal(body.includedPrimaryTypes, undefined);
  assert.deepEqual(body.includedRegionCodes, ['CA'], 'no country resolved → default region');
});

test('city / airport / transit fields stay narrowed to their own kinds', () => {
  assert.deepEqual(autocompleteBody({ query: 'rome', type: 'city' }).includedPrimaryTypes, ['(cities)']);
  assert.deepEqual(autocompleteBody({ query: 'yow', type: 'airport' }).includedPrimaryTypes, ['airport']);
  const transit = autocompleteBody({ query: 'union', type: 'transit' }).includedPrimaryTypes;
  assert.ok(transit.includes('train_station') && transit.length <= 5, 'max 5 types per the API');
  const addressCity = autocompleteBody({ query: 'ottawa', type: 'addressCity' });
  assert.ok(addressCity.includedPrimaryTypes.includes('locality'));
  assert.equal(addressCity.includedRegionCodes, undefined, 'contacts can live anywhere');
});
