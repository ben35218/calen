import AsyncStorage from '@react-native-async-storage/async-storage';
import { rememberPasskeyHints, latestPasskeyHint } from '../passkeyHints';

// The usernameless one-prompt contract's device half (auth-identity.md
// "Passkey" — Usernameless): the cache remembers every passkey credential's
// PRF salt, prefers the last credential that actually unlocked, and merges
// rather than replaces so one account's factor list can't evict another
// account's hint on a shared device.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('empty on a fresh device — the two-prompt fallback covers the first sign-in', async () => {
  expect(await latestPasskeyHint()).toBeNull();
});

test('remembers hints and surfaces the last-used credential first', async () => {
  await rememberPasskeyHints(
    [
      { credentialId: 'credA', prfSalt: 'saltA' },
      { credentialId: 'credB', prfSalt: 'saltB' },
    ],
    'credA'
  );
  expect(await latestPasskeyHint()).toEqual({ credentialId: 'credA', prfSalt: 'saltA' });
});

test('an unlock with a different credential moves the hint', async () => {
  await rememberPasskeyHints([{ credentialId: 'credA', prfSalt: 'saltA' }], 'credA');
  await rememberPasskeyHints([{ credentialId: 'credB', prfSalt: 'saltB' }], 'credB');
  expect(await latestPasskeyHint()).toEqual({ credentialId: 'credB', prfSalt: 'saltB' });
});

test('merge-only: re-seeing one account keeps the other account\'s last-used hint', async () => {
  await rememberPasskeyHints([{ credentialId: 'credB', prfSalt: 'saltB' }], 'credB');
  // A password unlock of account A passes its factor list through with no
  // usedCredentialId — B stays the sign-in hint.
  await rememberPasskeyHints([{ credentialId: 'credA', prfSalt: 'saltA' }]);
  expect(await latestPasskeyHint()).toEqual({ credentialId: 'credB', prfSalt: 'saltB' });
});

test('without any used credential yet, the most recently seen hint wins', async () => {
  await rememberPasskeyHints([
    { credentialId: 'credA', prfSalt: 'saltA' },
    { credentialId: 'credB', prfSalt: 'saltB' },
  ]);
  expect(await latestPasskeyHint()).toEqual({ credentialId: 'credB', prfSalt: 'saltB' });
});

test('caps stored hints but never evicts the last-used one', async () => {
  await rememberPasskeyHints([{ credentialId: 'used', prfSalt: 'usedSalt' }], 'used');
  for (let i = 0; i < 12; i++) {
    await rememberPasskeyHints([{ credentialId: `cred${i}`, prfSalt: `salt${i}` }]);
  }
  expect(await latestPasskeyHint()).toEqual({ credentialId: 'used', prfSalt: 'usedSalt' });
});

test('a corrupt store degrades to no hint, not a crash', async () => {
  await AsyncStorage.setItem('hc_passkey_prf_hints', 'not json');
  expect(await latestPasskeyHint()).toBeNull();
  await rememberPasskeyHints([{ credentialId: 'credA', prfSalt: 'saltA' }], 'credA');
  expect(await latestPasskeyHint()).toEqual({ credentialId: 'credA', prfSalt: 'saltA' });
});
