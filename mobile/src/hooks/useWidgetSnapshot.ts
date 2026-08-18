import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { refreshWidgetSnapshot } from '../lib/widgetSnapshot';
import { queryClient } from '../lib/queryClient';

// Coalesce the burst of ['calendar'] invalidations a single save can emit into
// one snapshot write (same doctrine as useReminderScheduler).
const MUTATION_DEBOUNCE_MS = 1500;

// Keep the home-screen widget's App Group snapshot fresh: while signed in,
// write once on mount, again whenever the app returns to the foreground, and
// again whenever the calendar data changes (every calendar mutation in the app
// invalidates the ['calendar'] query key, so subscribing to the cache covers
// forms, the assistant, sync passes, and prefs changes without each site
// remembering the widget exists). Separate from useReminderScheduler on
// purpose: the widget must stay fresh even when the user turns REMINDERS off.
//
// Sign-out does not go through this hook's disabled path for cleanup — the
// auth teardown calls clearWidgetData() directly, alongside the replica wipe.
export function useWidgetSnapshot(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios') return;
    void refreshWidgetSnapshot();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshWidgetSnapshot();
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action?.type !== 'invalidate') return;
      if (event.query.queryKey?.[0] !== 'calendar') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshWidgetSnapshot();
      }, MUTATION_DEBOUNCE_MS);
    });

    return () => {
      sub.remove();
      unsubscribeCache();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
