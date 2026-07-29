import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { settingsApi } from '../api';

// The device's IANA zone (e.g. "America/Toronto"), or '' if unavailable.
function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// Keep the server's stored timezone in sync with the phone. Alerts fire at the
// user's own 9am local (see server scheduler), so the stored zone must follow
// the device when the user travels or relocates. This sync is the SINGLE
// writer of the personal zone — there is no user-facing picker (a manual
// choice would just be silently reverted here, so we don't offer one). Runs at
// launch and again whenever the app returns to the foreground (landing in a
// new zone rarely coincides with a relaunch), but only issues a write when the
// zone actually changed since the last successful sync.
export function useSyncTimezone() {
  const lastSynced = useRef('');
  useEffect(() => {
    async function sync() {
      const tz = deviceTimezone();
      if (!tz || tz === lastSynced.current) return;
      try {
        const { data } = await settingsApi.get();
        if (data.timezone !== tz) await settingsApi.update({ timezone: tz });
        lastSynced.current = tz;
      } catch {
        // Non-critical: a failed sync just leaves the existing stored zone.
      }
    }
    sync();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') sync();
    });
    return () => sub.remove();
  }, []);
}
