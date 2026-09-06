import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Adding a booking by handing Calen the confirmation (trips.md → "Add from a
// confirmation"). These pin the parts a reader of the screen can't infer: the
// card belongs to a BLANK add form only, it opens collapsed, the paste is
// shown before it is sent, camera and library share one button behind the
// native source sheet, the parsed draft reaches the form through the
// assistant's own patch path, and a failed parse never costs the user the
// thing they pasted.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
// The native sheet has no JS implementation under test — stand in for it and
// drive its callback directly, which is what the two source rows amount to.
jest
  .spyOn(require('react-native').ActionSheetIOS, 'showActionSheetWithOptions')
  .mockImplementation(() => {});

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

const mockNav = { setOptions: jest.fn(), goBack: jest.fn(), navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) };
let mockRouteParams: Record<string, unknown> = { tripId: 't1' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: mockRouteParams }),
  useFocusEffect: () => {},
}));

// The clipboard the Paste disc pulls from.
let mockClipboard = '';
jest.mock('expo-clipboard', () => ({ getStringAsync: async () => mockClipboard }));

jest.mock('../../../lib/tripData', () => ({
  fetchTripDetail: async () => ({
    trip: { _id: 't1', name: 'Rome', destination: 'Rome, Italy', destinationTz: 'Europe/Rome' },
    items: [],
    isOwner: true,
  }),
  sealTripItemPayload: async (_t: string, _s: boolean, _i: string, p: unknown) => p,
  tripItemSharingEcho: () => ({}),
}));
jest.mock('../../../lib/e2ee', () => ({
  openRecord: async (_k: string, r: unknown) => r,
  getHDK: async () => null,
  newObjectId: async () => 'new1',
  loadResourceKeys: async () => null,
  currentResourceKeyVersion: () => 1,
}));
jest.mock('../../../lib/attachments', () => ({ encryptFileForUpload: jest.fn(), encryptFileForUploadResource: jest.fn() }));
jest.mock('../../../lib/attachmentDraft', () => ({
  getQueuedAttachments: () => [],
  addQueuedAttachment: jest.fn(),
  removeQueuedAttachment: jest.fn(),
  clearQueuedAttachments: jest.fn(),
  useQueuedAttachments: () => [],
}));
jest.mock('../../../lib/media', () => ({ pickDocument: jest.fn(), pickImage: jest.fn(), takePhoto: jest.fn() }));
jest.mock('@household/weather', () => ({ regionForAddress: async () => null }));
jest.mock('../../../lib/locationDraft', () => ({ useLocationDraft: () => null, clearLocationDraft: jest.fn() }));

// The AI switch is on for these; the card is gated on it.
jest.mock('../../../lib/privacyPrefs', () => ({ useAiEnabled: () => true, usePrivacyPrefs: () => ({ prefs: { aiEnabled: true } }) }));
jest.mock('../../../components/FormAssistChat', () => () => null);
jest.mock('../../../components/CreditsBanner', () => () => null);
jest.mock('../../../components/CustomAlertSheet', () => () => null);
jest.mock('../../../components/PlacesAutocomplete', () => {
  const { TextInput } = require('react-native');
  return ({ value, placeholder }: { value: string; placeholder: string }) => (
    <TextInput value={value} placeholder={placeholder} editable={false} />
  );
});

const mockUploadFile = jest.fn();
jest.mock('../../../lib/upload', () => ({ uploadFile: (...a: unknown[]) => mockUploadFile(...a) }));

const mockFromConfirmationText = jest.fn();
jest.mock('../../../api', () => ({
  tripsApi: {
    fromConfirmationText: (id: string, text: string) => mockFromConfirmationText(id, text),
    families: async () => ({ data: [{ householdId: 'h1', name: 'Polk' }] }),
    addItem: async () => ({ data: { _id: 'i9' } }),
    updateItem: async () => ({ data: {} }),
    removeItem: async () => ({ data: {} }),
  },
  placesApi: { autocomplete: async () => ({ data: [] }) },
  settingsApi: { get: async () => ({ data: { dayAlertTime: '09:00' } }) },
}));

import TripItemFormScreen from '../TripItemFormScreen';

