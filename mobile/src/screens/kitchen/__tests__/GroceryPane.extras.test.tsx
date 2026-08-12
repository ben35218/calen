// Two things the grocery card owes a shopper standing in a store
// (specs/features/kitchen.md): a way to add what no recipe implies, and a
// section sheet whose title says what the rows in it ARE.

import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react-native';
import GroceryPane from '../GroceryPane';

const SESSION = { organizedList: null };
const DERIVED = [{ name: 'Basil' }, { name: 'Whole Milk' }];

jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'settings') return { data: { groceryFrequency: 'weekly' } };
    if (queryKey[0] === 'grocery-session') return { data: SESSION };
    return { data: DERIVED, isLoading: false };
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
  const RealReact = require('react');
  const { View, Text, TextInput } = require('react-native');
  return {
    Card: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
      RealReact.createElement(View, { style }, children),
    Divider: () => null,
    Skeleton: () => null,
    Hint: ({ children }: { children: React.ReactNode }) => RealReact.createElement(Text, null, children),
    HintDisclosure: ({ label }: { label: React.ReactNode }) => RealReact.createElement(View, null, label),
    Input: (props: Record<string, unknown>) => RealReact.createElement(TextInput, props),
    // Pass-through: the swipe itself is the shared component's business; what
    // this suite pins is which rows get one.
    SwipeableRow: ({ children, accessibilityLabel }: { children: React.ReactNode; accessibilityLabel?: string }) =>
      RealReact.createElement(View, { accessibilityLabel }, children),
    BottomSheet: ({ visible, title, children }: { visible: boolean; title?: string; children: React.ReactNode }) =>
      visible ? RealReact.createElement(View, null, title ? RealReact.createElement(Text, null, title) : null, children) : null,
  };
});

describe('GroceryPane hand-added items', () => {
  afterEach(cleanup);

  it('adds an item the meal plan never called for, and keeps the field open for the next one', async () => {
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    await act(async () => { fireEvent.press(screen.getByText('Add item')); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('Item'), 'paper towels'); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('Amount'), '2 rolls'); });
    await act(async () => { fireEvent.press(screen.getByText('Add')); });

    // Title-cased, filed alphabetically among the derived rows, with its amount.
    expect(screen.getByText('Paper Towels')).toBeTruthy();
    expect(screen.getByText('2 rolls')).toBeTruthy();
    // Still open and emptied — a shopper adds several things in a row.
    expect(screen.getByPlaceholderText('Item').props.value).toBe('');
    // Only the hand-added row can be taken off the list.
    expect(screen.getByLabelText('Delete Paper Towels')).toBeTruthy();
    expect(screen.queryByLabelText('Delete Basil')).toBeNull();
  });

  it('titles the move sheet with what its rows are, and captions it with the item', async () => {
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    await act(async () => { fireEvent.press(screen.getByLabelText('Move Basil to a section')); });

    expect(screen.getByText('Grocery List Sections')).toBeTruthy();
    expect(screen.getByText(/Move Basil to:/)).toBeTruthy();
    expect(screen.getByText('Produce')).toBeTruthy();
  });
});
