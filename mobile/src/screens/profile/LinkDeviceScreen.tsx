// Signal-parity F4 — QR device linking screen (both roles).
//
//   mode 'show'  → the NEW device (signed in, vault locked): shows a QR carrying a
//                  one-shot ephemeral public key and polls until an existing device
//                  hands over the keys. No password/recovery code needed here.
//   mode 'scan'  → an existing UNLOCKED device: scans the QR, confirms the
//                  fingerprint, and seals the account's identity keypair to it.
//
// The server only ferries opaque ciphertext (server/src/routes/keys.js); the
// handshake + trust model live in lib/deviceLink.ts. See docs/SIGNAL-PARITY-PLAN §F4.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Text } from '../../components/Text';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import * as Device from 'expo-device';
import { Screen, Button, ScreenTitle, Hint, FormError, CenteredLoader } from '../../components/ui';
import LinkQr from '../../components/LinkQr';
import QrScanner from '../../components/QrScanner';
import { colors, spacing, radius } from '../../theme';
import { startLink, pollLink, parseLinkQr, fingerprintOf, completeLink } from '../../lib/deviceLink';
import type { RootStackParamList } from '../../navigation/types';

export default function LinkDeviceScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'LinkDevice'>>();
  const mode = route.params?.mode ?? 'show';
  return mode === 'scan' ? <ScanMode /> : <ShowMode />;
}

// ── New device: show the QR and wait for the handoff ────────────────────────
function ShowMode() {
  const navigation = useNavigation<any>();
  const [state, setState] = useState<'starting' | 'waiting' | 'linked' | 'expired' | 'error'>('starting');
  const [qr, setQr] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [error, setError] = useState('');
  const linkIdRef = useRef<string | null>(null);

  const begin = useCallback(async () => {
    setState('starting');
    setError('');
    try {
      const deviceName = Device.deviceName || Device.modelName || undefined;
      const started = await startLink(deviceName);
      linkIdRef.current = started.linkId;
      setQr(started.qr);
      setFingerprint(started.fingerprint);
      setState('waiting');
    } catch (e: any) {
      setError(e?.message || 'Could not start linking.');
      setState('error');
    }
  }, []);

  useEffect(() => { begin(); }, [begin]);

  // Poll while waiting.
  useEffect(() => {
    if (state !== 'waiting' || !linkIdRef.current) return;
    let active = true;
    const tick = async () => {
      if (!active || !linkIdRef.current) return;
      try {
        const r = await pollLink(linkIdRef.current);
        if (!active) return;
        if (r === 'linked') { setState('linked'); return; }
        if (r === 'expired') { setState('expired'); return; }
      } catch { /* keep polling */ }
    };
    const timer = setInterval(tick, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [state]);

  // On success, bounce back — the unlock state has flipped and the destination
  // (Account/Privacy) re-reads it on focus.
  useEffect(() => {
    if (state !== 'linked') return;
    const t = setTimeout(() => navigation.goBack(), 1400);
    return () => clearTimeout(t);
  }, [state, navigation]);

  return (
    <Screen>
      <ScreenTitle>Set up from another device</ScreenTitle>
      <Hint>
        On a device that’s already signed in and unlocked, open Privacy & security → Devices → “Link another
        device” and scan this code.
      </Hint>

      {state === 'starting' ? (
        <CenteredLoader />
      ) : null}

      {state === 'waiting' && qr ? (
        <View style={styles.center}>
          <LinkQr value={qr} />
          <View style={styles.fpBox}>
            <Text style={styles.fpLabel}>Verify this code matches on both devices</Text>
            <Text style={styles.fp}>{fingerprint}</Text>
          </View>
          <View style={styles.rowCenter}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.waiting}>Waiting for your other device…</Text>
          </View>
          <Text style={styles.expiryNote}>This code expires in a few minutes.</Text>
        </View>
      ) : null}

      {state === 'linked' ? (
        <View style={styles.center}>
          <Text style={styles.success}>This device is now set up. Your data is unlocked here.</Text>
        </View>
      ) : null}

      {state === 'expired' ? (
        <View style={styles.center}>
          <Text style={styles.muted}>That code expired before it was scanned.</Text>
          <Button title="Show a new code" onPress={begin} />
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

// ── Existing device: scan a code and hand over the keys ─────────────────────
function ScanMode() {
  const navigation = useNavigation<any>();
  const [scannerKey, setScannerKey] = useState(0); // bump to reset the one-shot scanner
  const [scanned, setScanned] = useState<{ linkId: string; epk: string; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onScan = useCallback(async (data: string) => {
    const parsed = parseLinkQr(data);
    if (!parsed) {
      Alert.alert('Not a linking code', 'That QR code isn’t a device-link code. Try again.', [
        { text: 'OK', onPress: () => setScannerKey((k) => k + 1) },
      ]);
      return;
    }
    const fingerprint = await fingerprintOf(parsed.epk);
    setScanned({ ...parsed, fingerprint });
  }, []);

  const confirm = useCallback(async () => {
    if (!scanned) return;
    setBusy(true);
    setError('');
    try {
      await completeLink(scanned.linkId, scanned.epk);
      Alert.alert(
        'Device linked',
        'Your other device now has your encryption keys. If you didn’t start this, remove it in Security and rotate your keys.',
        [{ text: 'Done', onPress: () => navigation.goBack() }],
      );
    } catch (e: any) {
      setError(e?.message || 'Could not link that device.');
    } finally {
      setBusy(false);
    }
  }, [scanned, navigation]);

  return (
    <Screen>
      <ScreenTitle>Link another device</ScreenTitle>
      <Hint>
        Scan the code shown on the other device (Privacy & security → “Have another device? Set this one up from
        it”). It will receive your encryption keys.
      </Hint>

      {!scanned ? (
        <QrScanner key={scannerKey} onScan={onScan} />
      ) : (
        <View style={styles.center}>
          <View style={styles.fpBox}>
            <Text style={styles.fpLabel}>Confirm this matches the code on the other device</Text>
            <Text style={styles.fp}>{scanned.fingerprint}</Text>
          </View>
          {error ? <FormError>{error}</FormError> : null}
          <Button title="Link this device" onPress={confirm} loading={busy} />
          <Button
            title="Scan a different code"
            variant="ghost"
            onPress={() => { setScanned(null); setError(''); setScannerKey((k) => k + 1); }}
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  waiting: { color: colors.textMuted },
  expiryNote: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted, textAlign: 'center' },
  success: { color: colors.primary, textAlign: 'center', fontSize: 16, fontWeight: '600', lineHeight: 22 },
  fpBox: {
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'stretch',
  },
  fpLabel: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  fp: { color: colors.text, fontSize: 18, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'] },
});
