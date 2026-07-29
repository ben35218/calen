const axios = require('axios');

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

// Google Geocoding when the Places key is configured (typo-tolerant, no rate
// cap that matters at our volume), falling back to keyless Nominatim — which
// also remains the whole chain when no key is set.
async function geocodeGoogle(address) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key },
      timeout: 8000,
    });
    const loc = data.status === 'OK' && data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lon: loc.lng } : null;
  } catch {
    return null; // key lacks the Geocoding API / transient — fall through
  }
}

async function geocodeAddress(address) {
  const viaGoogle = await geocodeGoogle(address);
  if (viaGoogle) return viaGoogle;
  const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: address, format: 'json', limit: 1 },
    headers: { 'User-Agent': 'HouseholdCalendar/1.0 (household management app)' },
    timeout: 8000,
  });
  if (!data.length) throw new Error('Could not geocode home address — check that your address in Settings is complete');
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function fetchWeatherArchive(lat, lon, startDate, endDate) {
  const { data } = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
    params: {
      latitude: lat,
      longitude: lon,
      start_date: startDate,
      end_date: endDate,
      daily: [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_sum',
        'wind_speed_10m_max',
      ].join(','),
      timezone: 'auto',
    },
    timeout: 20000,
  });
  return data;
}

async function fetchWeather(lat, lon) {
  const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude: lat,
      longitude: lon,
      daily: [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_sum',
        'precipitation_probability_max',
        'wind_speed_10m_max',
        'sunrise',
        'sunset',
      ].join(','),
      hourly: [
        'temperature_2m',
        'precipitation_probability',
        'precipitation',
        'weather_code',
      ].join(','),
      current: [
        'temperature_2m',
        'weather_code',
        'precipitation',
        'relative_humidity_2m',
        'wind_speed_10m',
      ].join(','),
      timezone: 'auto',
      forecast_days: 7,
    },
    timeout: 8000,
  });
  return data;
}

function isMowingDay(precipSum, precipProb, prevPrecipSum) {
  return (
    (precipProb ?? 0) < 35 &&
    (precipSum ?? 0) < 3 &&
    (prevPrecipSum ?? 0) < 15
  );
}

function buildForecast(raw) {
  const { daily, current, hourly, daily_units } = raw;

  // Group hourly readings by date ('yyyy-MM-dd')
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
      goodWeather: isMowingDay(
        daily.precipitation_sum[i],
        daily.precipitation_probability_max[i],
        prevPrecip
      ),
      sunrise: daily.sunrise?.[i],
      sunset: daily.sunset?.[i],
      hours: hourlyByDate[date] ?? [],
    };
  });

  return {
    current: {
      temperature: current.temperature_2m,
      weatherCode: current.weather_code,
      description: WMO_DESCRIPTIONS[current.weather_code] ?? 'Unknown',
      precipitation: current.precipitation,
      humidity: current.relative_humidity_2m,
      windSpeed: current.wind_speed_10m,
    },
    forecast,
    units: {
      temperature: daily_units?.temperature_2m_max ?? '°C',
      precipitation: daily_units?.precipitation_sum ?? 'mm',
      wind: daily_units?.wind_speed_10m_max ?? 'km/h',
    },
  };
}

module.exports = { WMO_DESCRIPTIONS, isMowingDay, geocodeAddress, fetchWeather, fetchWeatherArchive, buildForecast };
