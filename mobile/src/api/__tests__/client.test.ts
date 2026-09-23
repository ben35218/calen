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

import { shouldSignOutOn401 } from '../client';

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
