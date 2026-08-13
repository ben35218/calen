import React from 'react';
import { View, ScrollView, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { Text } from '../../components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { isPurchasesConfigured } from '../../lib/purchases';
import { ASSISTANT_NAME, TERMS_URL, PRIVACY_URL } from '../../config';
import { colors, spacing } from '../../theme';
import { useUnlockPurchase } from './shared';

// The hard paywall: a signed-in user without the one-time $4.99 app unlock
// lands here (RootNavigator gate) and can't reach the app until they buy or
// restore it. Per-USER — each household member unlocks with their own Apple ID.
// Restore + legal links live next to the CTA (App Review 5.2.5). Once the
// webhook lands, the activation poll flips the unlock cache and the gate
// re-renders into the app.

// Vertical room reserved above the hero for a floating back button (44pt tap
// target + breathing room). Present in both mounts so neither drifts.
const BACK_BUTTON_BAND = 56;

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  { icon: 'calendar', text: 'The shared family calendar — events, chores, groceries and more in one place' },
  { icon: 'sparkles', text: `${ASSISTANT_NAME}, your AI assistant — plans meals, schedules, scans photos, even makes phone calls` },
  { icon: 'people', text: 'Your whole household, together — everyone sees the same calendar' },
  { icon: 'lock-closed', text: 'End-to-end encrypted — your family’s life stays yours' },
];

export default function UnlockPaywallScreen() {
  const { logout } = useAuth();
  const insets = useSafeAreaInsets();
  const { billing, activation, pkg, busy, buy, restore } = useUnlockPurchase();

  const price = pkg?.product.priceString ?? `$${(billing.data?.unlockPrice ?? 4.99).toFixed(2)}`;
  const activating = activation.state === 'activating';

  return (
    // This screen mounts two ways and must look the same in both: bare from the
    // RootNavigator gate (no header at all), and pushed from the viewer shell
    // under a transparent, title-less header. So the top inset is computed here
    // rather than inherited — `never` opts out of iOS's automatic adjustment so
    // the two mounts can't drift — and reserves the back button's band, which
    // the pushed instance floats over the hero's left.
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={[styles.content, { paddingTop: insets.top + BACK_BUTTON_BAND }]}
    >
      <View style={styles.hero}>
        <Text style={styles.appName}>Calen</Text>
        <Text style={styles.tagline}>Your household, organized.</Text>
      </View>

      <Card style={styles.card}>
        {FEATURES.map((f) => (
          <View key={f.text} style={styles.featureRow}>
            <Ionicons name={f.icon} size={20} color={colors.primary} />
            <Text style={styles.featureText}>{f.text}</Text>
          </View>
        ))}
      </Card>

      {activation.state === 'active' ? (
        <Card style={[styles.card, styles.successCard]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.successText}>Unlocked — welcome in!</Text>
        </Card>
      ) : (
        <>
          {/* One filled control on the screen, carrying the price ONCE. The
              terms sit under it as micro-copy (where App Review expects the
              disclosure — adjacent to the CTA), not as a second price line
              above it. */}
          <Button
            title={activating ? 'Unlocking…' : `Unlock Calen — ${price}`}
            loading={busy || activating}
            disabled={!pkg}
            onPress={buy}
          />
          <Text style={styles.terms}>
            One-time purchase, per contact · tied to your account, not a subscription
          </Text>
          {activation.state === 'timeout' ? (
            <Text style={styles.timeoutNote}>Payment received — unlocking shortly.</Text>
          ) : null}
          {!pkg && isPurchasesConfigured() ? (
            <View style={styles.storeLoading}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.storeLoadingText}>Loading the store…</Text>
            </View>
          ) : null}
        </>
      )}

      {/* Utilities, not offers: Restore joins the legal links as a text link.
          It stays discoverable (App Review 3.1.1 / 5.2.5) without competing
          with the CTA the way a bordered button did. */}
      <View style={styles.linkRow}>
        {activation.state === 'active' ? null : (
          <>
            <Text style={styles.link} accessibilityRole="button" onPress={restore}>
              Restore purchase
            </Text>
            <Text style={styles.linkDot}>·</Text>
          </>
        )}
        <Text style={styles.link} accessibilityRole="link" onPress={() => Linking.openURL(TERMS_URL)}>
          Terms of Use
        </Text>
        <Text style={styles.linkDot}>·</Text>
        <Text style={styles.link} accessibilityRole="link" onPress={() => Linking.openURL(PRIVACY_URL)}>
          Privacy Policy
        </Text>
      </View>

      <Text style={styles.disclosure}>
        AI features use prepaid credits, sold separately — you start with some on the house.
      </Text>

      <Text style={styles.signOutLink} accessibilityRole="button" onPress={() => void logout()}>
        Sign out
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // paddingTop is supplied at render (safe area + the back-button band).
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  hero: { alignItems: 'center', marginBottom: spacing.lg },
  appName: { fontSize: 34, fontWeight: '800', color: colors.text },
  tagline: { fontSize: 15, color: colors.textMuted, marginTop: 4 },
  card: { marginBottom: spacing.lg },

  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm },
  featureText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },

  // The CTA's own fine print: quiet, close to the button, said once.
  terms: {
    textAlign: 'center', color: colors.textMuted, fontSize: 13, lineHeight: 18,
    marginTop: spacing.sm, paddingHorizontal: spacing.sm,
  },
  timeoutNote: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  storeLoading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.sm },
  storeLoadingText: { color: colors.textMuted, fontSize: 13 },

  successCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderColor: colors.success + '66',
    backgroundColor: colors.success + '14',
  },
  successText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },

  disclosure: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
  // Restore + legal, one row of text links. `paddingVertical` is the tap
  // target — a 13px Text alone is too small to hit comfortably.
  linkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  link: { color: colors.primary, fontSize: 13, paddingVertical: 8 },
  linkDot: { color: colors.textMuted, fontSize: 13 },
  // The escape hatch, not an offer: quiet text, generous tap target.
  signOutLink: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: spacing.xl,
    paddingVertical: spacing.sm,
  },
});
