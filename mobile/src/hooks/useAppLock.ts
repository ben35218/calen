import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { usePrivacyPrefs } from '../lib/privacyPrefs';
import { lock, unlockFromDeviceCache, ensureHouseholdKey, isUnlocked } from '../lib/e2ee';

// App lock (Signal-parity plan A4). When the policy is on, backgrounding the
// app for longer than the configured window drops the in-memory identity key +
// HDKs (`lock()`), so returning requires a fresh Face ID via the biometric
// device cache — attempted automatically here; if it fails or is canceled the
// app stays locked and the existing locked-state UI takes over.
//
// This guards the "phone handed over / left on the table" window by shortening
// how long decrypted keys stay in memory. Note the replica stores decrypted
// rows at rest (phone-passcode-level, like most app data) — the biometric gate
// protects the KEYS, i.e. the ability to decrypt new ciphertext and write.
// While this pref is any window (not "Never"), the silent device-key copy is
// deleted (lib/e2ee applyAppLockPolicy), so the relock below really does
// require Face ID to come back — cold starts included.
export function useAppLock(enabled: boolean) {
  const { prefs } = usePrivacyPrefs();
  const backgroundedAt = useRef<number | null>(null);
  const minutes = prefs.appLockMinutes;

  useEffect(() => {
    if (!enabled || minutes < 0) return;
    const sub = AppState.addEventListener('change', async (s: AppStateStatus) => {
      if (s !== 'active') {
        // 'inactive' fires for the app switcher and control center too; only
        // start the clock once (first departure from active).
        if (backgroundedAt.current == null) backgroundedAt.current = Date.now();
        return;
      }
      const away = backgroundedAt.current == null ? 0 : Date.now() - backgroundedAt.current;
      backgroundedAt.current = null;
      if (!isUnlocked()) return; // already locked — nothing to drop
      if (away < minutes * 60_000) return;
      lock();
      // One automatic Face ID attempt so the common case is a single glance,
      // not a trip to the unlock screen. Cancel/failure just stays locked.
      try {
        if (await unlockFromDeviceCache()) await ensureHouseholdKey();
      } catch { /* stay locked */ }
    });
    return () => sub.remove();
  }, [enabled, minutes]);
}
