// E-card photo uploads run AFTER the form closes (spec: features/calendar.md
// "Scheduled e-cards" — Photos): hitting the ✓ saves the card row (fast JSON)
// and leaves at once; the multi-MB photo uploads continue in the background
// via `uploadECardPhotos`, which uploads in parallel and reports how many
// failed (a failed photo never loses the card).
const mockUpload = jest.fn();
jest.mock('../../../lib/upload', () => ({
  uploadFile: (...a: unknown[]) => mockUpload(...a),
}));
jest.mock('../../../api', () => ({
  ecardPhotoUploadPath: (id: string) => `/ecards/${id}/photos`,
}));

import { uploadECardPhotos } from '../../../lib/ecardPhotos';

const file = (n: string) => ({ uri: `file:///${n}`, name: n, type: 'image/jpeg' });

beforeEach(() => mockUpload.mockReset());

test('uploads every photo to the card and reports zero failures', async () => {
  mockUpload.mockResolvedValue({});
  const failed = await uploadECardPhotos('card1', [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
  expect(failed).toBe(0);
  expect(mockUpload).toHaveBeenCalledTimes(3);
  expect(mockUpload).toHaveBeenCalledWith('/ecards/card1/photos', file('a.jpg'), 'photo');
});

test('a failed upload is counted, not thrown — the rest still upload', async () => {
  mockUpload
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({});
  const failed = await uploadECardPhotos('card1', [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
  expect(failed).toBe(1);
  expect(mockUpload).toHaveBeenCalledTimes(3);
});

test('no photos → no uploads, no failures', async () => {
  expect(await uploadECardPhotos('card1', [])).toBe(0);
  expect(mockUpload).not.toHaveBeenCalled();
});
