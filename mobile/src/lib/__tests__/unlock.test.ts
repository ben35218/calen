jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheUnlocked, clearUnlockCache, getUnlockedCached } from '../unlock';

describe('app-unlock cache', () => {
  afterEach(() => {
    clearUnlockCache();
  });

  it('defaults to locked while nothing is cached (safe default)', async () => {
    expect(await getUnlockedCached()).toBe(false);
  });

  it('round-trips the unlock through AsyncStorage, including revokes', async () => {
    cacheUnlocked(true);
    expect(await getUnlockedCached()).toBe(true);
    expect(await AsyncStorage.getItem('hc_app_unlocked')).toBe('true');

    // The server can also revoke (refund) — the cache follows.
    cacheUnlocked(false);
    expect(await getUnlockedCached()).toBe(false);
    expect(await AsyncStorage.getItem('hc_app_unlocked')).toBe('false');
  });

  it('a persisted unlock survives a cold start (offline relaunch)', async () => {
    await AsyncStorage.setItem('hc_app_unlocked', 'true');
    // Fresh module state (clearUnlockCache in afterEach resets loadPromise), so
    // this read comes from storage, not memory… but clear also wipes storage —
    // simulate the cold start by re-seeding storage first.
    expect(await getUnlockedCached()).toBe(true);
  });

  it('sign-out clears the cache so the next account starts locked', async () => {
    cacheUnlocked(true);
    clearUnlockCache();
    expect(await AsyncStorage.getItem('hc_app_unlocked')).toBeNull();
    expect(await getUnlockedCached()).toBe(false);
  });
});
