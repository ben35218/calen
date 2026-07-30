// Pre-call cost transparency (billing-plans.md): the flat published call price
// shown before an assistant phone call is placed. Null when the price isn't
// known (billing status not loaded / actionCosts missing) — the caption hides
// rather than showing a wrong or hard-coded number.
export function callCostCaption(callPerMinute: number | undefined | null): string | null {
  if (!callPerMinute || callPerMinute <= 0) return null;
  return `~${callPerMinute} credits/min from your AI credits, billed by the second`;
}
