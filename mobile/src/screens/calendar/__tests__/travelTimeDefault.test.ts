// The event form defaults travel time ON, seeding the origin from the user's
// current location — but only when location was ALREADY shared, and without ever
// prompting on form open. That rule lives in resolveCurrentAddressIfShared; when
// it returns null the form leaves travel time off. See specs/features/calendar.md.
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));

import * as Location from 'expo-location';
import { resolveCurrentAddressIfShared } from '../../../lib/currentLocation';

const getPerm = Location.getForegroundPermissionsAsync as jest.Mock;
const reqPerm = Location.requestForegroundPermissionsAsync as jest.Mock;
const getPos = Location.getCurrentPositionAsync as jest.Mock;
const revGeo = Location.reverseGeocodeAsync as jest.Mock;

describe('travel-time default origin (resolveCurrentAddressIfShared)', () => {
  beforeEach(() => {
    getPerm.mockReset();
    reqPerm.mockReset();
    getPos.mockReset();
    revGeo.mockReset();
    getPos.mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
    revGeo.mockResolvedValue([
      { streetNumber: '10', street: 'Main St', city: 'Springfield', region: 'ON', postalCode: 'A1A1A1', country: 'Canada' },
    ]);
  });

  it('resolves the current address when location is already granted', async () => {
    getPerm.mockResolvedValue({ status: 'granted' });
    expect(await resolveCurrentAddressIfShared()).toBe('10 Main St, Springfield, ON, A1A1A1, Canada');
  });

  it('returns null (→ travel stays off) when permission is not granted', async () => {
    getPerm.mockResolvedValue({ status: 'undetermined' });
    expect(await resolveCurrentAddressIfShared()).toBeNull();
    getPerm.mockResolvedValue({ status: 'denied' });
    expect(await resolveCurrentAddressIfShared()).toBeNull();
  });

  it('never prompts for permission on form open', async () => {
    getPerm.mockResolvedValue({ status: 'undetermined' });
    await resolveCurrentAddressIfShared();
    expect(reqPerm).not.toHaveBeenCalled();
    expect(getPos).not.toHaveBeenCalled();
  });

  it('returns null when the fix reverse-geocodes to nothing', async () => {
    getPerm.mockResolvedValue({ status: 'granted' });
    revGeo.mockResolvedValue([{}]);
    expect(await resolveCurrentAddressIfShared()).toBeNull();
  });
});
