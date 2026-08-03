import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ASSISTANT_NAME } from '../../config';
import { colors, spacing, radius } from '../../theme';

// Free viewer mode's standing offer (billing-plans.md). It lives on the BOTTOM
// EDGE of every screen in the shell: out of the navigation layer, in the thumb
// zone, and stating what you get and what it costs rather than asking a riddle.
// A promo in the top-left slot — the platform's back/identity affordance — gets
// mis-tapped, and a promo shaped like nav chrome stops being seen at all.
//
// Shared by the calendar home and the restore-access screen so the offer is one
// component in one place: a viewer who lands on restore-access first (their key
// no longer opens the shared events) still sees the same offer in the same spot,
// and neither copy nor geometry can drift between the two.

// The banner's footprint, so a screen can pad its content clear of it and float
// its own chrome (Today, hint notes) just above.
export const BANNER_H = 76;

export default function ViewerUpgradeBanner({ onPress }: { onPress: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <TouchableOpacity
      style={[styles.banner, { bottom: insets.bottom + 12 }]}
      activeOpacity={0.85}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Unlock Calen"
    >
      <View style={styles.bannerIcon}>
        <Ionicons name="lock-open-outline" size={18} color={colors.primary} />
      </View>
      <View style={styles.bannerCopy}>
        <Text style={styles.bannerTitle} numberOfLines={1}>Unlock Calen</Text>
        <Text style={styles.bannerSub} numberOfLines={2}>
          Your own calendar, {ASSISTANT_NAME} the AI assistant, and household sharing.
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute', left: spacing.md, right: spacing.md, zIndex: 15,
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    minHeight: BANNER_H - 12,
    paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md,
    borderRadius: radius.lg, backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  bannerIcon: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary + '22',
  },
  bannerCopy: { flex: 1, gap: 1 },
  bannerTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  bannerSub: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
});
