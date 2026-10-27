import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react-native';

// Assistant phone calls are a server deployment switch (ai-assistant.md →
// Phone calls → "Production switch"; calendar.md → detail view). The event
// view's "Reschedule/Cancel" card — the only place a call is set up from —
// renders only while BOTH the user's AI toggle is on AND the server reports
// `features.aiCalls`. Production reports it off, so the store build shows no
// calling UI at all; this pins that the switch, not just the AI toggle, hides
// the card.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
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

const mockNav = { setOptions: jest.fn(), goBack: jest.fn(), navigate: jest.fn(), replace: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: { eventId: 'e1' } }),
  useFocusEffect: () => {},
}));

// A timed event with a 20-minute drive, so the departure-anchored rows are in
// play — the pickers must offer both framings, exactly as the form does.
let mockEvent: Record<string, unknown> = {
  _id: 'e1',
  title: 'Dentist',
  calendarType: 'appointments',
  allDay: false,
  startDate: '2026-09-01T15:00:00.000Z',
  travelMinutes: 20,
  reminderMinutes: 30,
  alertAnchor: 'event',
};

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'calendar' && queryKey[1] === 'event') return { data: mockEvent, refetch: jest.fn() };
    if (queryKey[0] === 'settings') return { data: { dayAlertTime: '09:00' } };
    return { data: [] };
  },
  useMutation: ({ mutationFn }: { mutationFn: (v: unknown) => unknown }) => ({
    mutate: (v: unknown) => mockMutate(mutationFn, v),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

// Run the real mutationFn so the api call it makes is what we assert on.
const mockMutate = (fn: (v: unknown) => unknown, v: unknown) => { void fn(v); };

const mockSetAlerts = jest.fn(async () => ({ data: {} }));
jest.mock('../../../api', () => ({
  calendarApi: {
    getEvent: jest.fn(),
    setAlerts: (...a: unknown[]) => (mockSetAlerts as any)(...a),
  },
  callsApi: { list: jest.fn(async () => ({ data: [] })) },
  householdApi: { get: jest.fn() },
  invitationsApi: { sentForEvent: jest.fn() },
  eventAttachmentsApi: { list: jest.fn() },
  settingsApi: { get: jest.fn() },
}));

jest.mock('../../../lib/e2ee', () => ({
  openRecord: async (_c: string, r: unknown) => r,
  getHDK: () => new Uint8Array(1),
}));
jest.mock('../../../lib/secureToken', () => ({ getCachedToken: () => 'tok' }));
jest.mock('../../../lib/householdRsvp', () => ({ rsvpsForEvent: jest.fn() }));
const mockPrefs = { aiEnabled: true };
jest.mock('../../../lib/privacyPrefs', () => ({ usePrivacyPrefs: () => ({ prefs: mockPrefs }) }));
// The server switch as the shared hook reports it (false until status loads).
const mockAiCalls = { on: false };
jest.mock('../../../hooks/useBilling', () => ({
  useAiCallsEnabled: () => mockAiCalls.on,
  useBilling: () => ({ data: undefined }),
}));
jest.mock('../../../lib/calendarPrefs', () => ({
  useCalendarColors: () => ({ colors: { appointments: '#1976D2' } }),
  useCustomCalendars: () => ({ calendars: [] }),
}));

import EventDetailScreen from '../EventDetailScreen';

afterEach(() => {
  cleanup();
});

test('server switch off (production): no Reschedule/Cancel card even with the AI toggle on', async () => {
  mockPrefs.aiEnabled = true;
  mockAiCalls.on = false;
  const screen = await render(<EventDetailScreen />);
  expect((await screen.findAllByText('Dentist')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Reschedule/Cancel')).toBeNull();
});

test('server switch on + AI toggle on: the Reschedule/Cancel card is back', async () => {
  mockPrefs.aiEnabled = true;
  mockAiCalls.on = true;
  const screen = await render(<EventDetailScreen />);
  expect(await screen.findByText('Reschedule/Cancel')).toBeTruthy();
});

test('server switch on but AI toggle off: still no card (the user\'s consent gate stays)', async () => {
  mockPrefs.aiEnabled = false;
  mockAiCalls.on = true;
  const screen = await render(<EventDetailScreen />);
  expect((await screen.findAllByText('Dentist')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Reschedule/Cancel')).toBeNull();
});
