import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The Outside My Household add field's contract (calendar.md → outside sharing):
// it autocompletes over the contacts roster like the household invite field —
// a tapped suggestion STAGES the contact at View Only (nothing sends until the
// calendar saves) and runs the same lookup-gated outreach as a typed add; the
// suggestion list and the typed path both refuse household members and the
// owner (suggestions silently, typing with a pointed error).

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
// Reanimated's shipped mock still boots native worklets under jest-expo, so
// stub the handful of exports ui.tsx touches instead.
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

const mockNav = {
  setOptions: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  pop: jest.fn(),
  getState: () => ({ routes: [] }),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: undefined }),
}));

// Queries resolve synchronously from fixtures, keyed the same way the screen
// keys them; the people rows are what openRecord would have yielded.
const mockHouseholdData = {
  _id: 'hh',
  name: 'Polk',
  ownerId: 'me',
  members: [
    { _id: 'me', firstName: 'Ben', email: 'me@x.com' },
    { _id: 'm2', firstName: 'Sam', email: 'sam@x.com' },
  ],
};
const mockRoster = [
  { _id: 'ana', name: 'Ana Silva', type: 'friend', emails: [{ label: 'home', value: 'ana@example.com' }] },
  { _id: 'samp', name: 'Sam Member', type: 'family', emails: [{ label: 'home', value: 'sam@x.com' }] },
];
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'household') return { data: mockHouseholdData };
    if (queryKey[0] === 'people') return { data: mockRoster };
    return { data: [] };
  },
}));

jest.mock('../../../lib/e2ee', () => ({ openRecord: jest.fn() }));
jest.mock('../../../lib/homeRegion', () => ({ detectHomeRegion: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../lib/calendarFeeds', () => ({
  refreshFeed: jest.fn(),
  getFeedMeta: jest.fn().mockResolvedValue({ lastFetched: null }),
  dropFeedCache: jest.fn(),
  FeedError: class FeedError extends Error {},
}));
jest.mock('../../../lib/calendarPrefs', () => {
  const actual = jest.requireActual('../../../lib/calendarPrefs');
  return {
    CALENDARS: actual.CALENDARS,
    COLOR_PRESETS: actual.COLOR_PRESETS,
    DELETABLE_DEFAULT_IDS: actual.DELETABLE_DEFAULT_IDS,
    holidayCalendarSeed: actual.holidayCalendarSeed,
    useCustomCalendars: () => ({
      calendars: [], addCalendar: jest.fn(), updateCalendar: jest.fn(), removeCalendar: jest.fn(),
    }),
    useCalendarColors: () => ({ colors: {}, setColor: jest.fn() }),
    useDeletedDefaultCalendars: () => ({ deleteDefault: jest.fn() }),
    useDefaultCalendarAlerts: () => ({ mutedIds: [], setAlertsEnabled: jest.fn() }),
  };
});
jest.mock('../../../hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: () => jest.fn() }));

const mockComposeEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../components/EmailAppSheet', () => ({
  useEmailComposer: () => ({ composeEmail: mockComposeEmail, emailSheet: null }),
}));

const mockLookup = jest.fn();
jest.mock('../../../api', () => ({
  householdApi: {},
  ecardsApi: {},
  peopleApi: {},
  // Deref lazily — the factory runs during module require, before the const
  // initializers above it; a direct reference would freeze `undefined`.
  invitationsApi: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));
jest.mock('../../../store/auth', () => ({ useAuth: () => ({ user: { _id: 'me', email: 'me@x.com' } }) }));

import AddCalendarScreen from '../AddCalendarScreen';

const FIELD = 'Add name, email, or phone…';
const ON_CALEN_NOTE = 'They’re on Calen — they’ll be notified in-app when you save.';

describe('AddCalendarScreen outside-share autocomplete', () => {
  beforeEach(() => {
    mockLookup.mockReset().mockResolvedValue({ data: { userExists: true } });
    mockComposeEmail.mockClear();
  });
  afterEach(cleanup);

  // Typing helper: the state update from changeText commits asynchronously, so
  // flush (findByDisplayValue) before the next event — firing submit/press
  // immediately would run against the pre-typing render's empty-draft closure.
  const type = async (view: Awaited<ReturnType<typeof render>>, text: string) => {
    await fireEvent.changeText(view.getByPlaceholderText(FIELD), text);
    await view.findByDisplayValue(text);
  };
  const submit = (view: Awaited<ReturnType<typeof render>>) =>
    fireEvent(view.getByPlaceholderText(FIELD), 'submitEditing');

  it('typing a contact name suggests them; tapping stages at View Only with the on-Calen note, no composer', async () => {
    const view = await render(<AddCalendarScreen />);
    await type(view, 'ana');
    await fireEvent.press(await view.findByText('Ana Silva'));
    // Staged in the outside list at View Only — nothing sent until save.
    expect(await view.findByText('ana@example.com')).toBeTruthy();
    expect(await view.findByText('View Only')).toBeTruthy();
    // Account holder: in-app note instead of the composer.
    expect(await view.findByText(ON_CALEN_NOTE)).toBeTruthy();
    expect(mockLookup).toHaveBeenCalledWith({ email: 'ana@example.com' });
    expect(mockComposeEmail).not.toHaveBeenCalled();
  });

  it('suggestions exclude household members and already-staged recipients', async () => {
    const view = await render(<AddCalendarScreen />);
    // Sam is a household member — his roster card never suggests.
    await type(view, 'sam');
    expect(view.queryByText('Sam Member')).toBeNull();
    // Once Ana is staged, she stops suggesting too.
    await type(view, 'ana');
    await fireEvent.press(await view.findByText('Ana Silva'));
    await view.findByText(ON_CALEN_NOTE);
    await type(view, 'ana');
    expect(view.queryByText('Ana Silva')).toBeNull();
  });

  it('typed adds of yourself or a housemate are rejected with pointed errors', async () => {
    const view = await render(<AddCalendarScreen />);
    await type(view, 'me@x.com');
    await submit(view);
    expect(await view.findByText('That’s you — no need to share.')).toBeTruthy();
    await type(view, 'sam@x.com');
    await submit(view);
    expect(await view.findByText('Sam is in your household — select them above.')).toBeTruthy();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('a typed non-account recipient still stages, then opens the composer', async () => {
    mockLookup.mockResolvedValue({ data: { userExists: false } });
    const view = await render(<AddCalendarScreen />);
    await type(view, 'zed@x.com');
    await submit(view);
    expect(await view.findByText('zed@x.com')).toBeTruthy();
    await view.findByText('View Only');
    expect(mockComposeEmail).toHaveBeenCalledWith('zed@x.com', 'a shared calendar');
  });
});
