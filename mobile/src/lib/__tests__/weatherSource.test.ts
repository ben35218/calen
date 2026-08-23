jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@household/weather', () => ({
  geocodePlace: jest.fn(),
  loadWeatherForCoords: jest.fn(),
  loadWeatherForAddress: jest.fn(),
  loadOutlook: jest.fn(),
  loadOutlookForCoords: jest.fn(),
}));
jest.mock('../weather', () => ({ loadForecast: jest.fn(), loadOutlookWeeks: jest.fn() }));
jest.mock('../../api', () => ({ tripsApi: { list: jest.fn() } }));
jest.mock('../e2ee', () => ({ openRecord: jest.fn(async (_type: string, row: unknown) => row) }));
jest.mock('../addons', () => ({ getOwnedAddonIds: jest.fn() }));
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import {
  geocodePlace, loadWeatherForCoords, loadWeatherForAddress, loadOutlookForCoords,
} from '@household/weather';
import { loadForecast } from '../weather';
import { tripsApi } from '../../api';
import { getOwnedAddonIds } from '../addons';
import {
  getWeatherSource, setWeatherSource, sourceLabel,
  loadSourceForecast, loadSourceOutlook, loadPassiveForecast, LiveLocationError,
  isMissingHomeAddressError, applyTripForecast, loadCalendarForecast,
} from '../weatherSource';

const permMock = Location.requestForegroundPermissionsAsync as jest.Mock;
const posMock = Location.getCurrentPositionAsync as jest.Mock;

describe('weather source pref', () => {
  beforeEach(() => (AsyncStorage as any).clear());

  it('defaults to live location', async () => {
    expect(await getWeatherSource()).toEqual({ kind: 'live' });
  });

  it('round-trips home and custom choices', async () => {
    await setWeatherSource({ kind: 'home' });
    expect(await getWeatherSource()).toEqual({ kind: 'home' });
    await setWeatherSource({ kind: 'custom', place: 'Banff, AB, Canada' });
    expect(await getWeatherSource()).toEqual({ kind: 'custom', place: 'Banff, AB, Canada' });
  });

  it('falls back to the default on junk', async () => {
    await (AsyncStorage as any).setItem('hc_weather_source', '{"kind":"custom"}'); // no place
    expect(await getWeatherSource()).toEqual({ kind: 'live' });
  });
});

describe('sourceLabel', () => {
  it('labels each source', () => {
    expect(sourceLabel({ kind: 'live' })).toBe('My Location');
    expect(sourceLabel({ kind: 'home' })).toBe('Home');
    expect(sourceLabel({ kind: 'custom', place: 'Banff, AB, Canada' })).toBe('Banff');
  });
});

describe('loadSourceForecast / loadSourceOutlook', () => {
  it('live: a denied permission throws LiveLocationError("denied")', async () => {
    permMock.mockResolvedValue({ status: 'denied' });
    await expect(loadSourceForecast({ kind: 'live' })).rejects.toThrow(LiveLocationError);
    await expect(loadSourceForecast({ kind: 'live' })).rejects.toMatchObject({ reason: 'denied' });
  });

  it('live: fetches by GPS coords, one fix shared with the outlook', async () => {
    permMock.mockResolvedValue({ status: 'granted' });
    posMock.mockResolvedValue({ coords: { latitude: 43.7, longitude: -79.4 } });
    (loadWeatherForCoords as jest.Mock).mockResolvedValue({ current: {}, forecast: [] });
    (loadOutlookForCoords as jest.Mock).mockResolvedValue({ weeks: [] });

    await loadSourceForecast({ kind: 'live' });
    expect(loadWeatherForCoords).toHaveBeenCalledWith(43.7, -79.4);

    await loadSourceOutlook({ kind: 'live' });
    expect(loadOutlookForCoords).toHaveBeenCalledWith(43.7, -79.4);
    expect(posMock).toHaveBeenCalledTimes(1); // cached fix, not a second prompt
  });

  it('home: delegates to the E2EE-aware home path', async () => {
    (loadForecast as jest.Mock).mockResolvedValue({ current: {}, forecast: [] });
    await loadSourceForecast({ kind: 'home' });
    expect(loadForecast).toHaveBeenCalled();
    expect(loadWeatherForCoords).not.toHaveBeenCalledWith();
  });

  it('custom: geocodes the typed place with the loose place geocoder', async () => {
    (loadWeatherForAddress as jest.Mock).mockResolvedValue({ current: {}, forecast: [] });
    await loadSourceForecast({ kind: 'custom', place: 'Banff, AB, Canada' });
    expect(loadWeatherForAddress).toHaveBeenCalledWith('Banff, AB, Canada', { geocoder: geocodePlace });
  });
});

