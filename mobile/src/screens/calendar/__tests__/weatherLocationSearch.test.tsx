import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react-native';

// The Weather screen's "Another location" picker (calendar.md → "The Weather
// screen's location source" → Another location).
//
// The bug this guards against: the Google-Places search used to live *inside*
// the source-picker bottom sheet, with its suggestions in a dropdown hanging
// under the field. A sheet rides on top of the keyboard, so that dropdown grew
// straight behind the keys — the user could type but could neither read nor
// tap a single match. The fix is architectural, not a taller dropdown: the
// search is a PUSHED FULL SCREEN (like the event form's Location screen) whose
// field hangs from the header — out of the keyboard's reach by construction —
// with the matches filling the screen below it.

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

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useFocusEffect: () => {},
}));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 96 }));

const mockAutocomplete = jest.fn();
jest.mock('../../../api', () => ({
  placesApi: { autocomplete: (...args: unknown[]) => mockAutocomplete(...args) },
}));
jest.mock('../../../lib/placeBias', () => ({ getPlaceBias: async () => null }));

const mockSetWeatherSource = jest.fn();
jest.mock('../../../lib/weatherSource', () => ({
  setWeatherSource: (s: unknown) => mockSetWeatherSource(s),
}));

import WeatherLocationSearchScreen from '../WeatherLocationSearchScreen';

// Node built-ins for the source scan at the bottom (React Native tsconfig, no
// node types) — declared narrowly, as in lib/__tests__/eventInvitations.test.ts.
declare const __dirname: string;
const fs = require('fs') as { readFileSync(file: string, enc: string): string };
const path = require('path') as { join(...parts: string[]): string };

const MYRTLE = {
  place_id: 'p1',
  description: 'Myrtle Beach, SC, USA',
  main_text: 'Myrtle Beach',
  secondary_text: 'SC, USA',
};

describe('the weather "Another location" search screen', () => {
  beforeEach(() => {
    mockAutocomplete.mockReset();
    mockGoBack.mockReset();
    mockSetWeatherSource.mockReset();
    mockAutocomplete.mockResolvedValue({ data: { predictions: [MYRTLE] } });
  });
  afterEach(cleanup);

  // The whole flow: type (through the 350ms debounce), see matches in the
  // full-height results region, tap one — the pick persists the source and
  // pops back to Weather in a single gesture.
  it('searches, shows matches on screen, and a tap picks + returns', async () => {
    const view = await render(<WeatherLocationSearchScreen />);
    const field = view.getByPlaceholderText('Search for a city or place…');
    // The field auto-focuses — the user came here to type.
    expect(field.props.autoFocus).toBe(true);

    fireEvent.changeText(field, 'Myrtle Beach');
    await waitFor(() => expect(view.getByText('Myrtle Beach')).toBeTruthy());

    // Results live in their own scroll region (not a dropdown), and the first
    // tap must land while the keyboard is still up.
    const results = view.getByTestId('places-results');
    expect(results.props.keyboardShouldPersistTaps).toBe('handled');

    fireEvent.press(view.getByText('Myrtle Beach'));
    expect(mockSetWeatherSource).toHaveBeenCalledWith({ kind: 'custom', place: 'Myrtle Beach, SC, USA' });
    expect(mockGoBack).toHaveBeenCalled();
  });

  // The results region is always present, telling the user where they are —
  // before a query, and when a query matches nothing.
  it('explains itself before a query and when nothing matches', async () => {
    const view = await render(<WeatherLocationSearchScreen />);
    expect(view.getByText(/Type a city, town, or place/)).toBeTruthy();

    mockAutocomplete.mockResolvedValue({ data: { predictions: [] } });
    fireEvent.changeText(view.getByPlaceholderText('Search for a city or place…'), 'Zzzzqqq');
    await waitFor(() => expect(view.getByText(/No places found/)).toBeTruthy());
  });

  // The wiring that makes the architecture hold: the sheet row must LEAVE the
  // sheet (close, then push) — reintroducing a text field into the sheet is
  // reintroducing the bug.
  it('is reached by closing the sheet and pushing, with no field left in the sheet', () => {
    const weather = fs.readFileSync(path.join(__dirname, '..', 'WeatherScreen.tsx'), 'utf8');
    expect(weather).toContain("nav.navigate('WeatherLocationSearch')");
    expect(weather).not.toContain('PlacesAutocomplete');
    // Weather re-reads the persisted source when the search screen pops back.
    expect(weather).toMatch(/useFocusEffect\([\s\S]*?getWeatherSource\(\)/);

    // And the search screen's field hangs from the header, keyboard-proof:
    // a full screen, not a sheet.
    const search = fs.readFileSync(path.join(__dirname, '..', 'WeatherLocationSearchScreen.tsx'), 'utf8');
    expect(search).not.toContain('BottomSheet');
    expect(search).toMatch(/<PlacesAutocomplete[\s\S]*?\bexpand\b/);
  });
});
