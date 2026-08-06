import React from 'react';
import { render, waitFor, cleanup } from '@testing-library/react-native';

// The auth store's settle-before-enter contract (auth-identity.md "Sign-in
// paths"): the password login and register paths must finish the E2EE
// enroll/unlock BEFORE setUser flips the navigation gate. Entering the app
// first races every once-at-mount read of the lock state — the free-viewer
// shell read "locked" mid-enroll, pinned its initialRouteName to the
// restore-access screen, and stranded a brand-new invitee who had just typed
// a working password (billing-plans.md "Free viewer mode").

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }));

const mockLogin = jest.fn();
const mockRegister = jest.fn();
jest.mock('../../../api', () => ({
  authApi: {
    login: (creds: unknown) => mockLogin(creds),
    register: (payload: unknown) => mockRegister(payload),
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

// The enroll is the slow step under test (Argon2 + envelope round-trips), so
// it resolves only when a test says so — that held-open window is exactly
// where the old ordering let the user into the app.
let releaseEnroll: (() => void) | null = null;
const mockEnroll = jest.fn(
  () => new Promise<string>((resolve) => { releaseEnroll = () => resolve('ready'); })
);
const mockSetSealAuthor = jest.fn();
jest.mock('../../../lib/e2ee', () => ({
  ensureEnrolledOnLogin: (pw: string) => mockEnroll(pw),
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
  setSealAuthor: (id: string | null) => mockSetSealAuthor(id),
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

const AUTH_PAYLOAD = { data: { token: 'jwt', user: { _id: 'user-1', appUnlocked: false } } };

// The gate's-eye view: what RootNavigator reads from the store.
const probe: {
  isLoggedIn: boolean;
  bootstrapping: boolean;
  login: ReturnType<typeof useAuth>['login'] | null;
  register: ReturnType<typeof useAuth>['register'] | null;
} = { isLoggedIn: false, bootstrapping: true, login: null, register: null };

function Probe() {
  const { isLoggedIn, bootstrapping, login, register } = useAuth();
  probe.isLoggedIn = isLoggedIn;
  probe.bootstrapping = bootstrapping;
  probe.login = login;
  probe.register = register;
  return null;
}

async function mountStore() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(probe.bootstrapping).toBe(false));
}

beforeEach(() => {
  releaseEnroll = null;
  mockEnroll.mockClear();
  mockSetSealAuthor.mockClear();
  mockLogin.mockReset().mockResolvedValue(AUTH_PAYLOAD);
  mockRegister.mockReset().mockResolvedValue(AUTH_PAYLOAD);
  probe.isLoggedIn = false;
  probe.bootstrapping = true;
});
afterEach(cleanup);

test('login holds the gate shut until the E2EE enroll settles', async () => {
  await mountStore();

  const done = probe.login!({ email: 'a@b.c', password: 'pw' });

  // The enroll is running and unresolved: the user must NOT be in the app yet.
  await waitFor(() => expect(mockEnroll).toHaveBeenCalledWith('pw'));
  expect(probe.isLoggedIn).toBe(false);
  // The seal author is already set, so anything sealed during the unlock
  // pipeline (keys-ready sync, key hygiene) carries the author id.
  expect(mockSetSealAuthor).toHaveBeenCalledWith('user-1');

  releaseEnroll!();
  await done;
  await waitFor(() => expect(probe.isLoggedIn).toBe(true));
});

test('registration holds the gate shut until the E2EE enroll settles', async () => {
  await mountStore();

  const done = probe.register!({ email: 'a@b.c', firstName: 'A', password: 'pw' });

  await waitFor(() => expect(mockEnroll).toHaveBeenCalledWith('pw'));
  expect(probe.isLoggedIn).toBe(false);
  expect(mockSetSealAuthor).toHaveBeenCalledWith('user-1');

  releaseEnroll!();
  await done;
  await waitFor(() => expect(probe.isLoggedIn).toBe(true));
});

test('an enroll failure still completes sign-in — locked, never locked OUT', async () => {
  // initE2EE is best-effort by contract: a crypto failure leaves the session
  // locked (the unlock UI takes it from there) but must not strand the user
  // outside the app entirely.
  mockEnroll.mockRejectedValueOnce(new Error('KDF exploded'));
  await mountStore();

  await probe.login!({ email: 'a@b.c', password: 'pw' });
  await waitFor(() => expect(probe.isLoggedIn).toBe(true));
});
