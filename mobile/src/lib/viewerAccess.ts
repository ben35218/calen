import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BillingStatus } from '../api';

// Device-side mirror of the free-viewer-mode eligibility signal: whether this
// (locked) user has viewer content — a shared calendar they're seated on, or a
// pending calendar invitation addressed to them. The server is the source of
// truth (GET /billing/status → `viewer` counts); every sighting is cached here
// so the RootNavigator gate can route a locked user to the read-only viewer
// shell instead of the paywall, offline included. Unknown + uncached reads as
// NO CONTENT (the safe default is the paywall; the first status fetch
// re-caches). MUST be cleared on sign-out (auth store) so another account on
// the same device can't inherit the shell. Same module-level state + subscriber
// pattern as lib/unlock.

const VIEWER_KEY = 'hc_viewer_content';

let contentState: boolean | null = null; // null = not yet loaded from cache
const subs = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(VIEWER_KEY);
        // A cacheViewerContent() racing ahead of this read wins.
        if (contentState === null) contentState = raw === 'true';
      } catch {
        if (contentState === null) contentState = false;
      }
      subs.forEach((fn) => fn());
    })();
  }
  return loadPromise;
}

// Fold a billing-status payload down to the boolean the gate needs.
export function viewerContentFromStatus(status: Pick<BillingStatus, 'viewer'>): boolean {
  const v = status.viewer;
  return ((v?.calendarCollaborations ?? 0) + (v?.pendingCalendarInvitations ?? 0)) > 0;
}

// Record the server-reported viewer-content state (called from useBilling's
// queryFn / activation polling, alongside cacheUnlocked).
export function cacheViewerContent(hasContent: boolean): void {
  contentState = Boolean(hasContent);
  AsyncStorage.setItem(VIEWER_KEY, contentState ? 'true' : 'false').catch(() => {});
  subs.forEach((fn) => fn());
}

// Sign-out hygiene: forget the viewer content so the next account starts clean.
// Resets to a KNOWN no-content state (false), not null: RootNavigator and its
// useViewerContent hook stay mounted across a sign-out → next sign-in, and
// nothing re-runs ensureLoaded() after a clear — a null state left `loaded`
// false forever, holding the splash spinner for the next signed-in account
// (the billing-status fetch that would re-cache the signal lives in useBilling,
// which only mounts once the gate renders a screen — a deadlock broken only by
// relaunching the app). "Cleared" and "fresh install" mean the same safe
// default anyway: no content → paywall → the first status fetch re-caches.
export function clearViewerContentCache(): void {
  contentState = false;
  loadPromise = null;
  AsyncStorage.removeItem(VIEWER_KEY).catch(() => {});
  subs.forEach((fn) => fn());
}

// Cached state for non-React callers (and tests): resolves after the
// AsyncStorage read; unknown reads as no content (the safe default).
export async function getViewerContentCached(): Promise<boolean> {
  await ensureLoaded();
  return contentState === true;
}

export function useViewerContent() {
  const [hasContent, setHasContent] = useState<boolean>(contentState === true);
  const [loaded, setLoaded] = useState(contentState !== null);

  useEffect(() => {
    const sub = () => {
      setHasContent(contentState === true);
      setLoaded(contentState !== null);
    };
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  return { hasContent, loaded };
}
