// The planner's `scrollToDate` arrival (specs/features/kitchen.md, "Meal planner
// & grocery"): tapping a recipe's "Next scheduled" date — or saving a recipe
// from the planner's Add-recipe flow — lands here with the day to reveal.
//
// The trap this pins: a recipe can be scheduled weeks out, so KitchenScreen has
// to realign the shopping period *first* (the `weekStart` param) and PlannerPane
// renders once with the old period still mounted. If the pane consumed the param
// on that pass, it would clear it before the right week ever rendered and the
// user would land on an arbitrary day with nothing highlighted.

import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import PlannerPane from '../PlannerPane';
import { iso } from '../constants';

const mockStore: { params: Record<string, unknown> } = { params: {} };
const mockSubscribers = new Set<() => void>();
const mockSetParams = jest.fn((p: Record<string, unknown>) => {
  mockStore.params = { ...mockStore.params, ...p };
  mockSubscribers.forEach((fn) => fn());
});

jest.mock('@react-navigation/native', () => {
  const RealReact = require('react');
  return {
    useNavigation: () => ({ setOptions: jest.fn(), setParams: mockSetParams, navigate: jest.fn() }),
    useRoute: () => {
      const [, force] = RealReact.useReducer((x: number) => x + 1, 0);
      RealReact.useEffect(() => {
        mockSubscribers.add(force);
        return () => mockSubscribers.delete(force);
      }, []);
      return { params: mockStore.params };
    },
  };
});

// Weekly cadence, no meals — the window itself is what's under test.
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    (queryKey[0] === 'settings'
      ? { data: { groceryShoppingDay: 6, groceryFrequency: 'weekly', groceryAnchor: null } }
      : { data: [], isLoading: false }),
  useMutation: () => ({ mutate: jest.fn() }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../../api', () => ({ settingsApi: { get: jest.fn() }, recipeScheduleApi: { remove: jest.fn() } }));
jest.mock('../../../lib/mealSchedule', () => ({ loadPlannerMeals: jest.fn(), scheduleRecipeId: () => 'r1' }));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: ACCENT } }) }));
// Card forwards its style so the focus ring is assertable without reaching into
// the shared UI kit's native-module imports.
jest.mock('../../../components/ui', () => {
  const { View } = require('react-native');
  const RealReact = require('react');
  return {
    Card: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
      RealReact.createElement(View, { style, testID: 'day-card' }, children),
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));

const ACCENT = '#00897B';
// Saturday (the mocked shopping day), so the pane's 7 cards run Sat → Fri.
const WEEK_START = new Date(2026, 7, 8, 0, 0, 0);
const dayIso = (offset: number) => {
  const d = new Date(WEEK_START);
  d.setDate(d.getDate() + offset);
  return iso(d);
};

// Past the pane's 250ms settle delay, flushing the effects it schedules.
const tick = () => act(async () => { jest.advanceTimersByTime(300); });

const focusedIndexes = () =>
  screen
    .getAllByTestId('day-card')
    .map((c, i) => [i, StyleSheet.flatten(c.props.style) as { borderWidth?: number }] as const)
    .filter(([, s]) => s.borderWidth === 2)
    .map(([i]) => i);

describe('PlannerPane scrollToDate focus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStore.params = {};
    mockSubscribers.clear();
    mockSetParams.mockClear();
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('highlights the requested day and consumes the param', async () => {
    mockStore.params = { scrollToDate: dayIso(2) };
    await render(<PlannerPane weekStart={WEEK_START} />);

    await tick();

    expect(focusedIndexes()).toEqual([2]);
    expect(mockSetParams).toHaveBeenCalledWith({ scrollToDate: undefined });
  });

  it('leaves the param alone while the shown period does not contain the date', async () => {
    // Three weeks out: KitchenScreen is still realigning the period around it.
    mockStore.params = { scrollToDate: dayIso(21) };
    await render(<PlannerPane weekStart={WEEK_START} />);

    await tick();

    expect(focusedIndexes()).toEqual([]);
    // Consuming it here would strand the user on the wrong week with no highlight.
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('drops the highlight when the period shifts away from the focused day', async () => {
    mockStore.params = { scrollToDate: dayIso(2) };
    const { rerender } = await render(<PlannerPane weekStart={WEEK_START} />);
    await tick();
    expect(focusedIndexes()).toEqual([2]);

    const nextWeek = new Date(WEEK_START);
    nextWeek.setDate(nextWeek.getDate() + 7);
    await rerender(<PlannerPane weekStart={nextWeek} />);
    await tick();

    expect(focusedIndexes()).toEqual([]);
  });
});
