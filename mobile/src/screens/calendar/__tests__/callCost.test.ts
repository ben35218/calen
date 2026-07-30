// The Event Action screen's pre-call cost caption (billing-plans.md "Pre-call
// cost transparency"): the flat call price from billing/status.actionCosts is
// shown above the call CTA, and hidden — never guessed — while unknown.
import { callCostCaption } from '../../../lib/callCost';

describe('callCostCaption', () => {
  it('renders the flat per-minute price from the server catalog', () => {
    expect(callCostCaption(20)).toBe(
      '~20 credits/min from your AI credits, billed by the second'
    );
  });

  it('hides while the price is unknown or nonsensical (no hard-coded fallback)', () => {
    expect(callCostCaption(undefined)).toBeNull();
    expect(callCostCaption(null)).toBeNull();
    expect(callCostCaption(0)).toBeNull();
    expect(callCostCaption(-5)).toBeNull();
  });
});
