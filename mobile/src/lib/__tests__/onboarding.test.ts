jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { markOnboardingComplete, __resetOnboardingForTests } from '../onboarding';

const KEY = 'hc_onboarding_complete';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('onboarding first-run flag', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    __resetOnboardingForTests();
  });

  it('a fresh install has no persisted completion flag', async () => {
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  it('markOnboardingComplete persists the flag so the next launch skips it', async () => {
    markOnboardingComplete();
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBe('1');
  });
});
