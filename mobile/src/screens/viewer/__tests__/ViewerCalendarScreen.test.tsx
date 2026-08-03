import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react-native';

// Free viewer mode's shell contract (billing-plans.md → Free viewer mode):
// the home renders ONLY calendars shared TO this user (`mine:false`) and their
// events — the viewer's own household lanes stay behind the paywall — in two
// read-only layers (the month grid by default, the upcoming-events list behind
// the view toggle), plus the "waiting for the owner" hint while the
// CalendarKey hasn't reached this device, the Print route, and the
// "What more can Calen do?" CTA into the paywall route. A viewer never triages
// invitations: pending calendar shares auto-accept on entry/focus, so a shared
// calendar simply appears.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockNavigate = jest.fn();
const mockReplace = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, replace: mockReplace }),
  // Run the focus callback like a mount focus would — the auto-accept pass and
  // the sources refetch both live in it.
  useFocusEffect: (cb: () => void) => {
    const React = require('react');
    React.useEffect(cb, [cb]);
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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

// One replica read feeds both layers: the host's query resolves the sources,
// each layer expands the range it needs. Mock the hook + the expansion so the
// test is deterministic.
const mockAgenda = { events: [] as unknown[], isLoading: false };
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { sources: {} },
    isLoading: mockAgenda.isLoading,
    isRefetching: false,
    refetch: jest.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../../store/auth', () => ({ useAuth: () => ({ logout: jest.fn() }) }));
jest.mock('../../../lib/calendarData', () => ({
  loadCalendarWindowSources: jest.fn().mockResolvedValue({ sources: {} }),
  expandCalendarRange: () => ({ events: mockAgenda.events }),
}));
jest.mock('../../../lib/calendarKeys', () => ({
  ensureSharedCalendarKeys: jest.fn().mockResolvedValue(undefined),
}));

// The auto-accept pass: pending calendar-share invitations accept silently.
const mockInvitations = { list: [] as { _id: string; status: string }[] };
const mockAcceptInvitation = jest.fn().mockResolvedValue({ data: {} });
jest.mock('../../../api', () => ({
  customCalendarsApi: {
    invitations: () => Promise.resolve({ data: mockInvitations.list }),
    acceptInvitation: (id: string) => mockAcceptInvitation(id),
  },
}));

const mockCustom = { list: [] as unknown[], loaded: true };
jest.mock('../../../lib/calendarPrefs', () => ({
  // `loaded` = the server list has answered; the shell must not render a
  // verdict about shared calendars before it has.
  useCustomCalendars: () => ({ calendars: mockCustom.list, loaded: mockCustom.loaded }),
  refreshCustomCalendars: jest.fn().mockResolvedValue(undefined),
}));

// Key possession per calendar id — drives the waiting-for-owner hint.
const mockKeys = { held: new Set<string>() };
const mockLocked = { value: false };
jest.mock('../../../hooks/useSessionLocked', () => ({
  useSessionLocked: () => mockLocked.value,
}));
jest.mock('../../../lib/e2ee', () => ({
  currentCalendarKeyVersion: (id: string) => (mockKeys.held.has(id) ? 1 : 0),
  getResourceKey: (id: string) => (mockKeys.held.has(id) ? new Uint8Array(32) : null),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
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

// One trailing pill opens the view/actions menu (Calendar · List · Print ·
// What more can Calen do? · Sign out); the shell opens on the month grid.
const openMenu = async (view: Awaited<ReturnType<typeof render>>) => {
  await fireEvent.press(view.getByLabelText(/^Menu —/));
};
const showList = async (view: Awaited<ReturnType<typeof render>>) => {
  await openMenu(view);
  await fireEvent.press(view.getByText('List'));
};

describe('ViewerCalendarScreen', () => {
  afterEach(async () => {
    // The chosen layer is remembered per device — forget it between cases so
    // each one starts on the shell's default (the month grid).
    await AsyncStorage.clear();
    mockNavigate.mockReset();
    mockReplace.mockReset();
    mockAcceptInvitation.mockClear();
    mockCustom.list = [];
    mockCustom.loaded = true;
    mockAgenda.events = [];
    mockInvitations.list = [];
    mockKeys.held = new Set();
    cleanup();
  });

  it('the calendar grid draws only mine:false calendars’ events', async () => {
    mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-own', name: 'My Own', mine: true })];
    mockKeys.held = new Set(['custom-shared']);
    mockAgenda.events = [
      { _id: 'e1', title: 'Practice', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-shared' },
      { _id: 'e2', title: 'My Private Thing', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-own' },
      { _id: 'e3', title: 'A Chore', startDate: tomorrowNoon(), allDay: false, calendarType: 'chores' },
    ];

    const view = await render(<ViewerCalendarScreen />);
    await waitFor(() => expect(view.getAllByText('Practice').length).toBeGreaterThan(0));
    expect(view.queryByText('My Private Thing')).toBeNull();
    expect(view.queryByText('A Chore')).toBeNull();
  });

  it('the list view renders only mine:false calendars and their events', async () => {
    mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-own', name: 'My Own', mine: true })];
    mockKeys.held = new Set(['custom-shared']);
    mockAgenda.events = [
      { _id: 'e1', title: 'Practice', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-shared' },
      { _id: 'e2', title: 'My Private Thing', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-own' },
      { _id: 'e3', title: 'A Chore', startDate: tomorrowNoon(), allDay: false, calendarType: 'chores' },
    ];

    const view = await render(<ViewerCalendarScreen />);
    await showList(view);
    await waitFor(() => expect(view.getAllByText('Practice').length).toBeGreaterThan(0));
    expect(view.queryByText('My Private Thing')).toBeNull();
    expect(view.queryByText('A Chore')).toBeNull();
    // No roster of shared calendars in the body — rows carry their colour.
    expect(view.queryByText('Soccer Season')).toBeNull();
    expect(view.queryByText('My Own')).toBeNull();
  });

  // The list is anchored the way the app's own agenda is: a "Today" marker,
  // present even when today itself is quiet.
  it('the list view marks today, with a section for it even when it has no events', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(['custom-shared']);
    mockAgenda.events = [
      { _id: 'e1', title: 'Practice', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-shared' },
    ];
    const now = new Date();
    const todayHeading = `${now.toLocaleDateString(undefined, { weekday: 'long' })} – ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

    const view = await render(<ViewerCalendarScreen />);
    await showList(view);
    // Today's own section header, and the marker above it (the second "Today"
    // on screen — the first is the Today pill).
    await waitFor(() => expect(view.getByText(todayHeading)).toBeTruthy());
    expect(view.getAllByText('Today').length).toBeGreaterThan(1);
  });

  // Both layers carry the same month/year jump affordance on the leading edge
  // — the grid draws its own in its sticky header, the host draws the list's.
  it('keeps the month/year jump button in the list view’s header', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(['custom-shared']);
    mockAgenda.events = [
      { _id: 'e1', title: 'Practice', startDate: tomorrowNoon(), allDay: false, calendarType: 'custom-shared' },
    ];
    const thisMonth = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const view = await render(<ViewerCalendarScreen />);
    expect(view.getAllByText(thisMonth).length).toBe(1); // grid only
    await showList(view);
    // The host adds the list's own button (the grid's stays mounted behind it).
    await waitFor(() => expect(view.getAllByText(thisMonth).length).toBe(2));
    expect(view.queryByText('Shared with you')).toBeNull();
  });

  it('shows the waiting-for-owner hint while the CalendarKey is not held', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(); // owner hasn't wrapped the key to us yet

    const view = await render(<ViewerCalendarScreen />);
    expect(view.getByText(/appear the next time its owner opens Calen/)).toBeTruthy();
  });

  it('silently accepts pending calendar-share invitations (no Accept/Decline for a viewer)', async () => {
    mockInvitations.list = [
      { _id: 'inv-pending', status: 'pending' },
      { _id: 'inv-replied', status: 'accepted' },
    ];

    const view = await render(<ViewerCalendarScreen />);
    await waitFor(() => expect(mockAcceptInvitation).toHaveBeenCalledWith('inv-pending'));
    expect(mockAcceptInvitation).not.toHaveBeenCalledWith('inv-replied');
    // And no invitations inbox entry point in the shell.
    expect(view.queryByText('Invitations')).toBeNull();
  });

  // The offer lives on the bottom edge, out of the navigation layer: the value
  // line, no price (that belongs on the paywall, not on the way to it), and it
  // is the shell's ONLY upgrade affordance — the menu doesn't duplicate it.
  it('the upgrade banner opens the paywall route, without pricing the tap', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(['custom-shared']);

    const view = await render(<ViewerCalendarScreen />);
    expect(view.getByText('Unlock Calen')).toBeTruthy();
    expect(view.queryByText(/\$/)).toBeNull();
    await fireEvent.press(view.getByLabelText('Unlock Calen'));
    expect(mockNavigate).toHaveBeenCalledWith('UnlockPaywall');
  });

  it('keeps the upgrade path out of the view/actions menu', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(['custom-shared']);

    const view = await render(<ViewerCalendarScreen />);
    await openMenu(view);
    expect(view.queryByText('What more can Calen do?')).toBeNull();
    expect(view.getByText('Print')).toBeTruthy();
  });

  it('the menu’s Print row opens the shell’s print sheet on the month being viewed', async () => {
    mockCustom.list = [sharedCal()];
    mockKeys.held = new Set(['custom-shared']);
    const now = new Date();

    const view = await render(<ViewerCalendarScreen />);
    await openMenu(view);
    await fireEvent.press(view.getByText('Print'));
    expect(mockNavigate).toHaveBeenCalledWith('ViewerPrint', {
      year: now.getFullYear(),
      month: now.getMonth(),
    });
  });

  it('withholds the view rows and Print when nothing is shared', async () => {
    const view = await render(<ViewerCalendarScreen />);
    await openMenu(view);
    expect(view.queryByText('Print')).toBeNull();
    expect(view.queryByText('List')).toBeNull();
    // Sign out is in the menu AND repeated on the empty state.
    expect(view.getAllByText('Sign out').length).toBe(2);
  });

  // With nothing shared, the state covers both layers — an empty month grid
  // explains nothing on its own.
  it('empty state explains shares appear automatically when none exist', async () => {
    const view = await render(<ViewerCalendarScreen />);
    expect(view.getByText('No shared calendars yet')).toBeTruthy();
    expect(view.getByText(/it appears here automatically/)).toBeTruthy();
  });

  // The calendar list arrives asynchronously, so an empty list before it lands
  // is "still loading", NOT "nothing shared with you". Rendering the verdict
  // early told a viewer who genuinely HAD a shared calendar that they had none.
  it('does not claim "no shared calendars" before the server list has answered', async () => {
    mockCustom.loaded = false;

    const view = await render(<ViewerCalendarScreen />);
    expect(view.queryByText('No shared calendars yet')).toBeNull();
    expect(view.queryByText(/it appears here automatically/)).toBeNull();
  });

  // A pending re-key request hands this screen over to ViewerUnlock's "Request
  // sent" confirmation. Until it does, nothing calendar-shaped may paint: the
  // grid used to flash an empty month with the waiting note over it — chrome
  // that explains an ordinary sync delay — as the first thing a returning user
  // saw after signing in.
  it('paints no calendar while a pending access request hands off', async () => {
    mockCustom.list = [sharedCal({ accessRequestedAt: '2026-08-03T00:00:00.000Z' })];

    const view = await render(<ViewerCalendarScreen />);
    expect(mockReplace).toHaveBeenCalledWith('ViewerUnlock');
    // No waiting note, and no calendar chrome behind it.
    expect(view.queryByText(/appear the next time its owner opens/)).toBeNull();
    expect(view.queryByLabelText(/^Menu —/)).toBeNull();
  });

  // The ordinary case the note exists FOR: a fresh share the owner hasn't
  // wrapped yet. No request is pending, so the calendar renders and explains.
  it('still explains an ordinary wait when no request is pending', async () => {
    mockCustom.list = [sharedCal()];

    const view = await render(<ViewerCalendarScreen />);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(view.getByText(/appear the next time its owner opens/)).toBeTruthy();
  });
});
