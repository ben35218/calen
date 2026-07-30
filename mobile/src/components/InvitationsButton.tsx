import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { invitationsApi, customCalendarsApi, tripsApi, householdApi, callsApi } from '../api';
import { colors } from '../theme';

// The invitations button in the bottom-right floating pill on the Calendar and
// Events views (opens the Invitations modal). Shows a count badge for everything
// the inbox's "New" tab surfaces: an invitation — event, calendar, trip, or
// household — awaiting a reply; a pending request to join THIS household awaiting
// approval; an undismissed membership notice (removed / approved); or a Calen
// phone-call outcome notice awaiting dismissal. Keep this in sync with the "New"
// filter in InvitationsScreen. Sized to match the pill's other buttons.
export default function InvitationsButton({ onPress }: { onPress: () => void }) {
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
  const pending =
    countPending(invQ.data) + countPending(calInvQ.data) +
    countPending(tripInvQ.data) + countPending(hhInvQ.data) +
    joinReqs + notices + callNotices;

  return (
    <TouchableOpacity style={styles.btn} onPress={onPress}>
      <Ionicons name="mail-outline" size={22} color="#fff" />
      {pending > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{pending > 9 ? '9+' : pending}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 12, paddingVertical: 6 },
  badge: {
    position: 'absolute', top: 0, right: 4,
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3,
    backgroundColor: colors.error, alignItems: 'center', justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
