import React, { useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, AppState, Linking, Platform,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Badge, Button, Card, Hint, SectionTitle, Skeleton, SkeletonRows } from '../../components/ui';
import { isPurchasesConfigured } from '../../lib/purchases';
import { deriveAiPlanState } from '../../lib/planState';
import type { RootStackParamList } from '../../navigation/types';
import { TERMS_URL, PRIVACY_URL } from '../../config';
import { colors, spacing, radius } from '../../theme';
import {
  useCreditsPurchase, useAiPlanPurchase, useCreditLedger,
  describeReset, humanCredits, shortDate, ledgerAmount, LEDGER_LABEL,
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
  scan: 'Photo scans',
  generation: 'Recipe generation',
  manualParse: 'Owner’s manual parsing',
  aiHelper: 'Form assist',
  webSearch: 'Web searches',
};

// The "What things cost" price list: the published per-action prices from
// `status.actionCosts`, singular labels kept consistent with the "By feature
// this week" card's naming. `callPerMinute` renders per-minute; `chat` is
// token-priced (grows with the reply), so it reads "Varies with length"
// instead of a flat number — each reply reports its own credit cost in-thread.
// "Photo scan" covers items-from-photo and recipes-from-photo (receipts are
// plain E2EE attachments, never AI-scanned); "Recipe generation" covers
// generate-from-description and suggest-recipes — nothing generates plans.
// 'Owner’s manual parsing' is the Maintenance manuals AI (find a
// manual online, extract its maintenance tasks) — plain manual uploads are
// free and unmetered.
const COST_LABEL: Record<string, string> = {
  chat: 'Chat message',
  scan: 'Photo scan',
  generation: 'Recipe generation',
  manualParse: 'Owner’s manual parsing',
  aiHelper: 'Form assist',
  callPerMinute: 'Phone call',
};

