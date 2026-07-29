// Recovery code — the dedicated view opened from Privacy & security → Recovery
// methods. Explains what a recovery code is and the crucial fact that it can't
// be shown again (never stored server-side), and lets the user create or
// replace it. Replacing invalidates the previous code, so it's gated behind a
// confirm. The new code itself is surfaced by the app-root RecoveryCodeModal.

import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, ScreenTitle, Card, Button, Badge, Hint } from '../../components/ui';
import { isUnlocked, regenerateRecoveryCode } from '../../lib/e2ee';
import { useRecoveryHealth } from '../../hooks/useRecoveryHealth';
import { colors, spacing } from '../../theme';

export default function RecoveryCodeScreen() {
  const recovery = useRecoveryHealth();
  const unlocked = isUnlocked();
  const hasCode = recovery.recoveryConfirmed;
  const [busy, setBusy] = useState(false);

  async function mint() {
    setBusy(true);
    try {
      // Surfaces the new code via the one-time RecoveryCodeModal (app root); the
      // modal marks recovery set up and refreshes recoveryHealth on completion,
      // so this screen's badge repaints itself. null = locked.
      const code = await regenerateRecoveryCode();
      if (!code) Alert.alert('Locked', 'Unlock your encryption first, then try again.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not create your recovery code.');
    } finally {
      setBusy(false);
    }
  }

  function confirmReplace() {
    Alert.alert(
      'Replace recovery code?',
      'This creates a new code and invalidates your current one. If you saved your old code somewhere (a password manager, on paper), it will stop working.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: mint },
      ],
    );
  }

  return (
    <Screen>
      <ScreenTitle>Recovery code</ScreenTitle>

      {/* Status */}
      <Card style={styles.card}>
        <View style={styles.statusRow}>
          <Ionicons
            name={hasCode ? 'shield-checkmark' : 'warning-outline'}
            size={22}
            color={hasCode ? colors.success : colors.warning}
          />
          <Text style={styles.statusText}>
            {hasCode ? 'You have a recovery code' : 'No recovery code set up'}
          </Text>
          <Badge label={hasCode ? 'Saved' : 'Not set up'} color={hasCode ? colors.success : colors.warning} />
        </View>
      </Card>

      {/* What it is + the can't-be-viewed fact */}
      <Card style={styles.card}>
        <Row icon="key-outline">
          A one-time code that unlocks your encrypted data if you forget your password and lose your other
          sign-in methods. It’s the backstop every account gets.
        </Row>
        <Row icon="eye-off-outline">
          For your security it’s shown only once — when it’s created. We never store it, so it can’t be
          displayed again here, and we can’t recover it for you.
        </Row>
        <Row icon="lock-closed-outline">
          Resetting your password restores sign-in only. Your recovery code is what restores access to your
          encrypted data — keep it somewhere safe.
        </Row>
      </Card>

      {/* Action */}
      {!unlocked ? (
        <Hint>Unlock your encryption (in Privacy &amp; data) to create or replace your recovery code.</Hint>
      ) : hasCode ? (
        <>
          <Button title="Replace recovery code" loading={busy} onPress={confirmReplace} />
          <Hint>You’ll see the new code once. Save it before closing — it replaces your current one.</Hint>
        </>
      ) : (
        <>
          <Button title="Create recovery code" loading={busy} onPress={mint} />
          <Hint>You’ll see it once. Save it somewhere safe before closing.</Hint>
        </>
      )}
    </Screen>
  );
}

function Row({ icon, children }: { icon: React.ComponentProps<typeof Ionicons>['name']; children: React.ReactNode }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={18} color={colors.textMuted} style={styles.infoIcon} />
      <Text style={styles.infoText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: spacing.md },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.text },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6 },
  infoIcon: { marginRight: spacing.sm, marginTop: 1 },
  infoText: { flex: 1, fontSize: 13, color: colors.textMuted, lineHeight: 19 },
});
