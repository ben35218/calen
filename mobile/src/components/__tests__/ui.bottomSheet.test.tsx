import React from 'react';
import { Text } from '../Text';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';

// The shared bottom sheet (mobile/CLAUDE.md → "Presentation & dismissal"). It
// is the single chrome for every picker/action/confirm, so its lifecycle is
// what the ~12 call sites depend on: content appears while `visible`, a scrim
// tap reports the dismissal to the caller, and the sheet stays mounted through
// its slide-down before unmounting.

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
// Reanimated's shipped mock still boots native worklets under jest-expo, so
// stub the handful of exports ui.tsx touches instead. (The sheet itself runs on
// RN's own Animated, which needs no stub.)
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

import { BottomSheet } from '../ui';

const BODY = 'Sheet body';

describe('BottomSheet', () => {
  afterEach(cleanup);

  it('renders its title and children while visible', async () => {
    const view = await render(
      <BottomSheet visible onClose={jest.fn()} title="Weather location">
        <Text>{BODY}</Text>
      </BottomSheet>,
    );
    expect(view.getByText('Weather location')).toBeTruthy();
    expect(view.getByText(BODY)).toBeTruthy();
  });

  it('renders nothing when closed', async () => {
    const view = await render(
      <BottomSheet visible={false} onClose={jest.fn()}>
        <Text>{BODY}</Text>
      </BottomSheet>,
    );
    expect(view.queryByText(BODY)).toBeNull();
  });

  // Dismissal starts inside the sheet, so the caller is told only after the
  // slide-down finishes — callers that map onClose to a commit (the date
  // picker) rely on being called exactly once, not on being called instantly.
  it('reports a scrim tap to the caller', async () => {
    const onClose = jest.fn();
    const view = await render(
      <BottomSheet visible onClose={onClose}>
        <Text>{BODY}</Text>
      </BottomSheet>,
    );
    // `includeHiddenElements` because the sheet declares `accessibilityViewIsModal`,
    // which is exactly what hides the scrim from the a11y tree — assistive tech
    // should reach the sheet's controls, not the dimmed backdrop behind it.
    fireEvent.press(view.getByTestId('sheet-scrim', { includeHiddenElements: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // The caller owns `visible`; flipping it false must tear the sheet down on
  // its own (via the exit animation) without calling onClose a second time.
  it('unmounts when the caller closes it, without re-reporting', async () => {
    const onClose = jest.fn();
    const view = await render(
      <BottomSheet visible onClose={onClose}>
        <Text>{BODY}</Text>
      </BottomSheet>,
    );
    expect(view.getByText(BODY)).toBeTruthy();

    await view.rerender(
      <BottomSheet visible={false} onClose={onClose}>
        <Text>{BODY}</Text>
      </BottomSheet>,
    );
    await waitFor(() => expect(view.queryByText(BODY)).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  // The alert picker's "Custom…" row closes the option list and opens the
  // dual-wheel sheet from one `onChange`. iOS can only present one Modal at a
  // time, so the outgoing sheet MUST be gone from the tree in the same commit
  // that the incoming one appears — otherwise the new sheet never shows and the
  // old one's window keeps swallowing touches, freezing the form behind it.
  it('hands off to a second sheet without both being mounted', async () => {
    function Handoff({ open }: { open: 'first' | 'second' }) {
      return (
        <>
          <BottomSheet visible={open === 'first'} onClose={jest.fn()}>
            <Text>First sheet</Text>
          </BottomSheet>
          <BottomSheet visible={open === 'second'} onClose={jest.fn()}>
            <Text>Second sheet</Text>
          </BottomSheet>
        </>
      );
    }

    const view = await render(<Handoff open="first" />);
    expect(view.getByText('First sheet')).toBeTruthy();

    await view.rerender(<Handoff open="second" />);
    await waitFor(() => expect(view.queryByText('Second sheet')).toBeTruthy());
    expect(view.queryByText('First sheet')).toBeNull();
  });

  it('fires onShow once the sheet opens', async () => {
    const onShow = jest.fn();
    await render(
      <BottomSheet visible onClose={jest.fn()} onShow={onShow}>
        <Text>{BODY}</Text>
      </BottomSheet>,
    );
    await waitFor(() => expect(onShow).toHaveBeenCalled());
  });
});
