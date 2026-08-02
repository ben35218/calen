const axios = require('axios');

// Shared Google Places / Time Zone helpers. Mirrors the logic in routes/places.js
// but exposed as functions so the trip confirmation extractor can resolve an
// airport/station name into a place + IANA timezone server-side.

const BASE = 'https://places.googleapis.com/v1';
const apiKey = () => process.env.GOOGLE_PLACES_API_KEY;

const TRANSIT_TYPES = ['train_station', 'transit_station', 'subway_station', 'light_rail_station', 'ferry_terminal'];

// Best-match place for a free-text query, optionally restricted by kind.
async function searchPlace(query, kind) {
  if (!query || !apiKey()) return null;
  const body = { input: query };
  if (kind === 'airport') body.includedPrimaryTypes = ['airport'];
  else if (kind === 'transit') body.includedPrimaryTypes = TRANSIT_TYPES;

  try {
    const { data } = await axios.post(`${BASE}/places:autocomplete`, body, {
      headers: { 'X-Goog-Api-Key': apiKey(), 'Content-Type': 'application/json' },
    });
    const p = (data.suggestions ?? []).map(s => s.placePrediction).filter(Boolean)[0];
    if (!p) return null;
    return { placeId: p.placeId, description: p.text?.text ?? query };
  } catch {
    return null;
  }
}

// Google's Places (New) businessStatus enum → the lowercase status the chat
// assistant reasons over. Unknown/absent status means "not published" (Google
// only returns businessStatus when it knows one), which we surface as
// 'unknown' so the model doesn't wrongly drop a place we simply couldn't vet.
const BUSINESS_STATUS = {
  OPERATIONAL: 'operational',
  CLOSED_TEMPORARILY: 'closed_temporarily',
  CLOSED_PERMANENTLY: 'closed_permanently',
};

// Resolve a free-text business/venue query ("Republica Café, Ottawa ON") to its
// best Google match and current operating status, so the assistant can vet a
// recommendation before making it (spec: ai-assistant.md — Place verification).
// Text Search returns businessStatus for the top match in a single call — no
// separate details lookup. Biased to the household's area when coords are known
// (mirrors routes/places.js). Returns:
//   { status, name, address, phone, placeId } on a match (status one of
//     operational / closed_temporarily / closed_permanently / unknown),
//   { status: 'not_found' } when Google returns no match,
//   null on a missing key or API error (caller decides how to fail — chat fails
//     open to 'unknown' so an outage never suppresses good suggestions).
async function verifyPlaceStatus(query, { lat, lon } = {}) {
  if (!query || !apiKey()) return null;
  const body = { textQuery: String(query), maxResultCount: 1 };
  const qLat = Number(lat);
  const qLon = Number(lon);
  if (Number.isFinite(qLat) && Number.isFinite(qLon)) {
    // 50 km circle — the API max, roughly "my metro area".
    body.locationBias = { circle: { center: { latitude: qLat, longitude: qLon }, radius: 50000 } };
  }
  try {
    const { data } = await axios.post(`${BASE}/places:searchText`, body, {
      headers: {
        'X-Goog-Api-Key': apiKey(),
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.businessStatus,places.nationalPhoneNumber',
      },
    });
    const p = (data.places ?? [])[0];
    if (!p) return { status: 'not_found' };
    return {
      status: BUSINESS_STATUS[p.businessStatus] || 'unknown',
      name: p.displayName?.text ?? null,
      address: p.formattedAddress ?? null,
      phone: p.nationalPhoneNumber ?? null,
      placeId: p.id ?? null,
    };
  } catch (err) {
    console.error('[verifyPlaceStatus] error:', err.response?.data?.error?.message ?? err.message);
    return null;
  }
}

// IANA timezone id (e.g. "Europe/Rome") for a placeId, or null.
async function placeTimezone(placeId) {
  if (!placeId || !apiKey()) return null;
  try {
    const { data: place } = await axios.get(`${BASE}/places/${placeId}`, {
      headers: { 'X-Goog-Api-Key': apiKey(), 'X-Goog-FieldMask': 'location' },
    });
    const loc = place.location;
    if (!loc) return null;
    const { data: tz } = await axios.get('https://maps.googleapis.com/maps/api/timezone/json', {
      params: { location: `${loc.latitude},${loc.longitude}`, timestamp: Math.floor(Date.now() / 1000), key: apiKey() },
    });
    return tz.status === 'OK' ? tz.timeZoneId : null;
  } catch {
    return null;
  }
}

