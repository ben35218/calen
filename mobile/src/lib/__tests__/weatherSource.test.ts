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
import {
  getWeatherSource, setWeatherSource, sourceLabel,
  loadSourceForecast, loadSourceOutlook, loadPassiveForecast, LiveLocationError,
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
