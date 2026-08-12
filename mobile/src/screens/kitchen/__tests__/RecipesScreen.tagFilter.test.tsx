// The recipe library's list shape (specs/features/kitchen.md, "Recipes"). The
// "All" view lists each recipe exactly once — the old group-by-tag rendering
// repeated a multi-tagged recipe under every tag it carried, which read as
// duplicate recipes rather than categories. Selecting a chip narrows to that
// tag's recipes under a single header; Untagged collects the tagless.

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import RecipesScreen from '../RecipesScreen';

const RECIPES = [
  { _id: '1', title: 'Chicken Parm', tags: ['Dinner', 'Chicken'] },
  { _id: '2', title: 'Pancakes', tags: ['Breakfast'] },
  { _id: '3', title: 'Toast' },
];

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: RECIPES, isLoading: false, isRefetching: false, refetch: jest.fn() }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../../api', () => ({ recipesApi: { list: jest.fn(), delete: jest.fn() } }));
jest.mock('../../../lib/e2ee', () => ({ openRecord: jest.fn() }));
jest.mock('../../../lib/replica', () => ({ syncedList: jest.fn() }));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('../../../components/ui', () => {
  const { View, Text, TextInput, TouchableOpacity } = require('react-native');
  const RealReact = require('react');
  return {
    Card: ({ children }: { children: React.ReactNode }) => RealReact.createElement(View, null, children),
    Input: (props: Record<string, unknown>) => RealReact.createElement(TextInput, props),
    Badge: () => null,
    Chip: ({ label, onPress }: { label: string; onPress: () => void }) =>
      RealReact.createElement(TouchableOpacity, { onPress }, RealReact.createElement(Text, null, label)),
    RoundIconButton: () => null,
    SectionHeader: ({ children }: { children: React.ReactNode }) =>
      RealReact.createElement(Text, { testID: 'section-header' }, children),
    SkeletonList: () => null,
    EmptyState: ({ title }: { title: string }) => RealReact.createElement(Text, null, title),
    SwipeableRow: ({ children }: { children: React.ReactNode }) => RealReact.createElement(View, null, children),
  };
});

describe('RecipesScreen tag filtering', () => {
  afterEach(cleanup);

  it('lists a multi-tagged recipe once in the All view, with no section headers', async () => {
    await render(<RecipesScreen />);

    expect(screen.getAllByText('Chicken Parm')).toHaveLength(1);
    expect(screen.getAllByText('Pancakes')).toHaveLength(1);
    expect(screen.getAllByText('Toast')).toHaveLength(1);
    expect(screen.queryAllByTestId('section-header')).toHaveLength(0);
  });

  it('narrows to one headed section when a tag chip is selected', async () => {
    await render(<RecipesScreen />);

    await act(async () => { fireEvent.press(screen.getByText('Chicken')); });

    expect(screen.getByTestId('section-header')).toHaveTextContent('Chicken');
    expect(screen.getByText('Chicken Parm')).toBeTruthy();
    expect(screen.queryByText('Pancakes')).toBeNull();
    expect(screen.queryByText('Toast')).toBeNull();
  });

  it('collects tagless recipes under the Untagged chip', async () => {
    await render(<RecipesScreen />);

    await act(async () => { fireEvent.press(screen.getByText('Untagged')); });

    expect(screen.getByText('Toast')).toBeTruthy();
    expect(screen.queryByText('Chicken Parm')).toBeNull();
    expect(screen.queryByText('Pancakes')).toBeNull();
  });
});