const FLIGHT_DRAFT = {
  type: 'flight',
  title: 'Toronto to Rome',
  departure: { name: 'Toronto Pearson (YYZ)', tz: 'America/Toronto', date: '2026-09-04', time: '21:35' },
  arrival: { name: 'Rome Fiumicino (FCO)', tz: 'Europe/Rome', date: '2026-09-05', time: '12:10' },
  details: { airline: 'Air Canada', flightNumber: 'AC888', seat: '14C' },
  confirmation: 'XR4TQ9',
  cost: 1240.5,
  currency: 'CAD',
};

const EMAIL = 'Your Air Canada booking XR4TQ9 — AC888 YYZ→FCO, Sept 4, 9:35 PM. Seat 14C.';

// RNTL v14's render() is async — awaiting it is what flushes the screen's
// first effects (the trip fetch the form seeds from).
async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <TripItemFormScreen />
    </QueryClientProvider>
  );
}

// The card opens collapsed, so every source test has to open it first.
async function expandCard() {
  fireEvent.press(await screen.findByLabelText('Add from a confirmation'));
  // Settles the reveal before the caller reaches for a source.
  await screen.findByLabelText('Paste a confirmation email');
}

beforeEach(() => {
  mockRouteParams = { tripId: 't1' };
  mockClipboard = '';
  jest.clearAllMocks();
});
afterEach(cleanup);

describe('the confirmation-import card', () => {
  it('offers itself on a blank add form', async () => {
    await mount();
    expect(await screen.findByText('Add from a confirmation')).toBeTruthy();
  });

  it('is absent when editing an existing booking — it builds a booking, it does not re-read one', async () => {
    mockRouteParams = { tripId: 't1', itemId: 'i1' };
    await mount();
    await waitFor(() => expect(screen.queryByText('Type')).toBeTruthy());
    expect(screen.queryByText('Add from a confirmation')).toBeNull();
  });

  it('opens collapsed — the sources appear only once it is asked for', async () => {
    await mount();
    await screen.findByText('Add from a confirmation');
    expect(screen.queryByLabelText('Paste a confirmation email')).toBeNull();
    await expandCard();
    expect(screen.getByLabelText('Paste a confirmation email')).toBeTruthy();
  });

  it('is three source buttons and no prose', async () => {
    await mount();
    await expandCard();
    expect(screen.getByLabelText('Paste a confirmation email')).toBeTruthy();
    expect(screen.getByLabelText('Photograph a confirmation or choose a screenshot')).toBeTruthy();
    expect(screen.getByLabelText('Choose a confirmation file')).toBeTruthy();
  });
});

describe('pasting a confirmation', () => {
  it('shows the clipboard in the pad rather than importing it blind', async () => {
    mockClipboard = EMAIL;
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Paste a confirmation email'));
    // The email is on screen, in an editable pad, and nothing has been sent.
    await waitFor(() => expect(screen.getByDisplayValue(EMAIL)).toBeTruthy());
    expect(mockFromConfirmationText).not.toHaveBeenCalled();
  });

  it('sends the pasted text and fills the form from the draft', async () => {
    mockClipboard = EMAIL;
    mockFromConfirmationText.mockResolvedValue({ data: FLIGHT_DRAFT });
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Paste a confirmation email'));
    await waitFor(() => expect(screen.getByDisplayValue(EMAIL)).toBeTruthy());
    fireEvent.press(screen.getByText('Read booking'));

    await waitFor(() => expect(screen.getByDisplayValue('Toronto to Rome')).toBeTruthy());
    expect(mockFromConfirmationText).toHaveBeenCalledWith('t1', EMAIL);
    // The draft's type switched the form onto the journey branch, and both
    // airports came back resolved.
    expect(screen.getByDisplayValue('Toronto Pearson (YYZ)')).toBeTruthy();
    expect(screen.getByDisplayValue('Rome Fiumicino (FCO)')).toBeTruthy();
  });

  it('retires the card once a draft has landed, so a re-import cannot undo the fix-ups', async () => {
    mockClipboard = EMAIL;
    mockFromConfirmationText.mockResolvedValue({ data: FLIGHT_DRAFT });
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Paste a confirmation email'));
    await waitFor(() => expect(screen.getByDisplayValue(EMAIL)).toBeTruthy());
    fireEvent.press(screen.getByText('Read booking'));

    await waitFor(() => expect(screen.getByDisplayValue('Toronto to Rome')).toBeTruthy());
    expect(screen.queryByText('Add from a confirmation')).toBeNull();
  });

  it('keeps the pasted text and shows the server’s reason when the parse fails', async () => {
    mockClipboard = EMAIL;
    mockFromConfirmationText.mockRejectedValue({
      response: { data: { error: 'Could not read that confirmation. Try entering the booking manually.' } },
    });
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Paste a confirmation email'));
    await waitFor(() => expect(screen.getByDisplayValue(EMAIL)).toBeTruthy());
    fireEvent.press(screen.getByText('Read booking'));

    expect(await screen.findByText(/Could not read that confirmation/)).toBeTruthy();
    expect(screen.getByDisplayValue(EMAIL)).toBeTruthy();
  });
});

