import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The shared-calendar edit split (calendar.md → custom calendars): a housemate
// holding Full Access on a calendar shared with them edits its BASICS — name,
// colour, alerts — and their save sends ONLY those fields (the server 403s a
// non-owner payload touching sharing). Sharing and Delete stay the owner's.
// View-only housemates and outside collaborators (owner not in this household)
// read everything.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
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

const mockNav = {
  setOptions: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  pop: jest.fn(),
  getState: () => ({ routes: [] }),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: { calendarId: 'custom-fam' } }),
}));

const mockHouseholdData = {
  _id: 'hh',
  name: 'Polk',
  ownerId: 'me',
  members: [
    { _id: 'me', firstName: 'Ben', email: 'me@x.com' },
    { _id: 'm2', firstName: 'Sam', email: 'sam@x.com' },
  ],
};
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'household') return { data: mockHouseholdData };
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

// The calendar under edit — each test reshapes ownership/access before render.
const sharedCal = {
  id: 'custom-fam',
  ownerId: 'm2',
  name: 'Family',
  color: '#1976D2',
  alertsEnabled: true,
  sharedWithHousehold: true,
  householdAccess: 'full',
  sharedWith: [],
  sharedWithOutside: [],
  mine: false,
  access: 'full',
};
const mockUpdateCalendar = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../lib/calendarPrefs', () => {
  const actual = jest.requireActual('../../../lib/calendarPrefs');
  return {
    CALENDARS: actual.CALENDARS,
    COLOR_PRESETS: actual.COLOR_PRESETS,
    DELETABLE_DEFAULT_IDS: actual.DELETABLE_DEFAULT_IDS,
    holidayCalendarSeed: actual.holidayCalendarSeed,
    useCustomCalendars: () => ({
      calendars: [sharedCal],
      addCalendar: jest.fn(),
      updateCalendar: (...args: unknown[]) => mockUpdateCalendar(...args),
      removeCalendar: jest.fn(),
    }),
    useCalendarColors: () => ({ colors: {}, setColor: jest.fn() }),
    useDeletedDefaultCalendars: () => ({ deleteDefault: jest.fn() }),
    useDefaultCalendarAlerts: () => ({ mutedIds: [], setAlertsEnabled: jest.fn() }),
  };
});
jest.mock('../../../hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: () => jest.fn() }));
jest.mock('../../../components/EmailAppSheet', () => ({
  useEmailComposer: () => ({ composeEmail: jest.fn(), emailSheet: null }),
}));
jest.mock('../../../api', () => ({
  householdApi: {},
  ecardsApi: {},
  contactsApi: {},
  invitationsApi: { lookup: jest.fn() },
}));
jest.mock('../../../store/auth', () => ({ useAuth: () => ({ user: { _id: 'me', email: 'me@x.com' } }) }));

import AddCalendarScreen from '../AddCalendarScreen';

const HOUSEMATE_EDIT_NOTE =
  'Shared with you by a housemate — you can change its name, colour, and alerts. Sharing is managed by its owner.';
const OWNER_ONLY_NOTE = "Shared with you by a housemate — only the calendar's owner can make changes.";
const OUTSIDE_NOTE = "Shared with you — only the calendar's owner can make changes.";

// The saved header check button is installed via nav.setOptions; press the
// most recent headerRight render to trigger save.
const pressHeaderCheck = async () => {
  const withRight = mockNav.setOptions.mock.calls
    .map((c) => c[0])
    .filter((o) => typeof o?.headerRight === 'function')
    .pop();
  const node = withRight.headerRight();
  expect(node).not.toBeNull(); // enabled — a read-only form hides the check
  const btn = await render(<>{node}</>);
  await fireEvent.press(btn.getByLabelText('Save'));
};

describe('AddCalendarScreen shared-calendar edit split', () => {
  beforeEach(() => {
    mockNav.setOptions.mockClear();
    mockUpdateCalendar.mockClear();
    Object.assign(sharedCal, { ownerId: 'm2', mine: false, access: 'full' });
  });
  afterEach(cleanup);

  it('a full-access housemate edits basics, and the save sends ONLY basics', async () => {
    const view = await render(<AddCalendarScreen />);
    expect(await view.findByText(HOUSEMATE_EDIT_NOTE)).toBeTruthy();
    expect(mockNav.setOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Edit Calendar' }));

    const nameInput = await view.findByDisplayValue('Family');
    expect(nameInput.props.editable).not.toBe(false);
    await fireEvent.changeText(nameInput, 'Family Stuff');
    await view.findByDisplayValue('Family Stuff');

    await pressHeaderCheck();
    expect(mockUpdateCalendar).toHaveBeenCalledTimes(1);
    // Exactly the basics — a sharing field in this payload would 403 server-side.
    expect(mockUpdateCalendar).toHaveBeenCalledWith('custom-fam', {
      name: 'Family Stuff',
      color: '#1976D2',
      alertsEnabled: true,
    });
    // Sharing and deletion stay the owner's.
    expect(view.queryByText('Delete Calendar')).toBeNull();
  });

  it('a view-only housemate reads everything (no save button, name locked)', async () => {
    sharedCal.access = 'view';
    const view = await render(<AddCalendarScreen />);
    expect(await view.findByText(OWNER_ONLY_NOTE)).toBeTruthy();
    expect(mockNav.setOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Calendar' }));
    expect((await view.findByDisplayValue('Family')).props.editable).toBe(false);
    const withRight = mockNav.setOptions.mock.calls
      .map((c) => c[0])
      .filter((o) => typeof o?.headerRight === 'function')
      .pop();
    expect(withRight.headerRight()).toBeNull();
  });

  it('an outside collaborator is read-only even at Full Access', async () => {
    sharedCal.ownerId = 'stranger'; // not in this household's member list
    const view = await render(<AddCalendarScreen />);
    expect(await view.findByText(OUTSIDE_NOTE)).toBeTruthy();
    expect((await view.findByDisplayValue('Family')).props.editable).toBe(false);
  });
});
