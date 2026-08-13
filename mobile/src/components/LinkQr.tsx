// Signal-parity F4 — renders the device-link payload as a QR code.
//
// react-native-qrcode-svg (+ react-native-svg) is a native-linked dep: until the
// next dev-client/EAS rebuild links react-native-svg, the module may be
// unavailable, so it's required lazily and degrades to a message (same pattern as
// lib/screenSecurity.ts). Nothing secret is in the QR (the ephemeral key is public
// by design), so rendering it is safe.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { colors, spacing, radius } from '../theme';

let QrComponent: any;
function qrModule(): any {
  if (QrComponent !== undefined) return QrComponent;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    QrComponent = require('react-native-qrcode-svg').default;
  } catch {
    QrComponent = null; // not linked yet — rebuild required
  }
  return QrComponent;
}

export default function LinkQr({ value, size = 232 }: { value: string; size?: number }) {
  const Qr = qrModule();
  if (!Qr) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          Update this app to the latest build to show a linking code, or use your recovery code instead.
        </Text>
      </View>
    );
  }
  // A white quiet-zone frame keeps the code scannable on the dark theme.
  return (
    <View style={styles.frame}>
      <Qr value={value} size={size} color="#000000" backgroundColor="#FFFFFF" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignSelf: 'center',
    padding: spacing.md,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.md,
  },
  fallback: {
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackText: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
