// Signal-parity F4 — camera QR scanner for the existing (unlocked) device.
//
// expo-camera is a native-linked dep: until the next dev-client/EAS rebuild links
// it, the module is unavailable, so it's required lazily and degrades to a message
// (same pattern as lib/screenSecurity.ts). Fires `onScan` once per mount for the
// first QR seen; the parent decides what to do with the text.

import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { colors, spacing, radius } from '../theme';
import { Button } from './ui';

let camMod: any;
function cameraModule(): any {
  if (camMod !== undefined) return camMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    camMod = require('expo-camera');
  } catch {
    camMod = null; // not linked yet — rebuild required
  }
  return camMod;
}

export default function QrScanner({ onScan }: { onScan: (data: string) => void }) {
  const mod = cameraModule();
  const [granted, setGranted] = useState<boolean | null>(null);
  const scannedRef = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!mod) return;
      // expo-camera exposes the permission request either as a top-level export or
      // on the (legacy) Camera object depending on the SDK build.
      const request = mod.requestCameraPermissionsAsync || mod.Camera?.requestCameraPermissionsAsync;
      try {
        const res = request ? await request() : { status: 'denied' };
        if (active) setGranted(res?.status === 'granted');
      } catch {
        if (active) setGranted(false);
      }
    })();
    return () => { active = false; };
  }, [mod]);

  if (!mod) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          Update this app to the latest build to scan a linking code.
        </Text>
      </View>
    );
  }
  if (granted === null) {
    return <View style={styles.viewport}><Text style={styles.hint}>Requesting camera…</Text></View>;
  }
  if (!granted) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>Camera access is needed to scan the code.</Text>
        <Button title="Open Settings" variant="ghost" onPress={() => {
          try { require('expo-linking').openSettings(); } catch { /* best-effort */ }
        }} />
      </View>
    );
  }

  const CameraView = mod.CameraView;
  return (
    <View style={styles.viewport}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }: { data: string }) => {
          if (scannedRef.current) return;
          scannedRef.current = true;
          onScan(data);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { color: colors.textMuted },
  fallback: {
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  fallbackText: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
