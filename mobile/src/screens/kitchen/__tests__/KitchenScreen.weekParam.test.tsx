import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react-native';
import KitchenScreen from '../KitchenScreen';
import { periodStartOf } from '../constants';

// A tiny route-param store so setParams actually mutates what useRoute returns
// and forces a re-render — this is what lets the test catch the effect that
// clobbers the week when the param is cleared. (Names are `mock*`-prefixed so
// jest lets the mock factory reference them.)
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

// Settings: weekly shopping on Saturday (groceryDay = 6), loaded synchronously.
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { groceryShoppingDay: 6, groceryFrequency: 'weekly', groceryAnchor: null } }),
}));

jest.mock('../../../api', () => ({ settingsApi: { get: jest.fn() } }));
// Panes render a marker so the test can see which one is mounted.
jest.mock('../PlannerPane', () => {
  const { Text } = require('react-native');
  const RealReact = require('react');
  return () => RealReact.createElement(Text, null, 'PLANNER');
});
jest.mock('../GroceryPane', () => {
  const { Text } = require('react-native');
  const RealReact = require('react');
  return () => RealReact.createElement(Text, null, 'GROCERY');
});
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
// The Meals add-on gate: owned, so the screen under test renders its content.
jest.mock('../../../lib/addons', () => ({
  useOwnedAddons: () => ({ owned: new Set(['recipes']), loaded: true, isUnlocked: () => true }),
}));
jest.mock('../../plan/AddonLockedView', () => () => null);
// Stub the shared UI kit so the test doesn't drag in native modules
// (keyboard-controller / reanimated) that components/ui imports transitively.
// KitchenScreen only uses Card + SegmentedControl, and the week label under
// test is plain Text rendered directly by the screen.
jest.mock('../../../components/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => children,
  SegmentedControl: () => null,
  CenteredLoader: () => null,
  // The nav-bar overflow button and the options sheet it opens: neither is
  // under test here, but both have to exist or KitchenHome renders undefined.
  HeaderIconButton: () => null,
  BottomSheet: () => null,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));

const GROCERY_DAY = 6; // Saturday
const pad = (n: number) => String(n).padStart(2, '0');
const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The caption's trip date — the only concrete date the header carries now that
// the label is relative ("Seven Weeks"), so it is what pins which period is up.
const tripDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

describe('KitchenScreen grocery weekStart param', () => {
  beforeEach(() => {
    mockStore.params = {};
    mockSubscribers.clear();
    mockSetParams.mockClear();
  });
  afterEach(cleanup);

  it('opens the shopping period for the clicked grocery day, not the current week', async () => {
    // ~7 weeks out so it can never read as "This Week"/"Next Week", snapped to the
    // grocery day — exactly what the calendar's grocery icon passes.
    const base = new Date();
    base.setDate(base.getDate() + 50);
    const clickedStart = periodStartOf(base, GROCERY_DAY, 'weekly', null);
    const clicked = localYmd(clickedStart);
    mockStore.params = { pane: 'grocery', weekStart: clicked };

    render(<KitchenScreen />);

    // After effects settle (param applied, then cleared), the header must show the
    // clicked period — and must NOT snap back to the current week.
    await waitFor(() => {
      expect(screen.queryByText(new RegExp(`^Shop ${tripDate(clickedStart)} \\(`))).toBeTruthy();
    });
    expect(screen.queryByText('This Week')).toBeNull();
    expect(screen.queryByText('Next Week')).toBeNull();
    // The param must have been consumed so re-focusing later doesn't re-apply it.
    expect(mockSetParams).toHaveBeenCalledWith({ weekStart: undefined });
  });

  it('defaults to the current week when no weekStart param is given', async () => {
    mockStore.params = { pane: 'grocery' };
    render(<KitchenScreen />);
    await waitFor(() => {
      expect(screen.queryByText('This Week')).toBeTruthy();
    });
  });

  // The calendar's grocery cart sends all three params at once. `scrollToDate`
  // must NOT drag the user onto the Planner — it's the Planner's highlight,
  // queued until they flip over, and `pane` is the only thing that picks a pane.
  it('stays on the requested pane when a scrollToDate rides along', async () => {
    const clicked = localYmd(periodStartOf(new Date(), GROCERY_DAY, 'weekly', null));
    mockStore.params = { pane: 'grocery', weekStart: clicked, scrollToDate: clicked };

    render(<KitchenScreen />);

    await waitFor(() => expect(screen.queryByText('GROCERY')).toBeTruthy());
    expect(screen.queryByText('PLANNER')).toBeNull();
    // ...and the highlight is left in the params for PlannerPane to consume.
    // (Asserted on the store, not the spy: jest's call matcher ignores
    // undefined-valued keys, so `{weekStart: undefined}` would match a
    // `{scrollToDate: undefined}` expectation.)
    expect(mockStore.params.scrollToDate).toBe(clicked);
  });

  it('opens the Planner when that is the pane asked for', async () => {
    mockStore.params = { pane: 'planner', scrollToDate: localYmd(new Date()) };

    render(<KitchenScreen />);

    await waitFor(() => expect(screen.queryByText('PLANNER')).toBeTruthy());
    expect(screen.queryByText('GROCERY')).toBeNull();
  });
});
