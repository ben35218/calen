// Leaving cooking mode with a live timer (specs/features/kitchen.md, "Cooking
// mode"). The countdown lives in the module store, not in the screen, so the
// exit asks what to do with it: keep it running (armed as an OS alarm) or stop
// it. Nothing running → the exit is silent.

import React from 'react';
import { ActionSheetIOS } from 'react-native';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CookingModeScreen from '../CookingModeScreen';
import { getCookTimers, runningCookTimers, resetCookTimers } from '../../../lib/cookTimers';

const SEALED = { _id: 'r1', enc: { alg: 'aes', nonce: 'n', ct: 'c' } };
const OPEN = {
  title: 'Chicken Parm',
  ingredients: [{ name: 'Garlic', amount: '2', unit: 'cloves' }],
  instructions: ['Simmer the sauce', 'Plate it'],
  instructionIngredients: [[0], []],
  instructionTimers: [10, null],  // step 1's timer starts on Next
};

// What the screen hands usePreventRemove: whether to hold the exit, and what to
// run when one is attempted. The real hook holds both the JS event AND the
// native pop — a native stack ignores a bare preventDefault — so `leave()`
// answers the only question that matters here: was the exit held?
const prevent: { on: boolean; cb: ((o: { data: { action: unknown } }) => void) | null } =
  { on: false, cb: null };
const mockDispatch = jest.fn();
const POP = { type: 'POP' };
const leave = () => {
  if (!prevent.on) return false;
  prevent.cb?.({ data: { action: POP } });
  return true;
};

const mockSchedule = jest.fn(async () => 'notif-1');
const mockCancel = jest.fn(async () => {});
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...(a as [])),
  cancelScheduledNotificationAsync: (...a: unknown[]) => mockCancel(...(a as [])),
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { start: jest.fn(), abort: jest.fn(), requestPermissionsAsync: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { id: 'r1' } }),
  useNavigation: () => ({
    setOptions: jest.fn(),
    goBack: jest.fn(),
    dispatch: (...a: unknown[]) => mockDispatch(...(a as [])),
    addListener: () => () => {},
  }),
  usePreventRemove: (on: boolean, cb: unknown) => { prevent.on = on; prevent.cb = cb as typeof prevent.cb; },
}));
jest.mock('../../../api', () => ({ recipesApi: { get: jest.fn(async () => ({ data: SEALED })) } }));
jest.mock('../../../lib/e2ee', () => ({
  openRecord: jest.fn(async (_c: string, row: Record<string, unknown>) => ({ ...row, ...OPEN })),
}));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../../components/ui', () => {
  const { Text, TouchableOpacity } = require('react-native');
  const RealReact = require('react');
  return {
    CenteredLoader: () => null,
    BottomSheet: () => null,
    Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
      RealReact.createElement(TouchableOpacity, { onPress }, RealReact.createElement(Text, null, title)),
  };
});

// The action sheet, captured so a test can pick an option by its label.
let sheetTap: ((label: string) => Promise<void>) | null = null;
jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((opts, cb) => {
  sheetTap = async (label: string) => {
    await act(async () => { cb(opts.options.indexOf(label)); });
  };
});

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // render is async in RNTL v14 — `screen` isn't bound until it settles.
  const r = await render(
    <QueryClientProvider client={qc}>
      <CookingModeScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('Simmer the sauce');
  return r;
}

// Advancing off step 1 starts its 10-minute timer.
const startTimer = async () => {
  await act(async () => { fireEvent.press(screen.getByText('Next')); });
  expect(screen.getByText('10:00')).toBeTruthy();
};

describe('CookingModeScreen leaving with a running timer', () => {
  beforeEach(() => { jest.clearAllMocks(); sheetTap = null; prevent.on = false; prevent.cb = null; });
  afterEach(async () => { await cleanup(); resetCookTimers(); });

  it('leaves silently when no timer is running', async () => {
    await mount();
    expect(leave()).toBe(false);  // the exit is not held at all
    expect(ActionSheetIOS.showActionSheetWithOptions).not.toHaveBeenCalled();
  });

  it('blocks the exit and offers keep / stop / cancel', async () => {
    await mount();
    await startTimer();

    expect(leave()).toBe(true);  // the exit is held — natively too — while we ask
    const opts = (ActionSheetIOS.showActionSheetWithOptions as jest.Mock).mock.calls[0][0];
    expect(opts.title).toBe('A timer is still running.');
    expect(opts.options).toEqual(['Keep Timer Running', 'Stop Timer and Leave', 'Cancel']);
    expect(opts.destructiveButtonIndex).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('Cancel stays on the screen with the timer intact', async () => {
    await mount();
    await startTimer();
    leave();
    await sheetTap!('Cancel');

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(screen.getByText('10:00')).toBeTruthy();
  });

  it('Keep Timer Running leaves, and the timer survives the screen as an alarm', async () => {
    const r = await mount();
    await startTimer();
    leave();
    await sheetTap!('Keep Timer Running');

    expect(mockDispatch).toHaveBeenCalledWith(POP);
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ body: 'Step 1 is up.' }),
      trigger: expect.objectContaining({ type: 'date' }),
    }));
    // The countdown lives on past the screen, armed.
    await act(async () => { r.unmount(); });
    expect(runningCookTimers('r1').map((t) => t.notificationId)).toEqual(['notif-1']);

    // Coming back: the chip is counting again and the alarm stands down.
    await mount();
    expect(screen.getByText('10:00')).toBeTruthy();
    expect(mockCancel).toHaveBeenCalledWith('notif-1');
  });

  it('Stop Timer and Leave drops the timer outright', async () => {
    const r = await mount();
    await startTimer();
    leave();
    await sheetTap!('Stop Timer and Leave');

    expect(mockDispatch).toHaveBeenCalledWith(POP);
    expect(mockSchedule).not.toHaveBeenCalled();
    await act(async () => { r.unmount(); });
    expect(getCookTimers('r1')).toEqual([]);
  });
});
