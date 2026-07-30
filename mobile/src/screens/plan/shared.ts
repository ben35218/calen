// Shared pieces of the billing surfaces (the Profile credits card, the Unlock
// paywall, Credits, BuyCredits, Add-ons): formatting helpers, the RevenueCat
// package↔product mappings, and the purchase hooks that own the buy flows.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import type { CreditPack } from '../../api';
import { useAuth } from '../../store/auth';
import {
  useBilling, useUnlockActivation, useCreditsActivation, useAddonActivation, useAiPlanActivation,
} from '../../hooks/useBilling';
import type { AddonId } from '../../lib/addons';
import { AI_PLAN_ENTITLEMENT } from '../../lib/planState';
import {
  isPurchasesConfigured,
  configurePurchases,
  logInPurchases,
  getCurrentOffering,
  getOfferingById,
  getCustomerInfo,
  showManageSubscriptions,
  purchasePackage,
  restorePurchases,
} from '../../lib/purchases';

// The Apple manage-subscriptions deep link — the last-resort fallback when the
// native sheet is unavailable and CustomerInfo carries no managementURL.
const APPLE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

export const STORE_NAME = Platform.OS === 'ios' ? 'App Store' : 'Google Play';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The server rolls the usage-ANALYTICS window every Wednesday at 5PM Eastern and
// returns that next instant. Render it in the device's own timezone: how many
// whole days remain, plus the local weekday + clock time it happens. (Nothing is
// enforced weekly anymore — this captions the "By feature this week" card.)
export function describeReset(resetsAt?: string): string | null {
  if (!resetsAt) return null;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return null;

  // Whole calendar days between today and the reset day, in device-local time,
  // so a reset 6 days + a few hours away reads as "6 days", not "7".
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(reset) - startOfDay(new Date())) / 86_400_000);

  let hour = reset.getHours(); // device-local
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  const min = reset.getMinutes();
  const time = min ? `${hour}:${String(min).padStart(2, '0')} ${ampm}` : `${hour} ${ampm}`;

  if (days <= 0) return `New week starts today at ${time}`;
  return `New week starts ${WEEKDAYS[reset.getDay()]} at ${time}`;
}

