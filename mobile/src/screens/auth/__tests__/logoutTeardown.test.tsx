import React from 'react';
import { render, waitFor, cleanup } from '@testing-library/react-native';

// The sign-out teardown contract (auth-identity.md "Sign-out teardown"): the
// install's push token is retired best-effort BEFORE the session token clears
// (the unregister call needs the token to authorize), and a failed unregister
// never blocks the rest of the teardown — a signed-out device must not keep
// receiving the account's pushes, but sign-out must always complete.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }));

jest.mock('../../../api', () => ({
  authApi: {
    login: jest.fn().mockResolvedValue({ data: { token: 'jwt', user: { _id: 'user-1' } } }),
    me: jest.fn().mockRejectedValue(new Error('no stored session')),
  },
  householdApi: { reportClientVersion: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../api/client', () => ({ setUnauthorizedHandler: jest.fn() }));

// Call-order ledger: the assertion is the SEQUENCE, not just that both ran.
const calls: string[] = [];
jest.mock('../../../lib/push', () => ({
  unregisterCurrentPushToken: jest.fn(async () => { calls.push('unregisterPush'); }),
}));
jest.mock('../../../lib/secureToken', () => ({
  loadToken: jest.fn().mockResolvedValue(null),
  saveToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn(async () => { calls.push('clearToken'); }),
}));

jest.mock('../../../lib/e2ee', () => ({
  ensureEnrolledOnLogin: jest.fn().mockResolvedValue('ready'),
  ensureHouseholdKey: jest.fn().mockResolvedValue('ready'),
  unlockWithPasskey: jest.fn().mockResolvedValue(false),
  unlockWithPasskeyPrfOutput: jest.fn().mockResolvedValue(false),
  rewrapForNewPassword: jest.fn().mockResolvedValue(true),
  lock: jest.fn(),
  unlockFromDeviceCache: jest.fn().mockResolvedValue(false),
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
jest.mock('../../../lib/passkeys', () => ({
  passkeysSupported: () => false,
  assertPasskeyForLogin: jest.fn(),
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
import { unregisterCurrentPushToken } from '../../../lib/push';
import { clearToken } from '../../../lib/secureToken';

const probe: {
  isLoggedIn: boolean;
  bootstrapping: boolean;
  login: ReturnType<typeof useAuth>['login'] | null;
  logout: ReturnType<typeof useAuth>['logout'] | null;
} = { isLoggedIn: false, bootstrapping: true, login: null, logout: null };

function Probe() {
  const { isLoggedIn, bootstrapping, login, logout } = useAuth();
  probe.isLoggedIn = isLoggedIn;
  probe.bootstrapping = bootstrapping;
  probe.login = login;
  probe.logout = logout;
  return null;
}

async function mountAndSignIn() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(probe.bootstrapping).toBe(false));
  await probe.login!({ email: 'a@b.c', password: 'pw' });
  await waitFor(() => expect(probe.isLoggedIn).toBe(true));
}

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  probe.isLoggedIn = false;
  probe.bootstrapping = true;
});
afterEach(cleanup);

test('logout retires the push token before clearing the session token', async () => {
  await mountAndSignIn();

  await probe.logout!();
  await waitFor(() => expect(probe.isLoggedIn).toBe(false));

  expect(calls).toEqual(['unregisterPush', 'clearToken']);
});

test('a failed push unregister never blocks sign-out', async () => {
  (unregisterCurrentPushToken as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  await mountAndSignIn();

  await probe.logout!();
  await waitFor(() => expect(probe.isLoggedIn).toBe(false));

  expect(clearToken).toHaveBeenCalled();
});
