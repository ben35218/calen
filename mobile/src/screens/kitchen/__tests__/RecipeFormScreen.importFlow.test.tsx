// Quick-import flow on the recipe form (specs/features/kitchen.md, "Recipes"):
// a photo import can span several pages (library multi-select / camera
// "another page?" loop) uploaded as ONE extraction; while an import is in
// flight the form body is a shimmering skeleton (not a spinner over the empty
// form); and once the import populates the form, the Calen assistant card
// replaces the Quick import card so the result can be refined before saving.

import React from 'react';
import { Alert, Keyboard } from 'react-native';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RecipeFormScreen from '../RecipeFormScreen';

const PAGE1 = { uri: 'file:///p1.jpg', name: 'p1.jpg', type: 'image/jpeg' };
const PAGE2 = { uri: 'file:///p2.jpg', name: 'p2.jpg', type: 'image/jpeg' };
const DRAFT = {
  title: 'Pancakes',
  ingredients: [{ name: 'Flour', amount: '2', unit: 'cups' }],
  instructions: ['Mix', 'Fry'],
};

const mockTakePhoto = jest.fn();
const mockPickImages = jest.fn();
const mockUploadFiles = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: {} }),
  useNavigation: () => ({
    setOptions: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    dispatch: jest.fn(),
  }),
  StackActions: { popTo: jest.fn() },
}));
const mockFromUrl = jest.fn();
jest.mock('../../../api', () => ({ recipesApi: { fromUrl: (...a: unknown[]) => mockFromUrl(...a) }, recipeScheduleApi: {} }));
jest.mock('../../../lib/e2ee', () => ({ sealNew: jest.fn(), sealUpdate: jest.fn(), openRecord: jest.fn() }));
jest.mock('../../../lib/encSubsets', () => ({ RECIPE_ENC: (p: unknown) => p, RECIPE_SCHEDULE_ENC: (p: unknown) => p }));
jest.mock('../../../lib/privacyPrefs', () => ({
  useAiEnabled: () => true,
  // The shared FormAssist card reads the full prefs object.
  usePrivacyPrefs: () => ({ prefs: { aiEnabled: true, aiUsePersonalInfo: false } }),
}));
jest.mock('../../../lib/calendarPrefs', () => ({ useCalendarColors: () => ({ colors: { recipes: '#00897B' } }) }));
jest.mock('../../../lib/media', () => ({
  takePhoto: (...a: unknown[]) => mockTakePhoto(...a),
  pickImages: (...a: unknown[]) => mockPickImages(...a),
}));
jest.mock('../../../lib/upload', () => ({ uploadFiles: (...a: unknown[]) => mockUploadFiles(...a) }));
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
  // gcTime: 0 — the default 5-minute cache GC timer is an open handle that
  // keeps jest from exiting.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // render is async in RNTL v14 — callers must await mount().
  return render(
    <QueryClientProvider client={qc}>
      <RecipeFormScreen />
    </QueryClientProvider>,
  );
}

// Drive the native alerts the photo flow raises: the entry sheet picks a
// source, then the camera loop's "Page n added" prompts follow the plan.
function autoAnswerAlerts(answers: Record<string, string>) {
  jest.spyOn(Alert, 'alert').mockImplementation((title, _msg, buttons) => {
    const want = answers[String(title)];
    const btn = (buttons || []).find((b) => b.text === want);
    if (btn?.onPress) btn.onPress();
  });
}

