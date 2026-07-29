// The Event Action screen blocks its "Call to Cancel/Reschedule" button when the
// business number is on Calen's do-not-call list — but only on a definite `true`
// from the pre-check, never while it's still loading (undefined), so the button
// isn't stranded before the answer arrives. See specs/features/ai-assistant.md.
import { isCallBlockedBySuppression } from '../../../lib/callBlock';

describe('isCallBlockedBySuppression', () => {
  it('blocks only when the number is known to be suppressed', () => {
    expect(isCallBlockedBySuppression(true)).toBe(true);
  });

  it('does not block while the check is in flight (undefined) or when clear (false)', () => {
    expect(isCallBlockedBySuppression(undefined)).toBe(false);
    expect(isCallBlockedBySuppression(false)).toBe(false);
  });
});
