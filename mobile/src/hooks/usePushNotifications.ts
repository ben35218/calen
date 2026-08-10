import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { registerForPushNotifications } from '../lib/push';
import type { RootStackParamList } from '../navigation/types';

// Remote-push session wiring (mounted once in RootNavigator):
//  1. Register this device's Expo push token while signed in — on sign-in and
//     again on each foreground (registration replaces per-token server-side,
//     so re-running is idempotent; it also picks up a permission granted later
//     in Settings). The permission prompt therefore fires after sign-in, never
//     on the auth screens; denial degrades to the in-app Invitations inbox.
//  2. Route notification taps. The payload's `data.type` decides the landing:
//     invite requests → the Invitations inbox; an accept/decline reply → the
//     event it answers. Cold starts arrive via getLastNotificationResponseAsync
//     (the listener isn't mounted yet when the tap launches the app).
//
// No iOS banner actions (accept/decline from the notification) in v1 — a tap
// opens the app on the right screen and the user responds there.
export function usePushNotifications(
  navRef: NavigationContainerRefWithCurrent<RootStackParamList>,
  enabled: boolean,
) {
  // A cold-start tap response is delivered once; remember what we've routed so
  // the foreground listener firing later for the same response is a no-op.
  const routedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    registerForPushNotifications().catch(() => {});
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') registerForPushNotifications().catch(() => {});
    });
    return () => sub.remove();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const route = (response: Notifications.NotificationResponse | null) => {
      if (!response || !navRef.isReady()) return;
      const id = response.notification.request.identifier;
      if (routedRef.current === id) return;
      const data = response.notification.request.content.data as
        | { type?: string; eventId?: string }
        | undefined;
      switch (data?.type) {
        case 'household_event_request':
        case 'event_invitation':
        case 'household_invite':
        case 'calendar_invitation':
        case 'trip_invitation':
          routedRef.current = id;
          navRef.navigate('Invitations');
          break;
        case 'household_event_response':
          if (data.eventId) {
            routedRef.current = id;
            navRef.navigate('EventDetail', { eventId: data.eventId });
          }
          break;
        default:
          // Unknown/absent type (e.g. a local reminder): just open the app.
          break;
      }
    };

    // Tap that launched the app (listener not yet mounted at tap time). The
    // container may still be mounting when this resolves — wait for isReady
    // briefly instead of dropping the tap.
    let readyTimer: ReturnType<typeof setInterval> | null = null;
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        if (navRef.isReady()) return route(response);
        let tries = 0;
        readyTimer = setInterval(() => {
          if (navRef.isReady() || ++tries > 20) {
            if (readyTimer) clearInterval(readyTimer);
            readyTimer = null;
            if (navRef.isReady()) route(response);
          }
        }, 250);
      })
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(route);
    return () => {
      if (readyTimer) clearInterval(readyTimer);
      sub.remove();
    };
  }, [enabled, navRef]);
}
