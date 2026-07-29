import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { RouteProp } from '@react-navigation/native';
import { useRoute } from '@react-navigation/native';
import type { PurchasesPackage } from 'react-native-purchases';
import { Badge, Button, Card, IconAvatar, SectionHeader } from '../../components/ui';
import { isPurchasesConfigured } from '../../lib/purchases';
import { useCalendarColors } from '../../lib/calendarPrefs';
import {
  ADDON_CALENDAR_IDS,
  PAID_ADDON_CALENDAR_IDS,
  FREE_ADDON_CALENDAR_IDS,
  type AddonId,
} from '../../lib/addons';
import { billingApi } from '../../api';
import { TERMS_URL, PRIVACY_URL } from '../../config';
import { colors, spacing } from '../../theme';
import { useAddonPurchase } from './shared';
import type { RootStackParamList } from '../../navigation/types';

// The "Add-ons" store: the paid feature calendars (Meals, Maintenance, Trips)
// as one-time household-wide purchases plus the all-in bundle, and the FREE
// opt-in calendars (Birthdays, Chores) claimed here at no charge — included
// with the app but never default-added. Never titled "App Store" (App Review
// 5.2.5). Apple requires the restore button and legal links near the purchase
// CTAs, so they live here.

const ADDON_ICONS: Record<AddonId, string> = {
  recipes: 'silverware-fork-knife',
  maintenance: 'wrench',
  trips: 'airplane',
  birthdays: 'calendar-heart',
  chores: 'broom',
};

