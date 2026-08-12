// The "n of m" shopping progress on the grocery card (specs/features/kitchen.md,
// "Organize renames items for the aisle"). Shopping state is keyed by the name
// a row *displays*, and Organize renames items — so the plain list and the
// organized list are different key spaces. Counting the plain list while the
// organized one was on screen pinned the progress at "0 of 13" no matter how
// many boxes the shopper ticked. The count belongs to whatever is being checked
// off, which is what this suite pins.

import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react-native';
import GroceryPane from '../GroceryPane';
import { groceryFingerprint } from '../../../lib/groceryOrganize';

// The raw week's list, as aggregated from recipes: recipe-style names.
const mockItems = [
  { name: 'garlic cloves, minced', entries: [{ recipeTitle: 'Pesto', amount: '3', unit: 'cloves', multiplier: 1 }] },
  { name: 'fresh basil leaves', entries: [{ recipeTitle: 'Pesto', amount: '2', unit: 'tbsp', multiplier: 1 }] },
  { name: 'whole milk, chilled', entries: [{ recipeTitle: 'Pancakes', amount: '2', unit: 'cups', multiplier: 1 }] },
];

// The same week after Organize: shopper-facing names, so none of the keys above
// match any row on screen.
const mockOrganized = {
  store_known: false,
  categories: [
    { name: 'Produce', aisle: '', items: [{ name: 'Garlic Cloves', amount: '3 cloves' }, { name: 'Basil', amount: '2 tbsp' }] },
    { name: 'Dairy', aisle: '', items: [{ name: 'Whole Milk', amount: '2 cups' }] },
  ],
};

let mockSession: Record<string, unknown> = {};

jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'settings') return { data: { groceryFrequency: 'weekly' } };
    if (queryKey[0] === 'grocery-session') return { data: mockSession };
    return { data: mockItems, isLoading: false };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
  useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }),
}));
jest.mock('../../../api', () => ({
  settingsApi: { get: jest.fn() },
  recipeScheduleApi: { sessionGet: jest.fn(), sessionPut: () => Promise.resolve() },
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

// The row's check box is an icon button labelled with the item it belongs to.
const check = async (name: string) => {
  await act(async () => { fireEvent.press(screen.getByLabelText(name)); });
};

describe('GroceryPane shopping progress', () => {
  afterEach(cleanup);

  it('counts what the organized view is showing, not the raw list behind it', async () => {
    mockSession = { organizedList: mockOrganized, organizedFor: groceryFingerprint(mockItems) };
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    // Three organized rows, none done yet.
    expect(screen.getByText('0 of 3')).toBeTruthy();

    await check('Basil');
    expect(screen.getByText('1 of 3')).toBeTruthy();

    await check('Whole Milk');
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  it('counts the flat list while nothing has been organized yet', async () => {
    mockSession = {};
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    expect(screen.getByText('0 of 3')).toBeTruthy();
    await check('fresh basil leaves');
    expect(screen.getByText('1 of 3')).toBeTruthy();
  });

});
