import React from 'react';
import { render, fireEvent, waitFor, act, cleanup } from '@testing-library/react-native';

// "Ask Calen" on a form: the pill opens a sheet, a turn that fills the form
// applies the patch and gets out of the way, a turn that can't stays put so the
// question can be answered, and the conversation survives closing the sheet.
//
// The one test here that must never be allowed to rot is the aiEnabled gate:
// with AI off in Privacy settings, nothing about this component may exist.

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
// Reanimated's shipped mock still boots native worklets under jest-expo, so
// stub the handful of exports ui.tsx touches. (The sheet itself runs on RN's
// own Animated, which needs no stub.)
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
jest.mock('../CreditsBanner', () => () => null);
jest.mock('../CalenGlyph', () => () => null);
jest.mock('expo-haptics', () => ({ impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('../../lib/calenFabIntro', () => ({ useCalenFabIntro: () => ({ intro: false, markSeen: jest.fn() }) }));

const mockPrefs = { aiEnabled: true, aiUsePersonalInfo: true };
jest.mock('../../lib/privacyPrefs', () => ({
  usePrivacyPrefs: () => ({ prefs: mockPrefs }),
}));

const mockFill = jest.fn();
jest.mock('../../api', () => ({
  formAssistApi: { fill: (...args: unknown[]) => mockFill(...args) },
}));

import FormAssistChat from '../FormAssistChat';

const FIELDS = [{ name: 'title', type: 'text' as const, label: 'Title' }];

// RNTL v14's render() is async.
const setup = (props: Record<string, unknown> = {}) =>
  render(
    <FormAssistChat formType="calendar event" fields={FIELDS} current={{ title: '' }} {...props} />,
  );

const openSheet = async (utils: Awaited<ReturnType<typeof render>>) => {
  fireEvent.press(utils.getByLabelText('Ask Calen'));
  await waitFor(() => utils.getByPlaceholderText('Describe what you want to add…'));
};

// Type a prompt and send it. Both waits are load-bearing: the composer is
// read-only while a turn is in flight and the send button is disabled until it
// holds text, and RNTL refuses to fire on either — so without them a follow-up
// turn silently does nothing.
const ask = async (utils: Awaited<ReturnType<typeof render>>, text: string) => {
  const input = await waitFor(() => {
    const el = utils.getByPlaceholderText('Describe what you want to add…');
    if (el.props.editable === false) throw new Error('composer still busy');
    return el;
  });
  fireEvent.changeText(input, text);

  const sendBtn = await waitFor(() => {
    const el = utils.getByLabelText('Send to Calen');
    if (el.props.accessibilityState?.disabled) throw new Error('send still disabled');
    return el;
  });
  fireEvent.press(sendBtn);
};

beforeEach(() => {
  mockFill.mockReset();
  mockPrefs.aiEnabled = true;
  mockPrefs.aiUsePersonalInfo = true;
});
afterEach(cleanup);

describe('FormAssistChat', () => {
  it('renders the pill, and no sheet until it is tapped', async () => {
    const { getByLabelText, queryByPlaceholderText } = await setup();
    expect(getByLabelText('Ask Calen')).toBeTruthy();
    expect(queryByPlaceholderText('Describe what you want to add…')).toBeNull();
  });

  it('renders NOTHING when AI is disabled in Privacy settings', async () => {
    mockPrefs.aiEnabled = false;
    const { queryByLabelText } = await setup();
    expect(queryByLabelText('Ask Calen')).toBeNull();
  });

  // These two ride on the real CLOSE_DELAY_MS beat rather than fake timers:
  // RNTL's waitFor drives its own timers, and swapping in jest's fake ones
  // deadlocks the very waits these assertions are built on.
  const PAST_THE_BEAT_MS = 1400;

  it('applies the patch and closes the sheet after a filled turn', async () => {
    mockFill.mockResolvedValue({ data: { patch: { title: 'Dentist' }, reply: 'Set the title to Dentist.' } });
    const onApply = jest.fn();
    const utils = await setup({ onApply });

    await openSheet(utils);
    await ask(utils, 'dentist next Tuesday');

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ title: 'Dentist' }));
    // The confirmation is on screen during the beat, not skipped past.
    expect(utils.getByText('Set the title to Dentist.')).toBeTruthy();

    await waitFor(
      () => expect(utils.queryByText('Set the title to Dentist.')).toBeNull(),
      { timeout: PAST_THE_BEAT_MS },
    );
  });

  it('keeps the sheet open when the turn is a clarifying question', async () => {
    mockFill.mockResolvedValue({ data: { patch: {}, reply: 'Which day next week?' } });
    const onApply = jest.fn();
    const utils = await setup({ onApply });

    await openSheet(utils);
    await ask(utils, 'sometime next week');

    await waitFor(() => utils.getByText('Which day next week?'));
    expect(onApply).not.toHaveBeenCalled();

    // No close was ever armed — the sheet is still there well past the beat.
    await act(async () => { await new Promise((r) => setTimeout(r, PAST_THE_BEAT_MS)); });
    expect(utils.getByText('Which day next week?')).toBeTruthy();
  });

  it('sends the running transcript, not just the latest prompt', async () => {
    mockFill.mockResolvedValue({ data: { patch: {}, reply: 'Which day?' } });
    const utils = await setup();

    await openSheet(utils);
    await ask(utils, 'add a dentist appointment');
    await waitFor(() => utils.getByText('Which day?'));
    await ask(utils, 'Tuesday');

    await waitFor(() => expect(mockFill).toHaveBeenCalledTimes(2));
    expect(mockFill.mock.calls[1][0].messages).toEqual([
      { role: 'user', content: 'add a dentist appointment' },
      { role: 'assistant', content: 'Which day?' },
      { role: 'user', content: 'Tuesday' },
    ]);
    // The one-shot `prompt` field belongs to the old card; never send both.
    expect(mockFill.mock.calls[1][0].prompt).toBeUndefined();
  });

  it('still shows the conversation after the sheet is closed and reopened', async () => {
    mockFill.mockResolvedValue({ data: { patch: {}, reply: 'Which day next week?' } });
    const utils = await setup();

    await openSheet(utils);
    await ask(utils, 'sometime next week');
    await waitFor(() => utils.getByText('Which day next week?'));

    // includeHiddenElements: the scrim is mid-fade-in (opacity 0 → 1), which
    // RNTL scores as hidden even though it is tappable the whole time.
    fireEvent.press(utils.getByTestId('sheet-scrim', { includeHiddenElements: true }));
    await waitFor(() => expect(utils.queryByText('Which day next week?')).toBeNull());

    await openSheet(utils);
    expect(utils.getByText('sometime next week')).toBeTruthy();
    expect(utils.getByText('Which day next week?')).toBeTruthy();
  });

  it('withholds contacts when the personal-info pref is off', async () => {
    mockPrefs.aiUsePersonalInfo = false;
    mockFill.mockResolvedValue({ data: { patch: {}, reply: 'ok' } });
    const utils = await setup({ includeContacts: true });

    await openSheet(utils);
    await ask(utils, 'my dentist');

    await waitFor(() => expect(mockFill).toHaveBeenCalled());
    expect(mockFill.mock.calls[0][0].includeContacts).toBe(false);
  });

  it('surfaces a server error in the sheet and keeps it open', async () => {
    mockFill.mockRejectedValue({ response: { data: { error: 'Out of credits.' } } });
    const utils = await setup();

    await openSheet(utils);
    await ask(utils, 'anything');

    await waitFor(() => utils.getByText('Out of credits.'));
    // The user's message stays in the transcript so they can retry from it.
    expect(utils.getByText('anything')).toBeTruthy();
  });

  it('runs the screen\'s own action in onSubmit mode and never calls /form-assist', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const utils = await setup({ onSubmit, fields: undefined, current: undefined });

    await openSheet(utils);
    await ask(utils, 'make it vegan');

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('make it vegan'));
    expect(mockFill).not.toHaveBeenCalled();
    // No patch, so the sheet stays open with its confirmation.
    expect(utils.getByText('Done — the form has been updated.')).toBeTruthy();
  });

  it('reset() drops the conversation (used when a form re-seeds from an import)', async () => {
    mockFill.mockResolvedValue({ data: { patch: {}, reply: 'Which day?' } });
    const ref = React.createRef<{ reset: () => void }>();
    const utils = await render(
      <FormAssistChat ref={ref as never} formType="trip booking" fields={FIELDS} current={{}} />,
    );

    await openSheet(utils);
    await ask(utils, 'flight to Rome');
    await waitFor(() => utils.getByText('Which day?'));

    await act(async () => { ref.current?.reset(); });
    expect(utils.queryByText('flight to Rome')).toBeNull();
    expect(utils.queryByText('Which day?')).toBeNull();
  });
});
