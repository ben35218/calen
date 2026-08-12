// The grocery card's action band (specs/features/kitchen.md, "Organize renames
// items for the aisle"). What's pinned: the organized view is the ONLY view
// once it exists (there is no plain-list flip), a plan edit patches it locally
// (lib/groceryOrganize) — never silently re-billed, never silently stale —
// filing by hand is a standing name-tap gesture with no mode or extra button,
// and the AI action is always in the band.

import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react-native';
import GroceryPane from '../GroceryPane';
import { groceryFingerprint } from '../../../lib/groceryOrganize';

const mockItems = [
  { name: 'Basil', entries: [{ recipeTitle: 'Pesto', amount: '2', unit: 'tbsp', multiplier: 1 }] },
  { name: 'Whole Milk', entries: [{ recipeTitle: 'Pancakes', amount: '2', unit: 'cups', multiplier: 1 }] },
];

const mockOrganized = {
  store_known: false,
  categories: [
    { name: 'Produce', aisle: '', items: [{ name: 'Basil', amount: '2 tbsp' }] },
    { name: 'Dairy', aisle: '', items: [{ name: 'Whole Milk', amount: '2 cups' }] },
  ],
};

let mockSession: Record<string, unknown> = {};
const mockOrganizeMutate = jest.fn();
const mockSessionPut = jest.fn(() => Promise.resolve());

jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'settings') return { data: { groceryFrequency: 'weekly' } };
    if (queryKey[0] === 'grocery-session') return { data: mockSession };
    return { data: mockItems, isLoading: false };
  },
  useMutation: () => ({ mutate: mockOrganizeMutate, isPending: false }),
  useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }),
}));

jest.mock('../../../api', () => ({
  settingsApi: { get: jest.fn() },
  recipeScheduleApi: { sessionGet: jest.fn(), sessionPut: () => mockSessionPut() },
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

describe('GroceryPane organize / plain-list toggle', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(cleanup);

  it('offers Organize when nothing has been organized yet', async () => {
    mockSession = {};
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    // One label in every state — never "Re-organize", which would claim a
    // history a first-time shopper doesn't have.
    expect(screen.queryByText('Re-organize')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Organize')); });
    expect(mockOrganizeMutate).toHaveBeenCalled();
  });

  it('patches a drifted organized list locally, with Organize still on offer', async () => {
    // Organized before Pancakes joined the plan: the saved list only knows
    // Basil, and the week now also has Whole Milk.
    mockSession = {
      organizedList: {
        store_known: false,
        categories: [{ name: 'Produce', aisle: '', items: [{ name: 'Basil', amount: '2 tbsp' }] }],
      },
      organizedFor: groceryFingerprint([mockItems[0]]),
    };
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    // The organization survives — no retire, no silent AI call…
    expect(screen.getByText('Produce')).toBeTruthy();
    expect(screen.getByText('Basil')).toBeTruthy();
    expect(mockOrganizeMutate).not.toHaveBeenCalled();
    // …the new ingredient surfaces immediately, unfiled…
    expect(screen.getByText('New Items')).toBeTruthy();
    expect(screen.getByText('Whole Milk')).toBeTruthy();
    // …and the count follows the patched rows.
    expect(screen.getByText('0 of 2')).toBeTruthy();

    // Filing New Items into real sections is the user's call to make (and pay for).
    await act(async () => { fireEvent.press(screen.getByText('Organize')); });
    expect(mockOrganizeMutate).toHaveBeenCalled();
  });

  it('keeps Organize on offer even while the plan matches', async () => {
    mockSession = { organizedList: mockOrganized, organizedFor: groceryFingerprint(mockItems) };
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    // The AI path always sits on the title row; only the patch artifacts are
    // absent while nothing has drifted.
    expect(screen.getByText('Organize')).toBeTruthy();
    expect(screen.queryByText('New Items')).toBeNull();
  });

  it('keeps showing a pre-fingerprint saved list', async () => {
    mockSession = { organizedList: mockOrganized };
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    expect(screen.getByText('Produce')).toBeTruthy();
    expect(screen.getByText('Dairy')).toBeTruthy();
  });

  it('organizes manually from the plain list: the first name-tap creates the sections', async () => {
    mockSession = {};
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    // No mode to enter — the ⓘ hint explains the standing gesture, and a plain
    // row's name goes straight to the section sheet.
    expect(screen.getByText('Tap an item to move it into a section.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Move Basil to a section')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Move to Produce')); });

    // The move created the organized list: Basil filed, the rest under New
    // Items, the AI path still available — and nothing was billed.
    expect(screen.getByText('Produce')).toBeTruthy();
    expect(screen.getByText('New Items')).toBeTruthy();
    expect(screen.getByText('Whole Milk')).toBeTruthy();
    expect(screen.getByText('Organize')).toBeTruthy();
    expect(mockOrganizeMutate).not.toHaveBeenCalled();

    // File the last one too: nothing left unfiled.
    await act(async () => { fireEvent.press(screen.getByLabelText('Move Whole Milk to a section')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Move to Dairy')); });
    expect(screen.queryByText('New Items')).toBeNull();
    expect(screen.getByText('Dairy')).toBeTruthy();
  });

  it('moves a row between sections from the organized view', async () => {
    mockSession = { organizedList: mockOrganized, organizedFor: groceryFingerprint(mockItems) };
    await render(<GroceryPane weekStart={new Date(2026, 7, 8)} onShowPlanner={jest.fn()} />);

    await act(async () => { fireEvent.press(screen.getByLabelText('Move Basil to a section')); });
    // The sheet marks where the item already lives.
    expect(screen.getByLabelText('Produce, current section')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Move to Frozen')); });

    expect(screen.queryByText('Produce')).toBeNull(); // emptied by the move
    expect(screen.getByText('Frozen')).toBeTruthy();
    expect(mockOrganizeMutate).not.toHaveBeenCalled();
  });
});
