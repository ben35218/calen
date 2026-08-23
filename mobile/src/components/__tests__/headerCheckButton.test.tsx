import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

// The same stubs every ui.tsx-importing suite carries: the icon fonts, the
// keyboard bindings, and Reanimated all boot native modules under jest-expo.
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
import { HeaderCheckButton, useHeaderCheckButton } from '../ui';
import { colors } from '../../theme';
import { vividOnDark } from '../../lib/color';

const bg = (el: any) => StyleSheet.flatten(el.props.style)?.backgroundColor;

describe('HeaderCheckButton dirty states', () => {
  it('pristine (dirty: false) is the neutral grey disc and refuses the tap', async () => {
    const onPress = jest.fn();
    const view = await render(<HeaderCheckButton onPress={onPress} color="#5E35B1" dirty={false} />);
    const btn = view.getByLabelText('Save');
    expect(bg(btn)).toBe(colors.surfaceElevated);
    expect(btn.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('dirty fills with the lifted accent and saves on tap', async () => {
    const onPress = jest.fn();
    const view = await render(<HeaderCheckButton onPress={onPress} color="#5E35B1" dirty />);
    const btn = view.getByLabelText('Save');
    expect(bg(btn)).toBe(vividOnDark('#5E35B1'));
    expect(btn.props.accessibilityState?.disabled).not.toBe(true);
    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('dirty with no accent goes solid white (non-accented forms)', async () => {
    const view = await render(<HeaderCheckButton onPress={jest.fn()} dirty />);
    expect(bg(view.getByLabelText('Save'))).toBe('#FFFFFF');
  });

  it('without a dirty flag keeps the always-on accent look', async () => {
    const onPress = jest.fn();
    const view = await render(<HeaderCheckButton onPress={onPress} color="#5E35B1" />);
    const btn = view.getByLabelText('Save');
    expect(bg(btn)).toBe(vividOnDark('#5E35B1'));
    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('without a dirty flag and no accent stays the bare white glyph', async () => {
    const view = await render(<HeaderCheckButton onPress={jest.fn()} />);
    expect(bg(view.getByLabelText('Save'))).toBeUndefined();
  });
});

describe('useHeaderCheckButton', () => {
  function Harness({ nav, dirty }: { nav: any; dirty?: boolean }) {
    useHeaderCheckButton(nav, { onPress: jest.fn(), color: '#5E35B1', dirty });
    return null;
  }

  it('installs a pristine grey check through headerRight', async () => {
    const nav = { setOptions: jest.fn(), goBack: jest.fn() };
    await render(<Harness nav={nav} dirty={false} />);
    const opts = nav.setOptions.mock.calls.at(-1)[0];
    const view = await render(<>{opts.headerRight()}</>);
    const btn = view.getByLabelText('Save');
    expect(bg(btn)).toBe(colors.surfaceElevated);
    expect(btn.props.accessibilityState.disabled).toBe(true);
  });

  it('re-arms the check once the form goes dirty', async () => {
    const nav = { setOptions: jest.fn(), goBack: jest.fn() };
    const harness = await render(<Harness nav={nav} dirty={false} />);
    await harness.rerender(<Harness nav={nav} dirty />);
    const opts = nav.setOptions.mock.calls.at(-1)[0];
    const view = await render(<>{opts.headerRight()}</>);
    const btn = view.getByLabelText('Save');
    expect(bg(btn)).toBe(vividOnDark('#5E35B1'));
    expect(btn.props.accessibilityState?.disabled).not.toBe(true);
  });
});
