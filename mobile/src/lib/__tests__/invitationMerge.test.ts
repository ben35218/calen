// Invitation merge (spec: features/calendar.md — Invitees & sharing, "When the
// two households merge"). A cross-household EventInvitation stops describing
// anything real once the organizer and the recipient join one household: the
// recipient's independent copy becomes a duplicate of a row they now sync, and
// their answer belongs on an EventRsvp instead of on the invitation.
//
// These pin the pure decision table — which of {invite me, carry my answer,
// unlink my copy, defer} each invitation shape resolves to — plus the driver's
// ordering (sealed work before retirement) and its failure isolation. The stores,
// crypto, and network are mocked; only the reconciliation logic is under test.

jest.mock('../../api', () => ({
  invitationsApi: {
    toMerge: jest.fn(async () => ({ data: { invitations: [] } })),
    merge: jest.fn(async () => ({ data: { ok: true, merged: true, tombstoned: true } })),
  },
  calendarApi: {
    setHouseholdInvitees: jest.fn(async () => ({ data: {} })),
    detachInvitationCopy: jest.fn(async () => ({ data: {} })),
  },
}));

jest.mock('../recordStore', () => ({ refresh: jest.fn(async () => {}) }));
jest.mock('../replica', () => ({ getAll: jest.fn(async () => []) }));
jest.mock('../e2ee', () => ({
  currentUserId: jest.fn(() => 'me'),
  getHDK: jest.fn(() => new Uint8Array(32)),
}));
jest.mock('../householdRsvp', () => ({ recordExistingAnswer: jest.fn(async () => {}) }));

import { invitationsApi, calendarApi, InvitationToMerge } from '../../api';
import * as replica from '../replica';
import { getHDK } from '../e2ee';
import { recordExistingAnswer } from '../householdRsvp';
import { planInvitationMerge, reconcileMergedInvitations } from '../invitationMerge';

const ORGANIZER_EVENT = 'evt-source';
const MY_COPY = 'evt-copy';

const invitation = (over: Partial<InvitationToMerge> = {}): InvitationToMerge => ({
  _id: 'inv1',
  eventId: ORGANIZER_EVENT,
  acceptedEventId: MY_COPY,
  status: 'accepted',
  respondedAt: '2026-08-01T10:00:00.000Z',
  organizerUserId: 'organizer',
  sourceExists: true,
  ...over,
});

const sourceEvent = (over: Record<string, unknown> = {}) =>
  ({ _id: ORGANIZER_EVENT, title: 'Lake day', author: 'organizer', ...over } as any);
const myCopy = (over: Record<string, unknown> = {}) =>
  ({ _id: MY_COPY, title: 'Lake day', author: 'me', invitationId: 'inv1', ...over } as any);

beforeEach(() => jest.clearAllMocks());

describe('planInvitationMerge', () => {
  test('an accepted invitation joins me to the event and carries my answer across', () => {
    const plan = planInvitationMerge(invitation(), sourceEvent(), myCopy(), 'me');
    expect(plan).toEqual({
      addInvitee: true,
      invitees: ['me'],
      recordAnswer: 'accepted',
      detachCopy: false,
      defer: false,
    });
  });

  test('the invitee union preserves whoever was already invited', () => {
    const plan = planInvitationMerge(
      invitation(),
      sourceEvent({ householdInvitees: ['alan'] }),
      myCopy(),
      'me',
    );
    expect(plan.invitees).toEqual(['alan', 'me']);
  });

  test('a second pass over an already-merged event adds nothing (idempotent)', () => {
    const plan = planInvitationMerge(
      invitation(),
      sourceEvent({ householdInvitees: ['alan', 'me'] }),
      myCopy(),
      'me',
    );
    expect(plan.addInvitee).toBe(false);
    // The answer is still requested — recordExistingAnswer is itself absent-only,
    // so it is the one that decides whether a second write happens.
    expect(plan.recordAnswer).toBe('accepted');
  });

  test('a declined invitation still joins me to the event, carrying the decline', () => {
    const plan = planInvitationMerge(
      invitation({ status: 'declined', acceptedEventId: null }),
      sourceEvent(),
      undefined,
      'me',
    );
    expect(plan.addInvitee).toBe(true);
    expect(plan.recordAnswer).toBe('declined');
  });

  test('a pending invitation becomes an in-household request with no answer', () => {
    const plan = planInvitationMerge(
      invitation({ status: 'pending', acceptedEventId: null, respondedAt: undefined }),
      sourceEvent(),
      undefined,
      'me',
    );
    expect(plan.addInvitee).toBe(true);
    expect(plan.recordAnswer).toBeNull();
  });

  test('leaving the event is respected — the merge never re-invites me', () => {
    const plan = planInvitationMerge(
      invitation({ status: 'left', acceptedEventId: null }),
      sourceEvent(),
      undefined,
      'me',
    );
    expect(plan.addInvitee).toBe(false);
    expect(plan.recordAnswer).toBeNull();
    expect(plan.defer).toBe(false);
  });

  test('a missing source event defers rather than re-sealing what it cannot read', () => {
    // resealInLane rebuilds the whole sealed subset from the replica's copy, so
    // acting on an absent record would write an EMPTY event over a real one.
    const plan = planInvitationMerge(invitation(), undefined, myCopy(), 'me');
    expect(plan.defer).toBe(true);
    expect(plan.addInvitee).toBe(false);
  });

  test('an orphaned copy is unlinked into an ordinary event instead of deduped', () => {
    const plan = planInvitationMerge(
      invitation({ sourceExists: false }),
      undefined,
      myCopy(),
      'me',
    );
    expect(plan.detachCopy).toBe(true);
    expect(plan.addInvitee).toBe(false);
    expect(plan.defer).toBe(false);
  });

  test('an orphaned copy already unlinked needs no further work', () => {
    const plan = planInvitationMerge(
      invitation({ sourceExists: false }),
      undefined,
      myCopy({ invitationId: undefined }),
      'me',
    );
    expect(plan.detachCopy).toBe(false);
    expect(plan.defer).toBe(false);
  });

  test('an orphaned copy that has not synced yet defers', () => {
    const plan = planInvitationMerge(invitation({ sourceExists: false }), undefined, undefined, 'me');
    expect(plan.defer).toBe(true);
  });

  test('a source event with no surviving copy just retires the row', () => {
    const plan = planInvitationMerge(
      invitation({ sourceExists: false, acceptedEventId: null }),
      undefined,
      undefined,
      'me',
    );
    expect(plan.defer).toBe(false);
    expect(plan.detachCopy).toBe(false);
  });
});

