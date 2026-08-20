import { useEffect } from 'react';
import { Alert } from 'react-native';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { householdApi, keysApi, type StoredKeyMaterial } from '../api';
import { addPasskeyFactor, currentUserId, isUnlocked } from '../lib/e2ee';
import { passkeysSupported } from '../lib/passkeys';
import {
  type SecurityNudgeInput,
  interruptionThisLaunch,
  markNudgePrompted,
  noteInterruption,
  nudgeAlertContent,
  pickSecurityNudge,
  recordAppOpen,
} from '../lib/securityNudges';
import type { RootStackParamList } from '../navigation/types';

// The one-time security-posture pop-ups (spec: features/notifications.md —
// Security nudges; feature behavior in auth-identity.md and
// guardian-recovery.md). Mounted once in RootNavigator beside useInviteAlerts,
// same full-app-shell gate. On an app open — never foreground bounces — it
// counts the open, and from the second open on raises at most ONE nudge this
// device has never prompted: the passkey-adoption prompt for password-only
// accounts, else the guardian-recovery discovery prompt once the household has
// a second member. Eligibility/priority/wording/memory live in
// lib/securityNudges; everything here fails soft to "no nudge".

// Let the invitation pop-up (checked at mount in useInviteAlerts) win the open
// when both have something to say — its gather is a network round trip, so the
// nudge waits a beat before asking whether an alert already presented.
const CHECK_DELAY_MS = 3500;

// One check per launch, however often the effect re-arms (the enabled gate
// flips during bootstrap/unlock without the app having "re-opened").
let checkedThisLaunch = false;
export function resetSecurityNudgeLaunchForTest(): void {
  checkedThisLaunch = false;
}

export function useSecurityNudges(
  navRef: NavigationContainerRefWithCurrent<RootStackParamList>,
  enabled: boolean,
) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled || checkedThisLaunch) return;

    const addPasskeyNow = async () => {
      // The ceremony wraps the private key, so a locked vault can't finish it —
      // land on Privacy & Security, where the unlock UI and passkey row live.
      if (!isUnlocked()) {
        if (navRef.isReady()) navRef.navigate('PrivacyData', { focus: 'recovery' });
        return;
      }
      try {
        const ok = await addPasskeyFactor();
        if (ok) {
          qc.invalidateQueries({ queryKey: ['passkeyFactor'] });
          qc.invalidateQueries({ queryKey: ['recoveryHealth'] });
          Alert.alert(
            'Passkey added',
            'Face ID / Touch ID can now sign you in and unlock your encrypted data on this device.',
          );
        }
      } catch (e: any) {
        // TestFlight/beta builds lack the associated-domains entitlement
        // passkeys need, so the ceremony fails there every time — say so.
        Alert.alert(
          'Could not add passkey',
          (e?.message || 'Please try again.') +
            '\n\nOn TestFlight and beta builds, passkeys aren’t available yet — you can add one from Privacy & Security after the App Store release.',
        );
      }
    };

    const present = (kind: 'passkey' | 'guardian') => {
      // A security nudge is itself an interruption — the discovery nudge
      // (checked after this one) sits the open out when we present.
      noteInterruption();
      const { title, message } = nudgeAlertContent(kind);
      if (kind === 'passkey') {
        Alert.alert(title, message, [
          { text: 'Add Passkey', onPress: () => void addPasskeyNow() },
          { text: 'Not Now', style: 'cancel' },
        ]);
        return;
      }
      Alert.alert(title, message, [
        {
          text: 'Set Up',
          onPress: () => {
            if (navRef.isReady()) navRef.navigate('GuardianRecovery', { mode: 'setup' });
          },
        },
        { text: 'Not Now', style: 'cancel' },
      ]);
    };

    const check = async () => {
      try {
        const me = currentUserId();
        if (!me) return;
        const mem = await recordAppOpen(me);
        if (mem.opens < 2) return; // first run belongs to the recovery-code ceremony
        const material = (await keysApi.me()).data as StoredKeyMaterial;
        const factors = (material.wrappedPrivateKey || []) as Array<{ factor?: string }>;
        const input: SecurityNudgeInput = {
          opens: mem.opens,
          prompted: mem.prompted,
          enrolled: !!material.enrolled,
          recoveryConfirmed: !!material.recoverySetupAt,
          hasPasskey: factors.some((f) => f.factor === 'passkey'),
          passkeySupported: passkeysSupported(),
          // Pessimistic until fetched — only reached for when the passkey nudge
          // can't fire, so most opens cost no extra requests.
          guardianArmed: true,
          otherMembers: 0,
        };
        if (pickSecurityNudge(input) !== 'passkey' && !mem.prompted.includes('guardian')) {
          const [status, hh] = await Promise.all([
            keysApi.guardianStatus().then((r) => r.data),
            householdApi.get().then((r) => r.data),
          ]);
          input.guardianArmed = !!status.armed;
          input.otherMembers = (hh.members ?? []).filter((m) => m._id !== me).length;
        }
        const kind = pickSecurityNudge(input);
        if (!kind) return;
        // An invitation alert took this open — the nudge is NOT marked
        // prompted, so it returns on a later, quieter open.
        if (interruptionThisLaunch()) return;
        await markNudgePrompted(me, kind);
        present(kind);
      } catch {
        // Best-effort surface — Privacy & Security still carries both setups.
      }
    };

    const timer = setTimeout(() => {
      if (checkedThisLaunch) return;
      checkedThisLaunch = true;
      void check();
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, navRef, qc]);
}
