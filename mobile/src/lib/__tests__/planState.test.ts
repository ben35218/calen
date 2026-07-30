import { deriveAiPlanState } from '../planState';

// deriveAiPlanState folds the server's active/inactive base with the RC
// entitlement's will-renew intent into one of three display states. The server
// can't distinguish "will renew" from "cancelled but still active" (auto-renew
// off is a no-op until expiry), so the will-renew truth comes only from RC — and
// when RC is unavailable we must degrade to the server base, never a false
// "cancelled".

const SERVER_ACTIVE = { active: true, expiresAt: '2026-08-15T00:00:00.000Z' };

describe('deriveAiPlanState', () => {
  it('active + willRenew true → renewing (the happy path)', () => {
    const v = deriveAiPlanState(SERVER_ACTIVE, {
      willRenew: true,
      expirationDate: '2026-08-20T00:00:00.000Z',
    });
    expect(v.state).toBe('renewing');
    // Prefers the RC entitlement's expiration over the server's.
    expect(v.expiresAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('active + willRenew false → cancelled (benefits until expiry)', () => {
    const v = deriveAiPlanState(SERVER_ACTIVE, {
      willRenew: false,
      expirationDate: '2026-08-15T00:00:00.000Z',
    });
    expect(v.state).toBe('cancelled');
    expect(v.expiresAt).toBe('2026-08-15T00:00:00.000Z');
  });

  it('active but no entitlement (RC missing it) → renewing off the server base', () => {
    const v = deriveAiPlanState(SERVER_ACTIVE, null);
    expect(v.state).toBe('renewing');
    // Falls back to the server's expiry when RC carries none.
    expect(v.expiresAt).toBe('2026-08-15T00:00:00.000Z');
  });

  it('RC not configured (undefined entitlement) → renewing off server state only', () => {
    const v = deriveAiPlanState(SERVER_ACTIVE, undefined);
    expect(v.state).toBe('renewing');
    expect(v.expiresAt).toBe('2026-08-15T00:00:00.000Z');
  });

  it('server inactive → inactive regardless of any stale entitlement', () => {
    const v = deriveAiPlanState(
      { active: false, expiresAt: null },
      { willRenew: true, expirationDate: '2026-08-20T00:00:00.000Z' }
    );
    expect(v.state).toBe('inactive');
    expect(v.expiresAt).toBeNull();
  });

  it('missing server plan → inactive', () => {
    expect(deriveAiPlanState(undefined, null).state).toBe('inactive');
    expect(deriveAiPlanState(null, null).state).toBe('inactive');
  });

  it('active with no expiry anywhere → renewing with null date', () => {
    const v = deriveAiPlanState({ active: true, expiresAt: null }, { willRenew: true, expirationDate: null });
    expect(v.state).toBe('renewing');
    expect(v.expiresAt).toBeNull();
  });
});