// Resolve a free-text endpoint into { placeId, description, tz }, or null.
async function resolvePlaceWithTz(query, kind) {
  const place = await searchPlace(query, kind);
  if (!place) return null;
  const tz = await placeTimezone(place.placeId);
  return { ...place, tz };
}

// Pick a valid transit departureTime within Google's schedule-coverage window.
// If the trip date is too far out (or in the past), advance from "now" to the
// next date with the same UTC weekday + time-of-day as the trip's departure.
function transitDeparture(iso) {
  const now = Date.now();
  const HORIZON = now + 6 * 24 * 60 * 60 * 1000; // ~6 days
  if (iso) {
    const t = new Date(iso).getTime();
    if (!Number.isNaN(t)) {
      if (t >= now && t <= HORIZON) return new Date(t).toISOString();
      const tgt = new Date(t);
      const cand = new Date(now);
      cand.setUTCHours(tgt.getUTCHours(), tgt.getUTCMinutes(), 0, 0);
      let guard = 0;
      while ((cand.getTime() <= now + 60000 || cand.getUTCDay() !== tgt.getUTCDay()) && guard < 14) {
        cand.setUTCDate(cand.getUTCDate() + 1);
        guard++;
      }
      if (cand.getTime() > now) return cand.toISOString();
    }
  }
  return new Date(now + 60000).toISOString();
}

// Transit via the Directions API (better transit coverage than the Routes API).
// Note: Google does not license transit data for some regions (e.g. Japan), where
// it returns ZERO_RESULTS → null. origin/destination: { placeId } or { address }.
async function directionsTransit({ origin, destination, departureTime }) {
  if (!apiKey()) return null;
  const ref = (o) => (o.placeId ? `place_id:${o.placeId}` : (o.address || null));
  const o = ref(origin);
  const d = ref(destination);
  if (!o || !d) return null;
  const departure_time = Math.floor(new Date(transitDeparture(departureTime)).getTime() / 1000);

  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: { origin: o, destination: d, mode: 'transit', departure_time, key: apiKey() },
    });
    if (data.status !== 'OK') {
      if (data.status !== 'ZERO_RESULTS') console.error('[directionsTransit]', data.status, data.error_message || '');
      return null;
    }
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) return null;
    return {
      minutes: Math.ceil((leg.duration?.value ?? 0) / 60),
      distanceKm: Math.round(((leg.distance?.value ?? 0) / 1000) * 10) / 10,
    };
  } catch (err) {
    console.error('[directionsTransit] error:', err.response?.data?.error_message ?? err.message);
    return null;
  }
}

// Travel time between two endpoints. Driving/walking use the Routes API
// (traffic-aware); transit uses the Directions API. Returns { minutes, distanceKm } or null.
async function routeLeg({ origin, destination, mode = 'DRIVE', departureTime }) {
  if (!apiKey() || !origin || !destination) return null;
  if (mode === 'TRANSIT') return directionsTransit({ origin, destination, departureTime });

  const ref = (o) => (o.placeId ? { placeId: o.placeId } : (o.address ? { address: o.address } : null));
  const o = ref(origin);
  const d = ref(destination);
  if (!o || !d) return null;

  const body = { origin: o, destination: d, travelMode: mode };
  // routingPreference (traffic-aware) is only valid for driving modes.
  if (mode === 'DRIVE' || mode === 'TWO_WHEELER') body.routingPreference = 'TRAFFIC_AWARE';

  try {
    const { data } = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      body,
      {
        headers: {
          'X-Goog-Api-Key': apiKey(),
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
          'Content-Type': 'application/json',
        },
      },
    );
    const route = data.routes?.[0];
    if (!route) return null;
    const minutes = Math.ceil(parseInt(route.duration, 10) / 60);
    const distanceKm = Math.round(((route.distanceMeters ?? 0) / 1000) * 10) / 10;
    return { minutes, distanceKm };
  } catch (err) {
    console.error('[routeLeg] error:', err.response?.data?.error?.message ?? err.message);
    return null;
  }
}

module.exports = { searchPlace, verifyPlaceStatus, placeTimezone, resolvePlaceWithTz, routeLeg };