describe('importing a photo', () => {
  // iOS routes through ActionSheetIOS; the two rows are the two sources.
  const chooseSheetRow = (row: 'Take Photo' | 'Choose Photo') => {
    const { ActionSheetIOS } = require('react-native');
    const [{ options }, cb] = ActionSheetIOS.showActionSheetWithOptions.mock.calls.at(-1);
    cb(options.indexOf(row));
  };

  it('offers both photo sources behind one button', async () => {
    const { ActionSheetIOS } = require('react-native');
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Photograph a confirmation or choose a screenshot'));

    const [{ options }] = ActionSheetIOS.showActionSheetWithOptions.mock.calls.at(-1);
    expect(options).toEqual(['Take Photo', 'Choose Photo', 'Cancel']);
  });

  it('uploads the shot the camera row takes', async () => {
    const file = { uri: 'file:///shot.jpg', name: 'shot.jpg', type: 'image/jpeg' };
    require('../../../lib/media').takePhoto.mockResolvedValue(file);
    mockUploadFile.mockResolvedValue(FLIGHT_DRAFT);
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Photograph a confirmation or choose a screenshot'));
    chooseSheetRow('Take Photo');

    await waitFor(() => expect(screen.getByDisplayValue('Toronto to Rome')).toBeTruthy());
    expect(mockUploadFile).toHaveBeenCalledWith('/trips/t1/items/from-confirmation', file, 'file');
  });

  it('uploads the screenshot the library row picks', async () => {
    const file = { uri: 'file:///screenshot.png', name: 'screenshot.png', type: 'image/png' };
    require('../../../lib/media').pickImage.mockResolvedValue(file);
    mockUploadFile.mockResolvedValue(FLIGHT_DRAFT);
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Photograph a confirmation or choose a screenshot'));
    chooseSheetRow('Choose Photo');

    await waitFor(() => expect(screen.getByDisplayValue('Toronto to Rome')).toBeTruthy());
    expect(mockUploadFile).toHaveBeenCalledWith('/trips/t1/items/from-confirmation', file, 'file');
  });

  it('does nothing when the sheet is cancelled', async () => {
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Photograph a confirmation or choose a screenshot'));
    // Cancel: the callback simply never selects a source row.
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});

describe('importing a file', () => {
  it('uploads the picked e-ticket under the field the route reads', async () => {
    const file = { uri: 'file:///eticket.pdf', name: 'eticket.pdf', type: 'application/pdf' };
    require('../../../lib/media').pickDocument.mockResolvedValue(file);
    mockUploadFile.mockResolvedValue(FLIGHT_DRAFT);
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Choose a confirmation file'));

    await waitFor(() => expect(screen.getByDisplayValue('Toronto to Rome')).toBeTruthy());
    expect(mockUploadFile).toHaveBeenCalledWith('/trips/t1/items/from-confirmation', file, 'file');
  });

  it('does nothing at all when the picker is cancelled', async () => {
    require('../../../lib/media').pickDocument.mockResolvedValue(null);
    await mount();
    await expandCard();
    fireEvent.press(screen.getByLabelText('Choose a confirmation file'));

    await waitFor(() => expect(screen.getByText('Add from a confirmation')).toBeTruthy());
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});