describe('RecipeFormScreen quick-import flow', () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('uploads every library-picked page in one request, then swaps Quick import for the AI assistant', async () => {
    mockPickImages.mockResolvedValue([PAGE1, PAGE2]);
    mockUploadFiles.mockResolvedValue(DRAFT);
    autoAnswerAlerts({ 'Import from Photos': 'Choose Photos' });
    await mount();

    expect(screen.getByText('Quick import')).toBeTruthy();
    expect(screen.queryByText('Ask Calen')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByLabelText('Import from photo')); });

    expect(mockPickImages).toHaveBeenCalledWith(5);
    expect(mockUploadFiles).toHaveBeenCalledTimes(1);
    expect(mockUploadFiles).toHaveBeenCalledWith('/recipes/from-photo', [PAGE1, PAGE2], 'photo');
    // The import populated the form…
    expect(await screen.findByDisplayValue('Pancakes')).toBeTruthy();
    // …and the assistant is now available to refine it; Quick import is gone.
    expect(screen.getByText('Ask Calen')).toBeTruthy();
    expect(screen.queryByText('Quick import')).toBeNull();
  });

  it('camera capture loops "another page?" and sends all pages together', async () => {
    mockTakePhoto.mockResolvedValueOnce(PAGE1).mockResolvedValueOnce(PAGE2).mockResolvedValue(null);
    mockUploadFiles.mockResolvedValue(DRAFT);
    autoAnswerAlerts({
      'Import from Photos': 'Take Photos',
      'Page 1 added': 'Add Another Page',
      'Page 2 added': 'Done',
    });
    await mount();

    await act(async () => { fireEvent.press(screen.getByLabelText('Import from photo')); });

    expect(mockTakePhoto).toHaveBeenCalledTimes(2);
    expect(mockUploadFiles).toHaveBeenCalledWith('/recipes/from-photo', [PAGE1, PAGE2], 'photo');
    expect(await screen.findByDisplayValue('Pancakes')).toBeTruthy();
  });

  it('shows the shimmering form skeleton while the import is in flight, then the filled form', async () => {
    mockPickImages.mockResolvedValue([PAGE1]);
    let resolveUpload!: (v: unknown) => void;
    mockUploadFiles.mockReturnValue(new Promise((r) => { resolveUpload = r; }));
    autoAnswerAlerts({ 'Import from Photos': 'Choose Photos' });
    await mount();

    expect(screen.queryByTestId('import-skeleton')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByLabelText('Import from photo')); });

    // In flight: skeleton in place of the form body. (findBy — react-query
    // notifies its pending state on a batched tick after mutate().)
    expect(await screen.findByTestId('import-skeleton')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Title')).toBeNull();

    await act(async () => { resolveUpload(DRAFT); });

    expect(await screen.findByDisplayValue('Pancakes')).toBeTruthy();
    expect(screen.queryByTestId('import-skeleton')).toBeNull();
  });

  it('a URL import drops the keyboard and takes the Quick import card off screen while it runs', async () => {
    let resolveImport!: (v: unknown) => void;
    mockFromUrl.mockReturnValue(new Promise((r) => { resolveImport = r; }));
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    await mount();

    await act(async () => { fireEvent.press(screen.getByLabelText('Import from URL')); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('https://…'), 'https://ex.com/pancakes'); });
    await act(async () => { fireEvent.press(screen.getByText('Import')); });

    expect(dismiss).toHaveBeenCalled();
    expect(mockFromUrl).toHaveBeenCalledWith('https://ex.com/pancakes');
    // In flight: skeleton only — no Quick import card over it.
    expect(await screen.findByTestId('import-skeleton')).toBeTruthy();
    expect(screen.queryByText('Quick import')).toBeNull();

    await act(async () => { resolveImport({ data: DRAFT }); });

    // Done: the form is filled and the assistant (not Quick import) sits above it.
    expect(await screen.findByDisplayValue('Pancakes')).toBeTruthy();
    expect(screen.getByText('Apply changes')).toBeTruthy();
    expect(screen.queryByText('Quick import')).toBeNull();
  });

  it('brings the Quick import card back, URL intact, when the import fails', async () => {
    mockFromUrl.mockRejectedValue({ response: { data: { error: 'Could not read that page.' } } });
    jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    await mount();

    await act(async () => { fireEvent.press(screen.getByLabelText('Import from URL')); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('https://…'), 'https://ex.com/nope'); });
    await act(async () => { fireEvent.press(screen.getByText('Import')); });

    expect(await screen.findByText('Could not read that page.')).toBeTruthy();
    expect(screen.getByText('Quick import')).toBeTruthy();
    expect(screen.getByDisplayValue('https://ex.com/nope')).toBeTruthy();
  });
});