describe('isMissingHomeAddressError', () => {
  it('recognizes the client-direct throw and the server error body', () => {
    expect(isMissingHomeAddressError(new Error('No home address configured. Add one in Settings.'))).toBe(true);
    expect(isMissingHomeAddressError({ response: { data: { error: 'No home address set' } } })).toBe(true);
  });

  it('rejects every other failure — those get the generic retry message', () => {
    expect(isMissingHomeAddressError(new Error('Network Error'))).toBe(false);
    expect(isMissingHomeAddressError(new LiveLocationError('denied'))).toBe(false);
    expect(isMissingHomeAddressError({ response: { data: { error: 'Geocoding failed' } } })).toBe(false);
    expect(isMissingHomeAddressError(undefined)).toBe(false);
    expect(isMissingHomeAddressError(null)).toBe(false);
  });
});

describe('loadPassiveForecast (day view / assistant)', () => {
  const queryMock = Location.getForegroundPermissionsAsync as jest.Mock;

  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    queryMock.mockReset();
    permMock.mockClear();
    (loadForecast as jest.Mock).mockReset().mockResolvedValue({ current: {}, forecast: [] });
    (loadWeatherForCoords as jest.Mock).mockReset().mockResolvedValue({ current: {}, forecast: [] });
  });

  it('live source + permission already granted: uses GPS weather', async () => {
    queryMock.mockResolvedValue({ status: 'granted' });
    permMock.mockResolvedValue({ status: 'granted' });
    await loadPassiveForecast(); // default source is live
    expect(loadWeatherForCoords).toHaveBeenCalled();
    expect(loadForecast).not.toHaveBeenCalled();
  });

  it('live source without the permission: falls back to home WITHOUT prompting', async () => {
    queryMock.mockResolvedValue({ status: 'undetermined' });
    await loadPassiveForecast();
    expect(loadForecast).toHaveBeenCalled();
    expect(permMock).not.toHaveBeenCalled(); // no permission prompt from a passive surface
    expect(loadWeatherForCoords).not.toHaveBeenCalled();
  });

  it('live fetch failure falls back to home', async () => {
    queryMock.mockResolvedValue({ status: 'granted' });
    permMock.mockResolvedValue({ status: 'granted' });
    (loadWeatherForCoords as jest.Mock).mockRejectedValue(new Error('gps flake'));
    await loadPassiveForecast();
    expect(loadForecast).toHaveBeenCalled();
  });

  it('custom source loads the custom place directly', async () => {
    await setWeatherSource({ kind: 'custom', place: 'Banff' });
    (loadWeatherForAddress as jest.Mock).mockResolvedValue({ current: {}, forecast: [] });
    await loadPassiveForecast();
    expect(loadWeatherForAddress).toHaveBeenCalledWith('Banff', { geocoder: geocodePlace });
    expect(loadForecast).not.toHaveBeenCalled();
  });

  it('propagates the home error when nothing can produce a forecast', async () => {
    queryMock.mockResolvedValue({ status: 'denied' });
    (loadForecast as jest.Mock).mockRejectedValue(new Error('No home address configured'));
    await expect(loadPassiveForecast()).rejects.toThrow('No home address');
  });
});

// ── Trip-aware calendar forecast ────────────────────────────────────────────

const day = (date: string, tempMax: number) => ({
  date, weatherCode: 0, tempMax, tempMin: 10, precipProbability: 0, precipSum: 0,
});
const wx = (days: ReturnType<typeof day>[]) =>
  ({ current: {}, units: {}, forecast: days }) as any;

