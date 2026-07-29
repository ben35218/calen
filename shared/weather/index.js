// Shared client weather engine (§9.1 P5b).
//
// Pure `buildForecast` + thin open-meteo fetch helpers (keyless + CORS-open, so
// web and mobile can call them directly from the decrypted home coordinates —
// no server, no API key). Mirrors the shape server/services/weather.js returned
// so the weather views render unchanged. Uses the platform global `fetch`
// (browser / React Native / Node 18+).

const WMO_DESCRIPTIONS = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Moderate showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Heavy thunderstorm with hail',
};

function isMowingDay(precipSum, precipProb, prevPrecipSum) {
  return (
    (precipProb ?? 0) < 35 &&
    (precipSum ?? 0) < 3 &&
    (prevPrecipSum ?? 0) < 15
  );
}

// Pure: raw open-meteo forecast JSON -> { current, forecast, units }.
function buildForecast(raw) {
  const { daily, current, hourly, daily_units } = raw;

  const hourlyByDate = {};
  if (hourly) {
    hourly.time.forEach((iso, i) => {
      const date = iso.slice(0, 10);
      if (!hourlyByDate[date]) hourlyByDate[date] = [];
      hourlyByDate[date].push({
        time: iso,
        hour: parseInt(iso.slice(11, 13), 10),
        temperature: hourly.temperature_2m[i],
        precipProbability: hourly.precipitation_probability[i],
        precipitation: hourly.precipitation[i],
        weatherCode: hourly.weather_code[i],
        description: WMO_DESCRIPTIONS[hourly.weather_code[i]] ?? 'Unknown',
      });
    });
  }

  const forecast = daily.time.map((date, i) => {
    const prevPrecip = i > 0 ? daily.precipitation_sum[i - 1] : 0;
    return {
      date,
      weatherCode: daily.weather_code[i],
      description: WMO_DESCRIPTIONS[daily.weather_code[i]] ?? 'Unknown',
      tempMax: daily.temperature_2m_max[i],
      tempMin: daily.temperature_2m_min[i],
      precipSum: daily.precipitation_sum[i],
      precipProbability: daily.precipitation_probability_max[i],
      windMax: daily.wind_speed_10m_max[i],
      goodWeather: isMowingDay(daily.precipitation_sum[i], daily.precipitation_probability_max[i], prevPrecip),
      sunrise: daily.sunrise?.[i],
      sunset: daily.sunset?.[i],
      hours: hourlyByDate[date] ?? [],
    };
  });

  return {
    current: current ? {
      temperature: current.temperature_2m,
      weatherCode: current.weather_code,
      description: WMO_DESCRIPTIONS[current.weather_code] ?? 'Unknown',
      precipitation: current.precipitation,
      humidity: current.relative_humidity_2m,
      windSpeed: current.wind_speed_10m,
    } : null,
    forecast,
    units: {
      temperature: daily_units?.temperature_2m_max ?? '°C',
      precipitation: daily_units?.precipitation_sum ?? 'mm',
      wind: daily_units?.wind_speed_10m_max ?? 'km/h',
    },
  };
}

// Geocode a full street address to coordinates via OpenStreetMap Nominatim
// (keyless + CORS-open). Client-direct (D2 / §9.1 P5b). We can't use open-meteo's
// geocoder here: it only matches place/city names and returns nothing for a full
// home address. Nominatim resolves the full address exactly like the old server
// path (server/services/weather.js). RN fetch sends the User-Agent per Nominatim's
// usage policy; browsers ignore it but send a Referer, which also satisfies it.
const geocodeCache = new Map(); // query -> in-flight/settled promise (dedupes parallel lookups)

async function geocodeNominatim(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HouseholdCalendar/1.0 (household management app)' },
  });
  if (!res.ok) throw new Error('Geocoding failed');
  const data = await res.json();
  const r = data && data[0];
  if (!r) throw new Error('Could not find that location — check your address in Settings');
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon) };
}

