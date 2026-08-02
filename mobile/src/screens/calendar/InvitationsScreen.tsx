import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  invitationsApi, EventInvitation, InvitationEventSnapshot, customCalendarsApi, CalendarInvitation,
  tripsApi, TripInvitation, householdApi, HouseholdInvitation, JoinRequestForApprover, HouseholdNotice,
  callsApi, PhoneCallRecord,
} from '../../api';
import { refreshCustomCalendars } from '../../lib/calendarPrefs';
import { ensureSharedCalendarKeys } from '../../lib/calendarKeys';
import {
  myIdentityPublicKey, openInvitationSnapshot, sealInvitationSnapshot,
  ensureHouseholdKey, getHDK, wrapHDKForJoiner, publicKeyFingerprint,
} from '../../lib/e2ee';
import { sealAcceptedCopy } from '../../lib/invitees';
import { Button, SegmentedControl, Badge } from '../../components/ui';
import { SecurityCode } from '../../components/SecurityCode';
import { colors, spacing } from '../../theme';

// D3: an event invitation may arrive sealed (its snapshot encrypted to this
// user's identity key). Decrypt those into the plaintext `event` shape the rows
// render from; a plaintext invite passes through unchanged. Best-effort — a
// locked vault (or a blob not sealed to us) leaves `event` undefined.
async function decryptEventInvitations(rows: EventInvitation[]): Promise<EventInvitation[]> {
  return Promise.all(
    rows.map(async (inv) => {
      if (inv.event?.title || !inv.sealedEvent) return inv;
      const snap = await openInvitationSnapshot<InvitationEventSnapshot>(inv.sealedEvent);
      return snap ? { ...inv, event: snap } : inv;
    }),
  );
}

// Invitations inbox (event sharing across households). Opened from the
// bottom-right floating button on the Calendar and Events views; presented as
// a modal with an X close button in the header (see AppNavigator). "New" holds
// pending invitations with Accept/Decline; "Replied" is the response history.
// Accepting copies the event onto this user's calendar; either way the emailed
// invite.ics can add it to Apple/Google Calendar.

type Tab = 'new' | 'replied';

// The inbox mixes invitation kinds — one-shot event invites, ongoing shares of
// a calendar, a trip, or a whole household — plus outcome notices from phone
// calls Calen placed ("New" until dismissed, then in the history). It also
// carries the *approver* side of the household flow: pending requests to join
// THIS household, which an existing member reviews and approves here (mirroring
// the section on HouseholdScreen) so the request is visible where invites live.
type Row =
  | { kind: 'event'; inv: EventInvitation }
  | { kind: 'calendar'; inv: CalendarInvitation }
  | { kind: 'trip'; inv: TripInvitation }
  | { kind: 'household'; inv: HouseholdInvitation }
  | { kind: 'joinRequest'; inv: JoinRequestForApprover }
  | { kind: 'notice'; inv: HouseholdNotice }
  | { kind: 'call'; inv: PhoneCallRecord };

