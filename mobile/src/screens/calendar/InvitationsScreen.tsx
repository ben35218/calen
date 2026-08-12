import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, Alert, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  invitationsApi, EventInvitation, InvitationEventSnapshot, customCalendarsApi, CalendarInvitation,
  tripsApi, TripInvitation, householdApi, HouseholdInvitation, JoinRequestForApprover, HouseholdNotice,
  callsApi, PhoneCallRecord,
} from '../../api';
import { refreshCustomCalendars, useCalendarColors } from '../../lib/calendarPrefs';
import {
  ensureSharedCalendarKeys, listAccessRequests, approveAccessRequest,
  type CalendarAccessRequest,
} from '../../lib/calendarKeys';
import {
  myIdentityPublicKey, openInvitationSnapshot, sealInvitationSnapshot,
  ensureHouseholdKey, getHDK, wrapHDKForJoiner, publicKeyFingerprint,
  isUnlocked, subscribeLockState, subscribeKeysReady,
} from '../../lib/e2ee';
import { sealAcceptedCopy } from '../../lib/invitees';
import {
  listMyHouseholdEventRequests, respondToHouseholdEvent, type HouseholdEventRequest,
} from '../../lib/householdRsvp';
import { invitationLapsed, isEventRecordShare } from '../../lib/inviteAlerts';
import { useAuth } from '../../store/auth';
import { Button, SegmentedControl, Badge, SkeletonList, Card, IconAvatar, EmptyState } from '../../components/ui';
import { EVENT_INVITATIONS_KEY, fetchEventInvitations } from '../../lib/eventInvitations';
import { SecurityCode } from '../../components/SecurityCode';
import { colors, spacing } from '../../theme';

// D3: an event invitation may arrive sealed (its snapshot encrypted to this
// user's identity key), so the rows this screen renders need it opened first.
// That decrypt lives in lib/eventInvitations, NOT here, because it belongs to
// the `['invitations']` cache key rather than to this screen — three surfaces
// read that key, and when this screen owned the only decrypting fetcher, any
// refetch driven by one of the others replaced the cache with undecrypted rows
// and this inbox showed padlocks with the vault wide open.

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
  // A collaborator on one of MY calendars lost every unlock factor, re-keyed,
  // and is asking me to re-wrap the CalendarKey to their new identity. It lives
  // here because it is the same shape of decision as a join request — someone's
  // key changed, and only I can decide whether that's really them.
  | { kind: 'accessRequest'; inv: CalendarAccessRequest }
  | { kind: 'notice'; inv: HouseholdNotice }
  | { kind: 'call'; inv: PhoneCallRecord }
  // A housemate asked me to accept/decline one of the household's own events.
  // Derived from the synced replica (sealed householdInvitees + my EventRsvp),
  // not from a server feed — the server can't read who's invited.
  | { kind: 'householdEvent'; inv: HouseholdEventRequest };

// The event cards' two-line when. Clock row: the time — "3:00 PM – 4:00 PM",
// or "All Day" when the event has no start instant. Calendar row below: the
// full date, year-free — "Wednesday, August 26" (a multi-day event shows the
// date range).
type WhenFields = Pick<InvitationEventSnapshot, 'startDate' | 'endDate' | 'allDay'>;

