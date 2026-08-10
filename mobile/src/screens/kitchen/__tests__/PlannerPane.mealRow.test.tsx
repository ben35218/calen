// A meal row on the Meals view (specs/features/kitchen.md, "Meal planner &
// grocery"). The row used to carry a red ✕ that fired the delete on the first
// tap — a permanent mistap target sitting on something the user overwhelmingly
// means to *open*. It's now swipe-to-remove behind the native confirm, so what
// this suite pins is that nothing destructive happens until the confirm is
// answered, and that the row's own tap still opens the recipe.

import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import PlannerPane from '../PlannerPane';
import { iso } from '../constants';

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ setOptions: jest.fn(), setParams: jest.fn(), navigate: mockNavigate }),
  useRoute: () => ({ params: {} }),
}));

const MEAL = { _id: 'sch1', recipeId: 'r1', title: 'Chili' };
const mockMutate = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    (queryKey[0] === 'settings'
      ? { data: { groceryShoppingDay: 6, groceryFrequency: 'weekly', groceryAnchor: null } }
      : { data: [{ ...MEAL, day: mockDay }], isLoading: false }),
  // The screen's remove mutation, so a confirmed Remove is observable.
  useMutation: () => ({ mutate: mockMutate }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../../api', () => ({ settingsApi: { get: jest.fn() }, recipeScheduleApi: { remove: jest.fn() } }));
jest.mock('../../../lib/mealSchedule', () => ({ loadPlannerMeals: jest.fn(), scheduleRecipeId: () => 'r1' }));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
// Stand-ins for the shared kit (which pulls native modules in transitively).
// SwipeableRow's contract is what matters here: it renders the row, and its
// revealed action calls `onDelete` — it never deletes anything itself.
jest.mock('../../../components/ui', () => {
  const { View, Text, TouchableOpacity } = require('react-native');
  const RealReact = require('react');
  return {
    Card: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
      RealReact.createElement(View, { style }, children),
    SwipeableRow: ({ children, onDelete, label }: { children: React.ReactNode; onDelete: () => void; label?: string }) =>
      RealReact.createElement(
        View,
        null,
        children,
        RealReact.createElement(
          TouchableOpacity,
          { onPress: onDelete, testID: 'swipe-action' },
          RealReact.createElement(Text, null, label),
        ),
      ),
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));

const WEEK_START = new Date(2026, 7, 8, 0, 0, 0);
const mockDay = iso(WEEK_START);

describe('PlannerPane meal row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it("opens the recipe when the row itself is tapped", async () => {
    await render(<PlannerPane weekStart={WEEK_START} />);

    fireEvent.press(screen.getByText('Chili'));

    expect(mockNavigate).toHaveBeenCalledWith('RecipeDetail', { id: 'r1' });
  });

  it('labels the swipe action Remove and only removes once the confirm is answered', async () => {
    await render(<PlannerPane weekStart={WEEK_START} />);

    expect(screen.getByText('Remove')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('swipe-action')); });

    // The swipe itself commits nothing — the native confirm is the gate.
    expect(mockMutate).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalled();

    const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe('Remove meal?');
    // The recipe survives — say so, or the safe action reads as the dangerous one.
    expect(message).toMatch(/recipe stays in your library/i);
    expect(buttons[0]).toMatchObject({ style: 'cancel' });

    const destructive = buttons.find((b: { style?: string }) => b.style === 'destructive');
    expect(destructive.text).toBe('Remove');
    destructive.onPress();
    expect(mockMutate).toHaveBeenCalledWith('sch1');
  });
});
