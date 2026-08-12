// The app-open invitation pop-up (spec: features/notifications.md — In-app
// invitation pop-up). These pin the pure half of lib/inviteAlerts: which
// pending invitations are fresh enough to interrupt for, the once-only
// prompted memory (kind:id keys), and the alert wording — each kind's single
// sentence vs. the multi-invite count. The fetching/Alert/navigation wiring
// lives in hooks/useInviteAlerts and is not under test.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PendingInvite,
  eventInvitationExpired,
  freshInvites,
  invitationLapsed,
  inviteAlertContent,
  inviteKey,
  inviteWhenLabel,
  isEventRecordShare,
  loadPromptedInviteKeys,
  markInvitesPrompted,
} from '../inviteAlerts';
import type { HouseholdEventRequest } from '../householdRsvp';

const req = (over: Partial<HouseholdEventRequest> = {}): HouseholdEventRequest => ({
  eventId: 'e1',
  title: 'Dinner',
  startDate: '2026-08-15T18:00:00.000Z',
  endDate: '2026-08-15T19:00:00.000Z',
  allDay: false,
  myStatus: 'pending',
  creatorId: 'u-alan',
  ...over,
});

const hhEventInvite = (over: Partial<HouseholdEventRequest> = {}): PendingInvite => {
  const r = req(over);
  return { kind: 'householdEvent', id: r.eventId, title: r.title, request: r };
};

describe('freshInvites / inviteKey', () => {
  it('keeps only invitations this device has not prompted, preserving order', () => {
    const invites: PendingInvite[] = [
      hhEventInvite({ eventId: 'a' }),
      { kind: 'trip', id: 't1', title: 'Tahoe' },
      { kind: 'household', id: 'h1', title: 'The Polks' },
    ];
    const fresh = freshInvites(invites, new Set(['householdEvent:a']));
    expect(fresh.map(inviteKey)).toEqual(['trip:t1', 'household:h1']);
  });

  it('kinds have separate id spaces — the same id under another kind still prompts', () => {
    const invites: PendingInvite[] = [
      { kind: 'trip', id: 'x' },
      { kind: 'calendar', id: 'x' },
    ];
    expect(freshInvites(invites, new Set(['trip:x'])).map(inviteKey)).toEqual(['calendar:x']);
  });
});

describe('inviteAlertContent — single invitation per kind', () => {
  it('a household event request names the inviter, the event, and when', () => {
    const inv = { ...hhEventInvite(), from: 'Alan Polk' };
    const { title, message } = inviteAlertContent([inv]);
    expect(title).toBe('Event Invitation');
    expect(message).toContain('Alan Polk invited you to “Dinner”.');
    expect(message).toContain(inviteWhenLabel(req())!);
  });

  it('a household event request falls back to "A housemate"', () => {
    expect(inviteAlertContent([hhEventInvite()]).message).toMatch(/^A housemate invited you/);
  });

  it('a cross-household event invitation (sealed title falls back to "an event")', () => {
    expect(inviteAlertContent([{ kind: 'event', id: 'i1', from: 'Dana', title: 'Party' }]).message)
      .toBe('Dana invited you to “Party”.');
    expect(inviteAlertContent([{ kind: 'event', id: 'i1', from: null, title: null }]).message)
      .toBe('Someone invited you to an event.');
  });

  it('a record-share (sent after the event ended) is worded "shared", not an RSVP ask', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'event', id: 'i1', from: 'Dana', title: 'Party', shared: true },
    ]);
    expect(title).toBe('Event Shared');
    expect(message).toBe('Dana shared “Party” with you.');
  });

  it('a calendar share names the calendar', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'calendar', id: 'c1', from: 'Dana', title: 'Soccer' },
    ]);
    expect(title).toBe('Calendar Invitation');
    expect(message).toBe('Dana shared the calendar “Soccer” with you.');
  });

  it('a trip invitation names the trip', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'trip', id: 't1', from: 'Dana', title: 'Tahoe' },
    ]);
    expect(title).toBe('Trip Invitation');
    expect(message).toBe('Dana invited you to the trip “Tahoe”.');
  });

  it('a household invitation names the household', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'household', id: 'h1', from: 'Dana', title: 'The Polks' },
    ]);
    expect(title).toBe('Household Invitation');
    expect(message).toBe('Dana invited you to join “The Polks”.');
  });

  it('a join request names the requester', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'joinRequest', id: 'j1', from: 'Alan Polk' },
    ]);
    expect(title).toBe('Join Request');
    expect(message).toBe('Alan Polk wants to join your household.');
  });

  it('a guardian recovery request names the locked-out member', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'guardianRequest', id: 'g1', from: 'Alan Polk' },
    ]);
    expect(title).toBe('Recovery Request');
    expect(message).toBe(
      'Alan Polk is locked out of their account and asked for your help getting back in.',
    );
  });
});

describe('inviteAlertContent — several invitations', () => {
  it('collapses to a count routed at the inbox, across kinds', () => {
    const { title, message } = inviteAlertContent([
      hhEventInvite({ eventId: 'a' }),
      { kind: 'trip', id: 't1', title: 'Tahoe' },
    ]);
    expect(title).toBe('New Invitations');
    expect(message).toBe('You have 2 new invitations.');
  });

  it('an all-guardian batch keeps its recovery wording (the hook never mixes kinds)', () => {
    const { title, message } = inviteAlertContent([
      { kind: 'guardianRequest', id: 'g1', from: 'Alan Polk' },
      { kind: 'guardianRequest', id: 'g2', from: 'Dana Polk' },
    ]);
    expect(title).toBe('Recovery Requests');
    expect(message).toBe(
      '2 household members are locked out and asked for your help getting back in.',
    );
  });
});

