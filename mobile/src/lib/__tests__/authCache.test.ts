// The cached /auth/me profile (lib/authCache) — what lets a cold launch that
// can't reach the server enter the app on the stored session instead of
// stranding the user at the login screen. Spec: features/auth-identity.md →
// "Session persistence & restore".
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveCachedUser, loadCachedUser, clearCachedUser } from '../authCache';

const user = { _id: 'u1', email: 'ben@example.com', firstName: 'Ben' } as never;

beforeEach(() => AsyncStorage.clear());

test('round-trips the last /auth/me payload', async () => {
  await saveCachedUser(user);
  expect(await loadCachedUser()).toMatchObject({ _id: 'u1', email: 'ben@example.com' });
});

test('empty cache and corrupted JSON both read as null (never throw into the bootstrap)', async () => {
  expect(await loadCachedUser()).toBeNull();
  await AsyncStorage.setItem('hc_auth_user', '{not json');
  expect(await loadCachedUser()).toBeNull();
});

test('clear wipes it (the sign-out teardown path)', async () => {
  await saveCachedUser(user);
  await clearCachedUser();
  expect(await loadCachedUser()).toBeNull();
});
