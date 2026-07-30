import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { billingApi, type CreditLedgerEntry } from '../../api';
import { Badge, Button, Card, Hint, SectionTitle } from '../../components/ui';
import { isPurchasesConfigured } from '../../lib/purchases';
import { TERMS_URL, PRIVACY_URL } from '../../config';
import { colors, spacing, radius } from '../../theme';
import {
  useCreditsPurchase, useAiPlanPurchase, describeReset, humanCredits, shortDate,
} from './shared';
import PackStore from './PackStore';

// The Credits screen: prepaid AI-credit balance, the optional monthly Calen AI
// plan, the credit-pack store, the flat per-action price list, the ledger
// history, and this week's per-feature usage. The AI on/off and personal-info
// toggles live on Profile → Privacy & data (PrivacyDataScreen). Credits are
// spent by AI features and assistant phone calls alike; the plan is never
// required — its credits are ordinary balance and every feature works the same
// without it. Purchase CTAs live here, so Restore-adjacent legal links do too
// (App Review; the subscription CTA additionally carries price + renewal
// wording).

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
  plan: 'Monthly plan credits',
  refund: 'Refund',
  admin: 'Adjustment',
  usage: 'AI usage', // fallback — usage rows normally label by their action
};

// Usage-debit ledger rows labeled by the action that spent the credits.
const USAGE_LABEL: Record<string, string> = {
  chat: 'Chat',
  call: 'Phone call',
  scan: 'Photo scan',
  generation: 'Generation',
  manualParse: 'Import parsing',
  aiHelper: 'Form assist',
};

// The "What things cost" price list: the flat published per-action prices from
// `status.actionCosts`, singular labels kept consistent with the "By feature
// this week" card's naming. `callPerMinute` renders per-minute.
const COST_LABEL: Record<string, string> = {
  chat: 'Chat message',
  scan: 'Receipt & photo scan',
  generation: 'Recipe & plan generation',
  manualParse: 'Import & parsing',
  aiHelper: 'Form assist',
  callPerMinute: 'Phone call',
};
const COST_ORDER = ['chat', 'scan', 'generation', 'manualParse', 'aiHelper', 'callPerMinute'];

