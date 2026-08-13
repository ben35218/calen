import React from 'react';
import { PanResponder, PanResponderGestureState } from 'react-native';
import { Text } from '../Text';
import { render, fireEvent, cleanup, act } from '@testing-library/react-native';

// The shared swipe-to-delete row (mobile/CLAUDE.md → "Deleting a row from a
// list"). What's pinned here is how the revealed action *settles*: a row that
// only opens is a trap, because the swipe back that puts it away competes with
// the screen's own back gesture — losing that race navigates the user out of
// the view instead. Plus the action's contents, which follow the row's height
// rather than crushing a glyph and a word into an interior row.

jest.mock('@expo/vector-icons', () => {
  const { Text: RNText } = require('react-native');
  const RealReact = require('react');
  return {
    Ionicons: ({ name }: { name: string }) => RealReact.createElement(RNText, { testID: `icon-${name}` }, name),
    MaterialCommunityIcons: () => null,
  };
});
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
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
// The row reads the screen's navigation off the context (not `useNavigation`,
// which throws outside a navigator) to suspend the back gesture while open.
const mockSetOptions = jest.fn();
jest.mock('@react-navigation/native', () => {
  const RealReact = require('react');
  // Called through, not passed directly: the factory runs while the hoisted
  // `import` above is still initializing, so `mockSetOptions` isn't bound yet.
  return {
    NavigationContext: RealReact.createContext({
      setOptions: (...args: unknown[]) => mockSetOptions(...args),
    }),
  };
});

import { SwipeableRow } from '../ui';

const ROW = 'Chili';
const ACTION_WIDTH = 88;

// The row's PanResponder config, captured at create time: the settle rules live
// in its release handler, and driving it directly is what a real drag does.
let configs: Parameters<typeof PanResponder.create>[0][] = [];
const realCreate = PanResponder.create;

const gesture = (g: Partial<PanResponderGestureState>) => ({ dx: 0, dy: 0, vx: 0, vy: 0, ...g } as PanResponderGestureState);
const release = (g: Partial<PanResponderGestureState>) =>
  act(() => { configs[0].onPanResponderRelease?.(null as never, gesture(g)); });

const renderRow = async (height: number, onDelete = jest.fn()) => {
  const view = await render(
    <SwipeableRow onDelete={onDelete} label="Remove">
      <Text>{ROW}</Text>
    </SwipeableRow>,
  );
  await fireEvent(view.getByText(ROW).parent!.parent!, 'layout', { nativeEvent: { layout: { height, width: 300, x: 0, y: 0 } } });
  return view;
};

describe('SwipeableRow', () => {
  beforeEach(() => {
    configs = [];
    jest.clearAllMocks();
    jest.spyOn(PanResponder, 'create').mockImplementation((cfg) => {
      configs.push(cfg);
      return realCreate(cfg);
    });
  });
  afterEach(async () => {
    await cleanup();
    jest.restoreAllMocks();
  });

  it('gives a short row the word alone — no glyph crushed in beside it', async () => {
    const view = await renderRow(28);
    expect(view.getByText('Remove')).toBeTruthy();
    expect(view.queryByTestId('icon-trash-outline')).toBeNull();
  });

  it('gives a tall row the glyph over the word', async () => {
    const view = await renderRow(80);
    expect(view.getByText('Remove')).toBeTruthy();
    expect(view.getByTestId('icon-trash-outline')).toBeTruthy();
  });

  it('suspends the screen back gesture while open and restores it on close', async () => {
    const view = await renderRow(28);

    await release({ dx: -ACTION_WIDTH });
    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: false });

    await release({ dx: ACTION_WIDTH });
    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
    expect(view.queryByLabelText('Close')).toBeNull();
  });

  it('closes on a right flick that never reaches the halfway mark', async () => {
    const view = await renderRow(28);
    await release({ dx: -ACTION_WIDTH });
    expect(view.getByLabelText('Close')).toBeTruthy();

    // A quick flick back travels less than half the action's width; settling on
    // distance alone would spring it open again ("it won't let me undo it").
    await release({ dx: 20, vx: 0.8 });
    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
  });

  it('puts an open row away when the row itself is tapped', async () => {
    const onDelete = jest.fn();
    const view = await renderRow(28, onDelete);
    await release({ dx: -ACTION_WIDTH });

    await act(async () => { fireEvent.press(view.getByLabelText('Close')); });

    expect(view.queryByLabelText('Close')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('never deletes on the swipe itself — only the action fires onDelete', async () => {
    const onDelete = jest.fn();
    const view = await renderRow(28, onDelete);

    await release({ dx: -ACTION_WIDTH });
    expect(onDelete).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(view.getByLabelText('Remove')); });
    expect(onDelete).toHaveBeenCalled();
  });
});
