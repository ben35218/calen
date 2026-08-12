// Household event invites (spec: features/calendar.md — Household invitees).
// A creator seals `householdInvitees` into the event; each invited member
// answers with their OWN sealed EventRsvp record. These pin the derivation
// (which events ask ME for an answer, joined with MY responses), the per-event
// status map, and the respond write path (update-in-place, locked-vault guard,
// reply push to the creator). The stores and relay are mocked — the network
// and crypto are not under test.

// jest.mock factories are hoisted above imports, so state lives inside them.
jest.mock('../../api', () => ({
  notificationsApi: {
    eventRequest: jest.fn(async () => ({ data: { sent: 1 } })),
    eventResponse: jest.fn(async () => ({ data: { sent: 1 } })),
  },
}));

jest.mock('../recordStore', () => ({
  refresh: jest.fn(async () => {}),
  create: jest.fn(async (_c: string, sealed: any) => ({ data: sealed })),
  update: jest.fn(async (_c: string, _id: string, sealed: any) => ({ data: sealed })),
}));

jest.mock('../replica', () => ({
  getAll: jest.fn(async () => []),
}));

jest.mock('../e2ee', () => ({
  currentUserId: jest.fn(() => 'me'),
  getHDK: jest.fn(() => new Uint8Array(32)),
  sealNew: jest.fn(async (_c: string, payload: any) => ({
    _id: 'new-rsvp-id', ...payload, enc: { alg: 'x', nonce: 'n', ct: 'c' }, keyVersion: 1,
  })),
  sealUpdate: jest.fn(async (_c: string, _id: string, payload: any) => ({
    ...payload, enc: { alg: 'x', nonce: 'n', ct: 'c' }, keyVersion: 1,
  })),
}));

import { notificationsApi } from '../../api';
import * as recordStore from '../recordStore';
import * as replica from '../replica';
import { getHDK, sealNew, sealUpdate } from '../e2ee';
import {
  deriveHouseholdRequests, rsvpsForEvent, respondToHouseholdEvent,
  type EventRsvp, type RsvpEvent,
} from '../householdRsvp';

const mockGetAll = replica.getAll as jest.Mock;
const mockGetHDK = getHDK as jest.Mock;

const NOW = new Date('2026-08-06T12:00:00.000Z');

const event = (o: Partial<RsvpEvent> = {}): RsvpEvent => ({
  _id: 'e1',
  title: 'Dinner',
  startDate: '2026-08-10T22:00:00.000Z',
  allDay: false,
  author: 'ada',
  householdInvitees: ['me', 'ben'],
  ...o,
});

const rsvp = (o: Partial<EventRsvp> = {}): EventRsvp => ({
  _id: 'r1', eventId: 'e1', status: 'accepted', respondedAt: '2026-08-05T00:00:00.000Z', author: 'me', ...o,
});

beforeEach(() => jest.clearAllMocks());

describe('deriveHouseholdRequests', () => {
  it('surfaces an event I am invited to as pending', () => {
    const out = deriveHouseholdRequests([event()], [], 'me', NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      eventId: 'e1', title: 'Dinner', creatorId: 'ada', myStatus: 'pending',
    });
  });

  it('skips events I am not invited to, wrote myself, or that are cancelled', () => {
    expect(deriveHouseholdRequests([event({ householdInvitees: ['ben'] })], [], 'me', NOW)).toHaveLength(0);
    expect(deriveHouseholdRequests([event({ author: 'me' })], [], 'me', NOW)).toHaveLength(0);
    expect(deriveHouseholdRequests([event({ cancelled: true })], [], 'me', NOW)).toHaveLength(0);
  });

  it('joins MY response only (another member’s rsvp does not answer for me)', () => {
    const replied = deriveHouseholdRequests([event()], [rsvp({ status: 'declined' })], 'me', NOW);
    expect(replied[0].myStatus).toBe('declined');
    expect(replied[0].respondedAt).toBe('2026-08-05T00:00:00.000Z');

    const someoneElse = deriveHouseholdRequests([event()], [rsvp({ author: 'ben' })], 'me', NOW);
    expect(someoneElse[0].myStatus).toBe('pending');
  });

  it('drops past events still pending, keeps past events I replied to', () => {
    const past = event({ startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-08-01T01:00:00.000Z' });
    expect(deriveHouseholdRequests([past], [], 'me', NOW)).toHaveLength(0);
    expect(deriveHouseholdRequests([past], [rsvp()], 'me', NOW)).toHaveLength(1);
  });

  it('sorts soonest-first', () => {
    const later = event({ _id: 'e2', startDate: '2026-09-01T00:00:00.000Z' });
    const out = deriveHouseholdRequests([later, event()], [], 'me', NOW);
    expect(out.map((r) => r.eventId)).toEqual(['e1', 'e2']);
  });
});

describe('rsvpsForEvent', () => {
  it('maps each responder to their latest answer for the event only', async () => {
    mockGetAll.mockResolvedValue([
      rsvp({ _id: 'r1', author: 'ben', status: 'declined', respondedAt: '2026-08-01T00:00:00.000Z' }),
      rsvp({ _id: 'r2', author: 'ben', status: 'accepted', respondedAt: '2026-08-02T00:00:00.000Z' }),
      rsvp({ _id: 'r3', author: 'cat', status: 'declined' }),
      rsvp({ _id: 'r4', author: 'cat', eventId: 'other' }),
    ]);
    const map = await rsvpsForEvent('e1');
    expect(map.ben.status).toBe('accepted');
    expect(map.cat.status).toBe('declined');
    expect(Object.keys(map)).toHaveLength(2);
  });
});

describe('respondToHouseholdEvent', () => {
  const opts = {
    eventId: 'e1', status: 'accepted' as const, eventTitle: 'Dinner', creatorId: 'ada', myName: 'Me Contact',
  };

  it('creates my sealed EventRsvp and pushes the reply to the creator', async () => {
    await respondToHouseholdEvent(opts);
    expect(sealNew).toHaveBeenCalledWith('EventRsvp', expect.objectContaining({ eventId: 'e1', status: 'accepted' }), expect.anything());
    expect(recordStore.create).toHaveBeenCalledWith('EventRsvp', expect.objectContaining({ _id: 'new-rsvp-id' }));
    expect(notificationsApi.eventResponse).toHaveBeenCalledWith(expect.objectContaining({
      toUserId: 'ada', eventId: 'e1', title: 'Invitation accepted',
      body: 'Me Contact accepted “Dinner”',
    }));
  });

  it('updates my existing rsvp in place instead of stacking a second record', async () => {
    mockGetAll.mockResolvedValue([rsvp({ status: 'accepted' })]);
    await respondToHouseholdEvent({ ...opts, status: 'declined' });
    expect(sealUpdate).toHaveBeenCalledWith('EventRsvp', 'r1', expect.objectContaining({ status: 'declined' }), expect.anything());
    expect(recordStore.update).toHaveBeenCalledWith('EventRsvp', 'r1', expect.anything());
    expect(recordStore.create).not.toHaveBeenCalled();
  });

  it('throws the unlock message when the vault is locked, writing nothing', async () => {
    mockGetHDK.mockReturnValueOnce(null);
    await expect(respondToHouseholdEvent(opts)).rejects.toThrow(/Unlock/);
    expect(recordStore.create).not.toHaveBeenCalled();
    expect(notificationsApi.eventResponse).not.toHaveBeenCalled();
  });

  it('never pushes a reply to myself (self-authored edge)', async () => {
    await respondToHouseholdEvent({ ...opts, creatorId: 'me' });
    expect(notificationsApi.eventResponse).not.toHaveBeenCalled();
  });
});