// Photon (photon.komoot.io) — also OSM-backed, keyless + CORS-open. Second in
// the chain because Nominatim's full-address matching is stricter; Photon
// covers Nominatim outages and its 1 req/s public rate limit.
async function geocodePhoton(address) {
  const url = `https://photon.komoot.io/api?q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocoding failed');
  const data = await res.json();
  const c = data && data.features && data.features[0] && data.features[0].geometry && data.features[0].geometry.coordinates;
  if (!c) throw new Error('Could not find that location — check your address in Settings');
  return { lat: c[1], lon: c[0] };
}

async function geocode(address) {
  if (geocodeCache.has(address)) return geocodeCache.get(address);
  const p = geocodeNominatim(address).catch((err) =>
    geocodePhoton(address).catch(() => { throw err; }), // surface the primary's message
  );
  geocodeCache.set(address, p);
  p.catch(() => geocodeCache.delete(address)); // don't cache failures
  return p;
}

// Candidate queries for a *place* string (not a street address): the full
// string, then "first, last" comma parts, then just the first part. Google
// Places' verbose admin segments ("Florence, Metropolitan City of Florence,
// Italy") often find nothing in Nominatim; "Florence, Italy" does.
function placeCandidates(place) {
  const parts = place.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [place];
  if (parts.length >= 3) out.push(`${parts[0]}, ${parts[parts.length - 1]}`);
  if (parts.length >= 2) out.push(parts[0]);
  return out;
}

// Geocode a trip-destination-style place, falling back through simplified
// variants. Kept separate from `geocode` so street addresses stay strict (a
// loose match on a home address could silently pick the wrong city).
async function geocodePlace(place) {
  let lastErr;
  for (const c of placeCandidates(place)) {
    try { return await geocode(c); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Country + subdivision for an address, from the same keyless geocoders
// (Nominatim with addressdetails, Photon fallback — the address never touches
// our server). Returns { countryCode: 'CA', state: 'Ontario' } with either
// field possibly null, or null when neither provider matches.
async function regionForAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'HouseholdCalendar/1.0 (household management app)' },
    });
    if (res.ok) {
      const data = await res.json();
      const a = data && data[0] && data[0].address;
      if (a) {
        return {
          countryCode: a.country_code ? a.country_code.toUpperCase() : null,
          state: a.state || a.province || a.state_district || null,
        };
      }
    }
  } catch { /* fall through to Photon */ }
  try {
    const res = await fetch(`https://photon.komoot.io/api?q=${encodeURIComponent(address)}&limit=1`);
    if (res.ok) {
      const data = await res.json();
      const p = data && data.features && data.features[0] && data.features[0].properties;
      if (p) {
        return {
          countryCode: p.countrycode ? p.countrycode.toUpperCase() : null,
          state: p.state || null,
        };
      }
    }
  } catch { /* both failed */ }
  return null;
}

// IANA zone id for coordinates, from open-meteo's `timezone=auto` echo (keyless
// + CORS-open, so an E2EE household resolves its home zone without the address
// ever touching our server). Returns e.g. "America/Toronto", or null.
async function timezoneForCoords(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'auto', forecast_days: '1',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) return null;
  const data = await res.json();
  return (data && typeof data.timezone === 'string' && data.timezone.includes('/')) ? data.timezone : null;
}

// One call: address -> geocode -> IANA zone id (or null — never throws).
async function locationTimezone(address, { geocoder = geocode } = {}) {
  try {
    const { lat, lon } = await geocoder(address);
    return await timezoneForCoords(lat, lon);
  } catch {
    return null;
  }
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code',
    current: 'temperature_2m,weather_code,precipitation,relative_humidity_2m,wind_speed_10m',
    timezone: 'auto',
    forecast_days: '7',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error('Weather fetch failed');
  return res.json();
}

// One call: coords -> forecast -> built shape (e.g. a device GPS fix, which
// needs no geocoding at all).
async function loadWeatherForCoords(lat, lon) {
  const raw = await fetchWeather(lat, lon);
  return buildForecast(raw);
}

// One call: address -> geocode -> forecast -> built shape. Pass
// `geocoder: geocodePlace` for city-style destinations (trips).
async function loadWeatherForAddress(address, { geocoder = geocode } = {}) {
  const { lat, lon } = await geocoder(address);
  return loadWeatherForCoords(lat, lon);
}