describe('inviteWhenLabel', () => {
  it('an all-day event reads its date in UTC (noon-UTC storage)', () => {
    const label = inviteWhenLabel({ startDate: '2026-08-15T12:00:00.000Z', allDay: true });
    expect(label).toContain('August 15, 2026');
  });

  it('a timed event shows a start–end time range', () => {
    const label = inviteWhenLabel(req());
    expect(label).toMatch(/2026/);
    expect(label).toContain('–');
  });

  it('no start date → no when-line', () => {
    expect(inviteWhenLabel({ startDate: undefined, allDay: false })).toBeNull();
  });
});

describe('eventInvitationExpired', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('a timed event is actionable until its END, expired after', () => {
    const running = { startDate: '2026-08-20T11:00:00.000Z', endDate: '2026-08-20T13:00:00.000Z', allDay: false };
    const over = { startDate: '2026-08-18T11:00:00.000Z', endDate: '2026-08-18T12:00:00.000Z', allDay: false };
    const future = { startDate: '2026-08-22T11:00:00.000Z', allDay: false };
    expect(eventInvitationExpired(running, now)).toBe(false);
    expect(eventInvitationExpired(over, now)).toBe(true);
    expect(eventInvitationExpired(future, now)).toBe(false);
  });

  it('falls back to the start when there is no end', () => {
    expect(eventInvitationExpired({ startDate: '2026-08-18T09:00:00.000Z', allDay: false }, now)).toBe(true);
  });

  it('an all-day date (noon-UTC storage) gets its day of grace', () => {
    // Stored instant is noon UTC on the event day; the day itself isn't over.
    expect(eventInvitationExpired({ startDate: '2026-08-20T12:00:00.000Z', allDay: true }, now)).toBe(false);
    expect(eventInvitationExpired({ startDate: '2026-08-18T12:00:00.000Z', allDay: true }, now)).toBe(true);
  });

  it('a sealed snapshot (no readable dates) fails open — never silently expired', () => {
    expect(eventInvitationExpired(undefined, now)).toBe(false);
    expect(eventInvitationExpired({}, now)).toBe(false);
    expect(eventInvitationExpired({ startDate: 'garbage', allDay: false }, now)).toBe(false);
  });
});

describe('invitationLapsed / isEventRecordShare', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const pastEvent = { startDate: '2026-08-10T11:00:00.000Z', endDate: '2026-08-10T12:00:00.000Z', allDay: false };
  const futureEvent = { startDate: '2026-08-22T11:00:00.000Z', allDay: false };

  it('an invite sent BEFORE the event that outlived it lapses (not a record-share)', () => {
    const inv = { event: pastEvent, createdAt: '2026-08-08T09:00:00.000Z' };
    expect(invitationLapsed(inv, now)).toBe(true);
    expect(isEventRecordShare(inv, now)).toBe(false);
  });

  it('an invite sent AFTER the event ended is a record-share and never lapses', () => {
    const inv = { event: pastEvent, createdAt: '2026-08-15T09:00:00.000Z' };
    expect(invitationLapsed(inv, now)).toBe(false);
    expect(isEventRecordShare(inv, now)).toBe(true);
  });

  it('a future event neither lapses nor reads as a record-share', () => {
    const inv = { event: futureEvent, createdAt: '2026-08-19T09:00:00.000Z' };
    expect(invitationLapsed(inv, now)).toBe(false);
    expect(isEventRecordShare(inv, now)).toBe(false);
  });

  it('no createdAt → an expired invite lapses (the pre-record-share behavior)', () => {
    expect(invitationLapsed({ event: pastEvent }, now)).toBe(true);
  });

  it('a sealed snapshot fails open — actionable, not lapsed, not a record-share', () => {
    const inv = { createdAt: '2026-08-15T09:00:00.000Z' };
    expect(invitationLapsed(inv, now)).toBe(false);
    expect(isEventRecordShare(inv, now)).toBe(false);
  });
});

describe('prompted-key memory', () => {
  beforeEach(() => AsyncStorage.clear());

  it('marks and reloads per user', async () => {
    await markInvitesPrompted('u1', ['trip:a', 'household:b']);
    await markInvitesPrompted('u2', ['trip:c']);
    expect(Array.from(await loadPromptedInviteKeys('u1')).sort()).toEqual(['household:b', 'trip:a']);
    expect(Array.from(await loadPromptedInviteKeys('u2'))).toEqual(['trip:c']);
  });

  it('accumulates across calls and survives duplicates', async () => {
    await markInvitesPrompted('u1', ['event:a']);
    await markInvitesPrompted('u1', ['event:a', 'event:b']);
    expect(Array.from(await loadPromptedInviteKeys('u1')).sort()).toEqual(['event:a', 'event:b']);
  });

  it('caps the remembered set (oldest fall off)', async () => {
    const many = Array.from({ length: 305 }, (_, i) => `event:id${i}`);
    await markInvitesPrompted('u1', many);
    const seen = await loadPromptedInviteKeys('u1');
    expect(seen.size).toBe(300);
    expect(seen.has('event:id304')).toBe(true);
    expect(seen.has('event:id0')).toBe(false);
  });
});
