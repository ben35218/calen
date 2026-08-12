import { useQuery } from '@tanstack/react-query';
import { customCalendarsApi, tripsApi, householdApi, callsApi } from '../api';
import { EVENT_INVITATIONS_KEY, fetchEventInvitations } from '../lib/eventInvitations';
import { listAccessRequests } from '../lib/calendarKeys';
import { listMyHouseholdEventRequests } from '../lib/householdRsvp';
import { invitationLapsed } from '../lib/inviteAlerts';

// The Invitations inbox's pending count — everything the inbox's "New" tab
// surfaces: an invitation — event, calendar, trip, or household — awaiting a
// reply; a pending request to join THIS household awaiting approval; an
// undismissed membership notice (removed / approved); or a Calen phone-call
// outcome notice awaiting dismissal. Keep this in sync with the "New" filter
// in InvitationsScreen.
// Drives the badge cascade to the inbox (which lives in Profile, not the
// calendar chrome): the count overlays the calendar's profile avatar, and the
// same count badges Profile's Invitations row.
export function useInvitationsCount(): number {
  // Shared key AND shared queryFn — see lib/eventInvitations. This hook is
  // mounted on the calendar home and on Profile, so it is nearly always the
  // observer that refetches `['invitations']`; giving it its own undecrypted
  // queryFn poisoned the cache the inbox reads.
  const invQ = useQuery({
    queryKey: EVENT_INVITATIONS_KEY,
    queryFn: fetchEventInvitations,
    staleTime: 60_000,
  });
  const calInvQ = useQuery({
    queryKey: ['calendarInvitations'],
    queryFn: async () => (await customCalendarsApi.invitations()).data,
    staleTime: 60_000,
  });
  const tripInvQ = useQuery({
    queryKey: ['tripInvitations'],
    queryFn: async () => (await tripsApi.invitations()).data,
    staleTime: 60_000,
  });
  const hhInvQ = useQuery({
    queryKey: ['householdInvitations', 'mine'],
    queryFn: async () => (await householdApi.myInvitations()).data,
    staleTime: 60_000,
  });
  const joinReqQ = useQuery({
    queryKey: ['householdJoinRequests'],
    queryFn: async () => (await householdApi.joinRequests()).data,
    staleTime: 60_000,
  });
  const noticesQ = useQuery({
    queryKey: ['householdNotices'],
    queryFn: async () => (await householdApi.notices()).data,
    staleTime: 60_000,
  });
  const callsQ = useQuery({
    queryKey: ['calls'],
    queryFn: async () => (await callsApi.list()).data,
    staleTime: 60_000,
  });
  // Re-key access requests on calendars this user owns. Badged like a join
  // request: only the owner can wrap the key, so an unnoticed request leaves
  // the contact on the other end staring at an empty calendar indefinitely.
  const accessReqQ = useQuery({
    queryKey: ['calendarAccessRequests'],
    queryFn: listAccessRequests,
    staleTime: 60_000,
  });
  // Household event invites awaiting my accept/decline — derived from the
  // synced replica (see lib/householdRsvp), same key as the inbox row.
  const hhEventQ = useQuery({
    queryKey: ['calendar', 'householdEventRequests'],
    queryFn: listMyHouseholdEventRequests,
    staleTime: 60_000,
  });
  const countPending = (rows?: { status: string }[]) => (rows ?? []).filter((i) => i.status === 'pending').length;
  // Pre-event invitations lapse once the event has ended (the inbox shows them
  // under Replied as "Expired") — a badge for something un-actionable would
  // stay lit forever. Record-shares (sent after the event) stay actionable and
  // keep counting; sealed snapshots fail open, matching the New tab.
  const eventPending = (invQ.data ?? []).filter(
    (i) => i.status === 'pending' && !invitationLapsed(i),
  ).length;
  const callNotices = (callsQ.data ?? []).filter(
    (c) => (c.status === 'ended' || c.status === 'failed') && c.outcome && !c.acknowledged,
  ).length;
  // Join requests are always actionable (the server returns pending only);
  // membership notices count until dismissed.
  const joinReqs = (joinReqQ.data ?? []).length;
  const notices = (noticesQ.data ?? []).filter((n) => !n.acknowledgedAt).length;
  const accessReqs = (accessReqQ.data ?? []).length;
  const hhEventReqs = (hhEventQ.data ?? []).filter((r) => r.myStatus === 'pending').length;
  return (
    eventPending + countPending(calInvQ.data) +
    countPending(tripInvQ.data) + countPending(hhInvQ.data) +
    joinReqs + accessReqs + notices + callNotices + hhEventReqs
  );
}