// "July 20" (with the year only when it isn't this year) for ledger dates.
export function shortDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// "150000" reads as noise; "150k" reads as a number.
export function humanTokens(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// Call time is stored in seconds but reads best in minutes: "15 min",
// "1.5 min", "45 sec" (sub-minute, so a small value isn't shown as "0 min").
export function humanCallSeconds(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const mins = seconds / 60;
  return `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min`;
}

// "1,050 credits" — whole credits with a thousands separator, floored at 0 for
// display (a refund can drive the raw balance negative).
export function humanCredits(n: number | null | undefined): string {
  return Math.max(0, Math.floor(n ?? 0)).toLocaleString();
}

// Configure/refresh the RevenueCat identity for the signed-in user. Purchases
// are per-USER (app_user_id = user id): configure() covers the cold start,
// logIn() covers account switches and upgrades legacy installs that were keyed
// to the household id (RC aliases the old identity onto the user).
function useRcIdentity(userId: string | undefined) {
  useEffect(() => {
    if (!isPurchasesConfigured() || !userId) return;
    configurePurchases(userId);
    void logInPurchases(userId);
  }, [userId]);
}

// ── The $4.99 app unlock (UnlockPaywallScreen) ──────────────────────────────

// The unlock's package in the `current` offering: prefer the lifetime package,
// fall back to a product-id match so a mis-set package type still sells.
export function unlockPackage(packages: PurchasesPackage[]): PurchasesPackage | null {
  return (
    packages.find((p) => p.packageType === 'LIFETIME') ??
    packages.find((p) => `${p.product.identifier} ${p.identifier}`.toLowerCase().includes('app_unlock')) ??
    null
  );
}

// Owns the unlock purchase flow: RC identity, `current` offering load, buy()
// (store sheet → unlock activation poll), restore().
export function useUnlockPurchase() {
  const { user } = useAuth();
  const billing = useBilling();
  const activation = useUnlockActivation();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [busy, setBusy] = useState(false);

  useRcIdentity(user?._id);
  useEffect(() => {
    if (!isPurchasesConfigured() || !user?._id) return;
    getCurrentOffering()
      .then((offering) => setPackages(offering?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, [user?._id]);

  const pkg = useMemo(() => unlockPackage(packages), [packages]);

  async function buy() {
    if (!pkg) return;
    setBusy(true);
    try {
      await purchasePackage(pkg);
      // The unlock flips server-side via the RevenueCat webhook — poll until it
      // lands so the paywall opens for someone who just paid.
      activation.start();
    } catch (e: any) {
      if (!e?.userCancelled) Alert.alert('Purchase failed', e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Restore reports what actually came back instead of claiming success blindly:
  // no entitlements is the common case (wrong store account, nothing bought).
  async function restore() {
    try {
      const info = await restorePurchases();
      const active = Object.keys(info?.entitlements?.active ?? {});
      if (!active.includes('app_unlock')) {
        Alert.alert('Nothing to restore', 'No previous purchase was found for this account.');
        return;
      }
      const { data } = await billing.refetch();
      // Store shows the entitlement but the server hasn't flipped yet — the
      // webhook (or a TRANSFER) is in flight; poll like a fresh purchase.
      if (!data?.unlocked) activation.start();
    } catch {
      Alert.alert('Restore failed', 'Could not restore purchases.');
    }
  }

  return { billing, activation, pkg, busy, buy, restore };
}

// ── Prepaid AI-credit packs (CreditsScreen / BuyCreditsSheet) ───────────────

// Match a RevenueCat package to a catalog pack by product id (consumables carry
// no entitlement). Never claims add-on or unlock products.
export function packForRcPackage(pkg: PurchasesPackage, packs: CreditPack[]): CreditPack | null {
  const id = `${pkg.product.identifier} ${pkg.identifier}`.toLowerCase();
  if (id.includes('addon_') || id.includes('app_unlock')) return null;
  return packs.find((p) => id.includes(p.productId.toLowerCase())) ?? null;
}

// Owns the credit-pack purchase flow: RC identity, `credits` offering load,
// catalog↔package pairing, buy() (store sheet → balance activation poll).
export function useCreditsPurchase() {
  const { user } = useAuth();
  const billing = useBilling();
  const activation = useCreditsActivation();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useRcIdentity(user?._id);
  useEffect(() => {
    if (!isPurchasesConfigured() || !user?._id) return;
    getOfferingById('credits')
      .then((offering) => setPackages(offering?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, [user?._id]);

  const packs = billing.data?.packs ?? [];

  // One row per catalog pack, with the matching store package (for the
  // localized price) when RC has loaded. Catalog order = display order.
  const rows = useMemo(
    () =>
      packs.map((pack) => ({
        pack,
        pkg: packages.find((p) => packForRcPackage(p, packs)?.productId === pack.productId) ?? null,
      })),
    [packs, packages]
  );

  async function buy(row: { pack: CreditPack; pkg: PurchasesPackage | null }) {
    if (!row.pkg) return;
    const previousMc = billing.data?.creditBalanceMc ?? 0;
    setBusyId(row.pack.productId);
    try {
      await purchasePackage(row.pkg);
      // Credits land server-side via the RevenueCat webhook — poll until the
      // balance rises so the screen never shows the old balance to a buyer.
      activation.start(previousMc);
    } catch (e: any) {
      if (!e?.userCancelled) Alert.alert('Purchase failed', e?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  return { billing, activation, rows, busyId, buy };
}

// ── The monthly Calen AI plan (CreditsScreen plan card) ─────────────────────

// The plan's package in the dedicated `ai_plan` offering: match the catalog
// product id, falling back to the monthly package so a mis-set product id
// still sells. Never claims credit-pack, unlock, or add-on products — those
// belong to their own offerings/mappings.
export function aiPlanPackage(
  packages: PurchasesPackage[],
  productId: string
): PurchasesPackage | null {
  const eligible = packages.filter((p) => {
    const id = `${p.product.identifier} ${p.identifier}`.toLowerCase();
    return !id.includes('addon_') && !id.includes('app_unlock') && !id.includes('credits_');
  });
  return (
    eligible.find((p) =>
      `${p.product.identifier} ${p.identifier}`.toLowerCase().includes(productId.toLowerCase())
    ) ??
    eligible.find((p) => p.packageType === 'MONTHLY') ??
    null
  );
}

// Owns the Calen AI plan purchase flow: RC identity, the `ai_plan` offering
// load, buy() (store sheet → plan activation poll), restore(). The plan is the
// only subscription — everything else stays one-shot.
export function useAiPlanPurchase() {
  const { user } = useAuth();
  const billing = useBilling();
  const activation = useAiPlanActivation();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useRcIdentity(user?._id);
  useEffect(() => {
    if (!isPurchasesConfigured() || !user?._id) return;
    getOfferingById('ai_plan')
      .then((offering) => setPackages(offering?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, [user?._id]);

  const { refetch } = billing;
  // Pull the RC CustomerInfo — the client-only source of will-renew intent (the
  // server can't distinguish "will renew" from "cancelled but still active").
  const refreshCustomerInfo = useCallback(async () => {
    if (!isPurchasesConfigured()) return;
    try {
      setCustomerInfo(await getCustomerInfo());
    } catch {
      // Keep the last snapshot; a transient read failure shouldn't blank the card.
    }
  }, []);

  // Load once when the RC identity is ready.
  useEffect(() => {
    if (!user?._id) return;
    void refreshCustomerInfo();
  }, [user?._id, refreshCustomerInfo]);

  // Refetch both sources — used on screen focus / app foreground so a
  // cancellation or reactivation done in the Apple sheet is reflected without
  // an app restart.
  const refresh = useCallback(async () => {
    await Promise.all([refreshCustomerInfo(), refetch()]);
  }, [refreshCustomerInfo, refetch]);

  const productId = billing.data?.aiPlan?.productId ?? 'calen_ai_monthly_499';
  const pkg = useMemo(() => aiPlanPackage(packages, productId), [packages, productId]);

  // Open the native manage-subscriptions sheet (cancel / re-subscribe happen
  // inside it), then refresh on return. Fallback chain when the sheet is
  // unavailable: CustomerInfo.managementURL → the Apple subscriptions deep link.
  const manage = useCallback(async () => {
    const openFallback = async () => {
      const url = customerInfo?.managementURL ?? APPLE_SUBSCRIPTIONS_URL;
      try {
        await Linking.openURL(url);
      } catch {
        // Nothing more we can do; the card copy already points to the App Store.
      }
    };
    try {
      if (isPurchasesConfigured()) {
        await showManageSubscriptions();
      } else {
        await openFallback();
      }
    } catch {
      await openFallback();
    } finally {
      void refresh();
    }
  }, [customerInfo, refresh]);

  async function buy() {
    if (!pkg) return;
    setBusy(true);
    try {
      await purchasePackage(pkg);
      // The plan flips server-side via the RevenueCat webhook (which also
      // grants the period's credits) — poll until it lands.
      activation.start();
    } catch (e: any) {
      if (!e?.userCancelled) Alert.alert('Purchase failed', e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Restore reports what actually came back instead of claiming success
  // blindly (same doctrine as the unlock's restore).
  async function restore() {
    try {
      const info = await restorePurchases();
      const active = Object.keys(info?.entitlements?.active ?? {});
      if (!active.includes('calen_ai')) {
        Alert.alert('Nothing to restore', 'No active Calen AI plan was found for this account.');
        return;
      }
      const { data } = await billing.refetch();
      // Store shows the entitlement but the server hasn't flipped yet — the
      // webhook is in flight; poll like a fresh purchase.
      if (!data?.aiPlan?.active) activation.start();
    } catch {
      Alert.alert('Restore failed', 'Could not restore purchases.');
    }
  }

  // The RC entitlement for the plan, when the SDK has it — the will-renew source
  // deriveAiPlanState folds together with the server's aiPlan base.
  const entitlement = customerInfo?.entitlements.active[AI_PLAN_ENTITLEMENT] ?? null;

  return { billing, activation, pkg, busy, buy, restore, entitlement, refresh, manage };
}

// ── Feature-calendar add-ons (the "Add-ons" store screen) ────────────────────

// The RevenueCat 'addons' offering holds the three one-time add-on packages plus
// the bundle. Product ids carry marketing names (addon_meals, addon_bundle, …);
// map them back to our calendar-id keys. Bundle → 'bundle' (client display
// only — server-side the bundle product grants all three entitlements).
const PRODUCT_TO_ADDON: Record<string, AddonId> = {
  addon_meals: 'recipes',
  addon_maintenance: 'maintenance',
  addon_trips: 'trips',
};

export function addonForPackage(pkg: PurchasesPackage): AddonId | 'bundle' | null {
  const id = `${pkg.product.identifier} ${pkg.identifier}`.toLowerCase();
  if (id.includes('addon_bundle')) return 'bundle';
  for (const [productKey, addonId] of Object.entries(PRODUCT_TO_ADDON)) {
    if (id.includes(productKey)) return addonId;
  }
  return null;
}

// Owns the add-on purchase flow: RC identity, the 'addons' offering load,
// package↔add-on mapping, buy() (store sheet → owned-set activation poll), and
// restore(). Add-ons stay household-wide: the webhook resolves the purchasing
// user to their household.
export function useAddonPurchase() {
  const { user } = useAuth();
  const billing = useBilling();
  const activation = useAddonActivation();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useRcIdentity(user?._id);
  useEffect(() => {
    if (!isPurchasesConfigured() || !user?._id) return;
    getOfferingById('addons')
      .then((offering) => setPackages(offering?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, [user?._id]);

  // Package per add-on key (plus 'bundle'), for price buttons on the store cards.
  const packagesByAddon = useMemo(() => {
    const byAddon: Partial<Record<AddonId | 'bundle', PurchasesPackage>> = {};
    for (const pkg of packages) {
      const key = addonForPackage(pkg);
      if (key && !byAddon[key]) byAddon[key] = pkg;
    }
    return byAddon;
  }, [packages]);

  async function buy(pkg: PurchasesPackage) {
    const previousAddons = billing.data?.addons ?? [];
    setBusyId(pkg.identifier);
    try {
      await purchasePackage(pkg);
      // Ownership flips server-side via the RevenueCat webhook — poll until the
      // owned set changes so the store never shows "locked" to someone who paid.
      activation.start(previousAddons);
    } catch (e: any) {
      if (!e?.userCancelled) Alert.alert('Purchase failed', e?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  // Restore covers add-ons and the unlock alike (one store account). Reports
  // what came back; if the store shows add-on entitlements the server hasn't
  // granted yet, poll like a fresh purchase.
  async function restore() {
    try {
      const info = await restorePurchases();
      const active = Object.keys(info?.entitlements?.active ?? {});
      if (active.length === 0) {
        Alert.alert('Nothing to restore', 'No previous purchases were found for this account.');
        return;
      }
      const previousAddons = billing.data?.addons ?? [];
      const { data } = await billing.refetch();
      const restoredAddons = active.filter((e) => e.startsWith('addon_'));
      if (restoredAddons.length && (data?.addons ?? []).length === previousAddons.length) {
        activation.start(previousAddons);
      }
      Alert.alert('Restored', 'Your purchases have been restored.');
    } catch {
      Alert.alert('Restore failed', 'Could not restore purchases.');
    }
  }

  return { billing, activation, packages, packagesByAddon, busyId, buy, restore };
}
