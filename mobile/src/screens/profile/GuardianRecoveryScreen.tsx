// Guardian recovery, dual-control (specs/features/guardian-recovery.md).
//
//   mode 'setup'   → arm/replace/remove a household member as a recovery guardian
//                    (needs the vault unlocked); sets a 4-digit PIN.
//   mode 'recover' → the locked user asks their guardian to approve, then enters
//                    the PIN to get back in.
//   mode 'approve' → the guardian reviews pending requests and hands over the
//                    (still PIN-locked) key.
//
// All key material is sealed client-side; the server blind-relays. See lib/guardianRecovery.ts.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Alert, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { householdApi, keysApi, type GuardianRequest } from '../../api';
import { useAuth } from '../../store/auth';
import {
  Screen, ScreenTitle, Hint, Button, Input, FormError, CenteredLoader, Card, SectionTitle,
} from '../../components/ui';
import {
  armGuardian, disarmGuardian, startGuardianRecovery, resumeGuardianRecovery, pollGuardianRecovery,
  finishGuardianRecovery, approveGuardianRecovery,
} from '../../lib/guardianRecovery';
import { colors, spacing, radius } from '../../theme';
import type { RootStackParamList } from '../../navigation/types';

// Reject the PINs an attacker guesses first. The 4-digit space is small by
// design (trusted-guardian model), so at least block the obvious ones.
function isTrivialPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true; // 0000, 1111…
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return true; // 1234, 4321…
  return false;
}

export default function GuardianRecoveryScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'GuardianRecovery'>>();
  const mode = route.params?.mode ?? 'setup';
  if (mode === 'recover') return <RecoverMode />;
  if (mode === 'approve') return <ApproveMode />;
  return <SetupMode />;
}

// ── Setup: arm / replace / remove a guardian ────────────────────────────────
function SetupMode() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const statusQ = useQuery({ queryKey: ['guardianStatus'], queryFn: async () => (await keysApi.guardianStatus()).data });
  const householdQ = useQuery({ queryKey: ['household'], queryFn: async () => (await householdApi.get()).data });
  const members = (householdQ.data?.members ?? []).filter((m) => m._id !== user?._id);

  async function arm() {
    if (!selected) { setError('Choose a household member first.'); return; }
    if (isTrivialPin(pin)) { setError('Pick a less obvious 4-digit PIN (not 0000, 1234, repeated or sequential).'); return; }
    if (pin !== confirm) { setError('The PINs don’t match.'); return; }
    setBusy(true); setError('');
    try {
      await armGuardian(selected, pin);
      statusQ.refetch();
      Alert.alert(
        'Guardian set up',
        'This member can now help you recover your account — but only together with your PIN. Keep your PIN somewhere safe; without it, they can’t recover your data.',
        [{ text: 'Done', onPress: () => navigation.goBack() }],
      );
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not set up your guardian.');
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    Alert.alert('Remove guardian?', 'This member will no longer be able to help you recover your account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try { await disarmGuardian(); statusQ.refetch(); } catch (e: any) {
            Alert.alert('Could not remove', e?.response?.data?.error || 'Please try again.');
          }
        },
      },
    ]);
  }

  if (statusQ.isLoading || householdQ.isLoading) return <CenteredLoader />;

  if (statusQ.data?.armed) {
    return (
      <Screen>
        <ScreenTitle>Recovery guardian</ScreenTitle>
        <Card style={styles.card}>
          <View style={styles.rowCenter}>
            <Ionicons name="people-circle-outline" size={22} color={colors.success} />
            <Text style={styles.guardianName}>{statusQ.data.guardianName || 'A household member'}</Text>
          </View>
          <Text style={styles.note}>
            Can help you recover your account — but only with your 4-digit PIN. They can’t read your data on
            their own.
          </Text>
        </Card>
        <Button title="Remove guardian" variant="danger" onPress={remove} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenTitle>Set up a recovery guardian</ScreenTitle>
      <Hint>
        Pick a household member you trust. If you ever lose your password, passkey and recovery code, they can
        help you back in — but only together with a 4-digit PIN you set here. Only pick someone you’d trust to
        see your data.
      </Hint>

      <SectionTitle>Choose a member</SectionTitle>
      <Card style={styles.card}>
        {members.length === 0 ? (
          <Text style={styles.note}>You have no other household members yet.</Text>
        ) : members.map((m) => {
          const on = selected === m._id;
          const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || 'Member';
          return (
            <TouchableOpacity key={m._id} style={styles.memberRow} onPress={() => setSelected(m._id)} activeOpacity={0.7}>
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? colors.primary : colors.textMuted} />
              <Text style={styles.memberName}>{name}</Text>
            </TouchableOpacity>
          );
        })}
      </Card>

      <SectionTitle>Set a 4-digit PIN</SectionTitle>
      <Hint>You’ll enter this to finish a recovery. It’s not stored anywhere — if you forget it, this method can’t recover you.</Hint>
      <Input label="PIN" value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} />
      <Input label="Confirm PIN" value={confirm} onChangeText={(v) => setConfirm(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} />
      {error ? <FormError>{error}</FormError> : null}
      <Button title="Set up guardian" onPress={arm} loading={busy} disabled={!selected || pin.length !== 4 || confirm.length !== 4} />
    </Screen>
  );
}

