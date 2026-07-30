// The accept path is the C3b contract's client half: the recipient seals its
// OWN copy of the event and posts the opaque `_id` + `enc` — never the bare
// plaintext snapshot, which the server rejects with "A sealed event copy
// (_id + enc) is required". These pin that shape (and the locked-vault prompt).
// e2ee is mocked so the seal is deterministic and no native sodium is needed.
jest.mock('../e2ee', () => ({
  ensureHouseholdKey: jest.fn(async () => {}),
  sealNew: jest.fn(),
  sealInvitationSnapshot: jest.fn(),
}));
jest.mock('../../api', () => ({ invitationsApi: {} }));
jest.mock('../../config', () => ({ API_URL: 'http://test', WEB_URL: 'http://web.test' }));

import { sealAcceptedCopy, eventInviteEmailContent } from '../invitees';
import { ensureHouseholdKey, sealNew } from '../e2ee';
import type { EventInvitation, InvitationEventSnapshot } from '../../api';

const snapshot = {
  title: 'Test',
  startDate: '2026-08-07T13:00:00.000Z',
  allDay: false,
  calendarType: 'appointments',
} as InvitationEventSnapshot;

describe('sealAcceptedCopy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('seals the recipient’s own copy (invitationId folded in) and returns only _id + enc', async () => {
    (sealNew as jest.Mock).mockResolvedValue({
      _id: 'abc123', enc: { alg: 'x', nonce: 'n', ct: 'c' }, keyVersion: 3, title: 'Test',
    });

    const copy = await sealAcceptedCopy(snapshot, 'inv1');

    // Unlocks the HDK before sealing.
    expect(ensureHouseholdKey).toHaveBeenCalled();
    // Seals the snapshot with invitationId folded in — that flips the copy's
    // delete action to "Leave event" and marks it read-only.
    expect(sealNew).toHaveBeenCalledWith('CalendarEvent', { ...snapshot, invitationId: 'inv1' });
    // Posts ONLY the opaque copy the accept endpoint stores — no plaintext,
    // no stray fields leaked from the seal helper's return.
    expect(copy).toEqual({ _id: 'abc123', enc: { alg: 'x', nonce: 'n', ct: 'c' }, keyVersion: 3 });
  });

  it('throws an unlock prompt when the vault is locked (sealNew yields no enc)', async () => {
    // sealNew returns the payload unchanged (no _id / no enc) when no HDK is held.
    (sealNew as jest.Mock).mockResolvedValue({ ...snapshot, invitationId: 'inv1' });

    await expect(sealAcceptedCopy(snapshot, 'inv1')).rejects.toThrow(/unlock your vault/i);
  });
});

// The composed invite email for a NON-ACCOUNT invitee (and the per-row Remind)
// — the device-composed replacement for the retired server `event_invitation`
// mail (households-sharing.md: the server sends no invite email).
describe('eventInviteEmailContent', () => {
  it('plaintext-lane invite carries the public .ics link (keyed by shareToken)', () => {
    const inv = { _id: 'inv1', shareToken: 'tok123', status: 'pending' } as EventInvitation;
    const { subject, body } = eventInviteEmailContent(snapshot, inv);
    expect(subject).toContain('Test');
    expect(body).toContain('http://test/invitations/public/inv1/ics?k=tok123');
  });

  it('sealed-lane invite is notice-only — no .ics link (its public route 404s)', () => {
    const inv = { _id: 'inv2', shareToken: 'tok456', sealedEvent: 'opaque', status: 'pending' } as EventInvitation;
    const { body } = eventInviteEmailContent(snapshot, inv);
    expect(body).not.toContain('/invitations/public/');
    expect(body).toContain('end-to-end encrypted');
    expect(body).toContain('http://web.test');
  });
});
