// One-time recovery-code modal, shown right after first-time E2EE enrollment.
// The code is a high-entropy fallback that can unlock the account's encrypted
// data if the password/passkey is lost. It is NEVER stored server-side — lose
// every factor and the data is unrecoverable by design (no server escrow). The
// re-entry gate is deliberate friction. Mirrors the web RecoveryCodeDialog.
//
// Single-purpose: capture the recovery code. Adding a passkey is a separate,
// optional durability step handled in Privacy & security → Recovery methods (the
// recovery-health card nudges password accounts there) — the modal no longer
// pushes it inline, so a password signup isn't nagged to set up a passkey right
// after choosing not to use one.

import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, ScrollView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { colors, spacing, radius } from '../theme';
import { Button } from './ui';
import {
  subscribeRecoveryCode,
  getPendingRecoveryCode,
  clearRecoveryCode,
  markRecoverySetup,
  ensureHouseholdKey,
  subscribeE2eeActivated,
} from '../lib/e2ee';

export default function RecoveryCodeModal() {
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState<string | null>(getPendingRecoveryCode());
  // Require the user to re-enter the code before continuing. A self-attested "I
  // saved it" checkbox is too easy to click through, and under mandatory E2EE a
  // lost code + no passkey = permanently unrecoverable data. Re-entry proves the
  // code was actually captured (typed or pasted from wherever they stored it).
  const [confirmInput, setConfirmInput] = useState('');
  const [copied, setCopied] = useState(false);
  const norm = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
  const confirmed = !!code && norm(confirmInput) === norm(code);

  useEffect(() => subscribeRecoveryCode(() => {
    setCode(getPendingRecoveryCode());
    setConfirmInput('');
  }), []);

  // Refetch the household's encryption status whenever born-encrypted activation
  // lands (register→recovery, leave-household, on-unlock). This modal is always
  // mounted at the app root, so it's a stable home for the subscription; without
  // it the Encryption card keeps showing the stale pre-activation "Not encrypted
  // yet" it fetched before the background drop committed.
  useEffect(() => subscribeE2eeActivated(() => {
    qc.invalidateQueries({ queryKey: ['household'] });
  }), [qc]);

  async function copy() {
    if (!code) return;
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Paste from the clipboard into the confirm field so the user doesn't have to
  // retype the 25-char code by hand (e.g. after copying it into a password
  // manager). The normalized equality check below still gates "Continue".
  async function paste() {
    const text = await Clipboard.getStringAsync();
    if (text) setConfirmInput(text.trim());
  }

  function close() {
    setConfirmInput('');
    clearRecoveryCode();
  }

  // Repaint any open recovery-health guard (e.g. the Account view) once the code
  // is saved. The health query is keyed globally, so invalidating it here is what
  // makes the screen behind the modal reflect the just-saved code — otherwise it
  // keeps showing the stale pre-setup "Set up recovery" state.
  function refreshRecoveryState() {
    qc.invalidateQueries({ queryKey: ['recoveryHealth'] });
    qc.invalidateQueries({ queryKey: ['passkeyFactor'] });
  }

  // Saving the code satisfies the recovery mandate (a non-password unlock
  // factor). Now that a durable recovery factor is confirmed, the born-encrypted
  // drop is permitted — nudge it along (ensureHouseholdKey funnels into the
  // activation) instead of waiting for the next unlock — then close.
  function afterCode() {
    markRecoverySetup()
      .then(() => ensureHouseholdKey().catch(() => {}))
      .then(refreshRecoveryState)
      .catch(() => {});
    close();
  }

  return (
    <Modal visible={!!code} transparent animationType="fade" onRequestClose={() => {}}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.card}>
            <Text style={styles.title}>Save your recovery code</Text>
            <Text style={styles.body}>
              Your data is end-to-end encrypted. This one-time code is the only way to
              regain access if you lose your password and other sign-in methods.{' '}
              <Text style={styles.bold}>We can’t recover it for you.</Text>
            </Text>

            <View style={styles.codeBox}>
              <Text style={styles.code} selectable>{code}</Text>
            </View>

            <Pressable onPress={copy} style={styles.copyBtn}>
              <Text style={styles.copyText}>{copied ? 'Copied ✓' : 'Copy code'}</Text>
            </Pressable>

            <Text style={styles.note}>
              Resetting your password restores sign-in only — it does not by itself
              decrypt old data. Keep this code.
            </Text>

            <Text style={styles.confirmLabel}>Re-enter your recovery code to confirm you’ve saved it</Text>
            <View style={styles.confirmRow}>
              <TextInput
                style={[styles.confirmInput, styles.confirmInputFlex]}
                value={confirmInput}
                onChangeText={setConfirmInput}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                placeholder="Enter the code above"
                placeholderTextColor={colors.textMuted}
              />
              <Pressable onPress={paste} style={styles.pasteBtn} hitSlop={8}>
                <Text style={styles.pasteText}>Paste</Text>
              </Pressable>
            </View>

            <Button title="Continue" onPress={afterCode} disabled={!confirmed} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  // flexGrow + center keeps the card vertically centered when it fits, but lets
  // it scroll (rather than clip top/bottom) on a small screen or with the
  // keyboard up.
  scrollContent: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  // A single `gap` spaces every child; children below deliberately carry no
  // extra top/vertical margins so the card stays compact enough to fit a small
  // screen (e.g. iPhone SE) without the user having to scroll to reach Continue.
  // Font sizes / line-heights are deliberately trimmed for the same reason.
  card: {
    width: '100%', maxWidth: 420, backgroundColor: colors.surface,
    borderRadius: radius.lg, paddingVertical: spacing.md, paddingHorizontal: spacing.lg,
    gap: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  title: { color: colors.text, fontSize: 19, fontWeight: '700' },
  body: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  bold: { color: colors.text, fontWeight: '700' },
  codeBox: {
    backgroundColor: colors.background, borderRadius: radius.md,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
    alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  code: { color: colors.text, fontSize: 18, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  copyBtn: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  copyText: { color: colors.primary, fontWeight: '600' },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  confirmLabel: { color: colors.text, fontSize: 13 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  confirmInput: {
    backgroundColor: colors.background, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, color: colors.text, fontSize: 16, letterSpacing: 2,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  confirmInputFlex: { flex: 1 },
  pasteBtn: {
    backgroundColor: colors.background, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  pasteText: { color: colors.primary, fontWeight: '600', fontSize: 15 },
});
