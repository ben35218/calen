import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react-native';

// The trips list's row anatomy (trips.md → Trips & itinerary): the card body
// opens the trip's itinerary and the trailing ⓘ edits the trip's own details,
// the same split the Calendars screen uses. These pin both halves — the trip
// view no longer carries an Edit action, so the ⓘ is the path to the form.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
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

const mockNav = { setOptions: jest.fn(), navigate: jest.fn() };
jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNav }));

const trip = {
  _id: 't1',
  name: 'Toronto',
  destination: 'Toronto, ON',
  startDate: '2099-06-01',
  endDate: '2099-06-05',
};

jest.mock('../../../api', () => ({ tripsApi: { list: async () => ({ data: [trip] }) } }));
jest.mock('../../../lib/e2ee', () => ({ openRecord: async (_t: string, row: unknown) => row }));
jest.mock('../../../lib/replica', () => ({
  syncedList: async (_bucket: string, fetcher: () => Promise<unknown[]>) => fetcher(),
}));
jest.mock('../../../lib/addons', () => ({ useOwnedAddons: () => ({ isUnlocked: () => true, loaded: true }) }));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { trips: '#0a7' } }) }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => {
    const [data, setData] = require('react').useState(undefined);
    require('react').useEffect(() => { void queryFn().then(setData); }, []);
    return { data, isLoading: data === undefined, isRefetching: false, refetch: jest.fn() };
  },
}));

import TripsScreen from '../TripsScreen';

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// RNTL v14's render() is async.
const open = async () => {
  const view = await render(<TripsScreen />);
  await waitFor(() => view.getByText('Toronto'));
  return view;
};

describe('trips list rows', () => {
  it('opens the itinerary from the card body', async () => {
    const { getByLabelText } = await open();
    fireEvent.press(getByLabelText('Toronto'));
    expect(mockNav.navigate).toHaveBeenCalledWith('TripDetail', { id: 't1' });
  });

  it('opens the trip form from the row ⓘ', async () => {
    const { getByLabelText } = await open();
    fireEvent.press(getByLabelText('Edit Toronto'));
    expect(mockNav.navigate).toHaveBeenCalledWith('TripForm', { id: 't1' });
  });
});
