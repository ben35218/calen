jest.mock('@household/weather', () => ({ cityForAddress: jest.fn() }));

import { cityForAddress } from '@household/weather';
import { detectHomeCity, shouldDeriveHomeCity } from '../homeCity';

const cityMock = cityForAddress as jest.Mock;

beforeEach(() => cityMock.mockReset());

describe('detectHomeCity', () => {
  it('resolves the coarse area label for an address', async () => {
    cityMock.mockResolvedValue('Ottawa, Ontario, Canada');
    await expect(detectHomeCity('123 Main St, Ottawa')).resolves.toBe('Ottawa, Ontario, Canada');
  });

  it('returns null for an empty address without geocoding', async () => {
    await expect(detectHomeCity('   ')).resolves.toBeNull();
    await expect(detectHomeCity(null)).resolves.toBeNull();
    expect(cityMock).not.toHaveBeenCalled();
  });

  it('never throws when the geocoders fail', async () => {
    cityMock.mockRejectedValue(new Error('offline'));
    await expect(detectHomeCity('123 Main St')).resolves.toBeNull();
  });
});

describe('shouldDeriveHomeCity', () => {
  it('derives when the address is set for the first time', () => {
    expect(shouldDeriveHomeCity('123 Main St, Ottawa', '')).toBe(true);
    expect(shouldDeriveHomeCity('123 Main St, Ottawa', null)).toBe(true);
  });

  it('derives when the address changes to a new one', () => {
    expect(shouldDeriveHomeCity('9 King St, Toronto', '123 Main St, Ottawa')).toBe(true);
  });

  it('skips an unchanged address (idle blur, re-picking the same place)', () => {
    expect(shouldDeriveHomeCity('123 Main St, Ottawa', '123 Main St, Ottawa')).toBe(false);
    expect(shouldDeriveHomeCity('  123 Main St, Ottawa  ', '123 Main St, Ottawa')).toBe(false);
  });

  it('skips an empty address', () => {
    expect(shouldDeriveHomeCity('', '123 Main St, Ottawa')).toBe(false);
    expect(shouldDeriveHomeCity('   ', '')).toBe(false);
    expect(shouldDeriveHomeCity(undefined, undefined)).toBe(false);
  });
});