function costValue(key: string, credits: number): string {
  if (key === 'callPerMinute') return `${credits} credits/min`;
  return `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
}

// Ledger amounts keep grant styling (+N, whole credits) but a prorated usage
// debit can be fractional — show one decimal instead of flooring it away.
function ledgerAmount(n: number): string {
  return Number.isInteger(n) ? Math.floor(n).toLocaleString() : n.toFixed(1);
}

export default function CreditsScreen() {
  const { billing, activation, rows, busyId, buy } = useCreditsPurchase();
  const plan = useAiPlanPurchase();
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

  const aiPlan = data.aiPlan;
  // Localized store price when RC has loaded; USD catalog fallback otherwise.
  const planPrice = plan.pkg ? plan.pkg.product.priceString : `$${(aiPlan?.price ?? 4.99).toFixed(2)}`;
  // Value framing vs the packs, computed from the catalog (never hard-coded):
  // the plan's credits-per-dollar over the best pack's, as a whole-% bonus.
  const bestPackRate = Math.max(0, ...(data.packs ?? []).map((p) => (p.price > 0 ? p.credits / p.price : 0)));
  const planRate = aiPlan && aiPlan.price > 0 ? aiPlan.monthlyCredits / aiPlan.price : 0;
  const planBonus = bestPackRate > 0 ? Math.round((planRate / bestPackRate - 1) * 100) : 0;
  const renewDate = shortDate(aiPlan?.expiresAt);

  // Flat per-action prices in a stable display order (known actions first).
  const costs = Object.entries(data.actionCosts ?? {})
    .filter(([, credits]) => Number(credits) > 0)
    .sort(([a], [b]) => {
      const ia = COST_ORDER.indexOf(a);
      const ib = COST_ORDER.indexOf(b);
      return (ia < 0 ? COST_ORDER.length : ia) - (ib < 0 ? COST_ORDER.length : ib);
    });

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

      {/* Calen AI plan purchase status (same webhook-gap doctrine as packs:
          activating spinner, success, reassuring timeout). */}
      {plan.activation.state === 'activating' ? (
        <Card style={[styles.card, styles.activationCard]}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.activationText}>Activating your plan…</Text>
        </Card>
      ) : null}
      {plan.activation.state === 'active' ? (
        <Card style={[styles.card, styles.successCard]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.successText}>
            Calen AI plan active — your monthly credits have been added.
          </Text>
        </Card>
      ) : null}
      {plan.activation.state === 'timeout' ? (
        <Card style={[styles.card, styles.activationCard]}>
          <Ionicons name="time-outline" size={20} color={colors.warning} />
          <Text style={styles.activationText}>
            Payment received — your plan will activate shortly.
          </Text>
        </Card>
      ) : null}

      {/* The optional monthly Calen AI plan. Never required — packs stay the
          non-subscriber path and plan credits are ordinary balance (they never
          expire, even after cancelling). Hidden for exempt admins, like the
          store. */}
      {!data.unlimited && aiPlan ? (
        <Card style={styles.card}>
          <View style={styles.planHeader}>
            <Text style={styles.planLabel}>Calen AI plan</Text>
            {aiPlan.active ? (
              <Badge label="Active" color={colors.success} />
            ) : (
              <Badge label="Best rate" color={colors.primary} />
            )}
          </View>
          {aiPlan.active ? (
            <>
              <Text style={styles.planDesc}>
                Renews with {humanCredits(aiPlan.monthlyCredits)} credits
                {renewDate ? ` on ${renewDate}` : ' each month'}.
              </Text>
              <Text style={styles.planNote}>
                Plan credits go straight to your balance and never expire — even if you
                cancel. Manage or cancel anytime in Settings.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.planDesc}>
                {humanCredits(aiPlan.monthlyCredits)} credits every month
                {planBonus > 0
                  ? ` — ${planBonus}% more credits per dollar than any pack.`
                  : ' — the best per-credit rate.'}
              </Text>
              <Button
                title={`Subscribe for ${planPrice}/month`}
                loading={plan.busy || plan.activation.state === 'activating'}
                disabled={!plan.pkg}
                onPress={plan.buy}
              />
              <Text style={styles.planNote}>
                {planPrice}/month, renews monthly, cancel anytime in Settings. Credits
                you receive never expire.
              </Text>
            </>
          )}
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

      {/* The flat published per-action prices — spend is predictable before it
          happens. These are exactly what the debits charge. */}
      {costs.length > 0 ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>What things cost</Text>
          {costs.map(([key, credits]) => (
            <View key={key} style={styles.actionRow}>
              <Text style={styles.actionLabel}>{COST_LABEL[key] ?? key}</Text>
              <Text style={styles.actionCount}>{costValue(key, Number(credits))}</Text>
            </View>
          ))}
          <Text style={styles.costNote}>
            Phone calls are billed by the second, so a short call costs less than a
            full minute.
          </Text>
        </Card>
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

      {/* Every balance movement from the credit ledger: grants (packs, plan
          periods, welcome credits, adjustments) AND usage debits, each usage
          row labeled by the action that spent the credits. */}
      {(ledger.data?.length ?? 0) > 0 ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>History</Text>
          {ledger.data!.map((e, i) => (
            <View key={i} style={styles.actionRow}>
              <View style={styles.ledgerText}>
                <Text style={styles.actionLabel}>
                  {e.kind === 'usage' && e.action
                    ? USAGE_LABEL[e.action] ?? e.action
                    : LEDGER_LABEL[e.kind] ?? e.kind}
                </Text>
                <Text style={styles.ledgerDate}>{shortDate(e.createdAt)}</Text>
              </View>
              <Text style={[styles.actionCount, e.credits < 0 && { color: colors.error }]}>
                {e.credits > 0 ? '+' : ''}{ledgerAmount(e.credits)}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* AI on/off and personal-info toggles live on Profile → Privacy & data
          (they're privacy choices, not purchases) — see PrivacyDataScreen. */}

      {/* Restore sits with the subscription CTA (App Review): it re-attaches an
          active Calen AI plan bought under this store account. */}
      {isPurchasesConfigured() && !data.unlimited ? (
        <View style={{ marginTop: spacing.sm }}>
          <Button title="Restore purchases" variant="ghost" onPress={plan.restore} />
        </View>
      ) : null}

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

  // Calen AI plan card (header/label sizing mirrors the Add-ons bundle card).
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planLabel: { fontSize: 17, fontWeight: '700', color: colors.text, flexShrink: 1 },
  planDesc: { color: colors.text, fontSize: 14, lineHeight: 19, marginTop: 6, marginBottom: spacing.sm },
  planNote: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },

  costNote: { fontSize: 12, color: colors.textMuted, marginTop: 6, lineHeight: 16 },

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
