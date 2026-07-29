import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card } from '../../components/ui';
import { isPurchasesConfigured } from '../../lib/purchases';
import type { RootStackParamList } from '../../navigation/types';
import { colors, spacing } from '../../theme';
import { useCreditsPurchase, humanCredits } from './shared';
import PackStore from './PackStore';

// Focused conversion sheet the AI-surface nudges open when credits run low or
// out: the pack cards and one job — top up and get back to it. The full picture
// (history, usage, preferences) stays on the Credits screen.
export default function BuyCreditsSheet() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'BuyCredits'>>();
  const reason = route.params?.reason ?? 'low';

  const { billing, activation, rows, busyId, buy } = useCreditsPurchase();
  const loaded = Boolean(billing.data);

  if (!loaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const title = reason === 'out' ? "You're out of AI credits" : "You're running low on AI credits";
  const subtitle =
    reason === 'out'
      ? 'A credit pack lifts the wall right away — the AI assistants and phone calls pick up where you left off.'
      : `You have ${humanCredits(billing.data?.creditBalance)} credits left. Top up now so the assistants don't stop mid-task.`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>

      {activation.state === 'active' ? (
        <Card style={[styles.card, styles.successCard]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.successText}>
            Credits added — back to what you were doing.
          </Text>
        </Card>
      ) : (
        <Card style={styles.card}>
          <PackStore
            rows={rows}
            busyId={busyId}
            buy={buy}
            activating={activation.state === 'activating'}
          />
          {!isPurchasesConfigured() ? (
            <Text style={styles.note}>
              Purchases aren't available in this build. Manage credits from Profile → AI credits.
            </Text>
          ) : null}
        </Card>
      )}
      {activation.state === 'timeout' ? (
        <Text style={styles.timeoutNote}>Payment received — your credits will appear shortly.</Text>
      ) : null}

      {activation.state === 'active' ? (
        <Button title="Done" onPress={() => nav.goBack()} />
      ) : (
        <Button title="Manage credits" variant="ghost" onPress={() => nav.replace('Credits')} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  subtitle: { fontSize: 14, color: colors.textMuted, lineHeight: 20, marginBottom: spacing.md },
  card: { marginBottom: spacing.md },

  note: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: spacing.md },

  successCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderColor: colors.success + '66',
    backgroundColor: colors.success + '14',
  },
  successText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  timeoutNote: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginBottom: spacing.md },
});