function timeLabel(e: WhenFields): string {
  if (e.allDay !== false) return 'All Day';
  const t1 = new Date(e.startDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  if (!e.endDate) return t1;
  const t2 = new Date(e.endDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return t2 === t1 ? t1 : `${t1} – ${t2}`;
}

function dateLabel(e: WhenFields): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  // All-day records are stored at noon UTC → read the date in UTC.
  if (e.allDay !== false) opts.timeZone = 'UTC';
  const s = new Date(e.startDate).toLocaleDateString(undefined, opts);
  if (e.endDate) {
    const end = new Date(e.endDate).toLocaleDateString(undefined, opts);
    if (end !== s) return `${s} – ${end}`;
  }
  return s;
}

// "(today)" / "(tomorrow)" / "(in 3 days)" — and the Replied tab's past events
// read "(yesterday)" / "(3 days ago)". Calendar-day distance to the START:
// an all-day date reads in UTC (noon-UTC storage), a timed one in local time,
// and both compare against today's local calendar date.
function relativeDayPhrase(e: WhenFields, now: Date = new Date()): string {
  const start = new Date(e.startDate);
  const eventDay = e.allDay !== false
    ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
    : Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const todayDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((eventDay - todayDay) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

function WhenRows({ event }: { event: WhenFields }) {
  return (
    <>
      <View style={styles.metaRow}>
        <Ionicons name="time-outline" size={14} color={colors.textMuted} />
        <Text style={styles.meta}>{timeLabel(event)}</Text>
      </View>
      <View style={styles.metaRow}>
        <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
        <Text style={styles.meta}>{`${dateLabel(event)} (${relativeDayPhrase(event)})`}</Text>
      </View>
    </>
  );
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
    // The bottom margin keeps the toggle (and an expanded list) clear of the
    // Accept/Decline row that follows it on the invitation card.
    <View style={styles.guestsBlock}>
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

// The shared shell every inbox card renders through: the app-standard Card
// chrome (radius.lg + hairline border, via components/ui) headed by the
// list-row leading disc (IconAvatar, tinted per kind — a shared calendar's
// disc carries that calendar's colour) beside the "«who» «did what»" eyebrow
// and the bold title. Kind-specific meta rows, security codes, and the
// Accept/Decline (shared Button) or Badge status row render as children below.
// A tappable card (household event → its event, a call → the Interaction)
// gets the CardRow trailing chevron.
function InviteCard({
  icon,
  mdiIcon,
  accent = colors.primary,
  from,
  fromSub,
  title,
  onPress,
  children,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  mdiIcon?: string;
  accent?: string;
  from?: string;
  fromSub?: string;
  title?: string;
  onPress?: () => void;
  children?: React.ReactNode;
}) {
  const body = (
    <Card style={styles.card}>
      <View style={styles.headRow}>
        <IconAvatar icon={icon} mdiIcon={mdiIcon} bg={accent} />
        <View style={styles.headText}>
          {from ? (
            <Text style={styles.from} numberOfLines={2}>
              {from}
              {fromSub ? <Text style={styles.fromSub}> {fromSub}</Text> : null}
            </Text>
          ) : null}
          {title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}
        </View>
        {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /> : null}
      </View>
      {children ? <View style={styles.body}>{children}</View> : null}
    </Card>
  );
  return onPress ? (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress}>{body}</TouchableOpacity>
  ) : (
    body
  );
}

export default function InvitationsScreen() {
  const qc = useQueryClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [tab, setTab] = useState<Tab>('new');
  const [error, setError] = useState('');
  // Feature accents for the kind discs (a trip invite wears the Trips colour).
  const { colors: accents } = useCalendarColors();

  const invQ = useQuery({
    queryKey: EVENT_INVITATIONS_KEY,
    queryFn: fetchEventInvitations,
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
  // Approver side: contacts who accepted an invite and are now waiting for a
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
  // Re-key access requests on calendars I own. Only I can wrap the CalendarKey,
  // so until this is approved the requester sees nothing — worth the same poll
  // cadence as join requests.
  const accessReqQ = useQuery({
    queryKey: ['calendarAccessRequests'],
    queryFn: listAccessRequests,
    refetchInterval: 5000,
  });
  // Household event invites aimed at me, derived from the replica. The queryFn
  // does an inline record pull, so the 5s poll is what makes a request visible
  // seconds after the creator's push (or without any push at all).
  const hhEventQ = useQuery({
    queryKey: ['calendar', 'householdEventRequests'],
    queryFn: listMyHouseholdEventRequests,
    refetchInterval: 5000,
  });
  // Member names for the "X invited you" line and the response push.
  const { user } = useAuth();
  const membersQ = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });
  const memberName = (id?: string) => {
    const m = membersQ.data?.members?.find((x) => x._id === id);
    return m ? [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.email || 'A housemate' : 'A housemate';
  };

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

  // A fresh login races this inbox: a sealed event invitation decrypts with the
  // identity key inside the list queryFn, and that can run a beat BEFORE the
  // vault finishes unlocking (the invite pop-up isn't affected — it reads the
  // plaintext lanes — so the user lands here fast). The failed decrypt then
  // sits in the query cache and the card says "Unlock to view this invitation"
  // until a manual refresh. Re-list the moment the keys actually land, and
  // refresh the HDK-dependent approve state with them.
  useEffect(() => {
    const relist = () => {
      if (!isUnlocked()) return;
      qc.invalidateQueries({ queryKey: EVENT_INVITATIONS_KEY });
      qc.invalidateQueries({ queryKey: ['calendar', 'householdEventRequests'] });
      setHdkReady(getHDK() != null);
    };
    const unsubLock = subscribeLockState(relist);
    const unsubKeys = subscribeKeysReady(relist);
    return () => {
      unsubLock();
      unsubKeys();
    };
  }, [qc]);

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
  // Same out-of-band check for a re-key request — and it matters more here: the
  // whole point of the approval step is that the key on the other end is a NEW
  // one, so the code the requester reads out is the only evidence it's them and
  // not someone who took over their mailbox.
  useEffect(() => {
    if (!accessReqQ.data) return;
    accessReqQ.data.forEach(async (r) => {
      const id = `${r.calendarKey}:${r.userId}`;
      const fp = await publicKeyFingerprint(r.identityPublicKey);
      setFingerprints((cur) => (cur[id] === fp ? cur : { ...cur, [id]: fp }));
    });
  }, [accessReqQ.data]);

  // Approving wraps the calendar's CURRENT CalendarKey to the requester's new
  // identity key on-device and posts the envelope — the only path the server
  // accepts a wrap for a re-keyed collaborator through.
  const approveAccess = useMutation({
    mutationFn: async (r: CalendarAccessRequest) => {
      const ok = await approveAccessRequest(r);
      if (!ok) throw new Error('This device doesn’t hold that calendar’s key yet — reopen this screen and try again.');
    },
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['calendarAccessRequests'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || e.message || 'Could not approve'),
  });

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
      qc.invalidateQueries({ queryKey: EVENT_INVITATIONS_KEY });
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
      if (sealedAny) qc.invalidateQueries({ queryKey: EVENT_INVITATIONS_KEY });
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
    Alert.alert('Reject request?', 'This contact will not be able to join.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => rejectJoin.mutate(r) },
    ]);

  const dismissNotice = useMutation({
    mutationFn: (id: string) => householdApi.ackNotice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['householdNotices'] }),
    onError: (e: any) => setError(e.response?.data?.error || 'Something went wrong'),
  });

  // Accept/decline a household event invite: seals my own EventRsvp record and
  // pushes the reply to the creator (lib/householdRsvp). A locked vault can't
  // seal — the lib's "Unlock…" message surfaces here instead of a silent no-op.
  const respondHH = useMutation({
    mutationFn: ({ req, action }: { req: HouseholdEventRequest; action: 'accepted' | 'declined' }) =>
      respondToHouseholdEvent({
        eventId: req.eventId,
        status: action,
        eventTitle: req.title,
        creatorId: req.creatorId,
        myName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'A housemate',
      }),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e: any) => setError(e.response?.data?.error || e.message || 'Something went wrong'),
  });

  const items = useMemo<Row[]>(() => {
    const wantPending = tab === 'new';
    // Pending join requests are only ever actionable — they live in "New" only.
    const joinReqs: Row[] = wantPending
      ? (joinReqQ.data ?? []).map((inv) => ({ kind: 'joinRequest', inv }))
      : [];
    // Like join requests, an access request is only ever actionable — it has no
    // "replied" state to keep (approving simply removes it).
    const accessReqs: Row[] = wantPending
      ? (accessReqQ.data ?? []).map((inv) => ({ kind: 'accessRequest', inv }))
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
    // A pending pre-event invitation lapses once the event has ended and moves
    // to Replied as "Expired" (nobody should have to decline history, but the
    // trace stays findable). One SENT after the event ended is a record-share —
    // it stays under New with Add to Calendar. Sealed snapshots fail open —
    // see lib/inviteAlerts.invitationLapsed.
    const events: Row[] = (invQ.data ?? [])
      .filter((i) => (i.status === 'pending' && !invitationLapsed(i)) === wantPending)
      .map((inv) => ({ kind: 'event', inv }));
    const hhEvents: Row[] = (hhEventQ.data ?? [])
      .filter((r) => (r.myStatus === 'pending') === wantPending)
      .map((inv) => ({ kind: 'householdEvent', inv }));
    // Finished calls with a judged outcome: "New" until dismissed, then history.
    const calls: Row[] = (callsQ.data ?? [])
      .filter((c) => (c.status === 'ended' || c.status === 'failed') && c.outcome)
      .filter((c) => c.acknowledged !== wantPending)
      .map((inv) => ({ kind: 'call', inv }));
    return [...joinReqs, ...accessReqs, ...notices, ...calls, ...hh, ...cals, ...trips, ...hhEvents, ...events];
  }, [invQ.data, calInvQ.data, tripInvQ.data, hhInvQ.data, joinReqQ.data, accessReqQ.data, noticesQ.data, callsQ.data, hhEventQ.data, tab]);

  // Outcome of a phone call Calen placed (e.g. the event view's Call to
  // Cancel). The notice card has no inline action — tapping it opens the full
  // Interaction (Calen call) view (transcript, recording, confirm actions),
  // where the user resolves the outcome and dismisses the notice.
  const renderCallItem = (item: PhoneCallRecord) => {
    const confirmed = item.outcome === 'confirmed';
    return (
      <InviteCard
        icon="call"
        from="Calen"
        fromSub={`called to ${item.action === 'cancel' ? 'cancel' : 'reschedule'} an appointment`}
        title={item.eventTitle || 'Appointment'}
        onPress={() => navigation.navigate('Interaction', { id: item._id })}
      >
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
      </InviteCard>
    );
  };

  const renderCalendarItem = (item: CalendarInvitation) => {
    const busy = respondCal.isPending && respondCal.variables?.id === item._id;
    return (
      <InviteCard
        icon="calendar"
        accent={item.color || colors.primary}
        from={item.fromName || item.fromEmail || 'Someone'}
        fromSub="shared a calendar"
        title={item.calendarName}
      >
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
      </InviteCard>
    );
  };

  const renderTripItem = (item: TripInvitation) => {
    const busy = respondTrip.isPending && respondTrip.variables?.id === item._id;
    return (
      <InviteCard
        mdiIcon="bag-suitcase"
        accent={accents.vacations}
        from={item.fromName || item.fromEmail || 'Someone'}
        fromSub="shared a trip"
        title={item.tripName}
      >
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
      </InviteCard>
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
      <InviteCard
        mdiIcon={approved ? 'home-heart' : 'home-remove'}
        accent={approved ? colors.success : colors.error}
        title={approved ? 'You’re in the household' : 'Removed from a household'}
      >
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
      </InviteCard>
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
      <InviteCard icon="person-add" from={display} fromSub="wants to join your household">
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
      </InviteCard>
    );
  };

  // Someone who lost access to a calendar I own is asking for it back. There is
  // no "Reject" twin: doing nothing IS the refusal (the request stays pending
  // and grants nothing), and a reject button on a request that is usually
  // innocent — a contact who forgot their password — invites a punitive tap.
  const renderAccessRequestItem = (item: CalendarAccessRequest) => {
    const id = `${item.calendarKey}:${item.userId}`;
    const display = item.name || 'Someone';
    const busy = approveAccess.isPending
      && approveAccess.variables?.calendarKey === item.calendarKey
      && approveAccess.variables?.userId === item.userId;
    return (
      <InviteCard icon="key" from={display} fromSub={`lost access to “${item.calendarName}”`}>
        <Text style={styles.meta}>
          They set up a new encryption key, so their old one can’t read your calendar
          any more. Approving re-shares it with the new key.
        </Text>
        <Text style={styles.meta}>
          Their security code has changed. Check it matches what they see before
          approving — if it doesn’t, someone else may be holding their account.
        </Text>
        {fingerprints[id] ? (
          <SecurityCode code={fingerprints[id]} copyable={false} />
        ) : (
          <Text style={styles.fingerprint}>…</Text>
        )}
        <View style={styles.actions}>
          <View style={styles.actionBtn}>
            <Button
              title="Restore access"
              loading={busy}
              onPress={() => approveAccess.mutate(item)}
            />
          </View>
        </View>
      </InviteCard>
    );
  };

  const renderHouseholdItem = (item: HouseholdInvitation) => {
    const busy = respondHousehold.isPending && respondHousehold.variables?.id === item._id;
    return (
      <InviteCard
        mdiIcon="home-heart"
        from={item.fromName || item.fromEmail || 'Someone'}
        fromSub="invited you to their household"
        // Sender-name framing when the household name is sealed (C2).
        title={item.householdName || `${(item.fromName || 'their').split(' ')[0]}${item.fromName ? '’s' : ''} household`}
      >
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
      </InviteCard>
    );
  };

  // A housemate's "please accept/decline" on a household event. The event is
  // already on this user's calendar (household sync) — tapping the card opens
  // it; the buttons answer the request. Declining never removes access.
  const renderHouseholdEventItem = (item: HouseholdEventRequest) => {
    const busy = respondHH.isPending && respondHH.variables?.req.eventId === item.eventId;
    return (
      <InviteCard
        icon="calendar"
        from={memberName(item.creatorId)}
        fromSub="invited you"
        title={item.title}
        onPress={() => navigation.navigate('EventDetail', { eventId: item.eventId })}
      >
        {item.startDate ? (
          <WhenRows event={{ startDate: item.startDate, endDate: item.endDate, allDay: item.allDay }} />
        ) : null}
        <View style={styles.metaRow}>
          <Ionicons name="home-outline" size={14} color={colors.textMuted} />
          <Text style={styles.meta}>Already on your household calendar — they’d like your answer.</Text>
        </View>
        {item.myStatus === 'pending' ? (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button
                title="Accept"
                loading={busy && respondHH.variables?.action === 'accepted'}
                onPress={() => respondHH.mutate({ req: item, action: 'accepted' })}
              />
            </View>
            <View style={styles.actionBtn}>
              <Button
                title="Decline"
                variant="ghost"
                color={colors.error}
                loading={busy && respondHH.variables?.action === 'declined'}
                onPress={() => respondHH.mutate({ req: item, action: 'declined' })}
              />
            </View>
          </View>
        ) : (
          <View style={styles.statusRow}>
            <Badge
              label={item.myStatus === 'accepted' ? 'Accepted' : 'Declined'}
              color={item.myStatus === 'accepted' ? colors.success : colors.error}
            />
            {item.respondedAt ? (
              <Text style={styles.meta}>
                {new Date(item.respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            ) : null}
          </View>
        )}
      </InviteCard>
    );
  };

  const renderEventItem = (item: EventInvitation) => {
    const busy = respond.isPending && respond.variables?.id === item._id;
    const ev = item.event;
    // Sent after the event ended = record-share: "shared an event", Add to
    // Calendar / Dismiss — no RSVP framing for something already over.
    const shared = isEventRecordShare(item);
    // A sealed invite we can't open yet (vault locked) — show a placeholder
    // rather than crashing; unlocking re-lists and decrypts it.
    if (!ev?.title) {
      return (
        <InviteCard
          icon="calendar"
          from={item.fromName || item.fromEmail || 'Someone'}
          fromSub="invited you"
        >
          <View style={styles.metaRow}>
            <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta}>Unlock to view this invitation.</Text>
          </View>
        </InviteCard>
      );
    }
    return (
      <InviteCard
        icon="calendar"
        from={item.fromName || item.fromEmail || 'Someone'}
        fromSub={shared ? 'shared an event' : 'invited you'}
        title={ev.title}
      >
        <WhenRows event={ev} />
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

        {item.status === 'pending' && !invitationLapsed(item) ? (
          <View style={styles.actions}>
            <View style={styles.actionBtn}>
              <Button
                title={shared ? 'Add to Calendar' : 'Accept'}
                loading={busy && respond.variables?.action === 'accept'}
                onPress={() => respond.mutate({ id: item._id, action: 'accept', event: ev })}
              />
            </View>
            <View style={styles.actionBtn}>
              <Button
                title={shared ? 'Dismiss' : 'Decline'}
                variant="ghost"
                color={shared ? colors.textMuted : colors.error}
                loading={busy && respond.variables?.action === 'decline'}
                onPress={() => respond.mutate({ id: item._id, action: 'decline' })}
              />
            </View>
          </View>
        ) : (
          <View style={styles.statusRow}>
            {/* A still-pending invite lands here only once it lapsed (asked
                before the event, unanswered when it ended) — no buttons:
                accepting history isn't an action worth offering. Answered
                record-shares read Added/Dismissed, matching their buttons. */}
            <Badge
              label={item.status === 'pending' ? 'Expired'
                : item.status === 'accepted' ? (shared ? 'Added' : 'Accepted')
                  : item.status === 'left' ? 'Left' : shared ? 'Dismissed' : 'Declined'}
              color={item.status === 'accepted' ? colors.success
                : item.status === 'declined' && !shared ? colors.error : colors.textMuted}
            />
            {item.respondedAt ? (
              <Text style={styles.meta}>
                {new Date(item.respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            ) : null}
          </View>
        )}
      </InviteCard>
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
        <SkeletonList />
      ) : items.length === 0 ? (
        <EmptyState
          mdiIcon="email-open-outline"
          title={tab === 'new' ? 'No new invitations' : 'No replied invitations yet'}
          message={
            tab === 'new'
              ? 'Event, calendar, trip, and household invitations you receive land here.'
              : 'Invitations you’ve answered move here.'
          }
        />
      ) : (
        <FlatList
          data={items}
          // An access request is keyed by (calendar, requester) — it's the only
          // row kind that isn't a document with an `_id`.
          keyExtractor={(row) => (row.kind === 'accessRequest'
            ? `accessRequest-${row.inv.calendarKey}-${row.inv.userId}`
            // A household event request is derived (not a document) — keyed by
            // the event it asks about.
            : row.kind === 'householdEvent'
              ? `householdEvent-${row.inv.eventId}`
              : `${row.kind}-${row.inv._id}`)}
          renderItem={({ item }) =>
            item.kind === 'call' ? renderCallItem(item.inv)
              : item.kind === 'calendar' ? renderCalendarItem(item.inv)
                : item.kind === 'trip' ? renderTripItem(item.inv)
                  : item.kind === 'household' ? renderHouseholdItem(item.inv)
                    : item.kind === 'joinRequest' ? renderJoinRequestItem(item.inv)
                      : item.kind === 'accessRequest' ? renderAccessRequestItem(item.inv)
                        : item.kind === 'notice' ? renderNoticeItem(item.inv)
                          : item.kind === 'householdEvent' ? renderHouseholdEventItem(item.inv)
                            : renderEventItem(item.inv)}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={
                invQ.isRefetching || calInvQ.isRefetching || tripInvQ.isRefetching || hhInvQ.isRefetching
              }
              onRefresh={() => {
                invQ.refetch();
                calInvQ.refetch();
                tripInvQ.refetch();
                hhInvQ.refetch();
                joinReqQ.refetch();
                noticesQ.refetch();
                callsQ.refetch();
                accessReqQ.refetch();
                hhEventQ.refetch();
              }}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tabs: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  error: { color: colors.error, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  // The shared Card supplies the chrome (surface, radius, hairline border,
  // padding); the inbox only owns the stacking gap.
  card: { marginBottom: spacing.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headText: { flex: 1, minWidth: 0 },
  body: { marginTop: spacing.sm },
  from: { fontSize: 13, fontWeight: '600', color: colors.text },
  fromSub: { fontWeight: '400', color: colors.textMuted },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  meta: { fontSize: 13, color: colors.textMuted, flexShrink: 1 },
  description: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actionBtn: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  fingerprint: { fontSize: 13, letterSpacing: 1, color: colors.primary, marginTop: 6, fontVariant: ['tabular-nums'] },
  warn: { fontSize: 12, color: colors.warning ?? '#b26a00', marginTop: spacing.sm },
  leaveBtn: { marginLeft: 'auto' },
  guestsBlock: { marginBottom: spacing.sm },
  guestsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
  guestsToggleText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  guestsList: { marginTop: spacing.xs, gap: 2 },
  guestsLoading: { alignSelf: 'flex-start', marginTop: spacing.xs },
  guestsHidden: { fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, fontStyle: 'italic' },
});
