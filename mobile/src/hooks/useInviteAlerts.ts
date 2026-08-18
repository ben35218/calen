import { useEffect, useRef } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import {
  listMyHouseholdEventRequests,
  respondToHouseholdEvent,
  HouseholdEventRequest,
} from '../lib/householdRsvp';
import {
  PendingInvite,
  freshInvites,
  invitationLapsed,
  inviteAlertContent,
  inviteKey,
  isEventRecordShare,
  loadPromptedInviteKeys,
  markInvitesPrompted,
} from '../lib/inviteAlerts';
import { currentUserId, subscribeKeysReady } from '../lib/e2ee';
import { noteInterruption } from '../lib/securityNudges';
import { customCalendarsApi, householdApi, invitationsApi, keysApi, tripsApi } from '../api';
import { useAuth } from '../store/auth';
import type { RootStackParamList } from '../navigation/types';

// Push payload types that mean "an invitation landed" — arriving while the app
// is foregrounded (no banner worth tapping), they trigger the same pop-up the
// next open would have shown.
const INVITE_PUSH_TYPES = new Set([
  'household_event_request',
  'event_invitation',
  'household_invite',
  'calendar_invitation',
  'trip_invitation',
  'guardian_recovery_request',
]);

// The in-app half of invitations (mounted once in RootNavigator, beside
// usePushNotifications). The push banner is transient and best-effort; this
// hook is what guarantees an invited user actually SEES the invite: on app
// open, on each foreground, once the household keys unlock (household event
// requests aren't derivable before that), and when an invite push lands while
// the app is open, it gathers every pending invitation the Invitations inbox
// lists — household event requests, cross-household event invitations,
// calendar shares, trip and household invitations, and approver-side join
// requests — plus guardian recovery approvals awaiting the user — and pops the
// app's iOS-style native alert for the ones this device has never prompted. A single household event request is answerable
// inline (Accept / Decline / View Invitation / Not Now — the answer is one
// sealed EventRsvp write); every other kind, and any multiple, routes to the
// Invitations inbox where its real accept flow lives. "Not Now" leaves the
// invitation in the inbox and never re-prompts it.
export function useInviteAlerts(
  navRef: NavigationContainerRefWithCurrent<RootStackParamList>,
  enabled: boolean,
) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const busyRef = useRef(false);
  // Latest name without re-arming the listeners on every auth refresh.
  const myNameRef = useRef('');
  myNameRef.current =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'A housemate';

  useEffect(() => {
    if (!enabled) return;

    const respond = (req: HouseholdEventRequest, status: 'accepted' | 'declined') => {
      respondToHouseholdEvent({
        eventId: req.eventId,
        status,
        eventTitle: req.title,
        creatorId: req.creatorId,
        myName: myNameRef.current,
      })
        .then(() => {
          qc.invalidateQueries({ queryKey: ['calendar', 'householdEventRequests'] });
        })
        .catch((e: any) => {
          Alert.alert(
            'Could not send your reply',
            e?.message || 'Please answer from the Invitations screen.',
          );
        });
    };

    const openInbox = () => {
      if (navRef.isReady()) navRef.navigate('Invitations');
    };

    // Guardian recovery requests are a security approval, not a social invite:
    // they present on their own (never folded into the invitations count) and
    // route to the approve screen, where the fingerprint check lives. Requests
    // expire (30 min), so this alert is the difference between a recovery that
    // completes and one that times out.
    const presentGuardian = (fresh: PendingInvite[]) => {
      const { title, message } = inviteAlertContent(fresh);
      Alert.alert(title, message, [
        {
          text: 'Review Request',
          onPress: () => {
            if (navRef.isReady()) navRef.navigate('GuardianRecovery', { mode: 'approve' });
          },
        },
        { text: 'Not Now', style: 'cancel' },
      ]);
    };

    const present = (fresh: PendingInvite[]) => {
      const { title, message } = inviteAlertContent(fresh);
      if (fresh.length > 1) {
        Alert.alert(title, message, [
          { text: 'View Invitations', onPress: openInbox },
          { text: 'Not Now', style: 'cancel' },
        ]);
        return;
      }
      const inv = fresh[0];
      if (inv.kind === 'householdEvent' && inv.request) {
        const req = inv.request;
        if (Platform.OS === 'ios') {
          Alert.alert(title, message, [
            { text: 'Accept', onPress: () => respond(req, 'accepted') },
            { text: 'Decline', style: 'destructive', onPress: () => respond(req, 'declined') },
            { text: 'View Invitation', onPress: openInbox },
            { text: 'Not Now', style: 'cancel' },
          ]);
        } else {
          // Android alerts cap at three buttons; dismissing (back/outside tap)
          // is the "Not Now".
          Alert.alert(
            title,
            message,
            [
              { text: 'View', onPress: openInbox },
              { text: 'Decline', onPress: () => respond(req, 'declined') },
              { text: 'Accept', onPress: () => respond(req, 'accepted') },
            ],
            { cancelable: true },
          );
        }
        return;
      }
      // Every other kind acts in the inbox — its accept flow is multi-step
      // (key unwraps, join carry-over, calendar merge), not a one-tap answer.
      Alert.alert(title, message, [
        { text: inv.kind === 'joinRequest' ? 'Review Request' : 'View Invitation', onPress: openInbox },
        { text: 'Not Now', style: 'cancel' },
      ]);
    };

    // Gather every pending invitation lane the inbox lists. Each fetch fails
    // soft to [] — one lane erroring (offline, no household) must not hide the
    // others.
    const gather = async (): Promise<PendingInvite[]> => {
      const [hhEvents, events, cals, trips, hhInvs, joinReqs, guardianReqs] = await Promise.all([
        // Locked replica → rows don't decrypt → derives empty; the keys-ready
        // subscription below re-runs this once records become readable.
        listMyHouseholdEventRequests().catch(() => [] as HouseholdEventRequest[]),
        invitationsApi.list().then((r) => r.data).catch(() => []),
        customCalendarsApi.invitations().then((r) => r.data).catch(() => []),
        tripsApi.invitations().then((r) => r.data).catch(() => []),
        householdApi.myInvitations().then((r) => r.data).catch(() => []),
        householdApi.joinRequests().then((r) => r.data).catch(() => []),
        keysApi.guardianRequests().then((r) => r.data.requests).catch(() => []),
      ]);
      const from = (i: { fromName?: string; fromEmail?: string }) => i.fromName || i.fromEmail || null;
      return [
        ...hhEvents
          .filter((r) => r.myStatus === 'pending')
          .map((r): PendingInvite => ({ kind: 'householdEvent', id: r.eventId, title: r.title, request: r })),
        ...events
          // Lapsed invitations (asked before the event, unanswered when it
          // ended) aren't worth an interruption — the inbox's Replied tab
          // keeps the trace. Record-shares still prompt, worded "shared".
          .filter((i) => i.status === 'pending' && !invitationLapsed(i))
          // A sealed snapshot has no readable title here; the pop-up falls
          // back to "an event" and the inbox decrypts the full card.
          .map((i): PendingInvite => ({
            kind: 'event', id: i._id, from: from(i), title: i.event?.title ?? null,
            shared: isEventRecordShare(i),
          })),
        ...cals
          .filter((i) => i.status === 'pending')
          .map((i): PendingInvite => ({ kind: 'calendar', id: i._id, from: from(i), title: i.calendarName })),
        ...trips
          .filter((i) => i.status === 'pending')
          .map((i): PendingInvite => ({ kind: 'trip', id: i._id, from: from(i), title: i.tripName })),
        ...hhInvs
          .filter((i) => i.status === 'pending')
          .map((i): PendingInvite => ({ kind: 'household', id: i._id, from: from(i), title: i.householdName })),
        // Join requests are only ever pending (approving removes them).
        ...joinReqs.map(
          (r): PendingInvite => ({
            kind: 'joinRequest',
            id: r._id,
            from: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || null,
          }),
        ),
        // Guardian recovery approvals awaiting me (the server already filters
        // to unexpired requests that still name me). A re-request after expiry
        // mints a new requestId, so it prompts afresh.
        ...guardianReqs.map(
          (r): PendingInvite => ({ kind: 'guardianRequest', id: r.requestId, from: r.requesterName }),
        ),
      ];
    };

    const check = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const me = currentUserId();
        if (!me) return;
        const invites = await gather();
        const prompted = await loadPromptedInviteKeys(me);
        const fresh = freshInvites(invites, prompted);
        if (!fresh.length) return;
        // Remember before presenting: a re-trigger while the alert is up (a
        // foreground bounce, the push landing) must not stack a second copy.
        await markInvitesPrompted(me, fresh.map(inviteKey));
        // Invitations outrank the security nudges — an open where this pop-up
        // presents anything makes the nudge sit out (see useSecurityNudges).
        noteInterruption();
        // Guardian requests present apart from (and before) ordinary
        // invitations; iOS queues the second alert behind the first.
        const guardianFresh = fresh.filter((i) => i.kind === 'guardianRequest');
        const inviteFresh = fresh.filter((i) => i.kind !== 'guardianRequest');
        if (guardianFresh.length) presentGuardian(guardianFresh);
        if (!inviteFresh.length) return;
        // A lone household event request names its inviter from the member
        // list (the sealed event's author is a bare userId).
        if (inviteFresh.length === 1 && inviteFresh[0].kind === 'householdEvent' && inviteFresh[0].request?.creatorId) {
          inviteFresh[0].from = await householdApi
            .get()
            .then(({ data }) => {
              const m = data.members?.find((x) => x._id === inviteFresh[0].request!.creatorId);
              return m ? [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || null : null;
            })
            .catch(() => null);
        }
        present(inviteFresh);
      } catch {
        // Best-effort surface — the Invitations inbox still holds everything.
      } finally {
        busyRef.current = false;
      }
    };

    void check();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    const unsubKeys = subscribeKeysReady(() => void check());
    // An invite push arriving while the app is foregrounded shows no banner
    // worth tapping — surface the same pop-up right away instead.
    const pushSub = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as { type?: string } | undefined;
      if (data?.type && INVITE_PUSH_TYPES.has(data.type)) void check();
    });
    return () => {
      appState.remove();
      unsubKeys();
      pushSub.remove();
    };
  }, [enabled, navRef, qc]);
}
