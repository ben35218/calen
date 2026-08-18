import { useEffect } from 'react';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { ADDON_CALENDAR_IDS, getOwnedAddonIds } from '../lib/addons';
import { currentUserId } from '../lib/e2ee';
import {
  markDiscoverShown,
  pickDiscoverNudge,
  recordDiscoverOpen,
} from '../lib/discoverNudge';
import { interruptionThisLaunch } from '../lib/securityNudges';
import type { RootStackParamList } from '../navigation/types';

// The discovery nudge (spec: features/notifications.md — Discovery nudge):
// from the third app open, on a spaced/capped cadence, present the full-screen
// Discover modal — unowned add-ons + the Calen brainstorm pitch (brainstorm
// alone, at most once, when every add-on is owned). Mounted once in
// RootNavigator beside the invite/security hooks, same full-app-shell gate.
// Cadence/memory live in lib/discoverNudge; everything fails soft to "no
// nudge".

// Last in the interruption pecking order: invitations (3.5s check window in
// useInviteAlerts), the security nudges (3.5s), and the widget nudge (4.3s)
// all outrank discovery, so this check waits past them and skips the open
// when any presented.
const CHECK_DELAY_MS = 5000;

// One check per launch, however often the enabled gate re-arms.
let checkedThisLaunch = false;
export function resetDiscoverNudgeLaunchForTest(): void {
  checkedThisLaunch = false;
}

export function useDiscoverNudge(
  navRef: NavigationContainerRefWithCurrent<RootStackParamList>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || checkedThisLaunch) return;

    const check = async () => {
      try {
        const me = currentUserId();
        if (!me) return;
        const mem = await recordDiscoverOpen(me);
        // The owned mirror (cached from the last /billing/status) is enough to
        // decide which VERSION to show; the Discover screen itself renders
        // from the live set, so a stale mirror can't promote an owned add-on.
        const owned = await getOwnedAddonIds();
        const kind = pickDiscoverNudge({
          opens: mem.opens,
          shows: mem.shows,
          lastShownAt: mem.lastShownAt,
          brainstormShown: mem.brainstormShown,
          allAddonsOwned: ADDON_CALENDAR_IDS.every((id) => owned.has(id)),
          nowMs: Date.now(),
        });
        if (!kind) return;
        // An invitation or security nudge took this open — discovery is NOT
        // marked shown, so the cadence resumes on a later, quieter open.
        if (interruptionThisLaunch()) return;
        if (!navRef.isReady()) return;
        await markDiscoverShown(me, kind, Date.now());
        navRef.navigate('Discover');
      } catch {
        // Best-effort surface — the Add-Ons store row stays the durable path.
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
