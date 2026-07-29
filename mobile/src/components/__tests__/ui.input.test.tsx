import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The text-field clear affordance (mobile/CLAUDE.md → Text-field clear button):
// while an Input is focused and holds text, an ✕ at its right end empties it;
// it never renders for multiline, secure, non-editable, or opted-out fields.

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
// Reanimated's shipped mock still boots native worklets under jest-expo, so
// stub the handful of exports ui.tsx touches instead.
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

import { Input } from '../ui';

const CLEAR = 'Clear text';

describe('Input clear button', () => {
  afterEach(cleanup);

  it('appears only while focused with text, and clears on press', async () => {
    const onChangeText = jest.fn();
    const view = await render(<Input value="Mahdi" onChangeText={onChangeText} />);
    expect(view.queryByLabelText(CLEAR)).toBeNull();

    const field = view.getByDisplayValue('Mahdi');
    await fireEvent(field, 'focus');
    await fireEvent.press(view.getByLabelText(CLEAR));
    expect(onChangeText).toHaveBeenCalledWith('');

    await fireEvent(field, 'blur');
    expect(view.queryByLabelText(CLEAR)).toBeNull();
  });

  it('stays hidden while focused but empty', async () => {
    const view = await render(<Input value="" onChangeText={jest.fn()} placeholder="Name" />);
    await fireEvent(view.getByPlaceholderText('Name'), 'focus');
    expect(view.queryByLabelText(CLEAR)).toBeNull();
  });

  it.each([
    ['multiline', { multiline: true }],
    ['secure', { secureTextEntry: true }],
    ['non-editable', { editable: false }],
    ['opted out', { clearable: false }],
  ])('never renders for a %s field', async (_name, props) => {
    const view = await render(<Input value="Mahdi" onChangeText={jest.fn()} {...props} />);
    await fireEvent(view.getByDisplayValue('Mahdi'), 'focus');
    expect(view.queryByLabelText(CLEAR)).toBeNull();
  });
});
