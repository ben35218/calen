// Install identity (lib/deviceId.ts, spec: features/auth-identity.md "Install
// identity"): the id lives under a THIS_DEVICE_ONLY keychain item so a backup
// or Quick Start can't copy it onto a second phone, and an install that only
// holds the legacy (migratable) id mints a fresh one instead of reusing it.
jest.mock('@household/crypto/adapters/native', () => require('@household/crypto/adapters/web'));

const mockKeychain = new Map<string, { value: string; opts?: { keychainAccessible?: string } }>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  setItemAsync: async (k: string, value: string, opts?: { keychainAccessible?: string }) => {
    mockKeychain.set(k, { value, opts });
  },
  getItemAsync: async (k: string) => mockKeychain.get(k)?.value ?? null,
  deleteItemAsync: async (k: string) => { mockKeychain.delete(k); },
}));

function freshModule(): typeof import('../deviceId') {
  let mod: typeof import('../deviceId');
  jest.isolateModules(() => { mod = require('../deviceId'); });
  return mod!;
}

beforeEach(() => mockKeychain.clear());

test('mints a UUID once, stored this-device-only, stable across restarts', async () => {
  const id = await freshModule().getDeviceId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(mockKeychain.get('hc_device_id_v2')?.opts?.keychainAccessible).toBe('whenUnlockedThisDeviceOnly');
  expect(await freshModule().getDeviceId()).toBe(id);
});

test('ignores and deletes a legacy id that may have been restored from another phone', async () => {
  mockKeychain.set('hc_device_id', { value: 'shared-from-backup' });
  const id = await freshModule().getDeviceId();
  expect(id).not.toBe('shared-from-backup');
  await new Promise((r) => setTimeout(r, 0));
  expect(mockKeychain.has('hc_device_id')).toBe(false);
});
