// The shopping-day marker on the planner (specs/features/kitchen.md, "Meal
// planner & grocery"). A period *starts* on its shopping day, so on any day but
// the shopping day itself the period you're standing in opens on a Saturday you
// already shopped — the trip you're preparing for is the next period's. The
// marker used to read "Grocery Shopping Day" on the first card of whatever
// period was shown, which labelled a past trip as if it were ahead.

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import PlannerPane from '../PlannerPane';

const mockDayOf = (offsetFromToday: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetFromToday);
  return d;
};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ setOptions: jest.fn(), setParams: jest.fn(), navigate: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));
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
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('../../../components/ui', () => {
  const { View } = require('react-native');
  const RealReact = require('react');
  return {
    Card: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
      RealReact.createElement(View, { style }, children),
    SwipeableRow: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));

describe('PlannerPane shopping-day marker', () => {
  afterEach(cleanup);

  it('marks the period whose shopping day is the next one up', async () => {
    // A period starting tomorrow: the one before it started a week ago, so this
    // is the earliest shopping day still ahead.
    await render(<PlannerPane weekStart={mockDayOf(1)} />);

    expect(screen.getByText('Next Shopping Day')).toBeTruthy();
    expect(screen.queryByText('Shopped')).toBeNull();
  });

  it('marks it when the shopping day is today', async () => {
    await render(<PlannerPane weekStart={mockDayOf(0)} />);

    expect(screen.getByText('Next Shopping Day')).toBeTruthy();
  });

  it('says a shopping day that has been and gone is past', async () => {
    // The period you're standing in on most days: it opened two days ago.
    await render(<PlannerPane weekStart={mockDayOf(-2)} />);

    expect(screen.getByText('Shopped')).toBeTruthy();
    expect(screen.queryByText('Next Shopping Day')).toBeNull();
  });

  // `iso` reads the UTC date, so comparing it against a raw `new Date()` rolls
  // the day over in the evening — at 23:00 Eastern the UTC day is already
  // tomorrow. Both the "Today" pill and the shopping-day marker hang off that
  // comparison, so this pins them at an hour where the two dates disagree.
  it('reads the local day, not the UTC one, late in the evening', async () => {
    const lateTonight = new Date();
    lateTonight.setHours(23, 30, 0, 0);
    jest.useFakeTimers().setSystemTime(lateTonight);

    try {
      // The period opened this morning: its shopping day is today, not past.
      await render(<PlannerPane weekStart={mockDayOf(0)} />);
      expect(screen.getByText('Next Shopping Day')).toBeTruthy();
      expect(screen.queryByText('Shopped')).toBeNull();
      expect(screen.getByText('Today')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not call a later period the next one', async () => {
    // Two periods out — its shopping day is ahead, but it isn't the next trip.
    await render(<PlannerPane weekStart={mockDayOf(15)} />);

    expect(screen.getByText('Shopping Day')).toBeTruthy();
    expect(screen.queryByText('Next Shopping Day')).toBeNull();
    expect(screen.queryByText('Shopped')).toBeNull();
  });
});