// ── Secondary surfaces (§9.1 P5b follow-ups): client-direct range + outlook ──
// Post-drop the server can't read the home address, so the calendar weather
// overlay and the 90-day outlook fetch from the decrypted coords directly. No
// server WeatherRecord cache — each client fetches its own (accepted in D2).

// open-meteo historical archive (past daily observations). Keyless + CORS-open.
async function fetchWeatherArchive(lat, lon, startDate, endDate) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: startDate,
    end_date: endDate,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
    timezone: 'auto',
  });
  const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`);
  if (!res.ok) throw new Error('Weather archive fetch failed');
  return res.json();
}

// Pure: one archive `daily` day -> the calendar record shape (mirrors the
// server WeatherRecord fields the calendar overlay reads).
function archiveDayToRecord(daily, i) {
  const precipSum = daily.precipitation_sum[i] ?? 0;
  const prevPrecip = i > 0 ? (daily.precipitation_sum[i - 1] ?? 0) : 0;
  const weatherCode = daily.weather_code[i];
  return {
    date: daily.time[i],
    weatherCode,
    description: WMO_DESCRIPTIONS[weatherCode] ?? 'Unknown',
    tempMax: daily.temperature_2m_max[i],
    tempMin: daily.temperature_2m_min[i],
    precipSum,
    precipProbability: null,
    windMax: daily.wind_speed_10m_max[i],
    goodWeather: isMowingDay(precipSum, null, prevPrecip),
  };
}

// Pure: assemble the calendar overlay records for [from,to] from an archive
// response (past days) + a built forecast (today onward). Forecast wins on any
// overlapping date. Returns records sorted by date, clipped to [from,to].
function buildRangeRecords({ archiveRaw, forecast, from, to }) {
  const byDate = {};
  if (archiveRaw && archiveRaw.daily && archiveRaw.daily.time) {
    archiveRaw.daily.time.forEach((date, i) => {
      if (date >= from && date <= to) byDate[date] = archiveDayToRecord(archiveRaw.daily, i);
    });
  }
  for (const day of forecast || []) {
    if (day.date >= from && day.date <= to) {
      byDate[day.date] = {
        date: day.date,
        weatherCode: day.weatherCode,
        description: day.description,
        tempMax: day.tempMax,
        tempMin: day.tempMin,
        precipSum: day.precipSum,
        precipProbability: day.precipProbability,
        windMax: day.windMax,
        goodWeather: day.goodWeather,
        hours: day.hours ?? [],
      };
    }
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Orchestration: address -> the calendar overlay `records` for [from,to].
async function loadWeatherRange(address, from, to) {
  const { lat, lon } = await geocode(address);
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const archiveEnd = yesterday < to ? yesterday : to;

  const [archiveRaw, forecastBuilt] = await Promise.all([
    from <= archiveEnd ? fetchWeatherArchive(lat, lon, from, archiveEnd).catch(() => null) : Promise.resolve(null),
    to >= todayStr ? fetchWeather(lat, lon).then(buildForecast).catch(() => null) : Promise.resolve(null),
  ]);
  return { records: buildRangeRecords({ archiveRaw, forecast: forecastBuilt?.forecast, from, to }) };
}

// Pure: roll up the past-N-years archive responses into weekly averages (the
// 90-day seasonal outlook). Mirrors the server /outlook math exactly.
function buildOutlook(archiveResults, { today = new Date(), days = 90 } = {}) {
  const dailyAvg = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const maxTemps = [], minTemps = [], precips = [];
    for (const ar of archiveResults) {
      if (!ar || !ar.daily || i >= ar.daily.time.length) continue;
      if (ar.daily.temperature_2m_max[i] != null) maxTemps.push(ar.daily.temperature_2m_max[i]);
      if (ar.daily.temperature_2m_min[i] != null) minTemps.push(ar.daily.temperature_2m_min[i]);
      if (ar.daily.precipitation_sum[i] != null) precips.push(ar.daily.precipitation_sum[i]);
    }
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    dailyAvg.push({
      date: date.toISOString().slice(0, 10),
      avgTempMax: avg(maxTemps),
      avgTempMin: avg(minTemps),
      avgPrecip: avg(precips),
    });
  }

  const weeks = [];
  for (let w = 0; w < Math.ceil(days / 7); w++) {
    const slice = dailyAvg.slice(w * 7, (w + 1) * 7).filter((d) => d.avgTempMax != null);
    if (!slice.length) break;
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    weeks.push({
      startDate: slice[0].date,
      endDate: slice[slice.length - 1].date,
      avgTempMax: Math.round(avg(slice.map((d) => d.avgTempMax))),
      avgTempMin: Math.round(avg(slice.map((d) => d.avgTempMin))),
      totalPrecip: Math.round(slice.reduce((a, d) => a + (d.avgPrecip ?? 0), 0) * 10) / 10,
      rainyDays: slice.filter((d) => (d.avgPrecip ?? 0) >= 1).length,
      yearsInSample: archiveResults.length,
    });
  }
  return { weeks };
}

// Pure: per-day historical averages for a date list, from archive responses
// covering the same span in past years (index-aligned, like buildOutlook).
// Powers the trip "typical weather" view.
function buildDailyClimate(archiveResults, { dates }) {
  return dates.map((date, i) => {
    const maxs = [], mins = [], precips = [];
    for (const ar of archiveResults) {
      if (!ar || !ar.daily || i >= ar.daily.time.length) continue;
      if (ar.daily.temperature_2m_max[i] != null) maxs.push(ar.daily.temperature_2m_max[i]);
      if (ar.daily.temperature_2m_min[i] != null) mins.push(ar.daily.temperature_2m_min[i]);
      if (ar.daily.precipitation_sum[i] != null) precips.push(ar.daily.precipitation_sum[i]);
    }
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return {
      date,
      avgTempMax: maxs.length ? Math.round(avg(maxs)) : null,
      avgTempMin: mins.length ? Math.round(avg(mins)) : null,
      avgPrecip: precips.length ? Math.round(avg(precips) * 10) / 10 : null,
      rainYears: precips.filter((p) => p >= 1).length,
      yearsInSample: precips.length,
    };
  });
}

// Orchestration: address + date range -> per-day averages across the same
// dates in the past `years` years (e.g. a trip's typical weather).
async function loadDailyClimate(address, from, to, { years = 3, geocoder = geocode } = {}) {
  const { lat, lon } = await geocoder(address);
  const shift = (iso, y) => {
    const d = new Date(iso + 'T12:00:00');
    d.setFullYear(d.getFullYear() - y);
    return d.toISOString().slice(0, 10);
  };
  const archiveResults = (
    await Promise.all(
      Array.from({ length: years }, (_, k) => k + 1).map((y) =>
        fetchWeatherArchive(lat, lon, shift(from, y), shift(to, y)).catch(() => null),
      ),
    )
  ).filter(Boolean);
  const dates = [];
  const d = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return { days: buildDailyClimate(archiveResults, { dates }) };
}

// Orchestration: coords -> 90-day seasonal outlook (averages the same window
// across the past 3 years).
async function loadOutlookForCoords(lat, lon, { today = new Date(), days = 90 } = {}) {
  const archiveResults = (
    await Promise.all(
      [1, 2, 3].map((yearsAgo) => {
        const start = new Date(today); start.setFullYear(start.getFullYear() - yearsAgo);
        const end = new Date(today); end.setDate(end.getDate() + days - 1); end.setFullYear(end.getFullYear() - yearsAgo);
        return fetchWeatherArchive(lat, lon, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)).catch(() => null);
      }),
    )
  ).filter(Boolean);
  return buildOutlook(archiveResults, { today, days });
}

// Address wrapper over loadOutlookForCoords. Pass `geocoder: geocodePlace`
// for city-style places.
async function loadOutlook(address, { today = new Date(), days = 90, geocoder = geocode } = {}) {
  const { lat, lon } = await geocoder(address);
  return loadOutlookForCoords(lat, lon, { today, days });
}

module.exports = {
  WMO_DESCRIPTIONS, isMowingDay, buildForecast, geocode, geocodePlace, placeCandidates, fetchWeather, loadWeatherForAddress,
  timezoneForCoords, locationTimezone, regionForAddress, loadWeatherForCoords,
  fetchWeatherArchive, buildRangeRecords, loadWeatherRange, buildOutlook, loadOutlook, loadOutlookForCoords,
  buildDailyClimate, loadDailyClimate,
};
