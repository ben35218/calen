// Deriving the Calen AI plan's *display* state, client-side.
//
// The server can't tell "will renew" from "cancelled but still active": an
// auto-renew-off CANCELLATION is deliberately a no-op until EXPIRATION (see
// billing-plans.md → "The Calen AI plan"), so `status.aiPlan.active` stays true
// through the paid-out period either way. The will-renew truth lives only in the
// RevenueCat SDK's CustomerInfo (`entitlements.active[calen_ai].willRenew`).
//
// This pure function folds the two sources into one of three UI states, with the
// server's `aiPlan` as the base so we degrade gracefully when RC is unavailable
// (dev builds, offline, missing entitlement) — falling back to today's
// active/inactive behavior.

// The RC entitlement id for the plan (mirrors MonetizationConfig.aiPlan.entitlement).
export const AI_PLAN_ENTITLEMENT = 'calen_ai';

export type AiPlanUiState =
  | 'inactive' // never subscribed, or the plan has expired — show the subscribe CTA
  | 'renewing' // active and set to auto-renew (the default happy path)
  | 'cancelled'; // active but auto-renew is OFF — benefits until expiry, then lapses

// The minimal shape we read off an RC entitlement — structurally satisfied by
// react-native-purchases' PurchasesEntitlementInfo, so no conversion is needed.
export interface RcEntitlementSnapshot {
  willRenew: boolean;
  expirationDate: string | null;
}

// The minimal shape we read off the server's aiPlan status.
export interface ServerPlanSnapshot {
  active: boolean;
  expiresAt: string | null;
}

export interface AiPlanView {
  state: AiPlanUiState;
  // The period-end date to show ("renews on" / "benefits until"). Prefers the RC
  // entitlement's expirationDate (freshest) and falls back to the server's.
  expiresAt: string | null;
}

// serverPlan is the base truth (from GET /billing/status). entitlement is the RC
// snapshot for `calen_ai` when the SDK has loaded — pass null/undefined when RC
// isn't configured or the entitlement is absent, and we fall back to server state.
export function deriveAiPlanState(
  serverPlan: ServerPlanSnapshot | null | undefined,
  entitlement: RcEntitlementSnapshot | null | undefined
): AiPlanView {
  if (!serverPlan?.active) return { state: 'inactive', expiresAt: null };

  const expiresAt = entitlement?.expirationDate ?? serverPlan.expiresAt ?? null;

  // Only an entitlement we can actually read can demote us to "cancelled". With
  // no entitlement (RC not configured / not loaded / already lapsed in the SDK)
  // we trust the server's still-active base and show "renewing" — today's
  // behavior, never a false "cancelled".
  if (entitlement && entitlement.willRenew === false) {
    return { state: 'cancelled', expiresAt };
  }
  return { state: 'renewing', expiresAt };
}
