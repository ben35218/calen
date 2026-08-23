// Trip detail is sealed content (trips.md → Day itinerary): the server's
// plaintext title/location/destination columns were nulled at the drop, so a
// screen that renders `GET /trips/:id` as it arrives shows bookings with no
// title and no location. Every reader goes through this one fetcher, which
// opens the trip AND its items — and loads a shared trip's TripKey first, since
// those rows are sealed under it rather than the HDK.

const mockGet = jest.fn();
const mockOpenRecord = jest.fn();
const mockLoadResourceKeys = jest.fn();
const mockGetHDK = jest.fn();

jest.mock('../../api', () => ({ tripsApi: { get: (...a: unknown[]) => mockGet(...a) } }));
jest.mock('../e2ee', () => ({
  openRecord: (...a: unknown[]) => mockOpenRecord(...a),
  loadResourceKeys: (...a: unknown[]) => mockLoadResourceKeys(...a),
  getHDK: () => mockGetHDK(),
  currentResourceKeyVersion: jest.fn(() => 0),
  sealForResource: jest.fn(),
  sealNew: jest.fn(),
  sealUpdate: jest.fn(),
}));

import type { TripItem } from '../../api';
import { sealUpdate } from '../e2ee';
import { fetchTripDetail, tripItemSharingEcho, sealTripItemPayload } from '../tripData';

beforeEach(() => {
  mockGetHDK.mockReturnValue(new Uint8Array([1]));
  mockLoadResourceKeys.mockResolvedValue(undefined);
  // The decrypted content the sealed blob carries, merged over the plaintext row.
  mockOpenRecord.mockImplementation(async (collection: string, record: any) => ({
    ...record,
    ...(collection === 'Trip' ? { name: 'Toronto', destination: 'Toronto, ON' } : { title: 'Dinner at Alo', location: '163 Spadina Ave' }),
  }));
  mockGet.mockResolvedValue({
    data: {
      trip: { _id: 't1', enc: { alg: 'x', nonce: 'n', ct: 'c' } },
      items: [{ _id: 'i1', tripId: 't1', type: 'restaurant' }, { _id: 'i2', tripId: 't1', type: 'activity' }],
      isOwner: true,
    },
  });
});
afterEach(() => jest.clearAllMocks());

it('opens the trip and every booking, so titles and locations are readable', async () => {
  const { trip, items, isOwner } = await fetchTripDetail('t1');

  expect(trip.name).toBe('Toronto');
  expect(items.map((i) => i.title)).toEqual(['Dinner at Alo', 'Dinner at Alo']);
  expect(items[0].location).toBe('163 Spadina Ave');
  expect(items.map((i) => i._id)).toEqual(['i1', 'i2']); // plaintext routing columns kept
  expect(isOwner).toBe(true);
  expect(mockOpenRecord).toHaveBeenCalledWith('Trip', expect.objectContaining({ _id: 't1' }));
  expect(mockOpenRecord).toHaveBeenCalledWith('TripItem', expect.objectContaining({ _id: 'i2' }));
});

it("loads the trip's own key before opening, for a trip shared outside the household", async () => {
  await fetchTripDetail('t1');
  expect(mockLoadResourceKeys).toHaveBeenCalledWith('trip', 't1');
});

it('still returns the trip when the key is missing or the load fails', async () => {
  mockLoadResourceKeys.mockRejectedValue(new Error('no envelope'));
  mockOpenRecord.mockImplementation(async (_c: string, record: any) => record); // won't open
  const { trip, items } = await fetchTripDetail('t1');
  expect(trip._id).toBe('t1');
  expect(items).toHaveLength(2);
});

it('skips the key load entirely when the household is not unlocked', async () => {
  mockGetHDK.mockReturnValue(null);
  await fetchTripDetail('t1');
  expect(mockLoadResourceKeys).not.toHaveBeenCalled();
});

// `placeId` (the booking form's Location-view pick) seals beside the location,
// but unlike the other content fields the item route has no plaintext strip for
// it — so a sealed write must drop the plaintext copy itself, while the
// degraded plaintext lane (no key held) keeps it like it keeps the location.
describe('sealTripItemPayload placeId', () => {
  const payload = { title: 'Dinner at Alo', location: '163 Spadina Ave', placeId: 'pl_alo' };

  it('seals placeId with the content and strips the plaintext copy', async () => {
    (sealUpdate as jest.Mock).mockImplementation(async (_c, _id, p, fields) => ({ ...p, enc: { ct: 'x' }, sealedFields: fields }));
    const body = await sealTripItemPayload('t1', false, 'i1', payload, false);
    expect(body.placeId).toBeUndefined();
    expect((body.sealedFields as Record<string, unknown>).placeId).toBe('pl_alo');
    expect(body.location).toBe('163 Spadina Ave'); // the route's own strip handles this one
  });

  it('keeps the plaintext placeId when the write could not seal', async () => {
    (sealUpdate as jest.Mock).mockImplementation(async (_c, _id, p) => p); // no key → payload unchanged
    const body = await sealTripItemPayload('t1', false, 'i1', payload, false);
    expect(body.placeId).toBe('pl_alo');
  });
});