function costValue(key: string, credits: number): string {
  // Chat is token-priced — its credit cost grows with the conversation length,
  // so there's no single flat number to show (each reply reports its own).
  if (key === 'chat') return 'Varies with length';
  if (key === 'callPerMinute') return `${credits} credits/min`;
  return `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
}

// How many History rows the card shows inline before deferring the rest to the
// full-history screen — a peek, not the whole ledger, so the card can't grow
// without bound.
const HISTORY_PREVIEW = 5;

export default function CreditsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { billing, activation, rows, busyId, buy } = useCreditsPurchase();
  const plan = useAiPlanPurchase();
  const ledger = useCreditLedger();

  // Returning from the native manage-subscriptions sheet must reflect a
  // cancellation or reactivation without an app restart — refetch RC
  // CustomerInfo + billing status on focus and on app foreground.
  const refresh = plan.refresh;
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const data = billing.data;
  if (!data) {
    return (
      <View style={[styles.container, styles.content]}>
        <CreditsSkeleton />
      </View>
    );
  }

  const out = !data.unlimited && data.creditBalance <= 0;
  const low = !data.unlimited && !out && data.lowBalance;
  const reset = describeReset(data.resetsAt);
  // "Where your credits go": credits SPENT per feature this week, biggest first
  // — the summary of what the balance went to, so the History card can stay a
  // clean purchase/grant log (usage debits are aggregated here, not listed there).
  const spending = Object.entries(data.spend ?? {})
    .filter(([, credits]) => Number(credits) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a));
  const spentTotal = spending.reduce((sum, [, c]) => sum + Number(c), 0);
  // History is purchases & grants only — the server excludes usage debits (they
  // live in the spend card); the filter is defensive belt-and-suspenders. The
  // card shows only the most recent few, with a "See all" drill-in to the rest.
  const grants = (ledger.data ?? []).filter((e) => e.kind !== 'usage');
  const grantsPreview = grants.slice(0, HISTORY_PREVIEW);
  const hasMoreGrants = grants.length > HISTORY_PREVIEW;

  const aiPlan = data.aiPlan;
  // Localized store price when RC has loaded; USD catalog fallback otherwise.
  const planPrice = plan.pkg ? plan.pkg.product.priceString : `$${(aiPlan?.price ?? 4.99).toFixed(2)}`;
  // Value framing vs the packs, computed from the catalog (never hard-coded):
  // whether the plan's credits-per-dollar actually beats the best pack's — used
  // to pick the framing copy (we assert the advantage, not a specific %).
  const bestPackRate = Math.max(0, ...(data.packs ?? []).map((p) => (p.price > 0 ? p.credits / p.price : 0)));
  const planRate = aiPlan && aiPlan.price > 0 ? aiPlan.monthlyCredits / aiPlan.price : 0;
  const planBonus = bestPackRate > 0 ? Math.round((planRate / bestPackRate - 1) * 100) : 0;
  // Fold the server's active/inactive base with the RC entitlement's will-renew
  // intent into one of three display states (renewing / cancelled / inactive).
  const planView = deriveAiPlanState(aiPlan, plan.entitlement);
  const planDate = shortDate(planView.expiresAt);
  // iOS-only: no Play Store product exists yet, and Apple owns the manage sheet.
  const canManage = Platform.OS === 'ios';

  // The rate card. Chat pins FIRST — it's the headline action and now
  // token-priced ("Varies with length"), so sorting it by its nominal number
  // would be misleading. The per-minute call row pins LAST — its unit differs
  // from the per-action rows and the per-second billing note is its footnote.
  // Everything between ascends by the live server price (a hard-coded order
  // would go stale when actionCosts is re-tuned), ties alphabetical by label.
  const costRank = (k: string) => (k === 'chat' ? -1 : k === 'callPerMinute' ? 1 : 0);
  const costs = Object.entries(data.actionCosts ?? {})
    .filter(([key, credits]) => key === 'chat' || Number(credits) > 0)
    .sort(([a, av], [b, bv]) => {
      const ra = costRank(a);
      const rb = costRank(b);
      if (ra !== rb) return ra - rb;
      return Number(av) - Number(bv) || (COST_LABEL[a] ?? a).localeCompare(COST_LABEL[b] ?? b);
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
            {planView.state === 'renewing' ? (
              <Badge label="Active" color={colors.success} />
            ) : planView.state === 'cancelled' ? (
              <Badge label="Cancelled" color={colors.warning} />
            ) : (
              <Badge label="Best rate" color={colors.primary} />
            )}
          </View>
          {planView.state === 'renewing' ? (
            <>
              <Text style={styles.planDesc}>
                Renews with {humanCredits(aiPlan.monthlyCredits)} credits
                {planDate ? ` on ${planDate}` : ' each month'}.
              </Text>
              <Text style={styles.planNote}>
                Plan credits go straight to your balance and never expire — even if you
                cancel.
              </Text>
              {canManage ? (
                <Button title="Manage subscription" variant="ghost" onPress={plan.manage} style={styles.planButton} />
              ) : null}
            </>
          ) : planView.state === 'cancelled' ? (
            <>
              <Text style={styles.planDesc}>
                Cancelled — plan benefits{planDate ? ` until ${planDate}` : ' until the period ends'}.
                Your credits are yours forever.
              </Text>
              {canManage ? (
                <Button title="Manage subscription" variant="ghost" onPress={plan.manage} style={styles.planButton} />
              ) : null}
              <Text style={styles.planNote}>
                Changed your mind? Re-subscribe from the same App Store sheet.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.planDesc}>
                {humanCredits(aiPlan.monthlyCredits)} credits every month
                {planBonus > 0
                  ? ' — more credits per dollar than any pack.'
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

      {/* Where your credits go: credits SPENT per feature this week (a summary,
          not a cap). Answers "what am I spending on?" so the History card below
          stays a clean purchase/grant log. */}
      {spending.length > 0 ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>Where your credits go</Text>
          {reset ? <Text style={styles.reset}>{reset}</Text> : null}
          {spending.map(([action, credits]) => (
            <View key={action} style={styles.actionRow}>
              <Text style={styles.actionLabel}>{ACTION_LABEL[action] ?? action}</Text>
              <Text style={styles.actionCount}>{ledgerAmount(Number(credits))}</Text>
            </View>
          ))}
          <View style={[styles.actionRow, styles.spendTotalRow]}>
            <Text style={styles.spendTotalLabel}>Spent this week</Text>
            <Text style={styles.spendTotalValue}>{ledgerAmount(spentTotal)} credits</Text>
          </View>
        </Card>
      ) : null}

      {/* Purchases & grants only: packs, plan periods, welcome credits, refunds,
          adjustments. Usage debits are summarized in the "Where your credits go"
          card above rather than listed one-by-one here (they'd bury the
          purchases and make this an illegible per-message log). */}
      {grants.length > 0 ? (
        <Card style={styles.card}>
          <Text style={styles.heading}>History</Text>
          {grantsPreview.map((e, i) => (
            <View key={i} style={styles.actionRow}>
              <View style={styles.ledgerText}>
                <Text style={styles.actionLabel}>{LEDGER_LABEL[e.kind] ?? e.kind}</Text>
                <Text style={styles.ledgerDate}>{shortDate(e.createdAt)}</Text>
              </View>
              <Text style={[styles.actionCount, e.credits < 0 && { color: colors.error }]}>
                {e.credits > 0 ? '+' : ''}{ledgerAmount(e.credits)}
              </Text>
            </View>
          ))}
          {hasMoreGrants ? (
            <TouchableOpacity
              style={styles.seeAllRow}
              onPress={() => nav.navigate('CreditHistory')}
              accessibilityRole="button"
            >
              <Text style={styles.seeAllText}>See all history</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </TouchableOpacity>
          ) : null}
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

// A shimmering placeholder in the shape of the screen the billing status is
// about to fill — the balance hero (big number + caption), the pack-store
// tiles, then a price-list card. Built from the shared Skeleton pulse (same
// one the recipe-import skeleton uses).
function CreditsSkeleton() {
  return (
    <View>
      <Card style={styles.card}>
        <Skeleton width={96} height={13} />
        <Skeleton width={'42%'} height={34} style={styles.skelGap} />
        <Skeleton width={'86%'} height={12} style={styles.skelGap} />
        <Skeleton width={'58%'} height={12} style={styles.skelGapSm} />
      </Card>
      <Card style={styles.card}>
        <Skeleton width={88} height={16} />
        <View style={styles.skelTiles}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={96} radius={radius.md} style={styles.skelTile} />
          ))}
        </View>
      </Card>
      <Card style={styles.card}>
        <Skeleton width={110} height={13} />
        <SkeletonRows count={4} style={styles.skelGapSm} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
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
  planButton: { marginTop: spacing.sm },

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

  // "See all history" footer row on the History card — a hairline-topped tap
  // target that drills into the full-history screen.
  seeAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    marginTop: 4,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  seeAllText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  // The spend card's total, set off from the per-feature rows by a hairline.
  spendTotalRow: {
    marginTop: 4,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  spendTotalLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  spendTotalValue: { fontSize: 14, fontWeight: '700', color: colors.text },

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

  // CreditsSkeleton shapes — the tile row mirrors PackStore's `tiles` metrics.
  skelGap: { marginTop: spacing.sm },
  skelGapSm: { marginTop: 6 },
  skelTiles: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  skelTile: { flex: 1 },
});
