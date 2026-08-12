// Seed the signed-in user's "You" Contact at app boot — and the instant the key
// unlocks — so every contact-assignment UI has at least the user to pick,
// decoupled from ever opening the Contacts screen. Mounted once in RootNavigator.
//
// ensureSelfContact guards on e2eeActive + a held key, so this no-ops while locked
// or on a not-yet-encrypted household; we re-attempt on lock-state changes so the
// seed lands as soon as an email-code/passkey session unlocks.

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { isUnlocked, subscribeLockState } from '../lib/e2ee';
import { ensureSelfContact } from '../lib/selfContact';

export function useSelfContactSeed(enabled: boolean) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [unlocked, setUnlocked] = useState(isUnlocked());
  const refresh = useCallback(() => setUnlocked(isUnlocked()), []);
  useEffect(() => subscribeLockState(refresh), [refresh]);

  useEffect(() => {
    if (!enabled || !unlocked || !user) return;
    ensureSelfContact(user).then((created) => {
      if (created) qc.invalidateQueries({ queryKey: ['contacts'] });
    });
  }, [enabled, unlocked, user, qc]);
}