// The All day flag is sealed content like the title — nothing plaintext says
// whether the user entered times — and it must round-trip through every reseal
// (the booking view's live alert pickers included) or a write strips it.
describe('sealTripItemPayload allDay', () => {
  it('seals the flag beside the title', async () => {
    (sealUpdate as jest.Mock).mockImplementation(async (_c, _id, p, fields) => ({ ...p, enc: { ct: 'x' }, sealedFields: fields }));
    const body = await sealTripItemPayload('t1', false, 'i1', { title: 'Museum day', allDay: true }, false);
    expect((body.sealedFields as Record<string, unknown>).allDay).toBe(true);
  });

  it('omits it entirely on a timed booking, so legacy rows read back timed', async () => {
    (sealUpdate as jest.Mock).mockImplementation(async (_c, _id, p, fields) => ({ ...p, enc: { ct: 'x' }, sealedFields: fields }));
    const body = await sealTripItemPayload('t1', false, 'i1', { title: 'Dinner at Alo' }, false);
    expect('allDay' in (body.sealedFields as Record<string, unknown>)).toBe(true);
    expect((body.sealedFields as Record<string, unknown>).allDay).toBeUndefined();
  });
});

// The item route rebuilds the whole cost-sharing branch from every PUT body
// (applyItemBody), so a write that only means to touch sealed content — the
// booking view's live alert pickers — must echo the sharing state back or the
// server wipes it. These pin what each mode's echo carries.
describe('tripItemSharingEcho', () => {
  const base = { _id: 'b1', type: 'activity', title: 'Louvre', start: 'x' } as unknown as TripItem;

  it('private: the booking-level bill fields', () => {
    expect(tripItemSharingEcho({ ...base, sharing: 'private', cost: 40, currency: 'EUR', confirmation: 'ABC', confirmed: true }))
      .toEqual({ sharing: 'private', cost: 40, currency: 'EUR', confirmation: 'ABC', confirmed: true });
    // No sharing at all reads as private.
    expect(tripItemSharingEcho(base).sharing).toBe('private');
  });

  it('shared_separate: participants + the whole per-family myData (partySize included)', () => {
    const echo = tripItemSharingEcho({
      ...base, sharing: 'shared_separate', participants: ['h1', 'h2'],
      myData: { cost: 120, currency: 'EUR', confirmation: 'XYZ', partySize: 4, confirmed: true },
    });
    expect(echo).toEqual({
      sharing: 'shared_separate', participants: ['h1', 'h2'],
      myData: { cost: 120, currency: 'EUR', confirmation: 'XYZ', partySize: 4, confirmed: true },
    });
  });

  it('shared_one_separate: shared confirmation/booked, private bill', () => {
    const echo = tripItemSharingEcho({
      ...base, sharing: 'shared_one_separate', participants: ['h1', 'h2'],
      confirmation: 'SHARED1', confirmed: true, myData: { cost: 60, currency: 'USD' },
    });
    expect(echo).toEqual({
      sharing: 'shared_one_separate', participants: ['h1', 'h2'],
      confirmation: 'SHARED1', confirmed: true, myData: { cost: 60, currency: 'USD' },
    });
  });

  it('shared_shared: the split rows and who fronted the bill, ids stringified', () => {
    const echo = tripItemSharingEcho({
      ...base, sharing: 'shared_shared', cost: 300, currency: 'CAD', confirmation: 'Q', confirmed: false,
      shares: [{ householdId: 'h1' as any, amount: 150 }, { householdId: { toString: () => 'h2' } as any, amount: null }],
      paidByHouseholdId: 'h1',
    });
    expect(echo).toEqual({
      sharing: 'shared_shared', cost: 300, currency: 'CAD', confirmation: 'Q', confirmed: false,
      shares: [{ householdId: 'h1', amount: 150 }, { householdId: 'h2', amount: undefined }],
      paidByHouseholdId: 'h1',
    });
  });
});
