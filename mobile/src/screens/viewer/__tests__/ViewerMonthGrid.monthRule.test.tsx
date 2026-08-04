import React from 'react';
import { render, cleanup } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// The month-boundary rule (calendar.md → month blocks; billing-plans.md carries
// the viewer's copy). A month's first row opens with the SAME hairline as every
// other week rule — not a tinted or heavier line — and it is drawn per day cell
// over the days the month owns, so nothing hangs over the blank cells that lead
// into the 1st.

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
// renders the ones it wants itself.
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

jest.mock('../../../lib/calendarData', () => ({
  expandCalendarRange: () => ({ events: [] }),
}));

import ViewerMonthGrid from '../ViewerMonthGrid';
import { colors } from '../../../theme';

const CAL = { id: 'custom-shared', name: 'Shared', color: '#4A90D9', mine: false } as any;

const grid = () => (
  <ViewerMonthGrid sources={undefined as any} calendars={[CAL]} onOpenEvent={() => {}} bottomPad={0} />
);

// The rendered row's own style, plus one flattened style per cell, left to right.
async function rowStyles(week: unknown) {
  const view = await render(mockList.props.renderItem({ item: week }) as React.ReactElement);
  const json: any = view.toJSON();
  return {
    row: StyleSheet.flatten(json.props.style) as Record<string, unknown>,
    cells: (json.children as any[]).map((c) => StyleSheet.flatten(c.props.style) as Record<string, unknown>),
  };
}

afterEach(cleanup);

describe('ViewerMonthGrid — the month-boundary rule', () => {
  it('draws an ordinary hairline over the month’s own days, and none over the blanks', async () => {
    await render(grid());
    const weeks: any[] = mockList.props.data;

    // A month's first row that actually has blank lead-in cells (the 1st isn't
    // a Sunday), so there is something for a full-width rule to hang over.
    const monthStart = weeks.find((w) => w.isMonthStart && w.cells.some((c: any) => c.outside));
    expect(monthStart).toBeTruthy();

    const { row, cells } = await rowStyles(monthStart);
    // The row itself draws nothing — the rule moved onto the cells.
    expect(row.borderTopWidth).toBe(0);

    monthStart.cells.forEach((cell: any, col: number) => {
      if (cell.outside) {
        expect(cells[col].borderTopWidth).toBeFalsy();
      } else {
        expect(cells[col].borderTopWidth).toBe(StyleSheet.hairlineWidth);
        expect(cells[col].borderTopColor).toBe(colors.border);
      }
    });
  });

  it('matches the rule an ordinary week row draws', async () => {
    await render(grid());
    const weeks: any[] = mockList.props.data;

    const plain = weeks.find((w) => !w.isMonthStart);
    const { row, cells } = await rowStyles(plain);
    expect(row.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(row.borderTopColor).toBe(colors.border);
    // An ordinary row's cells carry no rule of their own — the row owns it.
    for (const cell of cells) expect(cell.borderTopWidth).toBeFalsy();
  });
});
