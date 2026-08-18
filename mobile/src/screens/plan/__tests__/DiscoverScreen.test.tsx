import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The Discover modal's contract (billing-plans.md → Discovery): it renders a
// card per UNOWNED add-on only — from the LIVE owned set, so an owned add-on
// is never promoted — badges the free ones, drops the whole add-on section
// when everything is owned (brainstorm pitch alone), and every route out
// closes the modal first so the target's back gesture lands on the calendar.
// The cadence deciding when this screen appears lives in lib/discoverNudge
// and is tested there.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

jest.mock('../../../components/CalenGlyph', () => () => null);

// Stub the shared UI kit so the test doesn't drag in native modules
// (keyboard-controller / reanimated) that ui.tsx imports. CardRow keeps its
// tap + title/subtitle/titleRight contract so rows are assertable.
jest.mock('../../../components/ui', () => {
  const ReactActual = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    Badge: ({ label }: any) => ReactActual.createElement(Text, null, label),
    Button: ({ title, onPress }: any) =>
      ReactActual.createElement(
        TouchableOpacity,
        { onPress, accessibilityRole: 'button' },
        ReactActual.createElement(Text, null, title)
      ),
    Card: ({ children }: any) => ReactActual.createElement(View, null, children),
    CardRow: ({ title, subtitle, titleRight, onPress }: any) =>
      ReactActual.createElement(
        TouchableOpacity,
        { onPress },
        ReactActual.createElement(Text, null, title),
        titleRight ?? null,
        subtitle ?? null
      ),
    IconAvatar: () => null,
    Screen: ({ children }: any) => ReactActual.createElement(View, null, children),
    SectionHeader: ({ children }: any) => ReactActual.createElement(Text, null, children),
  };
});

// Parameterized owned set per test; the id helpers stay real.
const mockOwned = { set: new Set<string>() };
jest.mock('../../../lib/addons', () => ({
  ...jest.requireActual('../../../lib/addons'),
  useOwnedAddons: () => ({
    owned: mockOwned.set,
    loaded: true,
    isUnlocked: (id: string) => mockOwned.set.has(id),
  }),
}));

jest.mock('../../../lib/calendarPrefs', () => ({
  CALENDARS: [
    { id: 'birthdays', name: 'Occasions', color: '#E91E63', group: 'basic' },
    { id: 'chores', name: 'Chores', color: '#F57C00', group: 'advanced' },
    { id: 'recipes', name: 'Meals', color: '#00897B', group: 'advanced' },
    { id: 'maintenance', name: 'Maintenance', color: '#1976D2', group: 'advanced' },
    { id: 'trips', name: 'Trips', color: '#5E35B1', group: 'advanced' },
  ],
  useCalendarColors: () => ({ colors: {} }),
}));

jest.mock('../../../config', () => ({ ASSISTANT_NAME: 'Calen' }));

import DiscoverScreen from '../DiscoverScreen';

const ALL = ['recipes', 'maintenance', 'trips', 'birthdays', 'chores'];

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  mockOwned.set = new Set();
});

it('renders a card per unowned add-on, free ones badged', async () => {
  const { getByText, getAllByText } = await render(<DiscoverScreen />);
  for (const name of ['Meals', 'Maintenance', 'Trips', 'Occasions', 'Chores']) {
    expect(getByText(name)).toBeTruthy();
  }
  // Occasions + Chores are the free opt-ins.
  expect(getAllByText('Free')).toHaveLength(2);
  expect(getByText('See all add-ons')).toBeTruthy();
});

it('never promotes an owned add-on', async () => {
  mockOwned.set = new Set(['recipes', 'birthdays']);
  const { queryByText, getByText } = await render(<DiscoverScreen />);
  expect(queryByText('Meals')).toBeNull();
  expect(queryByText('Occasions')).toBeNull();
  expect(getByText('Trips')).toBeTruthy();
  expect(getByText('Chores')).toBeTruthy();
});

it('all add-ons owned → the add-on section disappears, brainstorm pitch alone', async () => {
  mockOwned.set = new Set(ALL);
  const { queryByText, getByText } = await render(<DiscoverScreen />);
  expect(queryByText('Add-ons')).toBeNull();
  expect(queryByText('See all add-ons')).toBeNull();
  expect(getByText(/unlocked everything/)).toBeTruthy();
  expect(getByText('Chat with Calen')).toBeTruthy();
});

it('an add-on card closes the modal, then opens the store focused on it', async () => {
  const { getByText } = await render(<DiscoverScreen />);
  fireEvent.press(getByText('Trips'));
  expect(mockGoBack).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('AddOns', { focus: 'trips' });
});

it('the brainstorm CTA closes the modal, then opens the assistant', async () => {
  const { getByText } = await render(<DiscoverScreen />);
  fireEvent.press(getByText('Chat with Calen'));
  expect(mockGoBack).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('Assistant', undefined);
});
