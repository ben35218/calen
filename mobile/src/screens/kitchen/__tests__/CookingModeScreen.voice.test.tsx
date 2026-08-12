// Cooking mode's hands-free navigation (specs/features/kitchen.md, "Cooking
// mode"): the opt-in voice pill drives on-device keyword commands, and the
// step area's tap zones advance (right) / go back (left edge). "Next" on the
// last step does nothing — finishing stays a deliberate button tap.

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CookingModeScreen from '../CookingModeScreen';

const SEALED = { _id: 'r1', enc: { alg: 'aes', nonce: 'n', ct: 'c' } };
const OPEN = {
  title: 'Chicken Parm',
  ingredients: [{ name: 'Garlic', amount: '2', unit: 'cloves' }],
  instructions: ['Chop the garlic', 'Simmer the sauce', 'Plate it'],
  instructionIngredients: [[0], [], []],
  // No timers in this fixture: a started CookTimer's 1-second ticker would keep
  // firing state updates between act() scopes for the rest of the suite. The
  // timer hint/start behavior is pinned by CookingModeScreen.stepData.test.tsx.
  instructionTimers: [null, null, null],
};

const mockHandlers: Record<string, (e: unknown) => void> = {};
const mockStart = jest.fn();
const mockAbort = jest.fn();
const mockSpeak = jest.fn();
const mockSpeechStop = jest.fn(async () => {});

jest.mock('expo-speech', () => ({
  speak: (...a: unknown[]) => mockSpeak(...a),
  stop: () => mockSpeechStop(),
}));

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    start: (...a: unknown[]) => mockStart(...a),
    abort: (...a: unknown[]) => mockAbort(...a),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  },
  useSpeechRecognitionEvent: (name: string, cb: (e: unknown) => void) => { mockHandlers[name] = cb; },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { id: 'r1' } }),
  useNavigation: () => ({ setOptions: jest.fn(), goBack: jest.fn(), dispatch: jest.fn(), addListener: () => () => {} }),
  // The screen guards its exit with usePreventRemove (running timers).
  usePreventRemove: () => {},
}));
jest.mock('../../../api', () => ({ recipesApi: { get: jest.fn(async () => ({ data: SEALED })) } }));
jest.mock('../../../lib/e2ee', () => ({
  openRecord: jest.fn(async (_c: string, row: Record<string, unknown>) => ({ ...row, ...OPEN })),
}));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../../components/ui', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  const RealReact = require('react');
  return {
    CenteredLoader: () => null,
    BottomSheet: ({ visible, title, children }: { visible: boolean; title?: string; children: React.ReactNode }) =>
      visible
        ? RealReact.createElement(View, null, RealReact.createElement(Text, null, title), children)
        : null,
    Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
      RealReact.createElement(TouchableOpacity, { onPress }, RealReact.createElement(Text, null, title)),
  };
});

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const r = await render(
    <QueryClientProvider client={qc}>
      <CookingModeScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('Chop the garlic');
  return r;
}

const say = async (transcript: string, isFinal = true) => {
  await act(async () => {
    mockHandlers['result']?.({ isFinal, results: [{ transcript }] });
  });
};

