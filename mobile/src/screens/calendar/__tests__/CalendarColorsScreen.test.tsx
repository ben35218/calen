import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// Colors & Order's contract (calendar.md → Colors & Order): it lists the SAME
// calendars the Calendars manager does — built-ins, custom, subscribed and
// holiday calendars — sectioned by the same audience groups, minus what the
// household doesn't have (locked add-ons, deleted built-ins). Reordering moves
// a calendar within its section, and the section headers themselves reorder.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// The household member-count query (drives solo-household group merging).
const mockHousehold = { memberCount: 2 as number | undefined };
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockHousehold.memberCount }),
}));

const mockCustom = { list: [] as unknown[] };
const mockDeleted = { ids: [] as string[] };
const mockOrder = { ids: [] as string[] };
const mockGroupOrder = { keys: [] as string[] };
const mockSetOrder = jest.fn();
const mockSetGroupOrder = jest.fn();
jest.mock('../../../lib/calendarPrefs', () => {
  const actual = jest.requireActual('../../../lib/calendarPrefs');
  return {
    CALENDARS: actual.CALENDARS,
    CALENDAR_GROUP_KEYS: actual.CALENDAR_GROUP_KEYS,
    COLOR_PRESETS: actual.COLOR_PRESETS,
    calendarGroupOf: actual.calendarGroupOf,
    sortByCalendarOrder: actual.sortByCalendarOrder,
    sortByGroupOrder: actual.sortByGroupOrder,
    useCalendarColors: () => ({ colors: {}, setColor: jest.fn(), resetColor: jest.fn() }),
    useCalendarOrder: () => ({ order: mockOrder.ids, setOrder: mockSetOrder }),
    useCalendarGroupOrder: () => ({ groupOrder: mockGroupOrder.keys, setGroupOrder: mockSetGroupOrder }),
    useCustomCalendars: () => ({ calendars: mockCustom.list }),
    useDeletedDefaultCalendars: () => ({ deletedIds: mockDeleted.ids }),
  };
});

// A custom calendar with sensible defaults; override per test.
function customCal(overrides: Record<string, unknown>) {
  return {
    id: 'custom-x',
    name: 'Custom',
    color: '#123456',
    alertsEnabled: true,
    sharedWithHousehold: false,
    householdAccess: 'full',
    sharedWith: [],
    sharedWithOutside: [],
    mine: true,
    access: 'full',
    ...overrides,
  };
}

const mockOwned = { ids: new Set<string>() };
jest.mock('../../../lib/addons', () => {
  const actual = jest.requireActual('../../../lib/addons');
  return {
    useOwnedAddons: () => ({
      owned: mockOwned.ids,
      loaded: true,
      isUnlocked: (id: string) => !actual.isAddonCalendar(id) || mockOwned.ids.has(id),
    }),
  };
});

import CalendarColorsScreen from '../CalendarColorsScreen';

const ALL_ADDONS = ['recipes', 'maintenance', 'trips', 'birthdays', 'chores'];

describe('CalendarColorsScreen add-on gating', () => {
  beforeEach(() => {
    mockCustom.list = [
      customCal({ id: 'custom-hol', name: 'Canadian Holidays', holiday: { country: 'CA', selectedRegions: [], disabledIds: [] } }),
    ];
    mockDeleted.ids = [];
    mockGroupOrder.keys = [];
    mockHousehold.memberCount = 1;
  });
  afterEach(cleanup);

  it('hides locked add-on calendars (paid and unclaimed-free) but keeps always-on and holiday calendars', async () => {
    mockOwned.ids = new Set();
    const view = await render(<CalendarColorsScreen />);
    for (const name of ['Meals', 'Maintenance', 'Trips', 'Occasions', 'Chores']) {
      expect(view.queryByText(name)).toBeNull();
    }
    for (const name of ['Activities', 'Appointments', 'Weather', 'Canadian Holidays']) {
      expect(view.getByText(name)).toBeTruthy();
    }
  });

  it('owned/claimed add-on calendars are listed again', async () => {
    mockOwned.ids = new Set(['recipes', 'trips', 'chores']);
    const view = await render(<CalendarColorsScreen />);
    expect(view.getByText('Meals')).toBeTruthy();
    expect(view.getByText('Trips')).toBeTruthy();
    expect(view.getByText('Chores')).toBeTruthy();
    expect(view.queryByText('Maintenance')).toBeNull();
    expect(view.queryByText('Occasions')).toBeNull();
  });

  it('a built-in the user deleted drops out of the list', async () => {
    mockOwned.ids = new Set(ALL_ADDONS);
    mockDeleted.ids = ['weather'];
    const view = await render(<CalendarColorsScreen />);
    expect(view.queryByText('Weather')).toBeNull();
    expect(view.getByText('Activities')).toBeTruthy();
  });
});

