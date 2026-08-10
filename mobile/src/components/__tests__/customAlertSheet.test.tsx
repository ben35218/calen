import React, { useState } from 'react';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';

// The event form's "Custom…" alert sheet (specs/features/calendar.md → the
// custom alert sheet). Its contract is that the sheet is a PICKER, not a form:
// whatever the wheel is showing when the sheet goes away is the alert. A
// dismissal — scrim tap, drag-down, Android back — saves exactly what Done
// saves. With only Done saving, "dial 45 minutes, tap away" threw the setting
// on the floor. The one exception is a sheet the user never touched, which must
// not write its seeded default into a slot that held no alert.
//
// NOTE ON SCOPE: only ONE test here may interact with the sheet and then close
// it. React 19 + RNTL leave the test root mid-act once the sheet's animated
// teardown lands, so every later render in the same file comes back empty. Keep
// the interactive case last; a further case needs its own file.

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
// Reanimated's shipped mock still boots native worklets under jest-expo, so stub
// the handful of exports the wheel and ui.tsx touch. (The sheet itself runs on
// RN's own Animated, which needs no stub.)
jest.mock('react-native-reanimated', () => {
  const { View, ScrollView } = require('react-native');
  return {
    __esModule: true,
    default: { View, ScrollView },
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedRef: () => ({ current: { scrollTo: () => {} } }),
    useAnimatedScrollHandler: () => () => {},
    useAnimatedStyle: () => ({}),
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' },
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withSequence: (v: unknown) => v,
  };
});

import CustomAlertSheet from '../CustomAlertSheet';

type SheetProps = React.ComponentProps<typeof CustomAlertSheet>;
type View = Awaited<ReturnType<typeof render>>;

// Stands in for the event form: it owns `visible` and drops it when the sheet
// reports a close, so a dismissal is a real teardown rather than a sheet that
// slides out and comes straight back.
function Host({ onSave, ...rest }: Omit<SheetProps, 'visible' | 'onClose'>) {
  const [open, setOpen] = useState(true);
  return <CustomAlertSheet visible={open} onClose={() => setOpen(false)} onSave={onSave} {...rest} />;
}

async function open(props: Partial<SheetProps> = {}) {
  const onSave = jest.fn();
  const view = await render(
    <Host initialMinutes={null} initialAnchor="event" travelMinutes={null} onSave={onSave} {...props} />,
  );
  return { view, onSave };
}

// Every user dismissal — scrim tap, drag-down, Android back — runs the sheet's
// requestClose; the scrim is the one a test can reach.
function dismiss(view: View) {
  fireEvent.press(view.getByTestId('sheet-scrim', { includeHiddenElements: true }));
}

// The sheet reports its close only after the slide-out, so a dismissal is only
// complete once the sheet has left the tree.
async function gone(view: View) {
  await waitFor(() => expect(view.queryByText('Done', { includeHiddenElements: true })).toBeNull());
}

describe('CustomAlertSheet', () => {
  afterEach(cleanup);

  // The sheet seeds itself with 30 minutes so the wheel has something to show;
  // that seed is not a choice the user made.
  it('writes nothing when dismissed without touching a control', async () => {
    const { view, onSave } = await open();
    dismiss(view);
    await gone(view);
    expect(onSave).not.toHaveBeenCalled();
  });

  // The regression: a lead time dialled in and then dismissed used to vanish,
  // because only Done called back. Tapping a wheel row commits it exactly as
  // scrolling it under the selection band does.
  it('saves the dialled lead time when the sheet is dismissed, not just on Done', async () => {
    const { view, onSave } = await open();
    fireEvent.press(view.getByText('45', { includeHiddenElements: true }));
    dismiss(view);
    await gone(view);
    expect(onSave).toHaveBeenCalledWith(45, 'event');
  });
});
