import React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card } from '../../components/ui';
import { ASSISTANT_NAME } from '../../config';
import { colors, spacing, radius } from '../../theme';

// First-run orientation. A new user lands here once (RootNavigator gate, before
// the paywall and the app) so the empty calendar isn't their first impression —
// it names what Calen is beyond a calendar and points at where the extra
// calendars live. Dismiss is one-way: "Get started" flips the onboarding flag
// (lib/onboarding.ts) and the gate re-renders into the app. Spec: onboarding.md.

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; title: string; text: string }[] = [
  { icon: 'calendar', title: 'A shared calendar', text: 'Everyone in your household sees the same events, in one place.' },
  { icon: 'restaurant', title: 'Meals & groceries', text: 'Plan dinners and build the shopping list from them.' },
  { icon: 'construct', title: 'Home & chores', text: 'Track upkeep, repairs, and who does what around the house.' },
  { icon: 'airplane', title: 'Trips', text: 'Keep itineraries together and split expenses with everyone coming along.' },
  { icon: 'people', title: 'Contacts', text: 'Family, friends, and the pros you call — with the dates that matter.' },
  { icon: 'sparkles', title: `${ASSISTANT_NAME}, your assistant`, text: 'Plans, schedules, scans photos — even makes calls for you.' },
];

export default function OnboardingScreen({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.appName}>Welcome to Calen</Text>
        <Text style={styles.tagline}>
          More than a calendar — one private place to run your household.
        </Text>
      </View>

      <Card style={styles.card}>
        {FEATURES.map((f) => (
          <View key={f.title} style={styles.featureRow}>
            <View style={styles.iconDisc}>
              <Ionicons name={f.icon} size={18} color={colors.primary} />
            </View>
            <View style={styles.featureBody}>
              <Text style={styles.featureTitle}>{f.title}</Text>
              <Text style={styles.featureText}>{f.text}</Text>
            </View>
          </View>
        ))}
      </Card>

      <View style={styles.hintRow}>
        <Ionicons name="apps-outline" size={16} color={colors.textMuted} />
        <Text style={styles.hintText}>
          Find Meals, Trips, Chores and more under <Text style={styles.hintStrong}>Calendars</Text>,
          at the top of your calendar.
        </Text>
      </View>

      <View style={styles.privacyRow}>
        <Ionicons name="lock-closed" size={16} color={colors.success} />
        <Text style={styles.privacyText}>
          Everything is end-to-end encrypted — only your household can read it.
        </Text>
      </View>

      <Button title="Get started" onPress={onGetStarted} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingTop: spacing.xl * 2, paddingBottom: spacing.xl },
  hero: { alignItems: 'center', marginBottom: spacing.lg },
  appName: { fontSize: 30, fontWeight: '800', color: colors.text },
  tagline: { fontSize: 15, color: colors.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 21 },
  card: { marginBottom: spacing.lg },

  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm },
  iconDisc: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.primary + '1F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureBody: { flex: 1 },
  featureTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  featureText: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 2 },

  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.md },
  hintText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  hintStrong: { color: colors.text, fontWeight: '700' },

  privacyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.lg },
  privacyText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
});
