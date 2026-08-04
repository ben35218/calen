import React from 'react';
import { render, cleanup, act } from '@testing-library/react-native';

// The today anchor (calendar.md → "The grid opens on today, and stays there
// until the user moves it"; billing-plans.md carries the viewer's copy of the
// rule). A launch positions its first frame with `initialScrollIndex` on
// pre-data week heights, then resolves the rest of its inputs in stages — each
// one re-measuring the week rows and sliding today's week down. So the anchor
// is a PIN, not a one-shot snap: it re-snaps on every offset change and every
// content re-measure until the user drags the grid or jumps to a month.

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withSequence: (v: unknown) => v,
  };
});

// Stand in for the FlatList so the test can watch what the grid scrolls to and
// drive the callbacks a real list would fire.
const mockScrollToOffset = jest.fn();
const mockList: { props: Record<string, any> } = { props: {} };
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactLib = require('react');
  const MockFlatList = ReactLib.forwardRef((props: Record<string, any>, ref: unknown) => {
    mockList.props = props;
    ReactLib.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
    return null;
  });
  return { __esModule: true, default: MockFlatList };
});

// The sources → events expansion, so the test can land "late" data that grows
// the weeks above today exactly the way a cold launch's stages do.
const mockExpanded = { events: [] as unknown[] };
jest.mock('../../../lib/calendarData', () => ({
  expandCalendarRange: () => ({ events: mockExpanded.events }),
}));

import ViewerMonthGrid from '../ViewerMonthGrid';
import { initialWindow } from '../../../lib/calendarWindow';
import { monthBlockWeeks } from '../../../lib/monthGrid';

const MIN_WEEK = 96;
const TOP_PAD_OVER_HEADER = 8; // topPad = headerH + 8, so the snap lands here

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The row today lands on, from the grid's own geometry: the initial window
// (last month through three months ahead) laid out as month BLOCKS, so a
// boundary week is rendered once per month and today's row is the one where
// today is the block's own day. Nothing has loaded yet in these tests, so every
// row is still MIN_WEEK tall and the offset is index × MIN_WEEK.
function todayWeekIndex() {
  const weeks = monthBlockWeeks(initialWindow(new Date()));
  const today = ymd(new Date());
  return weeks.findIndex((w) =>
    w.dates.some((d, col) => d === today && col >= w.firstCol && col <= w.lastCol),
  );
}

const CAL = { id: 'custom-shared', name: 'Shared', color: '#4A90D9', mine: false } as any;

// A single-day event, on the shared calendar so the grid actually draws it.
const eventOn = (date: string, id: string) => ({
  _id: id,
  title: 'A rather long event title that wraps onto a second chip line',
  calendarType: CAL.id,
  startDate: `${date}T15:00:00.000Z`,
  endDate: `${date}T16:00:00.000Z`,
  allDay: false,
});

const grid = (sources: unknown, ref?: React.Ref<any>) => (
  <ViewerMonthGrid
    ref={ref}
    sources={sources as any}
    calendars={[CAL]}
    onOpenEvent={() => {}}
    bottomPad={0}
  />
);

beforeEach(() => {
  mockScrollToOffset.mockClear();
  mockExpanded.events = [];
});
afterEach(cleanup);

describe('ViewerMonthGrid — the today anchor', () => {
  it('opens on today: the first frame scrolls today’s week under the header', async () => {
    await render(grid(undefined));
    // Nothing has landed yet, so every week is still MIN_WEEK tall.
    expect(mockScrollToOffset).toHaveBeenCalledWith({
      offset: todayWeekIndex() * MIN_WEEK + TOP_PAD_OVER_HEADER,
      animated: false,
    });
  });

  it('re-snaps when late data grows the weeks above today', async () => {
    const view = await render(grid(undefined));
    const openedAt = todayWeekIndex() * MIN_WEEK + TOP_PAD_OVER_HEADER;
    expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: openedAt, animated: false });

    // A stage lands (the replica read, the prefs, an invalidation…) carrying a
    // full day's worth of events LAST week: the week ABOVE today outgrows
    // MIN_WEEK, so today's week is no longer at the offset the opening snap
    // used — the exact shift the old one-shot snap never followed.
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    mockExpanded.events = Array.from({ length: 3 }, (_, i) => eventOn(ymd(lastWeek), `e${i}`));
    await view.rerender(grid({ sources: {} }));

    const last = mockScrollToOffset.mock.calls[mockScrollToOffset.mock.calls.length - 1][0];
    expect(last.animated).toBe(false);
    expect(last.offset).toBeGreaterThan(openedAt); // it followed today down
  });

  it('re-snaps on a content re-measure while still pinned', async () => {
    await render(grid(undefined));
    mockScrollToOffset.mockClear();
    mockList.props.onContentSizeChange();
    expect(mockScrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('releases the pin on the user’s own drag — never on a programmatic scroll', async () => {
    await render(grid(undefined));
    // The opening snap and an edge extension are programmatic: still pinned.
    mockList.props.onContentSizeChange();
    mockScrollToOffset.mockClear();

    mockList.props.onScrollBeginDrag();
    mockList.props.onContentSizeChange();
    expect(mockScrollToOffset).not.toHaveBeenCalled();
  });

  it('tapping Today re-pins, so a repaint right after the tap keeps today up top', async () => {
    const ref = React.createRef<any>();
    await render(grid(undefined, ref));
    mockList.props.onScrollBeginDrag(); // the user had scrolled away
    ref.current.scrollToToday(true);
    mockScrollToOffset.mockClear();

    mockList.props.onContentSizeChange();
    expect(mockScrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('a month jump releases the pin', async () => {
    const ref = React.createRef<any>();
    await render(grid(undefined, ref));
    const now = new Date();
    await act(async () => { ref.current.jumpTo({ year: now.getFullYear() + 1, month: 0 }); });
    mockScrollToOffset.mockClear();

    mockList.props.onContentSizeChange();
    expect(mockScrollToOffset).not.toHaveBeenCalled();
  });
});
