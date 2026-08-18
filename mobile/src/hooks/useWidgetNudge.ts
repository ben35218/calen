import { useEffect } from 'react';
import { Platform } from 'react-native';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { getInstalledWidgetCount, widgetBridgeAvailable } from '../../modules/calen-widget';
import { currentUserId } from '../lib/e2ee';
import {
  markWidgetNudgeShown,
  pickWidgetNudge,
  recordWidgetNudgeOpen,
} from '../lib/widgetNudge';
import { interruptionThisLaunch, noteInterruption } from '../lib/securityNudges';
import type { RootStackParamList } from '../navigation/types';

// The widget-adoption nudge (spec: features/notifications.md — Widget nudge):
// from the second app open, present the WidgetPromo modal (the user's-own-data
// widget preview + add steps) — once, with a single 14-day-later re-nudge if
// the widget still isn't on the Home Screen. Mounted once in RootNavigator
// beside the invite/security hooks, same full-app-shell gate. iOS builds that
// actually ship the widget only (the native bridge is the tell); a user who
// already added the widget from the gallery is never interrupted at all
// (WidgetKit's getCurrentConfigurations). Cadence/memory live in
// lib/widgetNudge; everything fails soft to "no nudge".

// Third in the interruption pecking order: invitations (checked at mount in
// useInviteAlerts) and the security nudges (3.5s) outrank this, so the check
// waits past both; the discovery nudge (5s) checks after this one and sits the
// open out when we present (noteInterruption).
const CHECK_DELAY_MS = 4300;

// One check per launch, however often the enabled gate re-arms.
let checkedThisLaunch = false;
export function resetWidgetNudgeLaunchForTest(): void {
  checkedThisLaunch = false;
}

export function useWidgetNudge(
  navRef: NavigationContainerRefWithCurrent<RootStackParamList>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || checkedThisLaunch) return;

    const check = async () => {
      try {
        // Only where the widget exists to add: iOS builds carrying the native
        // module (Expo Go / Android resolve it to null).
        if (Platform.OS !== 'ios' || !widgetBridgeAvailable()) return;
        const me = currentUserId();
        if (!me) return;
        const mem = await recordWidgetNudgeOpen(me);
        // Decide off the memory first, so most opens never touch the native
        // install check at all.
        if (!pickWidgetNudge({ ...mem, installed: false, nowMs: Date.now() })) return;
        const count = await getInstalledWidgetCount();
        if (count != null && count > 0) return;
        // An invitation or security nudge took this open — the promo is NOT
        // marked shown, so it returns on a later, quieter open.
        if (interruptionThisLaunch()) return;
        if (!navRef.isReady()) return;
        // The promo is itself an interruption — the discovery nudge (checked
        // after this one) sits the open out when we present.
        noteInterruption();
        await markWidgetNudgeShown(me, Date.now());
        navRef.navigate('WidgetPromo');
      } catch {
        // Best-effort surface — the Profile "Home Screen Widget" row stays the
        // durable path.
      }
    };

    const timer = setTimeout(() => {
      if (checkedThisLaunch) return;
      checkedThisLaunch = true;
      void check();
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, navRef]);
}
