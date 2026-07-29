jest.mock('../../api', () => ({ settingsApi: { get: jest.fn() } }));
jest.mock('../e2ee', () => ({ getHDK: () => null, openRecord: jest.fn() }));
jest.mock('@household/weather', () => ({ regionForAddress: jest.fn() }));

import { regionForAddress } from '@household/weather';
import { settingsApi } from '../../api';
import { matchRegionName, detectHomeRegion } from '../homeRegion';

const regionMock = regionForAddress as jest.Mock;
const settingsGet = settingsApi.get as jest.Mock;

beforeEach(() => {
  regionMock.mockReset();
  settingsGet.mockReset();
});

describe('matchRegionName', () => {
  it('matches a subdivision to its REGIONS entry', () => {
    expect(matchRegionName('CA', 'Ontario')).toBe('Ontario');
    expect(matchRegionName('US', 'California')).toBe('California');
    expect(matchRegionName('GB', 'England')).toBe('England');
  });

  it('tolerates the "&"/"and" split', () => {
    expect(matchRegionName('CA', 'Newfoundland and Labrador')).toBe('Newfoundland & Labrador');
  });

  it('is case-insensitive and returns undefined for unknowns', () => {
    expect(matchRegionName('CA', 'ontario')).toBe('Ontario');
    expect(matchRegionName('CA', 'Bavaria')).toBeUndefined();
    expect(matchRegionName('CA', null)).toBeUndefined();
    expect(matchRegionName('CA')).toBeUndefined();
  });
});

describe('detectHomeRegion', () => {
  it('maps a geocoded address to country + region', async () => {
    regionMock.mockResolvedValue({ countryCode: 'CA', state: 'Ontario' });
    expect(await detectHomeRegion('123 Main St, Toronto')).toEqual({ country: 'CA', region: 'Ontario' });
  });

  it('returns the country alone when the subdivision is unknown', async () => {
    regionMock.mockResolvedValue({ countryCode: 'CA', state: 'Somewhereshire' });
    expect(await detectHomeRegion('somewhere')).toEqual({ country: 'CA', region: undefined });
  });

  it('returns null for countries without a holiday catalog', async () => {
    regionMock.mockResolvedValue({ countryCode: 'DE', state: 'Bayern' });
    expect(await detectHomeRegion('München')).toBeNull();
  });

  it('returns null (without geocoding) when no address is saved', async () => {
    settingsGet.mockResolvedValue({ data: { homeAddress: '' } });
    expect(await detectHomeRegion()).toBeNull();
    expect(regionMock).not.toHaveBeenCalled();
  });

  it('falls back to the saved settings address when none is passed', async () => {
    settingsGet.mockResolvedValue({ data: { homeAddress: '1 Yonge St, Toronto' } });
    regionMock.mockResolvedValue({ countryCode: 'CA', state: 'Ontario' });
    expect(await detectHomeRegion()).toEqual({ country: 'CA', region: 'Ontario' });
    expect(regionMock).toHaveBeenCalledWith('1 Yonge St, Toronto');
  });

  it('never throws on geocoder failure', async () => {
    regionMock.mockRejectedValue(new Error('offline'));
    expect(await detectHomeRegion('anywhere')).toBeNull();
  });
});