// "Monday, July 13, 2026" or "Jul 13, 3:00 PM – 4:00 PM" style when-line.
function whenLabel(e: InvitationEventSnapshot): string {
  const start = new Date(e.startDate);
  if (e.allDay !== false) {
    // All-day records are stored at noon UTC → read the date in UTC.
    const opts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' } as const;
    const s = start.toLocaleDateString(undefined, opts);
    if (e.endDate) {
      const end = new Date(e.endDate).toLocaleDateString(undefined, opts);
      if (end !== s) return `${s} – ${end}`;
    }
    return s;
  }
  const day = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const t1 = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  if (!e.endDate) return `${day}, ${t1}`;
  const t2 = new Date(e.endDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day}, ${t1} – ${t2}`;
}

const GUEST_STATUS_LABEL: Record<string, string> = {
  pending: 'Invited',
  accepted: 'Going',
  declined: 'Declined',
  left: 'Left',
};

// Lazy "See who's invited" expander on an event invitation card. Fetches only
// once opened (no eager per-card requests); the server answers visible:false
// when the organizer keeps the guest list private.
function GuestList({ invitation }: { invitation: EventInvitation }) {
  const [open, setOpen] = useState(false);
  const guestsQ = useQuery({
    queryKey: ['invitations', 'guests', invitation._id],
    queryFn: async () => (await invitationsApi.guests(invitation._id)).data,
    enabled: open,
  });
  return (
    <View>
      <TouchableOpacity style={styles.guestsToggle} onPress={() => setOpen((v) => !v)} activeOpacity={0.7}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
        <Text style={styles.guestsToggleText}>See who’s invited</Text>
      </TouchableOpacity>
      {!open ? null : guestsQ.isLoading ? (
        <ActivityIndicator size="small" color={colors.primary} style={styles.guestsLoading} />
      ) : guestsQ.data?.visible ? (
        <View style={styles.guestsList}>
          <View style={styles.metaRow}>
            <Ionicons name="person-circle-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta} numberOfLines={1}>
              {guestsQ.data.organizer?.name || guestsQ.data.organizer?.email} · Organizer
            </Text>
          </View>
          {guestsQ.data.guests.map((g) => (
            <View key={g._id} style={styles.metaRow}>
              <Ionicons name="person-outline" size={14} color={colors.textMuted} />
              <Text style={styles.meta} numberOfLines={1}>
                {g._id === invitation._id ? 'You' : g.toEmail || g.toPhone} · {GUEST_STATUS_LABEL[g.status]}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.guestsHidden}>The organizer hasn’t shared the guest list.</Text>
      )}
    </View>
  );
}

export default function InvitationsScreen() {
  const qc = useQueryClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [tab, setTab] = useState<Tab>('new');
  const [error, setError] = useState('');

  const invQ = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => decryptEventInvitations((await invitationsApi.list()).data),
  });
  const calInvQ = useQuery({
    queryKey: ['calendarInvitations'],
    queryFn: async () => (await customCalendarsApi.invitations()).data,
  });
  const tripInvQ = useQuery({
    queryKey: ['tripInvitations'],
    queryFn: async () => (await tripsApi.invitations()).data,
  });
  const hhInvQ = useQuery({
    queryKey: ['householdInvitations', 'mine'],
    queryFn: async () => (await householdApi.myInvitations()).data,
  });
  // Approver side: people who accepted an invite and are now waiting for a
  // member of THIS household to confirm them on-device. The server only ever
  // returns pending requests (empty for a solo household), so these are always
  // "New" — an actionable Approve/Reject card, not response history.
  const joinReqQ = useQuery({
    queryKey: ['householdJoinRequests'],
    queryFn: async () => (await householdApi.joinRequests()).data,
    // Poll so a request that lands while the inbox is open shows up without a
    // manual refresh (mirrors HouseholdScreen's 5s cadence).
    refetchInterval: 5000,
  });
  // One-off membership notices addressed to me (today: removed from a
  // household). "New" until dismissed, then in the response history.
  const noticesQ = useQuery({
    queryKey: ['householdNotices'],
    queryFn: async () => (await householdApi.notices()).data,
  });
  // Outcome notices for phone calls Calen placed (Call to Cancel / chat).
  const callsQ = useQuery({
    queryKey: ['calls'],
    queryFn: async () => (await callsApi.list()).data,
  });

  // Approving seals the current HDK to the joiner's key, so we need this
  // session's household key ready and its version. Unlock it once on open.
  const [hdkReady, setHdkReady] = useState(false);
  const [keyVersion, setKeyVersion] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        await ensureHouseholdKey();
        const { data } = await householdApi.getKey();
        setKeyVersion(data.currentKeyVersion || 0);
        setHdkReady(getHDK() != null);
      } catch { /* locked / not enrolled — the disabled state covers it */ }
    })();
  }, [joinReqQ.data]);

  // Safety numbers for out-of-band verification: the approver must confirm this
  // code matches what the joiner sees before granting access (see spec).
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!joinReqQ.data) return;
    joinReqQ.data.forEach(async (r) => {
      const fp = await publicKeyFingerprint(r.requesterPublicKey);
      setFingerprints((cur) => (cur[r._id] === fp ? cur : { ...cur, [r._id]: fp }));
    });
  }, [joinReqQ.data]);

  const respond = useMutation({
    // C3b: the server can't read the sealed source, so accepting seals our OWN
    // copy on-device — the decrypted snapshot plus `invitationId` (which flips
    // this copy's delete action to "Leave" and marks it read-only) — and posts
    // the client-minted `_id` + opaque `enc`. A locked vault can't seal, so we
    // surface that instead of letting the server reject an unsealed copy.
    mutationFn: async ({ id, action, event }: { id: string; action: 'accept' | 'decline'; event?: InvitationEventSnapshot }) => {
      if (action !== 'accept') return invitationsApi.decline(id);
      if (!event) throw new Error('This invitation is missing its event details.');
      return invitationsApi.accept(id, await sealAcceptedCopy(event, id));
    },
    onSuccess: (_res, { action }) => {
      setError('');
      qc.invalidateQueries({ queryKey: ['invitations'] });
      // Accepting adds a copy of the event to this user's calendar.
      if (action === 'accept') qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  // D3 lazily-claimed upgrade: any plaintext invite in my inbox that I hold keys
  // for gets re-sealed to my own identity key, so its snapshot stops sitting in
  // the clear at rest. One attempt per invite id per session; a re-seal then
  // re-lists (the row comes back sealed and decrypts under my key).
  const upgraded = useRef(new Set<string>());
  useEffect(() => {
    if (!invQ.data) return;
    (async () => {
      const pub = await myIdentityPublicKey();
      if (!pub) return; // locked / not enrolled — retry next session
      let sealedAny = false;
      for (const inv of invQ.data) {
        if (!inv.event?.title || inv.sealedEvent || upgraded.current.has(inv._id)) continue;
        upgraded.current.add(inv._id);
        try {
          const sealedEvent = await sealInvitationSnapshot(inv.event, pub);
          await invitationsApi.seal(inv._id, sealedEvent);
          sealedAny = true;
        } catch { /* leave it plaintext; retry next session */ }
      }
      if (sealedAny) qc.invalidateQueries({ queryKey: ['invitations'] });
    })();
  }, [invQ.data, qc]);

  const respondCal = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'accept' | 'decline' }) =>
      action === 'accept' ? customCalendarsApi.acceptInvitation(id) : customCalendarsApi.declineInvitation(id),
    onSuccess: async () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['calendarInvitations'] });
      // Access changed either way (decline after accept revokes it): re-pull
      // the calendar list and every calendar view.
      await refreshCustomCalendars();
      // Load the member-wrapped CalendarKey for the newly joined calendar (a
      // no-op until the owner's device wraps it) so shared events decrypt.
      await ensureSharedCalendarKeys().catch(() => {});
      qc.invalidateQueries({ queryKey: ['calendar'] });
      // Keep the free-viewer-mode gate signal truthful: accepting the first
      // share (or declining the last one) flips the viewer-content cache via
      // the billing status mirror.
      qc.invalidateQueries({ queryKey: ['billing', 'status'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  const respondTrip = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'accept' | 'decline' }) => {
      if (action === 'accept') await tripsApi.acceptInvitation(id);
      else await tripsApi.declineInvitation(id);
    },
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['tripInvitations'] });
      // Access changed either way — refresh the trip list and calendar overlay.
      qc.invalidateQueries({ queryKey: ['trips'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  const respondHousehold = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'accept' | 'decline' }) => {
      if (action === 'accept') await householdApi.acceptInvitation(id);
      else await householdApi.declineInvitation(id);
    },
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['householdInvitations', 'mine'] });
      // Accepting opens a join request; the Household screen reflects the wait.
      qc.invalidateQueries({ queryKey: ['household'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  // Approve a request to join this household: wrap the current HDK to the
  // joiner's public key on-device, then post the envelope — the point where
  // membership actually changes (same flow as HouseholdScreen's approve).
  const approveJoin = useMutation({
    mutationFn: async (r: JoinRequestForApprover) => {
      const envelope = await wrapHDKForJoiner(r.requesterPublicKey, keyVersion);
      if (!envelope) throw new Error('Your household key is not ready — reopen this screen and try again.');
      await householdApi.approveJoin(r._id, envelope);
    },
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['householdJoinRequests'] });
      // Membership changed: refresh the household and its shared views.
      qc.invalidateQueries({ queryKey: ['household'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || e.message || 'Could not approve'),
  });

  const rejectJoin = useMutation({
    mutationFn: (r: JoinRequestForApprover) => householdApi.rejectJoin(r._id),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['householdJoinRequests'] });
      // Rejecting retires the invitation this request answered — refresh the
      // Household screen's sent list so it drops off the member's card too.
      qc.invalidateQueries({ queryKey: ['householdInvitations', 'sent'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  const confirmReject = (r: JoinRequestForApprover) =>
    Alert.alert('Reject request?', 'This person will not be able to join.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => rejectJoin.mutate(r) },
    ]);

  const dismissNotice = useMutation({
    mutationFn: (id: string) => householdApi.ackNotice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['householdNotices'] }),
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  const items = useMemo<Row[]>(() => {
    const wantPending = tab === 'new';
    // Pending join requests are only ever actionable — they live in "New" only.
    const joinReqs: Row[] = wantPending
      ? (joinReqQ.data ?? []).map((inv) => ({ kind: 'joinRequest', inv }))
      : [];
    // Membership notices: "New" until dismissed (acknowledged), then history.
    const notices: Row[] = (noticesQ.data ?? [])
      .filter((n) => !n.acknowledgedAt === wantPending)
      .map((inv) => ({ kind: 'notice', inv }));
    const hh: Row[] = (hhInvQ.data ?? [])
      .filter((i) => (i.status === 'pending') === wantPending)
      .map((inv) => ({ kind: 'household', inv }));
    const cals: Row[] = (calInvQ.data ?? [])
      .filter((i) => (i.status === 'pending') === wantPending)
      .map((inv) => ({ kind: 'calendar', inv }));
    const trips: Row[] = (tripInvQ.data ?? [])
      .filter((i) => (i.status === 'pending') === wantPending)
      .map((inv) => ({ kind: 'trip', inv }));
    const events: Row[] = (invQ.data ?? [])
      .filter((i) => (i.status === 'pending') === wantPending)
      .map((inv) => ({ kind: 'event', inv }));
    // Finished calls with a judged outcome: "New" until dismissed, then history.
    const calls: Row[] = (callsQ.data ?? [])
      .filter((c) => (c.status === 'ended' || c.status === 'failed') && c.outcome)
      .filter((c) => c.acknowledged !== wantPending)
      .map((inv) => ({ kind: 'call', inv }));
    return [...joinReqs, ...notices, ...calls, ...hh, ...cals, ...trips, ...events];
  }, [invQ.data, calInvQ.data, tripInvQ.data, hhInvQ.data, joinReqQ.data, noticesQ.data, callsQ.data, tab]);

  // Outcome of a phone call Calen placed (e.g. the event view's Call to
  // Cancel). The notice card has no inline action — tapping it opens the full
  // Interaction (Calen call) view (transcript, recording, confirm actions),
  // where the user resolves the outcome and dismisses the notice.
  const renderCallItem = (item: PhoneCallRecord) => {
    const confirmed = item.outcome === 'confirmed';
    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('Interaction', { id: item._id })}
      >
        <Text style={styles.from}>
          Calen
          <Text style={styles.fromSub}>
            {' '}called to {item.action === 'cancel' ? 'cancel' : 'reschedule'} an appointment
          </Text>
        </Text>
        <View style={styles.calTitleRow}>
          <Ionicons name="call" size={16} color={colors.primary} style={{ marginTop: 2 }} />
          <Text style={styles.title}>{item.eventTitle || 'Appointment'}</Text>
        </View>
        {item.eventDate ? (
          <View style={styles.metaRow}>
            <Ionicons name="time-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta}>{item.eventDate}</Text>
          </View>
        ) : null}
        {item.summary ? <Text style={styles.description}>{item.summary}</Text> : null}
        <View style={styles.statusRow}>
          <Badge
            label={confirmed ? (item.action === 'cancel' ? 'Cancelled' : 'Rescheduled') : 'Couldn’t confirm'}
            color={confirmed ? colors.success : colors.warning}
          />
        </View>
      </TouchableOpacity>
    );
  };

  const renderCalendarItem = (item: CalendarInvitation) => {
    const busy = respondCal.isPending && respondCal.variables?.id === item._id;
    return (
      <View style={styles.card}>
        <Text style={styles.from}>
          {item.fromName || item.fromEmail || 'Someone'}
          <Text style={styles.fromSub}> shared a calendar</Text>
        </Text>
        <View style={styles.calTitleRow}>
          <View style={[styles.calDot, { backgroundColor: item.color || colors.primary }]} />
          <Text style={styles.title}>{item.calendarName}</Text>
        </View>
        <Text style={styles.meta}>
          {item.access === 'full'
            ? 'Accepting lets you see, add, and edit this calendar’s events.'
            : 'Accepting shows this calendar and its events alongside your own.'}
        </Text>

        {item.status === 'pending' ? (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button
                title="Accept"
                loading={busy && respondCal.variables?.action === 'accept'}
                onPress={() => respondCal.mutate({ id: item._id, action: 'accept' })}
              />
            </View>
            <View style={styles.actionBtn}>
              <Button
                title="Decline"
                variant="ghost"
                color={colors.error}
                loading={busy && respondCal.variables?.action === 'decline'}
                onPress={() => respondCal.mutate({ id: item._id, action: 'decline' })}
              />
            </View>
          </View>
        ) : (
          <View style={styles.statusRow}>
            <Badge
              label={item.status === 'accepted' ? 'Accepted' : 'Declined'}
              color={item.status === 'accepted' ? colors.success : colors.error}
            />
            {item.respondedAt ? (
              <Text style={styles.meta}>
                {new Date(item.respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            ) : null}
            {/* An accepted share stays revocable: declining gives up access. */}
            {item.status === 'accepted' ? (
              <View style={styles.leaveBtn}>
                <Button
                  title="Leave"
                  variant="ghost"
                  color={colors.error}
                  loading={busy}
                  onPress={() => respondCal.mutate({ id: item._id, action: 'decline' })}
                />
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  const renderTripItem = (item: TripInvitation) => {
    const busy = respondTrip.isPending && respondTrip.variables?.id === item._id;
    return (
      <View style={styles.card}>
        <Text style={styles.from}>
          {item.fromName || item.fromEmail || 'Someone'}
          <Text style={styles.fromSub}> shared a trip</Text>
        </Text>
        <View style={styles.calTitleRow}>
          <MaterialCommunityIcons name="bag-suitcase" size={16} color={colors.primary} style={{ marginTop: 2 }} />
          <Text style={styles.title}>{item.tripName}</Text>
        </View>
        {item.destination ? (
          <View style={styles.metaRow}>
            <Ionicons name="location-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta} numberOfLines={1}>{item.destination}</Text>
          </View>
        ) : null}
        <Text style={styles.meta}>Accepting shows the full itinerary and lets you add to it.</Text>

        {item.status === 'pending' ? (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button
                title="Accept"
                loading={busy && respondTrip.variables?.action === 'accept'}
                onPress={() => respondTrip.mutate({ id: item._id, action: 'accept' })}
              />
            </View>
            <View style={styles.actionBtn}>
              <Button
                title="Decline"
                variant="ghost"
                color={colors.error}
                loading={busy && respondTrip.variables?.action === 'decline'}
                onPress={() => respondTrip.mutate({ id: item._id, action: 'decline' })}
              />
            </View>
          </View>
        ) : (
          <View style={styles.statusRow}>
            <Badge
              label={item.status === 'accepted' ? 'Accepted' : 'Declined'}
              color={item.status === 'accepted' ? colors.success : colors.error}
            />
            {/* An accepted share stays revocable: declining gives up access. */}
            {item.status === 'accepted' ? (
              <View style={styles.leaveBtn}>
                <Button
                  title="Leave"
                  variant="ghost"
                  color={colors.error}
                  loading={busy}
                  onPress={() => respondTrip.mutate({ id: item._id, action: 'decline' })}
                />
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  // Membership notice — "removed from a household" or "approved into one". No
  // action beyond acknowledging it: a "Got it" dismiss moves it into the response
  // history.
  const renderNoticeItem = (item: HouseholdNotice) => {
    const who = item.actorName || (item.kind === 'approved' ? 'A household member' : 'A household owner');
    const dismissed = !!item.acknowledgedAt;
    const busy = dismissNotice.isPending && dismissNotice.variables === item._id;
    const approved = item.kind === 'approved';
    return (
      <View style={styles.card}>
        <View style={styles.calTitleRow}>
          <MaterialCommunityIcons
            name={approved ? 'home-heart' : 'home-remove'}
            size={16}
            color={approved ? colors.success : colors.error}
            style={{ marginTop: 2 }}
          />
          <Text style={styles.title}>{approved ? 'You’re in the household' : 'Removed from a household'}</Text>
        </View>
        <Text style={styles.meta}>
          {approved
            ? `${who} approved your request — you now share the household’s calendar, tasks, trips, and more.`
            : `${who} removed you from their shared household. Your own data has moved with you into your own household — anything the household shared stays with its remaining members.`}
        </Text>
        {dismissed ? (
          <View style={styles.statusRow}>
            <Badge label="Dismissed" color={colors.textMuted} />
          </View>
        ) : (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button title="Got it" loading={busy} onPress={() => dismissNotice.mutate(item._id)} />
            </View>
          </View>
        )}
      </View>
    );
  };

  // Approver-side card: someone accepted an invite and is waiting to be
  // confirmed. Before approving, the member verifies the security code matches
  // what the joiner sees on their device (out-of-band, per the E2EE spec).
  const renderJoinRequestItem = (item: JoinRequestForApprover) => {
    const display = [item.firstName, item.lastName].filter(Boolean).join(' ') || item.email || 'Someone';
    const busyApprove = approveJoin.isPending && approveJoin.variables?._id === item._id;
    const busyReject = rejectJoin.isPending && rejectJoin.variables?._id === item._id;
    return (
      <View style={styles.card}>
        <Text style={styles.from}>
          {display}
          <Text style={styles.fromSub}> wants to join your household</Text>
        </Text>
        {item.email ? (
          <View style={styles.metaRow}>
            <Ionicons name="mail-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta} numberOfLines={1}>{item.email}</Text>
          </View>
        ) : null}
        <Text style={styles.meta}>
          Confirm this code matches the one on their Household screen before approving.
        </Text>
        {fingerprints[item._id] ? (
          <SecurityCode code={fingerprints[item._id]} copyable={false} />
        ) : (
          <Text style={styles.fingerprint}>…</Text>
        )}
        {!hdkReady ? (
          <Text style={styles.warn}>
            Your device is still unlocking the household key — reopen this screen if this persists.
          </Text>
        ) : null}
        <View style={styles.actions}>
          <View style={styles.actionBtn}>
            <Button
              title="Approve"
              loading={busyApprove}
              disabled={!hdkReady || busyReject}
              onPress={() => approveJoin.mutate(item)}
            />
          </View>
          <View style={styles.actionBtn}>
            <Button
              title="Reject"
              variant="ghost"
              color={colors.error}
              disabled={busyApprove}
              onPress={() => confirmReject(item)}
            />
          </View>
        </View>
      </View>
    );
  };

  const renderHouseholdItem = (item: HouseholdInvitation) => {
    const busy = respondHousehold.isPending && respondHousehold.variables?.id === item._id;
    return (
      <View style={styles.card}>
        <Text style={styles.from}>
          {item.fromName || item.fromEmail || 'Someone'}
          <Text style={styles.fromSub}> invited you to their household</Text>
        </Text>
        <View style={styles.calTitleRow}>
          <MaterialCommunityIcons name="home-heart" size={16} color={colors.primary} style={{ marginTop: 2 }} />
          {/* Sender-name framing when the household name is sealed (C2). */}
          <Text style={styles.title}>
            {item.householdName || `${(item.fromName || 'their').split(' ')[0]}${item.fromName ? '’s' : ''} household`}
          </Text>
        </View>
        <Text style={styles.meta}>
          Accepting shares the family calendar, tasks, trips, and more. A member
          then confirms you on their device.
        </Text>

        {item.status === 'pending' ? (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button
                title="Accept"
                loading={busy && respondHousehold.variables?.action === 'accept'}
                onPress={() => respondHousehold.mutate({ id: item._id, action: 'accept' })}
              />
            </View>
            <View style={styles.actionBtn}>
              <Button
                title="Decline"
                variant="ghost"
                color={colors.error}
                loading={busy && respondHousehold.variables?.action === 'decline'}
                onPress={() => respondHousehold.mutate({ id: item._id, action: 'decline' })}
              />
            </View>
          </View>
        ) : (
          <View style={styles.statusRow}>
            <Badge
              label={item.status === 'accepted' ? 'Waiting for approval' : 'Declined'}
              color={item.status === 'accepted' ? colors.warning : colors.error}
            />
          </View>
        )}
      </View>
    );
  };

  const renderEventItem = (item: EventInvitation) => {
    const busy = respond.isPending && respond.variables?.id === item._id;
    const ev = item.event;
    // A sealed invite we can't open yet (vault locked) — show a placeholder
    // rather than crashing; unlocking re-lists and decrypts it.
    if (!ev?.title) {
      return (
        <View style={styles.card}>
          <Text style={styles.from}>
            {item.fromName || item.fromEmail || 'Someone'}
            <Text style={styles.fromSub}> invited you</Text>
          </Text>
          <View style={styles.metaRow}>
            <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta}>Unlock to view this invitation.</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.card}>
        <Text style={styles.from}>
          {item.fromName || item.fromEmail || 'Someone'}
          <Text style={styles.fromSub}> invited you</Text>
        </Text>
        <Text style={styles.title}>{ev.title}</Text>
        <View style={styles.metaRow}>
          <Ionicons name="time-outline" size={14} color={colors.textMuted} />
          <Text style={styles.meta}>{whenLabel(ev)}</Text>
        </View>
        {ev.location ? (
          <View style={styles.metaRow}>
            <Ionicons name="location-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta} numberOfLines={1}>{ev.location}</Text>
          </View>
        ) : null}
        {ev.description ? (
          <Text style={styles.description} numberOfLines={3}>{ev.description}</Text>
        ) : null}

        <GuestList invitation={item} />

        {item.status === 'pending' ? (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button
                title="Accept"
                loading={busy && respond.variables?.action === 'accept'}
                onPress={() => respond.mutate({ id: item._id, action: 'accept', event: ev })}
              />
            </View>
            <View style={styles.actionBtn}>
              <Button
                title="Decline"
                variant="ghost"
                color={colors.error}
                loading={busy && respond.variables?.action === 'decline'}
                onPress={() => respond.mutate({ id: item._id, action: 'decline' })}
              />
            </View>
          </View>
        ) : (
          <View style={styles.statusRow}>
            <Badge
              label={item.status === 'accepted' ? 'Accepted' : item.status === 'left' ? 'Left' : 'Declined'}
              color={item.status === 'accepted' ? colors.success : item.status === 'left' ? colors.textMuted : colors.error}
            />
            {item.respondedAt ? (
              <Text style={styles.meta}>
                {new Date(item.respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <SegmentedControl<Tab>
          value={tab}
          options={[
            { label: 'New', value: 'new' },
            { label: 'Replied', value: 'replied' },
          ]}
          onChange={setTab}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {invQ.isLoading || calInvQ.isLoading || tripInvQ.isLoading || hhInvQ.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <MaterialCommunityIcons name="email-open-outline" size={40} color={colors.textMuted} />
          <Text style={styles.emptyText}>
            {tab === 'new' ? 'No new invitations.' : 'No replied invitations yet.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(row) => `${row.kind}-${row.inv._id}`}
          renderItem={({ item }) =>
            item.kind === 'call' ? renderCallItem(item.inv)
              : item.kind === 'calendar' ? renderCalendarItem(item.inv)
                : item.kind === 'trip' ? renderTripItem(item.inv)
                  : item.kind === 'household' ? renderHouseholdItem(item.inv)
                    : item.kind === 'joinRequest' ? renderJoinRequestItem(item.inv)
                      : item.kind === 'notice' ? renderNoticeItem(item.inv)
                        : renderEventItem(item.inv)}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tabs: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: colors.textMuted, marginTop: spacing.sm },
  error: { color: colors.error, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, marginBottom: spacing.md },
  from: { fontSize: 13, fontWeight: '600', color: colors.text },
  fromSub: { fontWeight: '400', color: colors.textMuted },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  meta: { fontSize: 13, color: colors.textMuted, flexShrink: 1 },
  description: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actionBtn: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  fingerprint: { fontSize: 13, letterSpacing: 1, color: colors.primary, marginTop: 6, fontVariant: ['tabular-nums'] },
  warn: { fontSize: 12, color: colors.warning ?? '#b26a00', marginTop: spacing.sm },
  calTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  calDot: { width: 12, height: 12, borderRadius: 6, marginTop: 2 },
  leaveBtn: { marginLeft: 'auto' },
  guestsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
  guestsToggleText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  guestsList: { marginTop: spacing.xs, gap: 2 },
  guestsLoading: { alignSelf: 'flex-start', marginTop: spacing.xs },
  guestsHidden: { fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, fontStyle: 'italic' },
});
