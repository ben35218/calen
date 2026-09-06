import React from 'react';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';

// The shared time wheel steps in 5-minute intervals app-wide (Apple Calendar's
// granularity — specs/features/calendar.md → "Starts / Ends editing"). The one
// sanctioned opt-out is a minute-precise timetable time (the booking form's
// flight/transit Departs/Arrives), which passes minuteInterval={1}. Date mode
// has no minutes wheel, so it must not receive an interval at all.

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
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

const mockPickerSpy = jest.fn();
jest.mock('@react-native-community/datetimepicker', () => (props: Record<string, unknown>) => {
  mockPickerSpy(props);
  return null;
});

import { TimeField, DateField } from '../ui';

// The native picker only mounts once the field is tapped open (iOS renders it
// inside the shared BottomSheet).
async function openPicker(ui: React.ReactElement, valueText: string) {
  const view = await render(ui);
  fireEvent.press(view.getByText(valueText));
  await waitFor(() => expect(mockPickerSpy).toHaveBeenCalled());
  return mockPickerSpy.mock.calls[mockPickerSpy.mock.calls.length - 1][0];
}

describe('time wheel minute interval', () => {
  afterEach(() => {
    cleanup();
    mockPickerSpy.mockClear();
  });

  it('defaults the minutes wheel to 5-minute steps', async () => {
    const props = await openPicker(
      <TimeField value="09:00" onChange={jest.fn()} />,
      '9:00 AM',
    );
    expect(props.mode).toBe('time');
    expect(props.minuteInterval).toBe(5);
  });

  it('honors the timetable opt-out (minuteInterval={1})', async () => {
    const props = await openPicker(
      <TimeField value="07:43" onChange={jest.fn()} minuteInterval={1} />,
      '7:43 AM',
    );
    expect(props.minuteInterval).toBe(1);
  });

  it('passes no interval in date mode', async () => {
    const props = await openPicker(
      <DateField value="2026-09-06" onChange={jest.fn()} />,
      'Sep 6, 2026',
    );
    expect(props.mode).toBe('date');
    expect(props.minuteInterval).toBeUndefined();
  });
});
