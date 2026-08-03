import { useEffect, useState } from 'react';
import { isUnlocked, subscribeLockState } from '../lib/e2ee';

// Whether this SESSION currently holds the identity keypair — i.e. can decrypt
// anything at all. Flips to false the moment any unlock path succeeds (password,
// passkey, biometric device cache, recovery code, re-key).
//
// Deliberately distinct from `useE2eeLocked`, which answers a different
// question: "is MY OWN household encrypted-at-rest and shut?" That one gates on
// `Household.e2eeActive` and fires a household query, which is exactly wrong for
// a free viewer — their own household is empty and may not be active, while the
// thing they can't read belongs to someone else. Asking it here would report
// "not locked" for a viewer staring at a calendar full of ciphertext.
//
// Reactive rather than a render-time `getKeyPair()` read: a snapshot taken
// during render never updates, so an unlock elsewhere in the app would leave
// this stale until something unrelated re-rendered.
export function useSessionLocked(): boolean {
  const [locked, setLocked] = useState(() => !isUnlocked());
  useEffect(() => {
    const sync = () => setLocked(!isUnlocked());
    sync(); // catch an unlock landing between first render and subscribe
    return subscribeLockState(sync);
  }, []);
  return locked;
}
