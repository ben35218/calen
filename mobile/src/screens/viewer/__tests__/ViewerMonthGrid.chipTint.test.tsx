import React from 'react';
import { render, cleanup } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// The Details-grid chip styling (calendar.md → Views; billing-plans.md carries
// the viewer's copy): a chip is Apple's TINTED card — a translucent wash of the
// calendar's colour under title and time drawn in that same colour — never a
// solid block of the colour with white text.

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
// renders the one holding the event itself.
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

// A single timed event today, on the shared calendar below.
jest.mock('../../../lib/calendarData', () => {
  const today = new Date();
  today.setHours(12, 30, 0, 0);
  const at = today.toISOString();
  return {
    expandCalendarRange: () => ({
      events: [
        { _id: 'e1', title: 'Aqua Tots', calendarType: 'custom-shared', startDate: at, endDate: at, allDay: false },
      ],
    }),
  };
});

import ViewerMonthGrid from '../ViewerMonthGrid';
import { tintedChip } from '../../../lib/color';

const CAL_COLOR = '#1976D2'; // a Material-700 hue: unreadable as raw text on its own tint
const CAL = { id: 'custom-shared', name: 'Shared', color: CAL_COLOR, mine: false } as any;

// `sources` is opaque here — the expansion above is what produces the event.
const grid = () => (
  <ViewerMonthGrid sources={{} as any} calendars={[CAL]} onOpenEvent={() => {}} bottomPad={0} />
);

// Every flattened style in the rendered tree, so the chip's own container can be
// found by what it paints rather than by its position.
function allStyles(node: any, out: Record<string, any>[] = []): Record<string, any>[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) allStyles(n, out);
    return out;
  }
  if (node.props?.style) out.push(StyleSheet.flatten(node.props.style) as Record<string, any>);
  allStyles(node.children, out);
  return out;
}

afterEach(cleanup);

describe('ViewerMonthGrid — tinted event chips', () => {
  async function renderEventRow() {
    await render(grid());
    const weeks: any[] = mockList.props.data;
    const week = weeks.find((w) => w.cells.some((c: any) => c.chips.length));
    expect(week).toBeTruthy();
    return render(mockList.props.renderItem({ item: week }) as React.ReactElement);
  }

  it('fills the chip with the calendar colour at low opacity, not the solid colour', async () => {
    const view = await renderEventRow();
    const fills = allStyles(view.toJSON()).map((s) => s.backgroundColor);
    expect(fills).toContain(tintedChip(CAL_COLOR).fill);
    expect(fills).not.toContain(CAL_COLOR);
  });

  it('draws the title and time in the calendar colour, lightened to stay legible', async () => {
    const view = await renderEventRow();
    const title = StyleSheet.flatten(view.getByText('Aqua Tots').props.style) as Record<string, any>;
    const time = StyleSheet.flatten(view.getByText('12:30PM').props.style) as Record<string, any>;

    const tint = tintedChip(CAL_COLOR);
    expect(title.color).toBe(tint.label);
    expect(time.color).toBe(tint.time);
    // The old treatment — white on a solid block — is what this replaces.
    expect(title.color).not.toBe('#fff');
    // Lightened, so never the raw stored hue.
    expect(title.color.toUpperCase()).not.toBe(CAL_COLOR);
  });
});
