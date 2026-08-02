import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react-native';

// Free viewer mode's shell contract (billing-plans.md → Free viewer mode):
// the home renders ONLY calendars shared TO this user (`mine:false`) and their
// events — the viewer's own household lanes stay behind the paywall — plus the
// "waiting for the owner" hint while the CalendarKey hasn't reached this
// device, and the Unlock Calen CTA into the paywall route.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: () => {},
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
// ui.tsx pulls in native modules jest can't boot — same stubs as the other
// screen suites (AddCalendarScreen.outsideShare / CalendarColorsScreen).
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
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

// The agenda query resolves synchronously through the real useQuery contract's
// surface only — mock the hook to keep the test deterministic.
const mockAgenda = { events: [] as unknown[], isLoading: false };
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: mockAgenda.events,
    isLoading: mockAgenda.isLoading,
    isRefetching: false,
    refetch: jest.fn(),
  }),
}));

jest.mock('../../../store/auth', () => ({ useAuth: () => ({ logout: jest.fn() }) }));
jest.mock('../../../hooks/useInvitationsCount', () => ({ useInvitationsCount: () => 0 }));
jest.mock('../../../lib/calendarData', () => ({ loadCalendarData: jest.fn() }));
jest.mock('../../../lib/calendarKeys', () => ({
  ensureSharedCalendarKeys: jest.fn().mockResolvedValue(undefined),
}));

const mockCustom = { list: [] as unknown[] };
jest.mock('../../../lib/calendarPrefs', () => ({
  useCustomCalendars: () => ({ calendars: mockCustom.list }),
}));

// Key possession per calendar id — drives the waiting-for-owner hint.
const mockKeys = { held: new Set<string>() };
jest.mock('../../../lib/e2ee', () => ({
  getKeyPair: () => ({}),
  currentCalendarKeyVersion: (id: string) => (mockKeys.held.has(id) ? 1 : 0),
  getResourceKey: (id: string) => (mockKeys.held.has(id) ? new Uint8Array(32) : null),
}));

import ViewerCalendarScreen from '../ViewerCalendarScreen';

function sharedCal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'custom-shared',
    name: 'Soccer Season',
    color: '#123456',
    alertsEnabled: true,
    sharedWithHousehold: false,
    householdAccess: 'full',
    sharedWith: [],
    sharedWithOutside: [],
    mine: false,
    access: 'view',
    ...overrides,
  };
}

const tomorrowNoon = () => {
  const d = new Date(Date.now() + 86400_000);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

describe('ViewerCalendarScreen', () => {
  afterEach(() => {
    mockNavigate.mockReset();
    mockCustom.list = [];
    mockAgenda.events = [];
    mockKeys.held = new Set();
    cleanup();
  });

  it('renders only mine:false calendars and their events', async () => {
    mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-own', name: 'My Own', mine: true })];
    mockKeys.held = new Set(['custom-shared']);
    mockAgenda.events = [
      { _id: 'e1', title: 'Practice', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-shared' },
      { _id: 'e2', title: 'My Private Thing', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-own' },
      { _id: 'e3', title: 'A Chore', startDate: tomorrowNoon(), allDay: false, calendarType: 'chores' },
    ];

    const view = await render(<ViewerCalendarScreen />);
    await waitFor(() => expect(view.getByText('Practice')).toBeTruthy());
    expect(view.getByText('Soccer Season')).toBeTruthy();
    expect(view.queryByText('My Own')).toBeNull();
    expect(view.queryByText('My Private Thing')).toBeNull();
    expect(view.queryByText('A Chore')).toBeNull();
  });

  it('shows the waiting-for-owner hint while the CalendarKey is not held', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(); // owner hasn't wrapped the key to us yet

    const view = await render(<ViewerCalendarScreen />);
    expect(view.getByText(/appear once its owner opens Calen/)).toBeTruthy();
  });

  it('the Unlock Calen CTA opens the paywall route', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(['custom-shared']);

    const view = await render(<ViewerCalendarScreen />);
    await fireEvent.press(view.getByText('Unlock Calen'));
    expect(mockNavigate).toHaveBeenCalledWith('UnlockPaywall');
  });

  it('empty state invites the user to accept a share when none exist', async () => {
    const view = await render(<ViewerCalendarScreen />);
    expect(view.getByText('No shared calendars yet')).toBeTruthy();
  });
});
