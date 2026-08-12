// Cooking a chosen flavor variation (specs/features/kitchen.md, "Ingredient
// groups & flavor variations"): cooking mode shows only the steps that apply
// to the kit being cooked (shared steps + that kit's own), keeps the per-step
// ingredient links aligned via real instruction indices, and filters other
// kits' ingredients out of the reference panel entirely.

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CookingModeScreen from '../CookingModeScreen';

const SEALED = { _id: 'r1', enc: { alg: 'aes', nonce: 'n', ct: 'c' } };
const OPEN = {
  title: 'Energy Balls',
  variations: ['Lemon Blueberry', 'Chocolate PB'],
  ingredients: [
    { name: 'Oats', amount: '2', unit: 'cups' },
    { name: 'Blueberries', amount: '1', unit: 'cup', group: 'Lemon Blueberry' },
    { name: 'Peanut Butter', amount: '2', unit: 'tbsp', group: 'Chocolate PB' },
  ],
  instructions: ['Mix the base', 'Fold in the blueberries', 'Fold in the peanut butter', 'Roll into balls'],
  instructionVariations: [null, ['Lemon Blueberry'], ['Chocolate PB'], null],
  instructionIngredients: [[0], [1], [2], []],
};

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { start: jest.fn(), abort: jest.fn(), requestPermissionsAsync: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
const mockSetOptions = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { id: 'r1', variation: 'Lemon Blueberry' } }),
  useNavigation: () => ({
    setOptions: (...a: unknown[]) => mockSetOptions(...(a as [])),
    goBack: jest.fn(),
    dispatch: jest.fn(),
    addListener: () => () => {},
  }),
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
  const { Text, TouchableOpacity } = require('react-native');
  const RealReact = require('react');
  return {
    CenteredLoader: () => null,
    BottomSheet: () => null,
    Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
      RealReact.createElement(TouchableOpacity, { onPress }, RealReact.createElement(Text, null, title)),
  };
});

function mount() {
  // gcTime: 0 — the default 5-minute cache GC timer is an open handle that
  // keeps jest from exiting.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <CookingModeScreen />
    </QueryClientProvider>,
  );
}

describe('CookingModeScreen with a chosen variation', () => {
  beforeEach(() => mockSetOptions.mockClear());
  afterEach(cleanup);

  it("walks only the chosen kit's steps, with progress counting the visible set", async () => {
    await mount();

    // 4 instructions, but the Chocolate PB fold-in doesn't apply: 3 visible.
    // The kit's name is NOT here — it would crowd the voice pill beside it.
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByText('Mix the base')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByText('Next')); });
    expect(screen.getByText('Fold in the blueberries')).toBeTruthy();
    // Real-index alignment: the blueberry step still shows ITS tagged ingredient.
    expect(screen.getByText('• 1 cup Blueberries')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByText('Next')); });
    // The Chocolate PB step is skipped outright.
    expect(screen.getByText('Roll into balls')).toBeTruthy();
    expect(screen.queryByText('Fold in the peanut butter')).toBeNull();
    // Last visible step: the button flips to Finish.
    expect(screen.getByText('Finish')).toBeTruthy();
  });

  it('names the kit in the header, where there is room for it', async () => {
    await mount();
    await screen.findByText('Mix the base');

    expect(mockSetOptions).toHaveBeenCalledWith({ title: 'Cooking — Lemon Blueberry' });
  });

  it("keeps the other kit's ingredients out of the all-ingredients panel", async () => {
    await mount();
    await screen.findByText('Mix the base');

    await act(async () => { fireEvent.press(screen.getByText('View all ingredients')); });

    expect(screen.getByText('• 2 cups Oats')).toBeTruthy();
    expect(screen.getByText('• 1 cup Blueberries')).toBeTruthy();
    expect(screen.queryByText(/Peanut Butter/)).toBeNull();
  });
});
