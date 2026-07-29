// `guestListVisible` and the hand-set `cancelled` flag are SEALED event content
// (C3b) — the opaque store rejects a plaintext field PUT on an E2EE household
// with the "update to the latest app version" error (the TestFlight-19 invitee
// bug). These pin that the single-field flips (the Invitees screen's guest-list
// toggle, the two mark-cancelled surfaces) go through the client re-seal lane:
// merge the change over the decrypted replica row, seal the full EVENT_ENC
// subset, and route the update through the record store — never a bare
// plaintext body. See specs/features/calendar.md (Invitees & sharing).
jest.mock('../../../api/client', () => ({ __esModule: true, default: {} }));

const mockUpdate = jest.fn(async () => ({ data: {} }));
jest.mock('../../../lib/recordStore', () => ({ update: (...a: unknown[]) => mockUpdate(...a) }));

// The saved event as the replica holds it (decrypted); the flip must preserve
// its untouched fields in the re-sealed subset.
const mockExisting = {
  _id: 'e1',
  title: 'Dentist',
  calendarType: 'appointments',
  startDate: '2026-08-01T15:00:00.000Z',
  guestListVisible: true,
};
jest.mock('../../../lib/replica', () => ({ getAll: async () => [mockExisting] }));

// Fake seal: tag the payload with `enc` carrying the sealed fields, like
// sealUpdate's `{ ...payload, enc, keyVersion }` contract.
jest.mock('../../../lib/e2ee', () => ({
  sealUpdate: async (
    _c: string,
    _id: string,
    payload: Record<string, unknown>,
    fields: Record<string, unknown>,
  ) => ({ ...payload, enc: { alg: 'test', nonce: 'n', ct: 'ct', fields }, keyVersion: 3 }),
}));

import { calendarApi } from '../../../api';

const sentBody = () => mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1] as unknown[];

beforeEach(() => mockUpdate.mockClear());

test('guest-list toggle re-seals the event with the flipped flag (no plaintext PUT)', async () => {
  await calendarApi.setGuestListVisible('e1', false);
  const [collection, id, body] = sentBody() as [string, string, Record<string, any>];
  expect(collection).toBe('CalendarEvent');
  expect(id).toBe('e1');
  // Ciphertext present — the write survives the opaque store's E2EE guard.
  expect(body.enc).toBeTruthy();
  expect(body.keyVersion).toBe(3);
  // The sealed subset carries the flip AND the untouched content, merged from
  // the replica row (a bare `{ guestListVisible }` blob would wipe the event).
  expect(body.enc.fields).toMatchObject({
    guestListVisible: false,
    title: 'Dentist',
    calendarType: 'appointments',
  });
});

test('mark-cancelled re-seals the event with cancelled: true', async () => {
  await calendarApi.cancelEvent('e1');
  const [, , body] = sentBody() as [string, string, Record<string, any>];
  expect(body.enc).toBeTruthy();
  expect(body.enc.fields).toMatchObject({ cancelled: true, title: 'Dentist' });
});
