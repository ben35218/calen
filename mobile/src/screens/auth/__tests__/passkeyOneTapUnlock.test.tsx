import React from 'react';
import { render, waitFor, cleanup } from '@testing-library/react-native';

// The auth store's one-prompt passkey contract (auth-identity.md "Passkey"):
// a usernameless sign-in rides the device's cached PRF hint on the sign-in
// assertion, so when the assertion comes back with a PRF output the E2EE
// unlock happens in the SAME gesture — no second passkey sheet. The second
// sheet remains strictly a fallback: no output (foreign pick / first install)
// or an output whose factor won't open (stale hint) — never the default path
// the TestFlight double-prompt made it.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }));

const mockChallenge = jest.fn();
const mockPasskeyLogin = jest.fn();
jest.mock('../../../api', () => ({
  authApi: {
    passkeyChallenge: (d: unknown) => mockChallenge(d),
    passkeyLogin: (d: unknown) => mockPasskeyLogin(d),
    me: jest.fn().mockRejectedValue(new Error('no stored session')),
  },
  householdApi: { reportClientVersion: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../api/client', () => ({ setUnauthorizedHandler: jest.fn() }));
jest.mock('../../../lib/secureToken', () => ({
  loadToken: jest.fn().mockResolvedValue(null),
  saveToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
}));

const mockUnlockWithPrfOutput = jest.fn();
const mockUnlockFromDeviceCache = jest.fn();
const mockUnlockWithPasskey = jest.fn();
jest.mock('../../../lib/e2ee', () => ({
  ensureEnrolledOnLogin: jest.fn().mockResolvedValue('unlocked'),
  ensureHouseholdKey: jest.fn().mockResolvedValue('ready'),
  unlockWithPasskey: () => mockUnlockWithPasskey(),
  unlockWithPasskeyPrfOutput: (id: string, prf: string) => mockUnlockWithPrfOutput(id, prf),
  rewrapForNewPassword: jest.fn().mockResolvedValue(true),
  lock: jest.fn(),
  unlockFromDeviceCache: () => mockUnlockFromDeviceCache(),
  forgetDeviceKey: jest.fn().mockResolvedValue(undefined),
  generateAccountSecret: jest.fn().mockResolvedValue('device-secret'),
  addPasskeyFactor: jest.fn().mockResolvedValue(true),
  holdRecoveryCode: jest.fn(),
  releaseRecoveryCode: jest.fn(),
  clearRecoveryCode: jest.fn(),
  setSealAuthor: jest.fn(),
  subscribeKeysReady: jest.fn(() => jest.fn()),
  subscribeHouseholdChanged: jest.fn(() => jest.fn()),
  rememberSessionPassword: jest.fn(),
  getHDK: jest.fn(() => null),
}));

const mockAssert = jest.fn();
jest.mock('../../../lib/passkeys', () => ({
  passkeysSupported: () => true,
  assertPasskeyForLogin: (ch: unknown, hint: unknown) => mockAssert(ch, hint),
}));
const mockLatestHint = jest.fn();
jest.mock('../../../lib/passkeyHints', () => ({
  latestPasskeyHint: () => mockLatestHint(),
}));
jest.mock('../../../lib/dropMigration', () => ({ maintainKeyHygiene: jest.fn() }));
jest.mock('../../../lib/calendarKeys', () => ({
  ensureSharedCalendarKeys: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../lib/queryClient', () => ({
  queryClient: { clear: jest.fn(), invalidateQueries: jest.fn() },
}));
jest.mock('../../../lib/replica', () => ({ clearAll: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../lib/records', () => ({
  resetRecordCursor: jest.fn().mockResolvedValue(undefined),
  syncRecords: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../lib/calendarPrefs', () => ({
  resetCalendarPrefs: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../lib/addons', () => ({ resetOwnedAddons: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../lib/unlock', () => ({ cacheUnlocked: jest.fn(), clearUnlockCache: jest.fn() }));
jest.mock('../../../lib/viewerAccess', () => ({ clearViewerContentCache: jest.fn() }));

import { AuthProvider, useAuth } from '../../../store/auth';

const AUTH_PAYLOAD = { data: { token: 'jwt', user: { _id: 'user-1', appUnlocked: false } } };
const HINT = { credentialId: 'credA', prfSalt: 'saltA' };
const USERNAMELESS_CH = {
  data: { challengeId: 'ch1', challenge: 'c', rpId: 'calen.test', allowCredentials: [] },
};

const probe: { loginWithPasskey: ReturnType<typeof useAuth>['loginWithPasskey'] | null } = {
  loginWithPasskey: null,
};
let bootstrapped = false;

function Probe() {
  const { loginWithPasskey, bootstrapping } = useAuth();
  probe.loginWithPasskey = loginWithPasskey;
  bootstrapped = !bootstrapping;
  return null;
}

async function mountStore() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(bootstrapped).toBe(true));
}

beforeEach(() => {
  jest.clearAllMocks();
  bootstrapped = false;
  mockChallenge.mockResolvedValue(USERNAMELESS_CH);
  mockPasskeyLogin.mockResolvedValue(AUTH_PAYLOAD);
  mockLatestHint.mockResolvedValue(HINT);
  mockUnlockWithPrfOutput.mockResolvedValue(true);
  mockUnlockFromDeviceCache.mockResolvedValue(false);
  mockUnlockWithPasskey.mockResolvedValue(true);
});
afterEach(cleanup);

test('usernameless sign-in with a matching hint unlocks in the one gesture — no second sheet', async () => {
  mockAssert.mockResolvedValue({ response: { id: 'credA' }, credentialId: 'credA', prfOutput: 'prf-out' });
  await mountStore();

  expect(await probe.loginWithPasskey!()).toBe(true);

  expect(mockAssert).toHaveBeenCalledWith(USERNAMELESS_CH.data, HINT);
  expect(mockUnlockWithPrfOutput).toHaveBeenCalledWith('credA', 'prf-out');
  expect(mockUnlockFromDeviceCache).not.toHaveBeenCalled();
  expect(mockUnlockWithPasskey).not.toHaveBeenCalled();
});

test('no PRF output (foreign pick / fresh device) falls back to the post-auth unlock', async () => {
  mockAssert.mockResolvedValue({ response: { id: 'credB' }, credentialId: 'credB', prfOutput: null });
  await mountStore();

  expect(await probe.loginWithPasskey!()).toBe(true);

  expect(mockUnlockWithPrfOutput).not.toHaveBeenCalled();
  expect(mockUnlockWithPasskey).toHaveBeenCalled();
});

test("a stale hint whose factor won't open still falls back instead of staying locked", async () => {
  mockAssert.mockResolvedValue({ response: { id: 'credA' }, credentialId: 'credA', prfOutput: 'prf-out' });
  mockUnlockWithPrfOutput.mockResolvedValue(false);
  await mountStore();

  expect(await probe.loginWithPasskey!()).toBe(true);

  expect(mockUnlockWithPrfOutput).toHaveBeenCalledWith('credA', 'prf-out');
  expect(mockUnlockWithPasskey).toHaveBeenCalled();
});

test('username-first challenges carry server salts — the device hint stays out of it', async () => {
  const ch = {
    data: {
      challengeId: 'ch2', challenge: 'c', rpId: 'calen.test',
      allowCredentials: [{ id: 'credA', prfSalt: 'serverSalt' }],
    },
  };
  mockChallenge.mockResolvedValue(ch);
  mockAssert.mockResolvedValue({ response: { id: 'credA' }, credentialId: 'credA', prfOutput: 'prf-out' });
  await mountStore();

  expect(await probe.loginWithPasskey!('a@b.c')).toBe(true);

  expect(mockLatestHint).not.toHaveBeenCalled();
  expect(mockAssert).toHaveBeenCalledWith(ch.data, null);
});
