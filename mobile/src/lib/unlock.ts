import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Device-side mirror of the per-user $4.99 app unlock. The server is the source
// of truth (User.appUnlocked, flipped only by the RevenueCat webhook or the
// admin override) and lands on the client via login/session payloads and
// GET /billing/status — every sighting is cached here so the hard paywall works
// offline for a user who already unlocked. Unknown + uncached reads as LOCKED
// (a fresh sign-in needs the network anyway, and the first status fetch
// re-caches). MUST be cleared on sign-out (auth store) so another account on
// the same device can't inherit the unlock. Same module-level state +
// subscriber pattern as lib/addons.

const UNLOCK_KEY = 'hc_app_unlocked';

let unlockedState: boolean | null = null; // null = not yet loaded from cache
const subs = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(UNLOCK_KEY);
        // A cacheUnlocked() racing ahead of this read wins.
        if (unlockedState === null) unlockedState = raw === 'true';
      } catch {
        if (unlockedState === null) unlockedState = false;
      }
      subs.forEach((fn) => fn());
    })();
  }
  return loadPromise;
}

// Record the server-reported unlock state (called from the auth store on
// login/refresh and from useBilling's queryFn / activation polling).
export function cacheUnlocked(unlocked: boolean): void {
  unlockedState = Boolean(unlocked);
  AsyncStorage.setItem(UNLOCK_KEY, unlockedState ? 'true' : 'false').catch(() => {});
  subs.forEach((fn) => fn());
}

// Sign-out hygiene: forget the unlock so the next account starts locked.
// Resets to a KNOWN locked state (false), not null: the RootNavigator gate
// stays mounted across an account switch and nothing re-runs ensureLoaded()
// after a clear, so a null state would report `loaded: false` until relaunch
// and hold the splash (see lib/viewerAccess for the full deadlock). "Cleared"
// IS the safe default: locked until the next server sighting re-caches.
export function clearUnlockCache(): void {
  unlockedState = false;
  loadPromise = null;
  AsyncStorage.removeItem(UNLOCK_KEY).catch(() => {});
  subs.forEach((fn) => fn());
}

// Cached unlock state for non-React callers (and tests): resolves after the
// AsyncStorage read; unknown reads as locked (the safe default).
export async function getUnlockedCached(): Promise<boolean> {
  await ensureLoaded();
  return unlockedState === true;
}

export function useUnlocked() {
  const [unlocked, setUnlocked] = useState<boolean>(unlockedState === true);
  const [loaded, setLoaded] = useState(unlockedState !== null);

  useEffect(() => {
    const sub = () => {
      setUnlocked(unlockedState === true);
      setLoaded(unlockedState !== null);
    };
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  return { unlocked, loaded };
}
