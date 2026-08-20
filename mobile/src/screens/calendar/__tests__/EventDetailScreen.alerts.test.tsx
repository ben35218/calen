import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react-native';

// Managing an event's alerts WITHOUT opening the edit form (calendar.md →
// Reminders/alerts): the event detail view's Alert / Second alert rows are live
// pickers that write straight to the event. These pin the contract that makes
// that safe — the rows offer the SAME options the form offers (shared builder),
// clearing the first alert promotes the second into its place, and every pick
// writes both slots as one patch through the sealed re-seal lane.

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
jest.mock('../../../lib/privacyPrefs', () => ({ usePrivacyPrefs: () => ({ prefs: { aiEnabled: false } }) }));
jest.mock('../../../lib/calendarPrefs', () => ({
  useCalendarColors: () => ({ colors: { appointments: '#1976D2' } }),
  useCustomCalendars: () => ({ calendars: [] }),
}));

import EventDetailScreen from '../EventDetailScreen';

afterEach(() => {
  cleanup();
  mockSetAlerts.mockClear();
});

// Open a picker row by tapping its label, then tap one of its option rows.
async function pick(screen: Awaited<ReturnType<typeof render>>, row: string, option: string) {
  fireEvent.press(await screen.findByText(row));
  fireEvent.press(await screen.findByText(option));
}

test('the Alert row shows the saved alert and offers the form’s options, departure rows included', async () => {
  const screen = await render(<EventDetailScreen />);
  // The saved 30-minute alert reads back on the row, not a placeholder.
  expect(await screen.findByText('30 min before')).toBeTruthy();

  fireEvent.press(await screen.findByText('Alert'));
  // Departure-anchored rows are offered because the event has a drive time —
  // the same list the edit form builds (shared lib/eventAlertOptions).
  expect(await screen.findByText('None')).toBeTruthy();
  expect(screen.getByText('15 min before leaving')).toBeTruthy();
  expect(screen.getByText('1 hour before')).toBeTruthy();
  expect(screen.getByText('Custom…')).toBeTruthy();
});

test('picking an alert writes it straight to the event — no edit form', async () => {
  const screen = await render(<EventDetailScreen />);
  await pick(screen, 'Alert', '1 hour before');

  await waitFor(() => expect(mockSetAlerts).toHaveBeenCalled());
  const [id, alerts] = mockSetAlerts.mock.calls[0] as unknown as [string, Record<string, unknown>];
  expect(id).toBe('e1');
  expect(alerts.reminderMinutes).toBe(60);
  expect(alerts.alertAnchor).toBe('event');
  // The form is never opened for this.
  expect(mockNav.navigate).not.toHaveBeenCalledWith('EventForm', expect.anything());
});

test('a departure-anchored pick stores the framing, not just the number', async () => {
  const screen = await render(<EventDetailScreen />);
  await pick(screen, 'Alert', '15 min before leaving');

  await waitFor(() => expect(mockSetAlerts).toHaveBeenCalled());
  const [, alerts] = mockSetAlerts.mock.calls[0] as unknown as [string, Record<string, unknown>];
  // 20-minute drive + a 15-minute buffer, stored as minutes before the EVENT…
  expect(alerts.reminderMinutes).toBe(35);
  // …with the framing the user actually chose recorded beside it, so it can't be
  // re-read later as "35 minutes before the event".
  expect(alerts.alertAnchor).toBe('leave');
});

test('clearing the first alert promotes the second into its place', async () => {
  mockEvent = { ...mockEvent, reminderMinutes: 30, alert2Minutes: 1440, alert2Anchor: 'event' };
  const screen = await render(<EventDetailScreen />);
  // Both slots are showing.
  expect(await screen.findByText('Second alert')).toBeTruthy();

  await pick(screen, 'Alert', 'None');

  await waitFor(() => expect(mockSetAlerts).toHaveBeenCalled());
  const [, alerts] = mockSetAlerts.mock.calls[0] as unknown as [string, Record<string, unknown>];
  // The survivor moved up rather than being stranded behind the hidden row (or
  // silently discarded).
  expect(alerts.reminderMinutes).toBe(1440);
  expect(alerts.alert2Minutes).toBeUndefined();
});

test('an event with no alert offers the pickers anyway, and the second slot stays hidden', async () => {
  mockEvent = {
    _id: 'e1', title: 'Dentist', calendarType: 'appointments', allDay: false,
    startDate: '2026-09-01T15:00:00.000Z',
  };
  const screen = await render(<EventDetailScreen />);
  expect(await screen.findByText('Alert')).toBeTruthy();
  // Second alert renders only while a first alert exists (the form's rule).
  expect(screen.queryByText('Second alert')).toBeNull();
});