describe('CalendarColorsScreen sections', () => {
  beforeEach(() => {
    mockSetOrder.mockClear();
    mockSetGroupOrder.mockClear();
    mockOwned.ids = new Set(ALL_ADDONS);
    mockDeleted.ids = [];
    mockOrder.ids = [];
    mockGroupOrder.keys = [];
    mockHousehold.memberCount = 2;
    mockCustom.list = [
      customCal({ id: 'custom-mine', name: 'Workouts' }), // just me
      customCal({ id: 'custom-hh', name: 'Family Events', sharedWithHousehold: true }), // household
      customCal({ id: 'custom-out', name: 'Soccer', sharedWith: [{ userId: 'u1', access: 'full' }] }), // shared
    ];
  });
  afterEach(cleanup);

  // The reported gap: a calendar created after the built-ins never showed up
  // here, so it could be neither recolored nor placed.
  it('lists every calendar the household has, under its audience section', async () => {
    const view = await render(<CalendarColorsScreen />);
    const labels = view.getAllByText(/^(HOUSEHOLD|JUST ME|SHARED)$/).map((n) => n.props.children);
    expect(labels).toEqual(['HOUSEHOLD', 'JUST ME', 'SHARED']);
    for (const name of ['Activities', 'Family Events', 'Workouts', 'Soccer']) {
      expect(view.getByText(name)).toBeTruthy();
    }
  });

  it('moving a section writes the new section sequence', async () => {
    const view = await render(<CalendarColorsScreen />);
    await fireEvent.press(view.getByLabelText('Move SHARED section up'));
    expect(mockSetGroupOrder).toHaveBeenCalledWith(['household', 'shared', 'justMe']);
  });

  it('a calendar only moves within its own section', async () => {
    const view = await render(<CalendarColorsScreen />);
    // First row of HOUSEHOLD can't go up; the last one can't go down.
    await fireEvent.press(view.getByLabelText('Move Activities up'));
    expect(mockSetOrder).not.toHaveBeenCalled();
    // Swapping two built-ins rewrites the whole displayed sequence, sections in
    // their displayed order, so the other sections keep their arrangement.
    await fireEvent.press(view.getByLabelText('Move Appointments up'));
    const written = mockSetOrder.mock.calls[0][0] as string[];
    expect(written.slice(0, 2)).toEqual(['appointments', 'activities']);
    expect(written.indexOf('custom-mine')).toBeGreaterThan(written.indexOf('custom-hh'));
    expect(written.indexOf('custom-out')).toBeGreaterThan(written.indexOf('custom-mine'));
  });

  // Regression (2026-08-23): built-ins and custom calendars were two lists
  // sorted independently and rendered back to back, so a newly-added calendar
  // was pinned to the bottom of HOUSEHOLD — its "up" chevron and the built-ins'
  // "down" chevrons both appeared to do nothing.
  it('a custom calendar moves up past the built-ins above it', async () => {
    const view = await render(<CalendarColorsScreen />);
    await fireEvent.press(view.getByLabelText('Move Family Events up'));
    const written = mockSetOrder.mock.calls[0][0] as string[];
    // It swapped with the built-in directly above it — HOUSEHOLD's last one in
    // the natural order, Trips.
    expect(written.indexOf('custom-hh')).toBe(written.indexOf('trips') - 1);
  });

  it('renders a custom calendar at the position the saved order gives it', async () => {
    mockOrder.ids = ['activities', 'custom-hh', 'appointments'];
    const view = await render(<CalendarColorsScreen />);
    const names = view
      .getAllByText(/^(Activities|Family Events|Appointments)$/)
      .map((n) => n.props.children);
    // Not "every built-in, then the customs" — one sequence.
    expect(names).toEqual(['Activities', 'Family Events', 'Appointments']);
  });

  it('a built-in moves down past a custom calendar', async () => {
    // The section as the user last left it: the custom calendar sits above
    // Weather, which must still be able to sink below it.
    mockOrder.ids = ['activities', 'appointments', 'custom-hh', 'weather'];
    const view = await render(<CalendarColorsScreen />);
    await fireEvent.press(view.getByLabelText('Move Family Events down'));
    const written = mockSetOrder.mock.calls[0][0] as string[];
    expect(written.slice(0, 4)).toEqual(['activities', 'appointments', 'weather', 'custom-hh']);
  });

  it('solo household: JUST ME merges into HOUSEHOLD, matching the Calendars manager', async () => {
    mockHousehold.memberCount = 1;
    const view = await render(<CalendarColorsScreen />);
    expect(view.queryByText('JUST ME')).toBeNull();
    expect(view.getByText('Workouts')).toBeTruthy();
  });
});
