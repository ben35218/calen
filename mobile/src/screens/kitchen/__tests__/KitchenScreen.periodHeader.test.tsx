// The top of the Meals view (specs/features/kitchen.md, "Meal planner &
// grocery"). The schedule used to live here — first as a hero card, then as a
// caption reading "Every week on Saturday" directly under "Next Week", which
// stated a recurrence rule with nothing to say what it referred to. Two rules
// are pinned here:
//   1. Above the tabs there is the period and nothing else: a relative label
//      over the trip that opens it ("Shop Sat, Aug 15 (in 4 days)"), and no tap
//      target on the caption.
//   2. This screen's configuration lives in one nav-bar overflow menu, not
//      scattered into the content.

import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react-native';
import KitchenScreen from '../KitchenScreen';
import { periodStartOf } from '../constants';

let mockSettings: Record<string, unknown> = {};
let mockParams: Record<string, unknown> = {};
const mockNavigate = jest.fn();
// KitchenScreen installs its header actions through setOptions, so the test has
// to render what it registered to reach the overflow button.
let mockHeaderRight: (() => React.ReactElement) | null = null;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    setOptions: (o: { headerRight?: () => React.ReactElement }) => { mockHeaderRight = o.headerRight ?? null; },
    // Really mutate the param store: the screen consumes `weekStart` by
    // clearing it, and a no-op setParams leaves that effect firing forever.
    setParams: (p: Record<string, unknown>) => { mockParams = { ...mockParams, ...p }; },
    navigate: mockNavigate,
  }),
  useRoute: () => ({ params: mockParams }),
}));
jest.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: mockSettings }) }));
jest.mock('../../../api', () => ({ settingsApi: { get: jest.fn() } }));
jest.mock('../PlannerPane', () => () => null);
jest.mock('../GroceryPane', () => () => null);
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('../../../lib/addons', () => ({
  useOwnedAddons: () => ({ owned: new Set(['recipes']), loaded: true, isUnlocked: () => true }),
}));
jest.mock('../../plan/AddonLockedView', () => () => null);
jest.mock('../../../components/ui', () => {
  const { View, Text, TouchableOpacity } = require('react-native');
  const RealReact = require('react');
  return {
    Card: ({ children }: { children: React.ReactNode }) => children,
    SegmentedControl: () => null,
    CenteredLoader: () => null,
    HeaderIconButton: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel?: string }) =>
      RealReact.createElement(TouchableOpacity, { onPress }, RealReact.createElement(Text, null, accessibilityLabel)),
    // Only renders its contents while open — the sheet's own visibility is the
    // shared component's job, not this screen's.
    BottomSheet: ({ visible, title, children }: { visible: boolean; title?: string; children: React.ReactNode }) =>
      visible ? RealReact.createElement(View, null, RealReact.createElement(Text, null, title), children) : null,
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));

