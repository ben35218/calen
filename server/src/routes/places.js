const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { mapsGuard } = require('../middleware/usageMeter');
const { routeLeg } = require('../services/geo');
const TravelLeg = require('../models/TravelLeg');

const router = express.Router();
router.use(requireAuth);
// Maps is unlimited on every tier; this only caps runaway per-household volume.
router.use(mapsGuard());

const BASE = 'https://places.googleapis.com/v1';
const LEG_FRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Build the Places (New) autocomplete request body for a query + field `type`.
// `includedPrimaryTypes` is a *filter*, not a ranking hint: a type list drops
// every prediction outside it, so a field that accepts more than one kind of
// place must either widen the list or omit it entirely.
function autocompleteBody({ query, type, biasLat, biasLon, region }) {
  const hasCoords = Number.isFinite(biasLat) && Number.isFinite(biasLon);
  const body = { input: query };
  if (hasCoords) {
    // 50 km is the API's max circle radius — roughly "my metro area".
    body.locationBias = { circle: { center: { latitude: biasLat, longitude: biasLon }, radius: 50000 } };
  }
  if (type === 'address') {
    body.includedPrimaryTypes = ['street_address', 'route', 'premise', 'subpremise'];
    body.includedRegionCodes = [region ?? 'CA'];
  } else if (type === 'addressCity') {
    // Contacts whose home we may only know to the city: precise street
    // addresses *and* localities, so an address can be as coarse as a city.
    // (locality is a Table-A type, so it mixes with the street types — unlike
    // the "(cities)" collection, which can't be combined.) No region filter —
    // contacts can live anywhere; the location bias still favours nearby.
    body.includedPrimaryTypes = ['street_address', 'route', 'premise', 'subpremise', 'locality'];
  } else if (type === 'city') {
    // Cities worldwide (no region restriction) for trip destinations
    body.includedPrimaryTypes = ['(cities)'];
  } else if (type === 'airport') {
    body.includedPrimaryTypes = ['airport'];
  } else if (type === 'transit') {
    // Train stations, ferry terminals, etc. for rail/sea journeys (max 5 types)
    body.includedPrimaryTypes = ['train_station', 'transit_station', 'subway_station', 'light_rail_station', 'ferry_terminal'];
  } else if (type === 'business') {
    // Service contacts: match both businesses and street addresses (no
    // primary-type filter so a plumber name *or* an address resolves).
    body.includedRegionCodes = [region ?? 'CA'];
  } else {
    // Untyped — the "search for a business or address" fields (an event's
    // Location, a trip item's location). Both kinds must resolve, so there is
    // NO primary-type filter: the old `['establishment']` list made businesses
    // the only thing that could ever match, and typing a street address
    // returned an empty dropdown.
    // No coords to bias with — restricting to the user's country is the
    // only locality signal left (keeps "beach" from resolving to India).
    if (!hasCoords && region) body.includedRegionCodes = [region];
  }
  return body;
}

