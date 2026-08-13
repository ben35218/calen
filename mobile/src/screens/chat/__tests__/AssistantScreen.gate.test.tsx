import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react-native';

// The unified Calen view's add-on gate (ai-assistant.md → Chat surfaces): all
// four switcher tabs always render, but a tab whose add-on isn't owned swaps
// its chat body for the shared AddonLockedView (switcher kept above it, so the
// user can hop back); Calendar is never gated; until the entitlement cache
// loads the branch spins instead of flashing the locked view.

const mockRoute = { params: {} as { initial?: string } };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
  useNavigation: () => ({ setOptions: jest.fn(), navigate: jest.fn() }),
}));

// Each assistant body renders as a labelled marker.
jest.mock('../../calendar/CalendarAssistantScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>body:calendar</Text>;
});
jest.mock('../../maintenance/ChoresAssistantScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>body:chores</Text>;
});
jest.mock('../../maintenance/AiTaskPlanChatScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>body:maintenance</Text>;
});
jest.mock('../../trips/TripPickerScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>body:trip-picker</Text>;
});
jest.mock('../../trips/TripAssistantScreen', () => {
  const { Text } = require('react-native');
  return () => <Text>body:trip-assistant</Text>;
});

jest.mock('../../plan/AddonLockedView', () => {
  const { Text } = require('react-native');
  return ({ addon }: { addon: string }) => <Text>{`locked:${addon}`}</Text>;
});

// The switcher mock exposes one tappable per tab so the hop-away path is real.
jest.mock('../../../components/AssistantSwitcher', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  return ({ active, onSelectAssistant }: any) => (
    <View>
      <Text>{`switcher:${active}`}</Text>
      {['calendar', 'chores', 'maintenance', 'trips'].map((id) => (
        <TouchableOpacity key={id} onPress={() => onSelectAssistant?.(id)}>
          <Text>{`tab:${id}`}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
});

jest.mock('../../../components/ui', () => {
  const { Text } = require('react-native');
  return { CenteredLoader: () => <Text>loader</Text> };
});

jest.mock('../../../lib/calendarPrefs', () => ({
  useCalendarColors: () => ({
    colors: { chores: '#c1', maintenance: '#c2', trips: '#c3', recipes: '#c4', birthdays: '#c5' },
  }),
}));

jest.mock('../../../lib/chatHistory', () => ({
  peekResume: () => null,
  requestResume: jest.fn(),
  surfaceToTab: jest.fn(),
  surfaceTripId: () => null,
}));

// Parameterized entitlements per test.
const mockAddons = { owned: new Set<string>(), loaded: true };
jest.mock('../../../lib/addons', () => ({
  useOwnedAddons: () => ({
    owned: mockAddons.owned,
    loaded: mockAddons.loaded,
    isUnlocked: (id: string) => mockAddons.loaded && mockAddons.owned.has(id),
  }),
}));

import AssistantScreen from '../AssistantScreen';

const setup = async (initial: string | undefined, owned: string[], loaded = true) => {
  mockRoute.params = initial ? { initial } : {};
  mockAddons.owned = new Set(owned);
  mockAddons.loaded = loaded;
  return render(<AssistantScreen />);
};

afterEach(cleanup);

describe('AssistantScreen add-on gate', () => {
  it('shows the locked view (with the switcher) for an unowned tab', async () => {
    const { queryByText, getByText } = await setup('chores', []);
    getByText('locked:chores');
    getByText('switcher:chores');
    expect(queryByText('body:chores')).toBeNull();
  });

  it.each([
    ['chores', 'body:chores'],
    ['maintenance', 'body:maintenance'],
    ['trips', 'body:trip-picker'],
  ])('shows the %s body when its add-on is owned', async (tab, body) => {
    const { getByText } = await setup(tab, [tab]);
    getByText(body);
  });

  it('never gates the calendar tab', async () => {
    const { getByText } = await setup(undefined, []);
    getByText('body:calendar');
  });

  it('spins (not the locked view) until the entitlement cache loads', async () => {
    const { queryByText, getByText } = await setup('trips', [], false);
    getByText('loader');
    getByText('switcher:trips');
    expect(queryByText('locked:trips')).toBeNull();
  });

  it('hops back to an unlocked tab from the locked view', async () => {
    const { getByText, queryByText } = await setup('maintenance', []);
    getByText('locked:maintenance');
    fireEvent.press(getByText('tab:calendar'));
    await waitFor(() => getByText('body:calendar'));
    expect(queryByText('locked:maintenance')).toBeNull();
  });
});