// Pressing the pill kicks off voice.start()'s async permission chain; keep the
// press AND its microtasks inside one act so no update straddles act scopes.
const pressPill = async (label: string) => {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('CookingModeScreen hands-free navigation', () => {
  afterEach(() => { cleanup(); jest.clearAllMocks(); });

  it('voice mode is opt-in, runs on-device, and navigates steps by keyword', async () => {
    await mount();
    expect(mockStart).not.toHaveBeenCalled();

    await pressPill('Turn on voice commands');
    expect(screen.getByText('Listening…')).toBeTruthy();
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: true, continuous: true, interimResults: true }),
    );

    await say('OK next');
    expect(screen.getByText('Simmer the sauce')).toBeTruthy();
    await say('go back');
    expect(screen.getByText('Chop the garlic')).toBeTruthy();
  });

  it('acts on the first interim result, once per utterance', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    // The interim hit advances immediately — no waiting for the final…
    await say('next', false);
    expect(screen.getByText('Simmer the sauce')).toBeTruthy();
    // …and the same utterance growing ("next next") then finalizing doesn't
    // re-fire the command.
    await say('next next', false);
    await say('next next', true);
    expect(screen.getByText('Simmer the sauce')).toBeTruthy();

    // The next utterance is live again.
    await say('next', false);
    expect(screen.getByText('Plate it')).toBeTruthy();
  });

  it('jumps straight to a spoken step number, ignoring out-of-range ones', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    await say('go to step three');
    expect(screen.getByText('Plate it')).toBeTruthy();
    await say('step 1');
    expect(screen.getByText('Chop the garlic')).toBeTruthy();
    await say('step 9');
    expect(screen.getByText('Chop the garlic')).toBeTruthy(); // out of range — ignored
  });

  it('ignores "next" on the last step and mic-off aborts the recognizer', async () => {
    await mount();
    await pressPill('Turn on voice commands');
    await say('next');
    await say('next');
    expect(screen.getByText('Plate it')).toBeTruthy();

    await say('next');
    expect(screen.getByText('Plate it')).toBeTruthy(); // still there — no hands-free finish

    await pressPill('Turn off voice commands');
    expect(mockAbort).toHaveBeenCalled();
    // The pill may still be flashing the last command's label; the toggle
    // state is what proves the mic is off.
    expect(screen.getByLabelText('Turn on voice commands')).toBeTruthy();
  });

  it('"read" speaks the step with the mic parked, resuming when speech ends', async () => {
    await mount();
    await pressPill('Turn on voice commands');
    mockStart.mockClear();
    mockAbort.mockClear();
    const vibrate = jest.spyOn(require('react-native').Vibration, 'vibrate');

    await say('read');
    expect(mockSpeak).toHaveBeenCalledWith('Step 1. Chop the garlic', expect.any(Object));
    expect(vibrate).not.toHaveBeenCalled(); // the narration is the confirmation
    // Recognition is parked while the phone talks — the mic must not hear the
    // step text and fire commands out of the recipe.
    expect(mockAbort).toHaveBeenCalled();

    // The aborted session's trailing `end` must NOT restart mid-speech…
    await act(async () => { mockHandlers['end']?.({}); });
    expect(mockStart).not.toHaveBeenCalled();

    // …speech finishing is what brings the mic back.
    const opts = mockSpeak.mock.calls[0][1] as { onDone: () => void };
    await act(async () => { opts.onDone(); });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  // The paging math (partial pages that stack, clamped to the ends) is pinned
  // in lib/__tests__/scrollPage.test.ts as a pure function — firing layout/
  // contentSizeChange at the ScrollView here corrupts the test renderer's
  // later press dispatch, so this test only pins the command wiring.
  it('"down"/"up" are recognized scroll commands', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    await say('down');
    expect(screen.getByText('Down')).toBeTruthy(); // flashed in the pill
    await say('scroll up');
    expect(screen.getByText('Up')).toBeTruthy();
  });

  it('"top"/"bottom" are recognized step-area jump commands', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    await say('bottom');
    expect(screen.getByText('Bottom')).toBeTruthy(); // flashed in the pill
    await say('scroll to top');
    expect(screen.getByText('Top')).toBeTruthy();
  });

  it('"read ingredients" speaks the panel list slowly, mic parked, no buzz', async () => {
    await mount();
    await pressPill('Turn on voice commands');
    mockAbort.mockClear();
    const vibrate = jest.spyOn(require('react-native').Vibration, 'vibrate');

    await say('read ingredients');
    expect(mockSpeak).toHaveBeenCalledWith('Ingredients for step 1. 2 cloves Garlic.', expect.any(Object));
    // Slower than the default voice — the cook is measuring along.
    expect((mockSpeak.mock.calls[0][1] as { rate: number }).rate).toBeLessThan(1);
    expect(mockAbort).toHaveBeenCalled(); // parked, same as "read"
    // The narration is the confirmation — a read command doesn't rumble.
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('"ingredients top"/"bottom" jump the panel without flipping the view-all toggle', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    await say('ingredients bottom');
    expect(screen.getByText('Ingredients bottom')).toBeTruthy(); // flashed in the pill
    expect(screen.getByText('For this step')).toBeTruthy(); // toggle untouched

    await say('ingredients top');
    expect(screen.getByText('Ingredients top')).toBeTruthy();
    expect(screen.getByText('For this step')).toBeTruthy();
  });

  it('the "Voice commands" row pops up the command chart sheet', async () => {
    await mount();
    expect(screen.queryByText('Voice Commands')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByLabelText('Show voice commands')); });
    expect(screen.getByText('Voice Commands')).toBeTruthy();
    expect(screen.getByText('“Read ingredients”')).toBeTruthy();
    expect(screen.getByText('“Ingredients top”')).toBeTruthy();
  });

  it('"ingredients down"/"up" scroll the panel without flipping the view-all toggle', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    await say('ingredients down');
    expect(screen.getByText('Ingredients down')).toBeTruthy(); // flashed in the pill
    expect(screen.getByText('For this step')).toBeTruthy(); // toggle untouched

    await say('scroll ingredients up');
    expect(screen.getByText('Ingredients up')).toBeTruthy();
    expect(screen.getByText('For this step')).toBeTruthy();
  });

  it('a bare "ingredients" interim holds until the final, then toggles', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    // "ingredients down" may still be on its way — the interim must not fire
    // the toggle (which would swallow the scroll command)…
    await say('ingredients', false);
    expect(screen.getByText('For this step')).toBeTruthy();

    // …but the utterance genuinely ending on "ingredients" toggles as before.
    await say('ingredients', true);
    expect(screen.getByText('All ingredients')).toBeTruthy();
  });

  it('an interim that grows into "ingredients down" scrolls, and only scrolls', async () => {
    await mount();
    await pressPill('Turn on voice commands');

    await say('ingredients', false);
    await say('ingredients down', false); // unambiguous now — fires off the interim
    expect(screen.getByText('Ingredients down')).toBeTruthy();
    await say('ingredients down', true);
    expect(screen.getByText('For this step')).toBeTruthy(); // toggle never fired
  });

  it('changing steps cuts the narration short', async () => {
    await mount();
    await pressPill('Turn on voice commands');
    await say('read');
    mockSpeechStop.mockClear();

    await act(async () => { fireEvent.press(screen.getByTestId('tap-next')); });
    expect(mockSpeechStop).toHaveBeenCalled();
  });

  it('restarts the recognizer when the OS ends the session mid-listen', async () => {
    await mount();
    await pressPill('Turn on voice commands');
    mockStart.mockClear();

    await act(async () => { mockHandlers['end']?.({}); });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('tap zones: the next zone advances, the back zone returns', async () => {
    await mount();

    await act(async () => { fireEvent.press(screen.getByTestId('tap-next')); });
    expect(screen.getByText('Simmer the sauce')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByTestId('tap-back')); });
    expect(screen.getByText('Chop the garlic')).toBeTruthy();
  });

  it('the next zone stops at the last step', async () => {
    await mount();
    for (let i = 0; i < 3; i++) {
      await act(async () => { fireEvent.press(screen.getByTestId('tap-next')); });
    }
    expect(screen.getByText('Plate it')).toBeTruthy();
  });
});