router.get('/autocomplete', async (req, res) => {
  const { query, type, lat, lon, country } = req.query;
  if (!query || query.trim().length < 2) return res.json({ predictions: [] });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google Places API key not configured' });

  // Bias results toward the household's locale so a generic query ("beach")
  // ranks nearby places over globally prominent ones. Coords come from the
  // client (post-drop the server can't read the encrypted home location) or,
  // pre-drop, from the plaintext coords the weather geocoder caches on the
  // household. The client's holiday-calendar country is the coarse fallback.
  const hh = req.household || req.user;
  const qLat = Number(lat);
  const qLon = Number(lon);
  const biasLat = Number.isFinite(qLat) ? qLat : hh?.lat;
  const biasLon = Number.isFinite(qLon) ? qLon : hh?.lon;
  const region = typeof country === 'string' && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;

  try {
    const body = autocompleteBody({ query, type, biasLat, biasLon, region });

    const { data } = await axios.post(
      `${BASE}/places:autocomplete`,
      body,
      { headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' } },
    );

    const predictions = (data.suggestions ?? [])
      .map(s => s.placePrediction)
      .filter(Boolean)
      .map(p => ({
        place_id:       p.placeId,
        description:    p.text?.text ?? '',
        main_text:      p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        secondary_text: p.structuredFormat?.secondaryText?.text ?? '',
      }));

    res.json({ predictions });
  } catch (err) {
    console.error('[Places] error:', err.response?.data ?? err.message);
    res.status(500).json({ error: err.response?.data?.error?.message ?? err.message });
  }
});

router.get('/details/:placeId', async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google Places API key not configured' });

  try {
    const { data } = await axios.get(
      `${BASE}/places/${req.params.placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'formattedAddress,nationalPhoneNumber,internationalPhoneNumber,displayName',
        },
      },
    );

    res.json({
      result: {
        formatted_address:         data.formattedAddress,
        formatted_phone_number:    data.nationalPhoneNumber,
        international_phone_number: data.internationalPhoneNumber,
        name: data.displayName?.text,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message ?? err.message });
  }
});

// Resolve the IANA timezone (e.g. "Europe/Rome") for a place — used to
// auto-populate a trip's destination timezone label.
router.get('/timezone/:placeId', async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google Places API key not configured' });

  try {
    const { data: place } = await axios.get(
      `${BASE}/places/${req.params.placeId}`,
      { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'location' } },
    );
    const loc = place.location;
    if (!loc) return res.status(404).json({ error: 'No location for place' });

    const { data: tz } = await axios.get(
      'https://maps.googleapis.com/maps/api/timezone/json',
      {
        params: {
          location: `${loc.latitude},${loc.longitude}`,
          timestamp: Math.floor(Date.now() / 1000),
          key: apiKey,
        },
      },
    );
    if (tz.status !== 'OK') return res.status(502).json({ error: tz.status || 'Timezone lookup failed' });

    res.json({ timeZoneId: tz.timeZoneId, timeZoneName: tz.timeZoneName });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message ?? err.message });
  }
});

// Event travel time: origin → destination for a chosen mode. Drive/walk/bike
// go through the Routes API (traffic-aware where it applies); transit through
// the Directions API with `departureTime` (the event's start) so the estimate
// reflects the schedule around the event, not whenever the form happened to
// recompute.
const EVENT_TRAVEL_MODES = new Set(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT']);

router.get('/travel-time', async (req, res) => {
  const { destination, origin, departureTime } = req.query;
  if (!destination) return res.status(400).json({ error: 'destination required' });

  const mode = String(req.query.mode || 'DRIVE').toUpperCase();
  if (!EVENT_TRAVEL_MODES.has(mode)) return res.status(400).json({ error: 'Unsupported travel mode' });

  if (!process.env.GOOGLE_PLACES_API_KEY) return res.status(503).json({ error: 'Google Places API key not configured' });

  const homeAddress = origin?.trim() || (req.household || req.user).homeAddress;
  if (!homeAddress) return res.status(400).json({ error: 'No starting address — set one in Settings or type it in the From field' });

  const result = await routeLeg({
    origin:      { address: homeAddress },
    destination: { address: destination },
    mode,
    departureTime,
  });
  if (!result) {
    // Transit has real coverage gaps (Google doesn't license schedules
    // everywhere), so name the mode instead of a generic failure.
    return res.status(404).json({
      error: mode === 'TRANSIT' ? 'No transit route found between these locations' : 'No route found',
    });
  }

  res.json({ minutes: result.minutes, distanceKm: result.distanceKm.toFixed(1) });
});

// Travel time between two bookings (cached). Body: originPlaceId/originAddress,
// destPlaceId/destAddress, mode. Returns { minutes, distanceKm }.
router.post('/route-leg', async (req, res) => {
  const { originPlaceId, originAddress, destPlaceId, destAddress, mode = 'DRIVE', departureTime } = req.body || {};
  const originKey = originPlaceId ? `place:${originPlaceId}` : (originAddress ? `addr:${originAddress.toLowerCase().trim()}` : null);
  const destKey   = destPlaceId   ? `place:${destPlaceId}`   : (destAddress   ? `addr:${destAddress.toLowerCase().trim()}`   : null);
  if (!originKey || !destKey) return res.status(400).json({ error: 'origin and destination required' });
  if (originKey === destKey) return res.json({ minutes: 0, distanceKm: 0, sameLocation: true });

  try {
    const cached = await TravelLeg.findOne({ originKey, destKey, mode }).lean();
    if (cached && Date.now() - new Date(cached.computedAt).getTime() < LEG_FRESH_MS) {
      return res.json({ minutes: cached.minutes, distanceKm: cached.distanceKm, cached: true });
    }

    const result = await routeLeg({
      origin:      { placeId: originPlaceId, address: originAddress },
      destination: { placeId: destPlaceId,   address: destAddress },
      mode,
      departureTime,
    });
    // No route (e.g. no transit service / coverage) — 200 so it isn't a console error.
    if (!result) return res.json({ minutes: null, distanceKm: null, error: 'no_route' });

    await TravelLeg.findOneAndUpdate(
      { originKey, destKey, mode },
      { minutes: result.minutes, distanceKm: result.distanceKm, computedAt: new Date() },
      { upsert: true },
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy a Google Maps image (Static Maps or Street View) so the API key stays
// server-side and the app can load it in an <Image>. `kind` picks the endpoint.
// Location is an address string (`q`) or lat/lng. Returns the image bytes, or
// 404 when Street View has no panorama (return_error_code) so the client can
// hide the thumbnail.
async function proxyMapImage(kind, req, res) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google Maps API key not configured' });

  const { q, lat, lng } = req.query;
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  const location = hasCoords ? `${Number(lat)},${Number(lng)}` : (typeof q === 'string' ? q.trim() : '');
  if (!location) return res.status(400).json({ error: 'q or lat/lng required' });

  // Cap the requested size to Google's free-tier limits (640×640 before scale).
  const w = Math.min(Math.max(parseInt(req.query.w, 10) || 600, 100), 640);
  const h = Math.min(Math.max(parseInt(req.query.h, 10) || 300, 100), 640);

  let url;
  if (kind === 'streetview') {
    url = `https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}`
      + `&location=${encodeURIComponent(location)}&fov=80&return_error_code=true&key=${apiKey}`;
  } else {
    const zoom = Math.min(Math.max(parseInt(req.query.zoom, 10) || 15, 1), 20);
    url = `https://maps.googleapis.com/maps/api/staticmap?size=${w}x${h}&scale=2&zoom=${zoom}`
      + `&center=${encodeURIComponent(location)}`
      + `&markers=${encodeURIComponent(`color:red|${location}`)}&key=${apiKey}`;
  }

  try {
    const img = await axios.get(url, { responseType: 'arraybuffer' });
    res.setHeader('Content-Type', img.headers['content-type'] || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(img.data));
  } catch (err) {
    // Street View with no panorama returns 404 (return_error_code); pass it
    // through so the client hides the thumbnail rather than showing a placeholder.
    const status = err.response?.status || 500;
    res.status(status === 404 ? 404 : 502).json({ error: 'map image unavailable' });
  }
}

router.get('/staticmap', (req, res) => proxyMapImage('staticmap', req, res));
router.get('/streetview', (req, res) => proxyMapImage('streetview', req, res));

module.exports = router;
module.exports.autocompleteBody = autocompleteBody;
