import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { colors, spacing, radius } from '../theme';

// A safety/security code shown for out-of-band comparison in the
// approve-on-device flow — the fingerprint of an identity key, formatted as
// dashed 4-char groups (e.g. "PADN-VXAS-D6H9-…"). Rendering it as inline text
// let a group break across a line ("PRB0-\nG83F"), which is hard to read aloud
// and to compare. Instead we lay the groups out as a centered, monospace grid
// that wraps by WHOLE groups and never splits one, with a one-tap copy — the
// same code-display pattern as the recovery-code modal, adapted for a longer,
// dash-grouped code. Shared by both sides of the flow (the joiner reads their
// own code; the approver compares it), so the two always look identical.
export function SecurityCode({ code, copyable = true }: { code: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const groups = code.split('-').filter(Boolean);

  async function copy() {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.box}>
        {groups.map((g, i) => (
          <Text key={i} style={styles.group} selectable allowFontScaling={false}>
            {g}
          </Text>
        ))}
      </View>
      {copyable ? (
        <Pressable onPress={copy} style={styles.copyBtn} hitSlop={8}>
          <Ionicons
            name={copied ? 'checkmark-circle' : 'copy-outline'}
            size={15}
            color={copied ? colors.success : colors.primary}
          />
          <Text style={[styles.copyText, copied ? { color: colors.success } : null]}>
            {copied ? 'Copied' : 'Copy code'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Platform monospace so every group's glyphs align in a clean grid.
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm, gap: spacing.xs },
  box: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  group: {
    fontFamily: MONO,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 2,
    color: colors.text,
  },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', paddingVertical: spacing.xs },
  copyText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
});