// ── Recover: locked user requests + finishes with the PIN ───────────────────
function RecoverMode() {
  const navigation = useNavigation<any>();
  const [state, setState] = useState<'starting' | 'waiting' | 'ready' | 'expired' | 'error'>('starting');
  const [fingerprint, setFingerprint] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef<string | null>(null);

  const begin = useCallback(async () => {
    setState('starting'); setError('');
    try {
      // Resume a persisted in-flight request first — the guardian may have
      // approved while this screen was gone (app killed, or the shared-device
      // flow where the user signs out so the guardian can sign in). Starting
      // fresh here would orphan that approval: only the persisted ephemeral
      // key can open it. A resumed request the server no longer knows
      // (expired unapproved) falls through to a fresh start.
      const resumed = await resumeGuardianRecovery();
      if (resumed) {
        const status = await pollGuardianRecovery(resumed.requestId);
        if (status !== 'expired') {
          requestIdRef.current = resumed.requestId;
          setFingerprint(resumed.fingerprint);
          setState(status === 'ready' ? 'ready' : 'waiting');
          return;
        }
      }
      const r = await startGuardianRecovery();
      requestIdRef.current = r.requestId;
      setFingerprint(r.fingerprint);
      setState('waiting');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not start recovery.');
      setState('error');
    }
  }, []);
  useEffect(() => { begin(); }, [begin]);

  useEffect(() => {
    if (state !== 'waiting' || !requestIdRef.current) return;
    let active = true;
    const timer = setInterval(async () => {
      if (!active || !requestIdRef.current) return;
      try {
        const r = await pollGuardianRecovery(requestIdRef.current);
        if (!active) return;
        if (r === 'ready') setState('ready');
        if (r === 'expired') setState('expired');
      } catch { /* keep polling */ }
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [state]);

  async function finish() {
    setBusy(true); setError('');
    try {
      const ok = await finishGuardianRecovery(pin);
      if (ok) {
        Alert.alert('Recovered', 'Your data is unlocked on this device. Set up a new password and recovery code in Privacy & security.', [
          { text: 'Done', onPress: () => navigation.goBack() },
        ]);
      } else {
        setError('That PIN didn’t work. Try again.');
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not finish recovery.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScreenTitle>Recover with a household member</ScreenTitle>
      {state === 'starting' ? <CenteredLoader /> : null}

      {state === 'waiting' ? (
        <View style={styles.center}>
          <Hint>Ask your guardian to open Privacy & security and approve your request. Confirm this code matches on their screen:</Hint>
          <View style={styles.fpBox}>
            <Text style={styles.fp}>{fingerprint}</Text>
          </View>
          <View style={styles.rowCenter}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.waiting}>Waiting for approval…</Text>
          </View>
          <Text style={styles.expiryNote}>This request expires in about 30 minutes.</Text>
        </View>
      ) : null}

      {state === 'ready' ? (
        <View>
          <Hint>Approved. Enter your 4-digit recovery PIN to unlock your data on this device.</Hint>
          <Input label="Recovery PIN" value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} />
          {error ? <FormError>{error}</FormError> : null}
          <Button title="Unlock my data" onPress={finish} loading={busy} disabled={pin.length !== 4} />
        </View>
      ) : null}

      {state === 'expired' ? (
        <View style={styles.center}>
          <Text style={styles.muted}>That request expired before it was approved.</Text>
          <Button title="Try again" onPress={begin} />
        </View>
      ) : null}

      {state === 'error' ? (
        <View style={styles.center}>
          <FormError>{error}</FormError>
          <Button title="Try again" onPress={begin} />
        </View>
      ) : null}
    </Screen>
  );
}

// ── Approve: the guardian hands over the (PIN-locked) key ────────────────────
function ApproveMode() {
  const navigation = useNavigation<any>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['guardianRequests'], queryFn: async () => (await keysApi.guardianRequests()).data.requests, refetchInterval: 5000 });

  function approve(request: GuardianRequest) {
    Alert.alert(
      `Help ${request.requesterName} recover?`,
      `Confirm this code matches the one on their screen before approving:\n\n${request.fingerprint}\n\nYou'll hand over their key, still locked by their PIN — you won't be able to read their data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve', onPress: async () => {
            setBusyId(request.requestId);
            try {
              await approveGuardianRecovery(request);
              await q.refetch();
              Alert.alert('Approved', `${request.requesterName} can now finish with their PIN.`);
            } catch (e: any) {
              Alert.alert('Could not approve', e?.response?.data?.error || e?.message || 'Please try again.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  }

  if (q.isLoading) return <CenteredLoader />;

  return (
    <Screen>
      <ScreenTitle>Recovery requests</ScreenTitle>
      <Hint>Household members you’re a guardian for appear here when they ask for help getting back in.</Hint>
      {(q.data ?? []).length === 0 ? (
        <Card style={styles.card}><Text style={styles.note}>No pending requests.</Text></Card>
      ) : (q.data ?? []).map((r) => (
        <Card key={r.requestId} style={styles.card}>
          <View style={styles.rowCenter}>
            <Ionicons name="person-circle-outline" size={22} color={colors.primary} />
            <Text style={styles.guardianName}>{r.requesterName}</Text>
          </View>
          <Text style={styles.note}>
            They’re locked out of their account and asked for your help getting back in. Before you
            approve, talk to them in person or by phone and make sure the request is really theirs —
            you’ll be shown a security code to compare.
          </Text>
          <Button
            title="Review & approve"
            loading={busyId === r.requestId}
            onPress={() => approve(r)}
            style={styles.approveButton}
          />
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: spacing.md },
  center: { alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  note: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 18 },
  approveButton: { marginTop: spacing.md },
  guardianName: { fontSize: 16, fontWeight: '700', color: colors.text },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10 },
  memberName: { fontSize: 15, color: colors.text },
  waiting: { color: colors.textMuted },
  expiryNote: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted, textAlign: 'center' },
  fpBox: {
    alignItems: 'center', padding: spacing.md, backgroundColor: colors.surface,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignSelf: 'stretch',
  },
  fp: { color: colors.text, fontSize: 18, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'] },
});
