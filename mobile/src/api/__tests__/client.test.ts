// The session sign-out policy (client.ts shouldSignOutOn401): only a 401 that
// actually testifies about the stored session may sign the device out. This is
// the guard behind the "why do I have to sign in every day?" fix — before it,
// ANY 401 (a request racing the cold-start token load, a typo'd current
// password on the change-password screen) ran the full sign-out teardown.
// Spec: features/auth-identity.md → "Session persistence & restore".
jest.mock('expo-device', () => ({ deviceName: 'TestPhone', modelName: 'TestPhone' }));
jest.mock('../../config', () => ({ API_URL: 'http://test.local/api' }));
jest.mock('../../lib/secureToken', () => ({
  getCachedToken: () => null,
  saveToken: async () => {},
}));
jest.mock('../../lib/deviceId', () => ({ getDeviceId: async () => 'device-1' }));

import { shouldAdoptRefreshedToken, shouldSignOutOn401 } from '../client';
import { jwtClaims, tokenExpiry } from '../../lib/jwtClaims';

// An unsigned JWT-shaped token (header.payload.signature) carrying the given
// claims — the device only ever reads claims, never checks signatures.
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64u(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    out += B64U[a >> 2] + B64U[((a & 3) << 4) | ((b || 0) >> 4)];
    out += i + 1 < s.length ? B64U[((b & 15) << 2) | ((c || 0) >> 6)] : '';
    out += i + 2 < s.length ? B64U[c & 63] : '';
  }
  return out;
}
function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}.sig`;
}

const authed = { Authorization: 'Bearer tok' };

describe('shouldSignOutOn401', () => {
  test('a request that carried no token cannot sign the user out (pre-bootstrap race, pre-auth endpoints)', () => {
    expect(shouldSignOutOn401({ url: '/records/sync', headers: {} })).toBe(false);
    expect(shouldSignOutOn401({ url: '/auth/login', headers: {} })).toBe(false);
    expect(shouldSignOutOn401(undefined)).toBe(false);
  });

  test('a token-bearing request 401ing on an ordinary route signs out (dead session)', () => {
    expect(shouldSignOutOn401({ url: '/records/sync', headers: authed })).toBe(true);
    expect(shouldSignOutOn401({ url: '/auth/me', headers: authed })).toBe(true);
  });

  test('credential-check endpoints never sign out — their 401/403 means "wrong password typed", not "dead session"', () => {
    expect(shouldSignOutOn401({ url: '/auth/password', headers: authed })).toBe(false);
    expect(shouldSignOutOn401({ url: '/auth/email', headers: authed })).toBe(false);
    expect(shouldSignOutOn401({ url: '/auth/account', headers: authed })).toBe(false);
    // Query strings don't defeat the match.
    expect(shouldSignOutOn401({ url: '/auth/password?x=1', headers: authed })).toBe(false);
  });
});

describe('jwtClaims / tokenExpiry', () => {
  test('reads the payload of a well-formed token without atob', () => {
    const tok = fakeJwt({ userId: 'u1', sid: 's1', iat: 1_700_000_000, exp: 1_700_604_800 });
    expect(jwtClaims(tok)).toEqual({ userId: 'u1', sid: 's1', iat: 1_700_000_000, exp: 1_700_604_800 });
    expect(tokenExpiry(tok)).toBe(1_700_604_800);
  });

  test('anything that is not a three-part JWT with a numeric exp yields null', () => {
    expect(jwtClaims('not-a-jwt')).toBeNull();
    expect(jwtClaims('a.b')).toBeNull();
    expect(jwtClaims('a.!!!.c')).toBeNull();
    expect(tokenExpiry(fakeJwt({ userId: 'u1' }))).toBeNull();
    expect(tokenExpiry(fakeJwt({ exp: 'soon' }))).toBeNull();
  });
});

// The sliding-refresh adoption rule: a replayed response (iOS URL cache serving a
// week-old X-Refreshed-Token on a 304) must never replace a live token — that was
// the TestFlight 47–49 sign-in loop. Spec: features/auth-identity.md →
// "Session persistence & restore".
describe('shouldAdoptRefreshedToken', () => {
  const now = 1_700_000_000;
  const current = fakeJwt({ userId: 'u1', iat: now, exp: now + 7 * 86400 });

  test('a refreshed token that outlives the current one is adopted', () => {
    const newer = fakeJwt({ userId: 'u1', iat: now + 4 * 86400, exp: now + 11 * 86400 });
    expect(shouldAdoptRefreshedToken(newer, current)).toBe(true);
  });

  test('a stale (replayed) refreshed token that expires before the current one is ignored', () => {
    const stale = fakeJwt({ userId: 'u1', iat: now - 8 * 86400, exp: now - 86400 });
    expect(shouldAdoptRefreshedToken(stale, current)).toBe(false);
    // Same lifetime as what we hold is not an improvement either.
    expect(shouldAdoptRefreshedToken(current, current)).toBe(false);
  });

  test('with no current token (signed out mid-flight) nothing is adopted', () => {
    const newer = fakeJwt({ userId: 'u1', iat: now, exp: now + 11 * 86400 });
    expect(shouldAdoptRefreshedToken(newer, null)).toBe(false);
  });

  test('an undecodable refreshed value is ignored; an undecodable current token is replaced', () => {
    expect(shouldAdoptRefreshedToken('garbage', current)).toBe(false);
    expect(shouldAdoptRefreshedToken(undefined, current)).toBe(false);
    expect(shouldAdoptRefreshedToken(123, current)).toBe(false);
    const newer = fakeJwt({ userId: 'u1', iat: now, exp: now + 11 * 86400 });
    expect(shouldAdoptRefreshedToken(newer, 'legacy-opaque-token')).toBe(true);
  });
});
