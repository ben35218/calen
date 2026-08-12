// Cooking mode's per-step data (specs/features/kitchen.md, "Recipes"). The
// store row is sealed, so the screen must route its fetch through openRecord
// like every other recipe reader — a raw fetch renders only legacy plaintext
// fields, and the per-step ingredient tags and timers (which live in the enc
// blob) silently vanish. Uses a real QueryClient so the queryFn actually runs.

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CookingModeScreen from '../CookingModeScreen';

// What the store hands back: a sealed row with no readable content.
const SEALED = { _id: 'r1', enc: { alg: 'aes', nonce: 'n', ct: 'c' } };
// What openRecord recovers from the enc blob.
const OPEN = {
  title: 'Chicken Parm',
  ingredients: [
    { name: 'Garlic', amount: '2', unit: 'cloves' },
    { name: 'Basil', amount: '', unit: '' },
  ],
  instructions: ['Chop the garlic', 'Simmer the sauce'],
  instructionIngredients: [[0], [1]],
  instructionTimers: [null, 10],
};

const mockOpenRecord = jest.fn(async (_collection: string, row: Record<string, unknown>) => ({ ...row, ...OPEN }));

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { start: jest.fn(), abort: jest.fn(), requestPermissionsAsync: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { id: 'r1' } }),
  useNavigation: () => ({ setOptions: jest.fn(), goBack: jest.fn(), dispatch: jest.fn(), addListener: () => () => {} }),
  // The screen guards its exit with usePreventRemove (running timers).
  usePreventRemove: () => {},
}));
jest.mock('../../../api', () => ({ recipesApi: { get: jest.fn(async () => ({ data: SEALED })) } }));
jest.mock('../../../lib/e2ee', () => ({ openRecord: (...a: unknown[]) => mockOpenRecord(...(a as [string, Record<string, unknown>])) }));
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

describe('CookingModeScreen step data', () => {
  afterEach(cleanup);

  it('decrypts the sealed row and shows the step with its tagged ingredients', async () => {
    await mount();

    expect(await screen.findByText('Chop the garlic')).toBeTruthy();
    expect(mockOpenRecord).toHaveBeenCalledWith('Recipe', SEALED);
    // Step 1's tagged ingredient, not the whole list.
    expect(screen.getByText('• 2 cloves Garlic')).toBeTruthy();
    expect(screen.queryByText('• Basil')).toBeNull();
  });

  it("shows the next step's timer hint and its tagged ingredient after advancing", async () => {
    await mount();
    await screen.findByText('Chop the garlic');

    await act(async () => { fireEvent.press(screen.getByText('Next')); });

    expect(screen.getByText('Simmer the sauce')).toBeTruthy();
    expect(screen.getByText('10 min timer — starts when you continue')).toBeTruthy();
    expect(screen.getByText('• Basil')).toBeTruthy();
    expect(screen.queryByText('• 2 cloves Garlic')).toBeNull();
  });
});
