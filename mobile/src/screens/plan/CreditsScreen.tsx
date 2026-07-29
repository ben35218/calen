import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { billingApi, type CreditLedgerEntry } from '../../api';
import { Badge, Card, Hint, SectionTitle } from '../../components/ui';
import { isPurchasesConfigured } from '../../lib/purchases';
import { TERMS_URL, PRIVACY_URL } from '../../config';
import { colors, spacing, radius } from '../../theme';
import { useCreditsPurchase, describeReset, humanCredits, shortDate } from './shared';
import PackStore from './PackStore';

// The Credits screen: prepaid AI-credit balance, the credit-pack store, the
// purchase/grant history, and this week's per-feature usage. The AI on/off and
// personal-info toggles live on Profile → Privacy & data (PrivacyDataScreen).
// Credits are spent by AI features and assistant phone calls alike;
// there is no subscription and no weekly cap — the balance is the budget.
// Purchase CTAs live here, so Restore-adjacent legal links do too (App Review).

// Friendly labels for the per-action analytics counters the server tracks.
// Calls are their own feature (assistant phone calls), kept separate from chat.
const ACTION_LABEL: Record<string, string> = {
  chat: 'Chat & assistants',
  call: 'Assistant calls',
  scan: 'Receipt & photo scans',
  generation: 'Recipe & plan generation',
  manualParse: 'Imports & parsing',
  aiHelper: 'Form assist',
};

const LEDGER_LABEL: Record<CreditLedgerEntry['kind'], string> = {
  purchase: 'Credit pack',
  starter: 'Welcome credits',
  refund: 'Refund',
  admin: 'Adjustment',
};

export default function CreditsScreen() {
  const { billing, activation, rows, busyId, buy } = useCreditsPurchase();
  const ledger = useQuery({
    queryKey: ['billing', 'ledger'],
    queryFn: async () => (await billingApi.ledger()).data.entries,
    staleTime: 60_000,
  });

  const data = billing.data;
  if (!data) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const out = !data.unlimited && data.creditBalance <= 0;
  const low = !data.unlimited && !out && data.lowBalance;
  const reset = describeReset(data.resetsAt);
  const actions = Object.entries(data.usage ?? {}).filter(([, count]) => Number(count) > 0);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Balance hero. Exempt admin accounts read "Unlimited" (their balance is
          not enforced); refunds can drive the raw balance negative — display
          floors at 0 with an arrears note. */}
      <Card style={styles.card}>
        <Text style={styles.heading}>Your AI credits</Text>
        <View style={styles.balanceRow}>
          <Text style={styles.balance}>
            {data.unlimited ? 'Unlimited' : humanCredits(data.creditBalance)}
          </Text>
          {!data.unlimited ? <Text style={styles.balanceCaption}>credits</Text> : null}
          {low ? <Badge label="Running low" color={colors.warning} /> : null}
          {out ? <Badge label="Out of credits" color={colors.error} /> : null}
        </View>
        {data.creditBalance < 0 ? (
          <Text style={styles.arrearsNote}>
            A refund left this account below zero — new credits top up the difference first.
          </Text>
        ) : null}
        <Text style={styles.scopeNote}>
          Credits pay for AI features and the phone calls Calen places for you. Buy a pack
          below whenever you run low.
        </Text>
      </Card>

      {activation.state === 'activating' ? (
        <Card style={[styles.card, styles.activationCard]}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.activationText}>Adding your credits…</Text>
        </Card>
      ) : null}
      {activation.state === 'active' ? (
        <Card style={[styles.card, styles.successCard]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.successText}>Credits added — you're all set.</Text>
        </Card>
      ) : null}
      {activation.state === 'timeout' ? (
        <Card style={[styles.card, styles.activationCard]}>
          <Ionicons name="time-outline" size={20} color={colors.warning} />
          <Text style={styles.activationText}>
            Payment received — your credits will appear shortly.
          </Text>
        </Card>
      ) : null}

      {/* The pack store (select-then-confirm tiles; see PackStore). */}
      {!data.unlimited ? (
        <>
          <Card style={styles.card}>
            <SectionTitle style={{ marginTop: 0 }}>Buy credits</SectionTitle>
            <PackStore rows={rows} busyId={busyId} buy={buy} />
          </Card>
          {__DEV__ && !isPurchasesConfigured() ? (
            <Hint style={styles.devNote}>
              In-app purchases aren't configured in this build. Set the RevenueCat keys and
              run a dev/production build — purchases don't work in Expo Go.
            </Hint>
          ) : null}
        </>
      ) : null}

      {/* This week's per-feature usage (analytics, not a cap). */}
      {actions.length > 0 ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>By feature this week</Text>
          {reset ? <Text style={styles.reset}>{reset}</Text> : null}
          {actions.map(([action, count]) => (
            <View key={action} style={styles.actionRow}>
              <Text style={styles.actionLabel}>{ACTION_LABEL[action] ?? action}</Text>
              <Text style={styles.actionCount}>{count}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Purchase/grant history from the credit ledger (usage isn't itemized —
          the balance reflects it). */}
      {(ledger.data?.length ?? 0) > 0 ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>History</Text>
          {ledger.data!.map((e, i) => (
            <View key={i} style={styles.actionRow}>
              <View style={styles.ledgerText}>
                <Text style={styles.actionLabel}>{LEDGER_LABEL[e.kind] ?? e.kind}</Text>
                <Text style={styles.ledgerDate}>{shortDate(e.createdAt)}</Text>
              </View>
              <Text style={[styles.actionCount, e.credits < 0 && { color: colors.error }]}>
                {e.credits > 0 ? '+' : ''}{Math.floor(e.credits).toLocaleString()}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* AI on/off and personal-info toggles live on Profile → Privacy & data
          (they're privacy choices, not purchases) — see PrivacyDataScreen. */}

      <View style={styles.legalRow}>
        <Text style={styles.legalLink} onPress={() => Linking.openURL(TERMS_URL)}>
          Terms of Use
        </Text>
        <Text style={styles.legalDot}>·</Text>
        <Text style={styles.legalLink} onPress={() => Linking.openURL(PRIVACY_URL)}>
          Privacy Policy
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  card: { marginBottom: spacing.md },

  heading: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 2 },
  reset: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: 4 },
  balance: { fontSize: 34, fontWeight: '700', color: colors.text },
  balanceCaption: { fontSize: 14, color: colors.textMuted },
  arrearsNote: { fontSize: 12, color: colors.error, marginTop: 6, lineHeight: 16 },
  scopeNote: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 17 },

  activationCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  activationText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  successCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderColor: colors.success + '66',
    backgroundColor: colors.success + '14',
  },
  successText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },

  devNote: { marginTop: -spacing.sm, marginBottom: spacing.md },

  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  actionLabel: { fontSize: 14, color: colors.text },
  actionCount: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  ledgerText: { flex: 1, marginRight: spacing.sm },
  ledgerDate: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

  cardNote: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm, lineHeight: 18 },

  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  legalLink: { color: colors.primary, fontSize: 12, textDecorationLine: 'underline' },
  legalDot: { color: colors.textMuted, fontSize: 12 },
});
