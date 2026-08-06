// E-card photos are picked MULTI-SELECT in one library visit (spec:
// features/calendar.md "Scheduled e-cards" — Photos): the form's add button
// calls `pickImages(remaining)` with the card's open slots (3 minus the photos
// already on the card) so the OS picker itself enforces the cap, and every
// selected photo lands in one pass — not one photo per visit.
const mockLaunch = jest.fn();
const mockPerm = jest.fn(async () => ({ granted: true }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: () => mockPerm(),
  launchImageLibraryAsync: (...a: unknown[]) => mockLaunch(...a),
}));
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { pickImages } from '../../../lib/media';

beforeEach(() => {
  mockLaunch.mockReset();
  mockPerm.mockClear();
});

test('opens the library multi-select, capped at the requested slot count', async () => {
  mockLaunch.mockResolvedValue({
    canceled: false,
    assets: [
      { uri: 'file:///a/one.jpg', fileName: 'one.jpg', mimeType: 'image/jpeg' },
      { uri: 'file:///a/two.png', fileName: 'two.png', mimeType: 'image/png' },
    ],
  });
  const files = await pickImages(2);
  expect(mockLaunch).toHaveBeenCalledWith(
    expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 2 }),
  );
  expect(files).toEqual([
    { uri: 'file:///a/one.jpg', name: 'one.jpg', type: 'image/jpeg' },
    { uri: 'file:///a/two.png', name: 'two.png', type: 'image/png' },
  ]);
});

test('missing asset metadata falls back to the uri basename and jpeg', async () => {
  mockLaunch.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///cache/IMG_0042.HEIC.jpg' }],
  });
  expect(await pickImages(3)).toEqual([
    { uri: 'file:///cache/IMG_0042.HEIC.jpg', name: 'IMG_0042.HEIC.jpg', type: 'image/jpeg' },
  ]);
});

test('cancel and permission denial both return an empty list, never null', async () => {
  mockLaunch.mockResolvedValue({ canceled: true });
  expect(await pickImages(3)).toEqual([]);

  mockPerm.mockResolvedValueOnce({ granted: false });
  expect(await pickImages(3)).toEqual([]);
  expect(mockLaunch).toHaveBeenCalledTimes(1); // denial never opens the picker
});
