import React from 'react';
import { render, cleanup } from '@testing-library/react-native';

// The "+N more" overflow label (calendar.md → Views; billing-plans.md carries
// the viewer's copy): the week-height math reserves exactly ONE line for it
// (MORE_H), so the label must never wrap — on narrow cells it shrinks to fit.
// A wrapped second line falls below the reserved height and is cut off by the
// cell's overflow: 'hidden' (reported from a 320pt-wide device).

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

// The list is a stand-in: the test reads the built week rows off its props and
// renders the one holding the overflowing day itself.
const mockList: { props: Record<string, any> } = { props: {} };
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactLib = require('react');
  const MockFlatList = ReactLib.forwardRef((props: Record<string, any>, ref: unknown) => {
    mockList.props = props;
    ReactLib.useImperativeHandle(ref, () => ({ scrollToOffset: () => {} }));
    return null;
  });
  return { __esModule: true, default: MockFlatList };
});

// Five timed events today — two past the three-chip cap, so the cell carries
// a "+2 more" label.
jest.mock('../../../lib/calendarData', () => {
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const at = today.toISOString();
  return {
    expandCalendarRange: () => ({
      events: [1, 2, 3, 4, 5].map((n) => ({
        _id: `e${n}`, title: `Event ${n}`, calendarType: 'custom-shared', startDate: at, endDate: at, allDay: false,
      })),
    }),
  };
});

import ViewerMonthGrid from '../ViewerMonthGrid';

const CAL = { id: 'custom-shared', name: 'Shared', color: '#1976D2', mine: false } as any;

const grid = () => (
  <ViewerMonthGrid sources={{} as any} calendars={[CAL]} onOpenEvent={() => {}} bottomPad={0} />
);

afterEach(cleanup);

describe('ViewerMonthGrid — "+N more" overflow label', () => {
  it('caps a day at three chips and pins the overflow label to one shrink-to-fit line', async () => {
    await render(grid());
    const weeks: any[] = mockList.props.data;
    const week = weeks.find((w) => w.cells.some((c: any) => c.extra > 0));
    expect(week).toBeTruthy();
    const cell = week.cells.find((c: any) => c.extra > 0);
    expect(cell.chips).toHaveLength(3);
    expect(cell.extra).toBe(2);

    const view = await render(mockList.props.renderItem({ item: week }) as React.ReactElement);
    const more = view.getByText('+2 more');
    expect(more.props.numberOfLines).toBe(1);
    expect(more.props.adjustsFontSizeToFit).toBe(true);
  });
});
