import React from 'react';
import { render, cleanup } from '@testing-library/react-native';

// Regression: the Colours & Order list must not offer calendars the household
// doesn't have — locked add-on calendars are excluded (calendar.md →
// feature-calendar add-ons: locked ids hide from every calendar surface).

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// Stub the shared UI kit (the screen only uses Hint) so the test doesn't drag
// in native modules (keyboard-controller / reanimated) that ui.tsx imports.
jest.mock('../../../components/ui', () => ({ Hint: () => null }));

jest.mock('../../../lib/calendarPrefs', () => {
  const actual = jest.requireActual('../../../lib/calendarPrefs');
  return {
    CALENDARS: actual.CALENDARS,
    COLOR_PRESETS: actual.COLOR_PRESETS,
    sortByCalendarOrder: actual.sortByCalendarOrder,
    useCalendarColors: () => ({ colors: {}, setColor: jest.fn(), resetColor: jest.fn() }),
    useCalendarOrder: () => ({ order: [], setOrder: jest.fn() }),
    useHolidayCalendars: () => ({
      calendars: [{ id: 'custom-hol', country: 'CA', name: 'Canadian Holidays', color: '#D32F2F', selectedRegions: [], disabledIds: [] }],
    }),
  };
});

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

describe('CalendarColorsScreen add-on gating', () => {
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
});
