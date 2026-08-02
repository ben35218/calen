import { useQuery } from '@tanstack/react-query';
import { invitationsApi, customCalendarsApi, tripsApi, householdApi, callsApi } from '../api';

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
  const invQ = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => (await invitationsApi.list()).data,
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
  const countPending = (rows?: { status: string }[]) => (rows ?? []).filter((i) => i.status === 'pending').length;
  const callNotices = (callsQ.data ?? []).filter(
    (c) => (c.status === 'ended' || c.status === 'failed') && c.outcome && !c.acknowledged,
  ).length;
  // Join requests are always actionable (the server returns pending only);
  // membership notices count until dismissed.
  const joinReqs = (joinReqQ.data ?? []).length;
  const notices = (noticesQ.data ?? []).filter((n) => !n.acknowledgedAt).length;
  return (
    countPending(invQ.data) + countPending(calInvQ.data) +
    countPending(tripInvQ.data) + countPending(hhInvQ.data) +
    joinReqs + notices + callNotices
  );
}
