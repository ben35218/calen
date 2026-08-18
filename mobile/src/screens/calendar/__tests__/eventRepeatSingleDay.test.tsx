import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// Node built-ins the RN tsconfig has no types for (same shape textScaling.test uses).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
const fs = require('fs') as { readFileSync(p: string, enc: string): string };
const path = require('path') as { join(...parts: string[]): string };

// The shared Repeat screen's `singleDay` restriction (maintenance.md → the
// repeat-rule section). The sealed chore/task Recurrence stores ONE dayOfWeek /
// dayOfMonth, so the chore and task forms push the screen with `singleDay:
// true`: the weekday list and month-date grid become single-select (the tapped
// day REPLACES the selection instead of joining it). Without the param — the
// calendar event form — multi-select is unchanged.

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
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
jest.mock('../../../components/WheelPicker', () => {
  const mock = () => null;
  return { __esModule: true, default: mock, WHEEL_ITEM_H: 40, WHEEL_VISIBLE: 5 };
});
jest.mock('../../../lib/repeatDraft', () => ({
  setRepeatDraft: jest.fn(),
  clearRepeatDraft: jest.fn(),
  useRepeatDraft: () => null,
}));

const mockParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockParams }),
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }),
}));

import EventRepeatScreen from '../EventRepeatScreen';
import { setRepeatDraft } from '../../../lib/repeatDraft';
import { EMPTY_REPEAT } from '../../../lib/eventRepeat';

const mockSetRepeatDraft = setRepeatDraft as jest.Mock;

const setParams = (params: Record<string, unknown>) => {
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  Object.assign(mockParams, params);
};

beforeEach(() => jest.clearAllMocks());

describe('EventRepeatScreen singleDay restriction', () => {
  const weeklyTue = { ...EMPTY_REPEAT, freq: 'weekly', daysOfWeek: [2] };

  it('weekly: tapping another weekday REPLACES the selection', async () => {
    setParams({ rule: weeklyTue, date: '2026-08-11', singleDay: true });
    const view = await render(<EventRepeatScreen />);
    fireEvent.press(view.getByText('Thursday'));
    expect(mockSetRepeatDraft).toHaveBeenCalledWith(
      expect.objectContaining({ daysOfWeek: [4] }),
    );
  });

  it('weekly without the param (events): tapping another weekday ADDS it', async () => {
    setParams({ rule: weeklyTue, date: '2026-08-11' });
    const view = await render(<EventRepeatScreen />);
    fireEvent.press(view.getByText('Thursday'));
    expect(mockSetRepeatDraft).toHaveBeenCalledWith(
      expect.objectContaining({ daysOfWeek: [2, 4] }),
    );
  });

  it('monthly: tapping another date REPLACES the selection', async () => {
    setParams({
      rule: { ...EMPTY_REPEAT, freq: 'monthly', daysOfMonth: [5] },
      date: '2026-08-05',
      singleDay: true,
    });
    const view = await render(<EventRepeatScreen />);
    fireEvent.press(view.getByText('20'));
    expect(mockSetRepeatDraft).toHaveBeenCalledWith(
      expect.objectContaining({ daysOfMonth: [20] }),
    );
  });

  it('yearly: the within-year ordinal switch is hidden (nowhere to store it)', async () => {
    setParams({
      rule: { ...EMPTY_REPEAT, freq: 'yearly', months: [6] },
      date: '2026-06-15',
      singleDay: true,
    });
    const view = await render(<EventRepeatScreen />);
    expect(view.queryByText('Days of week')).toBeNull();
  });
});

// Param-level wiring: the chore and task forms MUST push the Repeat screen in
// restricted mode, and the event form must not. A source scan pins the wiring
// without mounting the (heavily query/E2EE-coupled) form screens.
describe('singleDay param wiring', () => {
  const src = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');

  it.each([
    'screens/maintenance/ChoreFormScreen.tsx',
    'screens/maintenance/TaskFormScreen.tsx',
  ])('%s passes singleDay: true to EventRepeat', (rel) => {
    const nav = /navigate\('EventRepeat',\s*\{[^}]*\}/s.exec(src(rel));
    expect(nav).not.toBeNull();
    expect(nav![0]).toContain('singleDay: true');
  });

  it('the calendar event form keeps the unrestricted picker', () => {
    expect(src('screens/calendar/EventFormScreen.tsx')).not.toContain('singleDay');
  });
});
