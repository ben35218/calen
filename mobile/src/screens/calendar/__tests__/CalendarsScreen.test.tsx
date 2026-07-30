import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The Calendars manager's interaction contract (calendar.md → Calendars view):
// tapping a row toggles visibility (rows are single-purpose), navigation lives
// in the trailing Open pill / edit button, and locked add-on calendars collapse
// into one storefront row instead of rendering in HOUSEHOLD.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// The household member-count query (drives solo-household group merging).
// useQuery is mocked so the real householdApi is never called.
const mockHousehold = { memberCount: 2 as number | undefined };
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockHousehold.memberCount }),
}));

const mockSetVisible = jest.fn();
// Parameterized custom-calendar list per test.
const mockCustom = { list: [] as unknown[] };
jest.mock('../../../lib/calendarPrefs', () => {
  const actual = jest.requireActual('../../../lib/calendarPrefs');
  return {
    CALENDARS: actual.CALENDARS,
    sortByCalendarOrder: actual.sortByCalendarOrder,
    useCalendarVisibility: () => ({ visibility: { chores: false }, setVisible: mockSetVisible }),
    useCalendarColors: () => ({ colors: {} }),
    useCustomCalendars: () => ({ calendars: mockCustom.list }),
    useDeletedDefaultCalendars: () => ({ deletedIds: [] }),
    useCalendarOrder: () => ({ order: [] }),
    refreshCustomCalendars: jest.fn().mockResolvedValue(undefined),
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

// Parameterized add-on ownership per test.
const mockOwned = { ids: new Set<string>(['recipes', 'maintenance', 'trips', 'birthdays', 'chores']) };
jest.mock('../../../lib/addons', () => {
  const actual = jest.requireActual('../../../lib/addons');
  return {
    ADDON_CALENDAR_IDS: actual.ADDON_CALENDAR_IDS,
    isAddonCalendar: actual.isAddonCalendar,
    isFreeAddon: actual.isFreeAddon,
    useOwnedAddons: () => ({
      owned: mockOwned.ids,
      loaded: true,
      isUnlocked: (id: string) => !actual.isAddonCalendar(id) || mockOwned.ids.has(id),
    }),
  };
});
jest.mock('../../../hooks/useBilling', () => ({
  useBilling: () => ({
    data: {
      addonCatalog: {
        items: [
          { key: 'recipes', label: 'Meals', price: 2.99, description: '' },
          { key: 'maintenance', label: 'Maintenance', price: 2.99, description: '' },
          { key: 'trips', label: 'Trips', price: 2.99, description: '' },
          { key: 'birthdays', label: 'Birthdays', price: 0, description: '' },
          { key: 'chores', label: 'Chores', price: 0, description: '' },
        ],
        bundle: { label: 'All add-ons', price: 7.99, description: '' },
      },
    },
  }),
}));

import CalendarsScreen from '../CalendarsScreen';

describe('CalendarsScreen rows', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetVisible.mockClear();
    mockOwned.ids = new Set(['recipes', 'maintenance', 'trips', 'birthdays', 'chores']);
    mockCustom.list = [];
  });
  afterEach(cleanup);

  it('tapping a row toggles visibility and never navigates', async () => {
    const view = await render(<CalendarsScreen />);
    await fireEvent.press(view.getByLabelText('Activities calendar'));
    expect(mockSetVisible).toHaveBeenCalledWith('activities', false); // visible → hide
    await fireEvent.press(view.getByLabelText('Chores calendar'));
    expect(mockSetVisible).toHaveBeenCalledWith('chores', true); // hidden → show
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('the Open pill navigates to the feature home; the edit button opens Edit Calendar', async () => {
    const view = await render(<CalendarsScreen />);
    await fireEvent.press(view.getByLabelText('Open Meals'));
    expect(mockNavigate).toHaveBeenCalledWith('KitchenHome');
    await fireEvent.press(view.getByLabelText('Edit Activities calendar'));
    expect(mockNavigate).toHaveBeenCalledWith('AddCalendar', { calendarId: 'activities' });
    expect(mockSetVisible).not.toHaveBeenCalled();
  });

  it('feature calendars carry BOTH the Open pill and the edit button', async () => {
    const view = await render(<CalendarsScreen />);
    expect(view.getByLabelText('Open Meals')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('Edit Meals calendar'));
    expect(mockNavigate).toHaveBeenCalledWith('AddCalendar', { calendarId: 'recipes' });
  });

  it('holiday calendars: Open pill opens the holidays editor; the edit button opens Edit Calendar', async () => {
    mockCustom.list = [
      customCal({ id: 'custom-hol', name: 'Canadian Holidays', holiday: { country: 'CA', selectedRegions: [], disabledIds: [] } }),
    ];
    const view = await render(<CalendarsScreen />);
    await fireEvent.press(view.getByLabelText('Open Canadian Holidays'));
    expect(mockNavigate).toHaveBeenCalledWith('Holidays', { calendarId: 'custom-hol' });
    await fireEvent.press(view.getByLabelText('Edit Canadian Holidays calendar'));
    expect(mockNavigate).toHaveBeenCalledWith('AddCalendar', { calendarId: 'custom-hol' });
  });
});

describe('CalendarsScreen grouping', () => {
  beforeEach(() => {
    mockOwned.ids = new Set(['recipes', 'maintenance', 'trips', 'birthdays', 'chores']);
    mockCustom.list = [];
    mockHousehold.memberCount = 2;
  });
  afterEach(cleanup);

  it('orders groups HOUSEHOLD → JUST ME → SHARED', async () => {
    mockCustom.list = [
      customCal({ id: 'custom-mine', name: 'Workouts' }), // just me
      customCal({ id: 'custom-out', name: 'Soccer', sharedWith: [{ userId: 'u1', access: 'full' }] }), // shared
    ];
    const view = await render(<CalendarsScreen />);
    const labels = view
      .getAllByText(/^(HOUSEHOLD|JUST ME|SHARED)$/)
      .map((n) => n.props.children);
    expect(labels).toEqual(['HOUSEHOLD', 'JUST ME', 'SHARED']);
  });

  it('every SHARED row states its direction: shared by you (with count) vs shared with you', async () => {
    mockCustom.list = [
      customCal({
        id: 'custom-out',
        name: 'Soccer',
        sharedWith: [{ userId: 'u1', access: 'full' }],
        sharedWithOutside: [{ email: 'a@b.c', access: 'view' }],
      }),
      customCal({ id: 'custom-in', name: 'Carpool', mine: false }),
    ];
    const view = await render(<CalendarsScreen />);
    expect(view.getByText('Shared by you · 2 people')).toBeTruthy();
    expect(view.getByText('Shared with you')).toBeTruthy();
  });

  it('household-wide custom calendars carry no direction subtitle (the group says it)', async () => {
    mockCustom.list = [
      customCal({ id: 'custom-hh', name: 'Family Events', sharedWithHousehold: true }),
    ];
    const view = await render(<CalendarsScreen />);
    expect(view.getByText('Family Events')).toBeTruthy();
    expect(view.queryByText(/Shared by you/)).toBeNull();
  });

  it('solo household: unshared calendars merge into HOUSEHOLD and JUST ME disappears', async () => {
    mockHousehold.memberCount = 1;
    mockCustom.list = [
      customCal({ id: 'custom-hol', name: 'Canadian Holidays', holiday: { country: 'CA', selectedRegions: [], disabledIds: [] } }),
    ];
    const view = await render(<CalendarsScreen />);
    expect(view.queryByText('JUST ME')).toBeNull();
    expect(view.getByText('Canadian Holidays')).toBeTruthy();
    // Everything renders under the one HOUSEHOLD group.
    expect(view.getByText('HOUSEHOLD')).toBeTruthy();
  });

  it('with a second member, unshared calendars return to a meaningful JUST ME group', async () => {
    mockHousehold.memberCount = 2;
    mockCustom.list = [
      customCal({ id: 'custom-hol', name: 'Canadian Holidays', holiday: { country: 'CA', selectedRegions: [], disabledIds: [] } }),
    ];
    const view = await render(<CalendarsScreen />);
    expect(view.getByText('JUST ME')).toBeTruthy();
    expect(view.getByText('Canadian Holidays')).toBeTruthy();
  });
});

describe('CalendarsScreen add-ons storefront', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockOwned.ids = new Set();
  });
  afterEach(cleanup);

  it('locked add-on calendars (paid and unclaimed-free alike) collapse into one storefront row', async () => {
    const view = await render(<CalendarsScreen />);
    // No per-calendar rows for locked add-ons…
    expect(view.queryByLabelText('Meals calendar')).toBeNull();
    expect(view.queryByLabelText('Open Trips')).toBeNull();
    expect(view.queryByLabelText('Occasions calendar')).toBeNull();
    expect(view.queryByLabelText('Chores calendar')).toBeNull();
    // …just the single storefront row naming the full add-on catalog, in store
    // order, with no price — the store screen does the selling.
    expect(view.getByText('Meals, Maintenance, Trips, Occasions & Chores')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('Add-ons'));
    expect(mockNavigate).toHaveBeenCalledWith('AddOns');
  });

  it('unclaimed free add-ons still fold into the one storefront row (no standalone rows)', async () => {
    mockOwned.ids = new Set(['recipes', 'maintenance', 'trips']);
    const view = await render(<CalendarsScreen />);
    // The still-locked free add-ons don't render as their own calendar rows…
    expect(view.queryByLabelText('Occasions calendar')).toBeNull();
    expect(view.queryByLabelText('Open Occasions')).toBeNull();
    expect(view.queryByLabelText('Chores calendar')).toBeNull();
    // …they collapse into the storefront row, which always names the full
    // catalog in store order with no price (owned or not).
    expect(view.getByLabelText('Add-ons')).toBeTruthy();
    expect(view.getByText('Meals, Maintenance, Trips, Occasions & Chores')).toBeTruthy();
  });

  it('all add-ons owned: rows render normally and the storefront row persists as the manage entry', async () => {
    mockOwned.ids = new Set(['recipes', 'maintenance', 'trips', 'birthdays', 'chores']);
    const view = await render(<CalendarsScreen />);
    expect(view.getByLabelText('Open Meals')).toBeTruthy();
    expect(view.getByLabelText('Open Occasions')).toBeTruthy();
    // The row is permanent — the entry point keeps its learned location and
    // future add-ons surface here — but its subtitle flips to a status line
    // instead of re-selling the owned catalog.
    expect(view.getByText('All add-ons added')).toBeTruthy();
    expect(view.queryByText('Meals, Maintenance, Trips, Occasions & Chores')).toBeNull();
    await fireEvent.press(view.getByLabelText('Add-ons'));
    expect(mockNavigate).toHaveBeenCalledWith('AddOns');
  });
});