const GROCERY_DAY = 6; // Saturday
const SET = { groceryShoppingDay: GROCERY_DAY, groceryFrequency: 'weekly', groceryAnchor: null };
const md = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const pad = (n: number) => String(n).padStart(2, '0');
const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// "Sat, Aug 22" — the date half of the caption.
const tripDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
// The expected parenthetical, worked out independently of the screen's helper.
const away = (d: Date) => {
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((midnight(d) - midnight(new Date())) / 86_400_000);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
};
const rangeFrom = (start: Date) => {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${md(start)} – ${md(end)}`;
};

describe('KitchenScreen period header', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockHeaderRight = null;
  });
  afterEach(cleanup);

  const shiftedPeriod = (periods: number) => {
    const d = periodStartOf(new Date(), GROCERY_DAY, 'weekly', null);
    d.setDate(d.getDate() + periods * 7);
    return d;
  };

  it('names the trip and how far off it is, not the span', async () => {
    mockSettings = SET;
    await render(<KitchenScreen />);

    expect(screen.getByText('This Week')).toBeTruthy();
    // The caption is the trip and how far off it is — NOT the span. A period
    // starts on its shopping day, so the range only restated the trip date and
    // then added an end date nobody shops by. (Whether *this* period's trip is
    // ahead or behind depends on the weekday the suite runs on; the tenses get
    // their own deterministic tests below.)
    const start = periodStartOf(new Date(), GROCERY_DAY, 'weekly', null);
    expect(screen.getByText(new RegExp(`^Shop.* \\(${away(start)}\\)$`))).toBeTruthy();
    expect(screen.queryByText(rangeFrom(start))).toBeNull();
    expect(screen.queryByText('Every week on Saturday')).toBeNull();
    expect(screen.queryByText('Grocery Shopping Schedule')).toBeNull();
  });

  it('labels a far period by its distance, never by dates', async () => {
    mockSettings = SET;
    const farStart = shiftedPeriod(7);
    mockParams = { pane: 'planner', weekStart: localYmd(farStart) };

    await render(<KitchenScreen />);

    // The label answers "where am I?" in weeks; the only date on screen is the
    // trip in the caption below it.
    expect(screen.getByText('Seven Weeks')).toBeTruthy();
    expect(screen.queryByText(rangeFrom(farStart))).toBeNull();
    expect(screen.getByText(`Shop ${tripDate(farStart)} (${away(farStart)})`)).toBeTruthy();
  });

  it('counts backwards for periods behind the current one', async () => {
    mockSettings = SET;
    const backStart = shiftedPeriod(-3);
    mockParams = { pane: 'planner', weekStart: localYmd(backStart) };

    await render(<KitchenScreen />);

    expect(screen.getByText('Three Weeks Ago')).toBeTruthy();
    expect(screen.queryByText(rangeFrom(backStart))).toBeNull();
  });

  // The trip that opens the period, in the tense that is true. This used to sit
  // on the Grocery card, where it belonged to one tab only; the period selector
  // is where facts about the period live, and both tabs share it.
  it('names an upcoming trip in the future tense', async () => {
    mockSettings = SET;
    const start = shiftedPeriod(1);
    mockParams = { pane: 'grocery', weekStart: localYmd(start) };

    await render(<KitchenScreen />);

    expect(screen.getByText(`Shop ${tripDate(start)} (${away(start)})`)).toBeTruthy();
    expect(screen.queryByText(rangeFrom(start))).toBeNull();
  });

  it('says a trip already taken in the past tense', async () => {
    mockSettings = SET;
    // The period before this one: its Saturday is behind us for certain, so
    // both the verb and the parenthetical run backwards.
    const start = shiftedPeriod(-1);
    mockParams = { pane: 'grocery', weekStart: localYmd(start) };

    await render(<KitchenScreen />);

    expect(screen.getByText('Last Week')).toBeTruthy();
    expect(screen.getByText(`Shopped ${tripDate(start)} (${away(start)})`)).toBeTruthy();
  });

  it('leaves the trip out until a shopping day is chosen', async () => {
    // The period maths falls back to Saturday, but nobody picked it — naming a
    // day here would be a lie the setup card above is asking them to fix.
    mockSettings = { groceryShoppingDay: null, groceryFrequency: 'weekly', groceryAnchor: null };
    await render(<KitchenScreen />);

    // The caption is the bare range: no trip half, no middot.
    expect(screen.getByText(rangeFrom(periodStartOf(new Date(), GROCERY_DAY, 'weekly', null)))).toBeTruthy();
  });

  it("gathers this screen's settings into one nav-bar menu", async () => {
    mockSettings = SET;
    // The screen registers its header actions through setOptions, so the test
    // renders the registered headerRight alongside the screen — one tree, so a
    // press on the overflow button and the sheet it opens share a render root.
    function Harness() {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      React.useEffect(() => { force(); }, []);
      return (
        <>
          <KitchenScreen />
          {mockHeaderRight ? mockHeaderRight() : null}
        </>
      );
    }
    await render(<Harness />);

    // Nothing is open until the overflow button is used — and Recipes is not a
    // header button any more, so the title keeps the centre of the bar.
    expect(screen.queryByText('Grocery List Sections')).toBeNull();
    expect(screen.queryByText('Recipes')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Meals options')); });

    // The destination first, then both settings, each showing its current value.
    expect(screen.getByText('Recipes')).toBeTruthy();
    expect(screen.getByText('Grocery Shopping Schedule')).toBeTruthy();
    expect(screen.getByText('Every week on Saturday')).toBeTruthy();
    expect(screen.getByText('Grocery List Sections')).toBeTruthy();

    // Every row closes the sheet on its way out, so reopen between presses.
    await act(async () => { fireEvent.press(screen.getByLabelText(/^Recipes,/)); });
    expect(mockNavigate).toHaveBeenCalledWith('Recipes');
    expect(screen.queryByText('Grocery List Sections')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Meals options')); });

    await act(async () => { fireEvent.press(screen.getByLabelText(/^Grocery Shopping Schedule,/)); });
    expect(mockNavigate).toHaveBeenCalledWith('GrocerySchedule');
    // The sheet is closed by the caller before navigating, so it can't sit on
    // top of the pushed screen swallowing touches.
    expect(screen.queryByText('Grocery List Sections')).toBeNull();
  });

  it('keeps the full setup card while no shopping day has been chosen', async () => {
    mockSettings = { groceryShoppingDay: null, groceryFrequency: 'weekly', groceryAnchor: null };
    await render(<KitchenScreen />);

    expect(screen.getByText('Grocery Shopping Schedule')).toBeTruthy();
    expect(screen.getByText('Not set — tap to choose a shopping day')).toBeTruthy();
  });
});
