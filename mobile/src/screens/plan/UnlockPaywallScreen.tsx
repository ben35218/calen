import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Linking } from 'react-native';
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

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  { icon: 'calendar', text: 'The shared family calendar — events, chores, groceries and more in one place' },
  { icon: 'sparkles', text: `${ASSISTANT_NAME}, your AI assistant — plans meals, schedules, scans receipts, even makes phone calls` },
  { icon: 'people', text: 'Your whole household, together — everyone sees the same calendar' },
  { icon: 'lock-closed', text: 'End-to-end encrypted — your family’s life stays yours' },
];

export default function UnlockPaywallScreen() {
  const { logout } = useAuth();
  const { billing, activation, pkg, busy, buy, restore } = useUnlockPurchase();

  const price = pkg?.product.priceString ?? `$${(billing.data?.unlockPrice ?? 4.99).toFixed(2)}`;
  const activating = activation.state === 'activating';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
          <Text style={styles.priceLine}>
            One-time purchase · <Text style={styles.price}>{price}</Text> per person
          </Text>
          <Button
            title={activating ? 'Unlocking…' : `Unlock Calen — ${price}`}
            loading={busy || activating}
            disabled={!pkg}
            onPress={buy}
          />
          {activation.state === 'timeout' ? (
            <Text style={styles.timeoutNote}>Payment received — unlocking shortly.</Text>
          ) : null}
          {!pkg && isPurchasesConfigured() ? (
            <View style={styles.storeLoading}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.storeLoadingText}>Loading the store…</Text>
            </View>
          ) : null}
          <Button title="Restore purchase" variant="ghost" onPress={restore} />
        </>
      )}

      <Text style={styles.disclosure}>
        The unlock is a one-time purchase tied to your account. AI features use prepaid
        credits, sold separately — you start with some on the house.
      </Text>
      <View style={styles.legalRow}>
        <Text style={styles.legalLink} onPress={() => Linking.openURL(TERMS_URL)}>
          Terms of Use
        </Text>
        <Text style={styles.legalDot}>·</Text>
        <Text style={styles.legalLink} onPress={() => Linking.openURL(PRIVACY_URL)}>
          Privacy Policy
        </Text>
      </View>

      <View style={styles.signOut}>
        <Button title="Sign out" variant="ghost" onPress={() => void logout()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingTop: spacing.xl * 2, paddingBottom: spacing.xl },
  hero: { alignItems: 'center', marginBottom: spacing.lg },
  appName: { fontSize: 34, fontWeight: '800', color: colors.text },
  tagline: { fontSize: 15, color: colors.textMuted, marginTop: 4 },
  card: { marginBottom: spacing.lg },

  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm },
  featureText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },

  priceLine: { textAlign: 'center', color: colors.textMuted, fontSize: 13, marginBottom: spacing.sm },
  price: { color: colors.text, fontWeight: '700' },
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
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  legalLink: { color: colors.primary, fontSize: 12, textDecorationLine: 'underline' },
  legalDot: { color: colors.textMuted, fontSize: 12 },
  signOut: { marginTop: spacing.lg },
});
