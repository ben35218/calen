// The recipe's own photo on the add/edit form (specs/features/kitchen.md, "The
// photo on a recipe"). Distinct from the quick import beside it in every way
// that matters: that reads a recipe OUT of a photo of a page and costs an AI
// scan; this attaches a picture OF the dish and costs nothing. It uploads on
// pick, so the field holds a server path the sealed record can carry.

import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RecipeFormScreen from '../RecipeFormScreen';

const SHOT = { uri: 'file:///dish.jpg', name: 'dish.jpg', type: 'image/jpeg' };

const mockTakePhoto = jest.fn();
const mockPickImages = jest.fn();
const mockUploadRecipePhoto = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: {} }),
  useNavigation: () => ({
    setOptions: jest.fn(), navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn(), dispatch: jest.fn(),
  }),
  StackActions: { popTo: jest.fn() },
}));
jest.mock('../../../api', () => ({ recipesApi: { fromUrl: jest.fn() }, recipeScheduleApi: {} }));
jest.mock('../../../lib/e2ee', () => ({ sealNew: jest.fn(), sealUpdate: jest.fn(), openRecord: jest.fn() }));
jest.mock('../../../lib/encSubsets', () => ({ RECIPE_ENC: (p: unknown) => p, RECIPE_SCHEDULE_ENC: (p: unknown) => p }));
jest.mock('../../../lib/privacyPrefs', () => ({ useAiEnabled: () => true }));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('../../../lib/media', () => ({
  takePhoto: (...a: unknown[]) => mockTakePhoto(...a),
  pickImages: (...a: unknown[]) => mockPickImages(...a),
}));
jest.mock('../../../lib/upload', () => ({ uploadFiles: jest.fn(), uploadFile: jest.fn() }));
jest.mock('../../../lib/recipePhoto', () => ({
  recipeImageUri: (v?: string | null) => (v ? `https://api.test${v}` : null),
  uploadRecipePhoto: (...a: unknown[]) => mockUploadRecipePhoto(...a),
  claimRecipePhoto: jest.fn(),
}));
jest.mock('../../../hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: () => jest.fn() }));
jest.mock('../../../components/StepIngredientLinker', () => () => null);
jest.mock('../../../components/CalenChatIcon', () => () => null);
jest.mock('../../../components/CreditsBanner', () => () => null);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../../components/formStyles', () => {
  const { View } = require('react-native');
  const RealReact = require('react');
  return {
    form: {},
    GroupCard: ({ children }: { children?: React.ReactNode }) => RealReact.createElement(View, null, children),
    CardDivider: () => null,
  };
});
jest.mock('../../../components/ui', () => {
  const { View, Text, TextInput, TouchableOpacity } = require('react-native');
  const RealReact = require('react');
  return {
    Screen: ({ children }: { children?: React.ReactNode }) => RealReact.createElement(View, null, children),
    SectionTitle: ({ children }: { children?: React.ReactNode }) => RealReact.createElement(Text, null, children),
    Chip: ({ label }: { label: string }) => RealReact.createElement(Text, null, label),
    Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
      RealReact.createElement(TouchableOpacity, { onPress }, RealReact.createElement(Text, null, title)),
    Input: ({ value, onChangeText, placeholder }: { value?: string; onChangeText?: (v: string) => void; placeholder?: string }) =>
      RealReact.createElement(TextInput, { value, onChangeText, placeholder }),
    FormError: ({ children }: { children?: React.ReactNode }) =>
      children ? RealReact.createElement(Text, null, children) : null,
    CenteredLoader: () => null,
    Skeleton: () => null,
    useHeaderCheckButton: jest.fn(),
  };
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecipeFormScreen />
    </QueryClientProvider>,
  );
}

// Answer the native action sheet the photo row raises.
function answerAlert(pick: string) {
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
    (buttons || []).find((b) => b.text === pick)?.onPress?.();
  });
}

describe('RecipeFormScreen photo', () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('offers Add until there is a photo, then Change', async () => {
    mockTakePhoto.mockResolvedValue(SHOT);
    mockUploadRecipePhoto.mockResolvedValue('/uploads/recipes/abc.jpg');
    answerAlert('Take Photo');
    await mount();

    expect(screen.getByText('Add')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByLabelText('Add a recipe photo')); });

    // Uploaded on pick, not held until save: the record carries a server path.
    expect(mockUploadRecipePhoto).toHaveBeenCalledWith(SHOT);
    expect(screen.getByText('Change')).toBeTruthy();
    expect(screen.getByLabelText('Change recipe photo')).toBeTruthy();
  });

  it('takes a photo from the library too', async () => {
    mockPickImages.mockResolvedValue([SHOT]);
    mockUploadRecipePhoto.mockResolvedValue('/uploads/recipes/abc.jpg');
    answerAlert('Choose Photo');
    await mount();

    await act(async () => { fireEvent.press(screen.getByLabelText('Add a recipe photo')); });

    expect(mockPickImages).toHaveBeenCalledWith(1);
    expect(mockUploadRecipePhoto).toHaveBeenCalledWith(SHOT);
  });

  it('keeps the field empty when the picker is cancelled', async () => {
    mockTakePhoto.mockResolvedValue(null);
    answerAlert('Take Photo');
    await mount();

    await act(async () => { fireEvent.press(screen.getByLabelText('Add a recipe photo')); });

    expect(mockUploadRecipePhoto).not.toHaveBeenCalled();
    expect(screen.getByText('Add')).toBeTruthy();
  });

  it('removes the photo, offering Remove only while there is one', async () => {
    mockTakePhoto.mockResolvedValue(SHOT);
    mockUploadRecipePhoto.mockResolvedValue('/uploads/recipes/abc.jpg');

    const offered: string[][] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      offered.push((buttons || []).map((b) => String(b.text)));
      const want = offered.length === 1 ? 'Take Photo' : 'Remove Photo';
      (buttons || []).find((b) => b.text === want)?.onPress?.();
    });
    await mount();

    await act(async () => { fireEvent.press(screen.getByLabelText('Add a recipe photo')); });
    expect(offered[0]).toEqual(['Take Photo', 'Choose Photo', 'Cancel']);

    await act(async () => { fireEvent.press(screen.getByLabelText('Change recipe photo')); });
    expect(offered[1]).toEqual(['Take Photo', 'Choose Photo', 'Remove Photo', 'Cancel']);
    expect(screen.getByText('Add')).toBeTruthy();
  });
});
