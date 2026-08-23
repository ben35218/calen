import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

// The booking view (trips.md → Day itinerary): tapping a block on a trip day
// opens the booking to READ it, the way tapping an event chip opens the event
// view. These pin what that means — the sealed content is rendered through the
// shared decrypting fetcher, the header's Edit is what reaches the form, and the
// page's own control deletes the booking behind a confirm.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withSequence: (v: unknown) => v,
  };
});

const mockNav = { setOptions: jest.fn(), goBack: jest.fn(), navigate: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: { tripId: 't1', itemId: 'i1', date: '2026-08-22' } }),
}));

// A dinner booking on a Toronto trip, with everything a booking can carry that
// the view is expected to name.
const item = {
  _id: 'i1',
  type: 'restaurant',
  title: 'Dinner at Alo',
  location: '163 Spadina Ave',
  start: '2026-08-22T21:30:00.000Z', // 5:30 PM in Toronto
  end: '2026-08-22T23:00:00.000Z',   // 7:00 PM
  cost: 240,
  currency: 'CAD',
  confirmation: 'ABC123',
  confirmed: true,
  notes: 'Tasting menu, no nuts',
  phone: '+14165551234',
};

const mockFetchTripDetail = jest.fn(async (_tripId: string) => ({
  trip: { _id: 't1', name: 'Toronto', destinationTz: 'America/Toronto' },
  items: [item] as any[],
}));
jest.mock('../../../lib/tripData', () => ({ fetchTripDetail: (id: string) => mockFetchTripDetail(id) }));

const mockRemoveItem = jest.fn(async (_tripId: string, _itemId: string) => ({ data: {} }));
jest.mock('../../../api', () => ({
  tripsApi: { removeItem: (tripId: string, itemId: string) => mockRemoveItem(tripId, itemId) },
  // The all-day alert labels read the account's day-alert hour.
  settingsApi: { get: async () => ({ data: { dayAlertTime: '09:00' } }) },
}));

jest.mock('../../../lib/tripAttachments', () => ({ openTripAttachment: jest.fn() }));
jest.mock('../../../lib/secureToken', () => ({ getCachedToken: () => 'tok' }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => {
    const [data, setData] = require('react').useState(undefined);
    require('react').useEffect(() => { queryFn().then(setData); }, []);
    return { data, isLoading: data === undefined, isError: false };
  },
  useMutation: ({ mutationFn }: { mutationFn: (v: unknown) => unknown }) => ({
    mutate: (v: unknown) => { void mutationFn(v); },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

import TripItemDetailScreen from '../TripItemDetailScreen';

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// RNTL v14's render() is async.
const open = async () => {
  const view = await render(<TripItemDetailScreen />);
  await waitFor(() => view.getByText('Dinner at Alo'));
  return view;
};

describe('TripItemDetailScreen', () => {
  it('reads the decrypted booking: title, place, its time in the trip’s timezone, and what was booked', async () => {
    const view = await open();
    // Everything shown is sealed content, so it comes through the shared fetcher.
    expect(mockFetchTripDetail).toHaveBeenCalledWith('t1');
    view.getByText('163 Spadina Ave');
    view.getByText('Sat, Aug 22, 2026, 5:30 PM – 7:00 PM'); // destination tz, not the device's
    view.getByText('Times are local to America/Toronto');
    view.getByText('Booked');
    view.getByText('ABC123');
    view.getByText('CAD 240');
    view.getByText('Tasting menu, no nuts');
  });

  it('renders an all-day booking as day labels, with no clocks and no tz note', async () => {
    mockFetchTripDetail.mockResolvedValueOnce({
      trip: { _id: 't1', name: 'Toronto', destinationTz: 'America/Toronto' },
      items: [{
        _id: 'i1', type: 'activity', title: 'Dinner at Alo', allDay: true,
        start: '2026-08-22T04:00:00.000Z', // midnight Aug 22, Toronto
        end: '2026-08-24T04:00:00.000Z',
      } as any],
    });
    const view = await open();
    view.getByText('All day, Sat, Aug 22, 2026');
    view.getByText('to Mon, Aug 24, 2026');
    expect(view.queryByText(/Times are local to/)).toBeNull();
  });

  it('leaves out what the booking does not have', async () => {
    mockFetchTripDetail.mockResolvedValueOnce({
      trip: { _id: 't1', name: 'Toronto', destinationTz: 'America/Toronto' },
      items: [{ _id: 'i1', type: 'restaurant', title: 'Dinner at Alo', start: item.start } as any],
    });
    const view = await open();
    expect(view.queryByText('Confirmation')).toBeNull();
    expect(view.queryByText('Cost')).toBeNull();
    view.getByText('Not booked yet');
  });

  it('reaches the form from the header’s edit action, on the day it was opened from', async () => {
    await open();
    const headerRight = mockNav.setOptions.mock.calls.at(-1)![0].headerRight;
    const view = await render(headerRight());
    fireEvent.press(view.getByLabelText('Edit booking'));
    expect(mockNav.navigate).toHaveBeenCalledWith('TripItemForm', {
      tripId: 't1', itemId: 'i1', date: '2026-08-22',
    });
  });

  it('deletes the booking only after the native confirm', async () => {
    const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await open();
    fireEvent.press(view.getByText('Delete Booking'));
    expect(mockRemoveItem).not.toHaveBeenCalled();
    // Take the confirm sheet's destructive action.
    const [, , buttons] = spy.mock.calls[0] as any;
    buttons.find((b: any) => b.style === 'destructive').onPress();
    await waitFor(() => expect(mockRemoveItem).toHaveBeenCalledWith('t1', 'i1'));
    spy.mockRestore();
  });
});