export default function AddOnsScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'AddOns'>>();
  const focus = route.params?.focus;
  const { billing, activation, packagesByAddon, busyId, buy, restore } = useAddonPurchase();
  const { colors: calColors } = useCalendarColors();
  const [claimBusy, setClaimBusy] = useState<string | null>(null);

  const owned = new Set(billing.data?.addons ?? []);
  const ownedPaid = PAID_ADDON_CALENDAR_IDS.filter((id) => owned.has(id));
  const catalog = billing.data?.addonCatalog;
  const allOwned = ADDON_CALENDAR_IDS.every((id) => owned.has(id));
  const bundlePkg = packagesByAddon.bundle ?? null;

  // Store price when the package loaded; USD catalog price as the fallback.
  const priceLabel = (pkg: PurchasesPackage | null | undefined, fallback: number | undefined) =>
    pkg ? pkg.product.priceString : `$${(fallback ?? 2.99).toFixed(2)}`;

  // Free add-ons skip the store entirely: one authenticated call flips the
  // household ledger, and the billing refetch re-mirrors the owned cache.
  async function claim(key: AddonId) {
    setClaimBusy(key);
    try {
      await billingApi.claimAddon(key);
      await billing.refetch();
    } catch (e: any) {
      Alert.alert('Could not add', e?.response?.data?.error || 'Please try again.');
    } finally {
      setClaimBusy(null);
    }
  }

  const renderAddonCard = (key: AddonId, free: boolean) => {
    const item = catalog?.items.find((i) => i.key === key);
    const pkg = packagesByAddon[key] ?? null;
    const accent = calColors[key] ?? colors.primary;
    const isOwned = owned.has(key);
    return (
      <Card key={key} style={[styles.addonCard, focus === key && { borderColor: accent }]}>
        <View style={styles.addonRow}>
          <IconAvatar mdiIcon={ADDON_ICONS[key]} bg={accent} />
          <View style={styles.addonText}>
            <Text style={styles.addonLabel}>{item?.label ?? key}</Text>
            {item?.description ? <Text style={styles.addonDesc}>{item.description}</Text> : null}
          </View>
          {isOwned ? (
            <Ionicons
              name="checkmark-circle"
              size={24}
              color={colors.success}
              accessibilityLabel={free ? 'Added' : 'Purchased'}
            />
          ) : null}
        </View>
        {!isOwned ? (
          <View style={styles.addonCta}>
            {free ? (
              <Button
                title="Get"
                color={accent}
                loading={claimBusy === key}
                onPress={() => claim(key)}
              />
            ) : (
              <Button
                title={priceLabel(pkg, item?.price)}
                color={accent}
                loading={busyId === pkg?.identifier}
                disabled={!pkg}
                onPress={() => pkg && buy(pkg)}
              />
            )}
          </View>
        ) : null}
      </Card>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {activation.state === 'activating' ? (
        <Card style={[styles.card, styles.activationCard]}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.activationText}>Unlocking your add-on…</Text>
        </Card>
      ) : null}
      {activation.state === 'active' ? (
        <Card style={[styles.card, styles.successCard]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.successText}>
            Unlocked for your whole household — it's back on your calendar.
          </Text>
        </Card>
      ) : null}
      {activation.state === 'timeout' ? (
        <Card style={[styles.card, styles.activationCard]}>
          <Ionicons name="time-outline" size={20} color={colors.warning} />
          <Text style={styles.activationText}>
            Payment received — your add-on will unlock shortly.
          </Text>
        </Card>
      ) : null}

      {/* Free add-ons lead the screen: the zero-friction wins come before any
          purchase ask (give-first sequencing), and the locked Birthdays/Chores
          views' "Add for free" entry lands on target without scrolling. Order
          is state-stable — claimed cards stay put as quiet "Added" receipts. */}
      {billing.data ? (
        <>
          <SectionHeader>Included free</SectionHeader>
          {FREE_ADDON_CALENDAR_IDS.map((key) => renderAddonCard(key, true))}
          <SectionHeader>One-time purchases</SectionHeader>
        </>
      ) : null}

      {/* Featured bundle (paid add-ons only — free ones aren't sold). The CTA
          disappears once any single PAID add-on is owned — a partial owner
          buying the bundle would pay twice for what they have (App Review
          rejects double-charge paths). */}
      {allOwned ? (
        <Card style={[styles.card, styles.successCard]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.successText}>You have every add-on. Enjoy!</Text>
        </Card>
      ) : (
        <Card style={styles.bundleCard}>
          <View style={styles.bundleHeader}>
            <Text style={styles.bundleLabel}>{catalog?.bundle.label ?? 'All add-ons'}</Text>
            {ownedPaid.length === 0 ? <Badge label="Best value" color={colors.primary} /> : null}
          </View>
          {catalog?.bundle.description ? (
            <Text style={styles.bundleDesc}>{catalog.bundle.description}</Text>
          ) : null}
          <Text style={styles.bundleNote}>
            One-time purchase · unlocks all three paid calendars for your whole household
          </Text>
          {ownedPaid.length === 0 ? (
            <Button
              title={priceLabel(bundlePkg, catalog?.bundle.price)}
              loading={busyId === bundlePkg?.identifier}
              disabled={!bundlePkg}
              onPress={() => bundlePkg && buy(bundlePkg)}
            />
          ) : (
            <Text style={styles.bundleNote}>
              Already own some add-ons? Individual prices below.
            </Text>
          )}
        </Card>
      )}

      {billing.data ? (
        PAID_ADDON_CALENDAR_IDS.map((key) => renderAddonCard(key, false))
      ) : (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.lg }} />
      )}

      {__DEV__ && !isPurchasesConfigured() ? (
        <Card style={styles.card}>
          <Text style={styles.note}>
            In-app purchases aren't configured in this build. Set the RevenueCat keys
            (expo.extra.revenueCatIosKey / revenueCatAndroidKey) and run a dev/production
            build — purchases don't work in Expo Go. The server-side webhook is ready.
          </Text>
        </Card>
      ) : null}

      {isPurchasesConfigured() ? (
        <View style={{ marginTop: spacing.sm }}>
          <Button title="Restore purchases" variant="ghost" onPress={restore} />
        </View>
      ) : null}

      <Text style={styles.disclosure}>
        Paid add-ons are one-time purchases; free ones just need adding. Both are
        shared by your whole household, and anything you've already added is kept
        and comes back when you unlock.
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  card: { marginBottom: spacing.md },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },

  activationCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  activationText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  successCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderColor: colors.success + '66',
    backgroundColor: colors.success + '14',
    marginBottom: spacing.md,
  },
  successText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },

  bundleCard: { marginBottom: spacing.md },
  bundleHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bundleLabel: { fontSize: 17, fontWeight: '700', color: colors.text, flexShrink: 1 },
  bundleDesc: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  bundleNote: { color: colors.textMuted, fontSize: 12, marginTop: 6, marginBottom: spacing.sm },

  addonCard: { marginBottom: spacing.md },
  addonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  addonText: { flex: 1 },
  addonLabel: { fontSize: 16, fontWeight: '700', color: colors.text },
  addonDesc: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  addonCta: { marginTop: spacing.sm },

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
});
