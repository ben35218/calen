import { useEffect } from 'react';
import { AppState } from 'react-native';
import { rescheduleReminders, cancelAllReminders } from '../lib/notifications';
import { registerBackgroundRefresh, unregisterBackgroundRefresh } from '../lib/backgroundRefresh';
import { queryClient } from '../lib/queryClient';

// Coalesce the burst of ['calendar'] invalidations a single save can emit (the
// form invalidates, the detail screen invalidates, a sync pass lands) into one
// reschedule.
const MUTATION_DEBOUNCE_MS = 1500;

// Keep the rolling on-device reminder window fresh (Phase 5): while `enabled`
// (i.e. signed in), reschedule once now, again whenever the app returns to the
// foreground, and again whenever the calendar data itself changes; clear
// everything when signed out. Permission is prompted on the first schedule — if
// denied, nothing is scheduled and this is a no-op.
//
// The data-change trigger is what makes a just-created alert real: without it an
// event saved and left alone (no background → foreground round trip) had its
// reminder computed only on the NEXT foreground, so a same-session alert simply
// never fired. Every calendar mutation in the app already invalidates the
// ['calendar'] query key, so subscribing to the cache covers all of them —
// forms, detail screens, the assistant, templates, invitations, prefs — without
// each site remembering to call the scheduler.
//
// A periodic background-fetch task tightens the window between foregrounds
// (best-effort — the OS chooses when it actually runs).
export function useReminderScheduler(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      void cancelAllReminders();
      void unregisterBackgroundRefresh();
      return;
    }
    void rescheduleReminders();
    void registerBackgroundRefresh();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void rescheduleReminders();
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action?.type !== 'invalidate') return;
      if (event.query.queryKey?.[0] !== 'calendar') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void rescheduleReminders();
      }, MUTATION_DEBOUNCE_MS);
    });

    return () => {
      sub.remove();
      unsubscribeCache();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
