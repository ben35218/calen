// The organized grocery list's section headers (specs/features/kitchen.md,
// "Organize renames items for the aisle"). The household's section order
// constrains the model to a fixed list, so it routinely returns sections the
// week's meals never filled — and a bare "Bakery" header over no rows reads as
// a list that failed to load. The server drops empty sections now, but an
// organized list from before that shipped is persisted in ShoppingSession, so
// what this pins is that the *render* skips them too.

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import GroceryPane from '../GroceryPane';

const SESSION = {
  organizedList: {
    store_known: false,
    categories: [
      { name: 'Produce', aisle: '', items: [{ name: 'Basil', amount: '2 tbsp' }] },
      { name: 'Bakery', aisle: '', items: [] },
      { name: 'Deli', aisle: '' },
      { name: 'Dairy', aisle: '', items: [{ name: 'Whole Milk', amount: '2 cups' }] },
    ],
  },
};

jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'settings') return { data: { groceryFrequency: 'weekly' } };
    if (queryKey[0] === 'grocery-session') return { data: SESSION };
    return { data: [{ name: 'Basil' }, { name: 'Whole Milk' }], isLoading: false };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
  useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }),
}));

jest.mock('../../../api', () => ({
  settingsApi: { get: jest.fn() },
  recipeScheduleApi: { sessionGet: jest.fn(), sessionPut: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../../lib/groceryList', () => ({ loadGroceryList: jest.fn() }));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('../../../components/CreditsBanner', () => () => null);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => {
  const { ScrollView } = require('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});
jest.mock('../../../components/ui', () => {
  const { View, TextInput } = require('react-native');
  const RealReact = require('react');
  const { Text } = require('react-native');
  return {
    Card: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
      RealReact.createElement(View, { style }, children),
    Divider: () => null,
    Hint: ({ children }: { children: React.ReactNode }) => RealReact.createElement(Text, null, children),
    // Always-open stand-in: label and hint both render, so tests can assert the
    // hint copy without simulating the toggle.
    HintDisclosure: ({ label, hint }: { label: React.ReactNode; hint: React.ReactNode }) =>
      RealReact.createElement(View, null, label, RealReact.createElement(Text, null, hint)),
    Input: (props: Record<string, unknown>) => RealReact.createElement(TextInput, props),
    BottomSheet: ({ visible, title, children }: { visible: boolean; title?: string; children: React.ReactNode }) =>
      visible ? RealReact.createElement(View, null, title ? RealReact.createElement(Text, null, title) : null, children) : null,
  };
});

describe('GroceryPane organized sections', () => {
  afterEach(cleanup);

  it('shows a section header only when the section has something to buy', async () => {
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    expect(screen.getByText('Produce')).toBeTruthy();
    expect(screen.getByText('Dairy')).toBeTruthy();
    expect(screen.queryByText('Bakery')).toBeNull();
    // A section the model returned with no `items` key at all, not just an
    // empty one — the render must not blow up reading its length either.
    expect(screen.queryByText('Deli')).toBeNull();

    expect(screen.getByText('Basil')).toBeTruthy();
    expect(screen.getByText('Whole Milk')).toBeTruthy();
  });
});
