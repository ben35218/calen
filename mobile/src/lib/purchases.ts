import { Platform } from 'react-native';
import Purchases, { PurchasesOffering, CustomerInfo } from 'react-native-purchases';
import { REVENUECAT_IOS_KEY, REVENUECAT_ANDROID_KEY } from '../config';

// RevenueCat wrapper. Purchases flow: the user buys a product on the App Store /
// Play Store; RevenueCat records it and POSTs a webhook to the server
// (server/src/routes/billing.js → /api/billing/webhook). The RevenueCat
// app_user_id is the signed-in USER id — the $4.99 app unlock and credit packs
// are per-user; the webhook resolves user → household for the household-wide
// feature-calendar add-ons.

const apiKey = Platform.OS === 'ios' ? REVENUECAT_IOS_KEY : REVENUECAT_ANDROID_KEY;

export function isPurchasesConfigured(): boolean {
  return Boolean(apiKey);
}

let configured = false;
let currentAppUserId: string | null = null;

// Initialize once with the signed-in user as the app_user_id. No-op if keys are
// missing (e.g. running in Expo Go / before store setup).
export function configurePurchases(appUserId: string): void {
  if (!apiKey || configured) return;
  Purchases.configure({ apiKey, appUserID: appUserId });
  configured = true;
  currentAppUserId = appUserId;
}

// Switch the RevenueCat identity to a (different) signed-in user. Covers
// account switches on one device and upgrades legacy installs that were
// configured with the household id — RC aliases the old identity onto the user
// so prior sandbox/store purchases stay attached.
export async function logInPurchases(appUserId: string): Promise<void> {
  if (!configured || currentAppUserId === appUserId) return;
  try {
    await Purchases.logIn(appUserId);
    currentAppUserId = appUserId;
  } catch {
    // Identity switch is best-effort; purchase/restore flows re-assert it.
  }
}

// The default (`current`) offering — holds the single app-unlock package.
export async function getCurrentOffering(): Promise<PurchasesOffering | null> {
  if (!configured) return null;
  const offerings = await Purchases.getOfferings();
  return offerings.current ?? null;
}

// A named (non-current) offering. Feature-calendar add-ons live in 'addons' and
// credit packs in 'credits', deliberately outside `current` so the unlock
// paywall never renders them as orphan cards.
export async function getOfferingById(id: string): Promise<PurchasesOffering | null> {
  if (!configured) return null;
  const offerings = await Purchases.getOfferings();
  return offerings.all[id] ?? null;
}

// The consumable AI-credit packs offering.
export function getPacksOffering(): Promise<PurchasesOffering | null> {
  return getOfferingById('credits');
}

// Purchase a package; resolves with the updated CustomerInfo. The entitlement /
// credit grant is applied server-side via the webhook, so callers should poll
// billing status afterwards.
export async function purchasePackage(
  pkg: Parameters<typeof Purchases.purchasePackage>[0]
): Promise<CustomerInfo> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return customerInfo;
}

export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  return Purchases.restorePurchases();
}