describe('reconcileMergedInvitations', () => {
  const withRows = (rows: InvitationToMerge[], events: any[]) => {
    (invitationsApi.toMerge as jest.Mock).mockResolvedValue({ data: { invitations: rows } });
    (replica.getAll as jest.Mock).mockResolvedValue(events);
  };

  test('does nothing while the vault is locked', async () => {
    (getHDK as jest.Mock).mockReturnValueOnce(null);
    expect(await reconcileMergedInvitations()).toEqual({ total: 0, merged: 0, deferred: 0, failed: 0 });
    expect(invitationsApi.toMerge).not.toHaveBeenCalled();
  });

  test('runs the sealed half before retiring the row', async () => {
    withRows([invitation()], [sourceEvent(), myCopy()]);
    const order: string[] = [];
    (calendarApi.setHouseholdInvitees as jest.Mock).mockImplementation(async () => { order.push('invitees'); });
    (recordExistingAnswer as jest.Mock).mockImplementation(async () => { order.push('rsvp'); });
    (invitationsApi.merge as jest.Mock).mockImplementation(async () => {
      order.push('merge');
      return { data: { ok: true, merged: true, tombstoned: true } };
    });

    const res = await reconcileMergedInvitations();

    expect(res).toEqual({ total: 1, merged: 1, deferred: 0, failed: 0 });
    // Retiring first would strand the row with its sealed half undone; every step
    // is idempotent, so redoing an interrupted pass is always the safe order.
    expect(order).toEqual(['invitees', 'rsvp', 'merge']);
    expect(calendarApi.setHouseholdInvitees).toHaveBeenCalledWith(ORGANIZER_EVENT, ['me']);
    expect(recordExistingAnswer).toHaveBeenCalledWith({
      eventId: ORGANIZER_EVENT, status: 'accepted', respondedAt: '2026-08-01T10:00:00.000Z',
    });
    expect(invitationsApi.merge).toHaveBeenCalledWith('inv1');
  });

  test('a deferred row is left entirely alone', async () => {
    withRows([invitation()], []); // neither record has synced yet
    const res = await reconcileMergedInvitations();
    expect(res).toEqual({ total: 1, merged: 0, deferred: 1, failed: 0 });
    expect(calendarApi.setHouseholdInvitees).not.toHaveBeenCalled();
    expect(invitationsApi.merge).not.toHaveBeenCalled();
  });

  test('one failing row does not stop the rest', async () => {
    withRows(
      [invitation({ _id: 'bad' }), invitation({ _id: 'good' })],
      [sourceEvent(), myCopy()],
    );
    (calendarApi.setHouseholdInvitees as jest.Mock)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ data: {} });

    const res = await reconcileMergedInvitations();

    expect(res).toEqual({ total: 2, merged: 1, deferred: 0, failed: 1 });
    expect(invitationsApi.merge).toHaveBeenCalledTimes(1);
    expect(invitationsApi.merge).toHaveBeenCalledWith('good');
  });

  test('an orphaned copy is unlinked and the row retired, with no invitee write', async () => {
    withRows([invitation({ sourceExists: false })], [myCopy()]);
    const res = await reconcileMergedInvitations();
    expect(res.merged).toBe(1);
    expect(calendarApi.detachInvitationCopy).toHaveBeenCalledWith(MY_COPY);
    expect(calendarApi.setHouseholdInvitees).not.toHaveBeenCalled();
    expect(recordExistingAnswer).not.toHaveBeenCalled();
  });
});