describe('applyTripForecast', () => {
  const base = wx([day('2026-09-01', 20), day('2026-09-02', 21), day('2026-09-03', 22)]);
  const span = { tripId: 't1', destination: 'Tokyo, Japan', from: '2026-09-02', to: '2026-09-10' };

  it('swaps days inside the trip span for the destination day, tagged with place + tripId', () => {
    const dest = wx([day('2026-09-02', 30), day('2026-09-03', 31)]);
    const out = applyTripForecast(base, [span], { 'Tokyo, Japan': dest });
    expect(out.forecast.map((d) => [d.date, d.tempMax, d.place, d.tripId])).toEqual([
      ['2026-09-01', 20, undefined, undefined],   // before the trip: home day untouched
      ['2026-09-02', 30, 'Tokyo', 't1'],          // trip days: destination weather
      ['2026-09-03', 31, 'Tokyo', 't1'],
    ]);
  });

  it('keeps the home day when the destination has no forecast for that date', () => {
    const dest = wx([day('2026-09-02', 30)]); // nothing for 09-03
    const out = applyTripForecast(base, [span], { 'Tokyo, Japan': dest });
    expect(out.forecast[2]).toEqual(day('2026-09-03', 22));
  });

  it('keeps every home day when the destination fetch failed (null)', () => {
    expect(applyTripForecast(base, [span], { 'Tokyo, Japan': null })).toEqual(base);
  });

  it('no spans: returns the base untouched', () => {
    expect(applyTripForecast(base, [], {})).toBe(base);
  });
});

describe('loadCalendarForecast', () => {
  const listMock = tripsApi.list as jest.Mock;
  const ownedMock = getOwnedAddonIds as jest.Mock;
  const base = wx([day('2026-09-01', 20), day('2026-09-02', 21)]);

  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    await setWeatherSource({ kind: 'home' }); // keep the passive path off GPS
    (loadForecast as jest.Mock).mockReset().mockResolvedValue(base);
    (loadWeatherForAddress as jest.Mock).mockReset();
    listMock.mockReset();
    ownedMock.mockReset().mockResolvedValue(new Set(['trips']));
  });

  it('overlays a dated trip that overlaps the forecast window', async () => {
    listMock.mockResolvedValue({ data: [
      { _id: 'trip-1', destination: 'Tokyo, Japan', startDate: '2026-09-02T00:00:00Z', endDate: '2026-09-08T00:00:00Z' },
    ] });
    (loadWeatherForAddress as jest.Mock).mockResolvedValue(wx([day('2026-09-02', 30)]));

    const out = await loadCalendarForecast();
    expect(loadWeatherForAddress).toHaveBeenCalledWith('Tokyo, Japan', { geocoder: geocodePlace });
    expect(out.forecast[0].place).toBeUndefined();
    expect(out.forecast[1]).toMatchObject({ tempMax: 30, place: 'Tokyo', tripId: 'trip-1' });
  });

  it('ignores destination-less, undated, and non-overlapping trips — no destination fetch', async () => {
    listMock.mockResolvedValue({ data: [
      { startDate: '2026-09-02', endDate: '2026-09-08' }, // no destination
      { destination: 'Oslo, Norway' }, // no dates
      { destination: 'Lima, Peru', startDate: '2026-10-01', endDate: '2026-10-05' },
    ] });
    expect(await loadCalendarForecast()).toEqual(base);
    expect(loadWeatherForAddress).not.toHaveBeenCalled();
  });

  it('locked trips add-on: home forecast, and the trips list is never fetched', async () => {
    ownedMock.mockResolvedValue(new Set());
    expect(await loadCalendarForecast()).toEqual(base);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('fails open to the home forecast when the trip lookup or destination fetch throws', async () => {
    listMock.mockRejectedValue(new Error('offline'));
    expect(await loadCalendarForecast()).toEqual(base);

    listMock.mockResolvedValue({ data: [
      { destination: 'Tokyo, Japan', startDate: '2026-09-01', endDate: '2026-09-08' },
    ] });
    (loadWeatherForAddress as jest.Mock).mockRejectedValue(new Error('geocode down'));
    expect(await loadCalendarForecast()).toEqual(base);
  });
});
