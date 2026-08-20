import { assertPasskeyForLogin } from '../passkeys';
import type { PasskeyChallenge } from '../../api';

// The assertion half of the usernameless one-prompt contract (auth-identity.md
// "Passkey" — Usernameless): with no server salts, the device's cached hint
// rides as a TOP-LEVEL prf.eval (WebAuthn forbids evalByCredential next to an
// empty allowCredentials) — and because that form evaluates against whichever
// credential the picker chooses, the output is only honored when the choice
// matches the hint. A foreign pick must surface prfOutput: null so the caller
// falls back to the post-auth unlock instead of failing on a wrong-salt output.

const mockGet = jest.fn();
jest.mock('react-native-passkeys', () => ({
  isSupported: () => true,
  get: (req: unknown) => mockGet(req),
  create: jest.fn(),
}));
jest.mock('@household/crypto/adapters/native', () => ({ loadHouseholdCrypto: jest.fn() }));
jest.mock('../../api', () => ({ authApi: {} }));
jest.mock('../../config', () => ({ PASSKEY_RP_ID: 'calen.test' }));

const HINT = { credentialId: 'credA', prfSalt: 'saltA' };

function challenge(allowCredentials: PasskeyChallenge['allowCredentials']): PasskeyChallenge {
  return { challengeId: 'ch1', challenge: 'challenge-b64', rpId: 'calen.test', allowCredentials };
}

function assertion(id: string, prfFirst?: string) {
  return {
    id,
    clientExtensionResults: prfFirst ? { prf: { results: { first: prfFirst } } } : {},
  };
}

beforeEach(() => mockGet.mockReset());

test('username-first salts still evaluate per credential (hint ignored)', async () => {
  mockGet.mockResolvedValue(assertion('credA', 'prf-out'));
  const res = await assertPasskeyForLogin(
    challenge([{ id: 'credA', prfSalt: 'serverSaltA' }]),
    HINT
  );
  expect(mockGet.mock.calls[0][0].extensions).toEqual({
    prf: { evalByCredential: { credA: { first: 'serverSaltA' } } },
  });
  expect(res).toMatchObject({ credentialId: 'credA', prfOutput: 'prf-out' });
});

test('usernameless + hint: the salt rides as a top-level eval and the output unlocks', async () => {
  mockGet.mockResolvedValue(assertion('credA', 'prf-out'));
  const res = await assertPasskeyForLogin(challenge([]), HINT);
  expect(mockGet.mock.calls[0][0].extensions).toEqual({ prf: { eval: { first: 'saltA' } } });
  expect(res).toMatchObject({ credentialId: 'credA', prfOutput: 'prf-out' });
});

test('usernameless + hint, but the picker chose another account: output discarded', async () => {
  mockGet.mockResolvedValue(assertion('credB', 'wrong-salt-output'));
  const res = await assertPasskeyForLogin(challenge([]), HINT);
  expect(res).toMatchObject({ credentialId: 'credB', prfOutput: null });
});

test('usernameless with no hint sends no PRF extension', async () => {
  mockGet.mockResolvedValue(assertion('credA'));
  const res = await assertPasskeyForLogin(challenge([]), null);
  expect(mockGet.mock.calls[0][0].extensions).toBeUndefined();
  expect(res).toMatchObject({ credentialId: 'credA', prfOutput: null });
});

test('cancel still returns null', async () => {
  mockGet.mockResolvedValue(null);
  expect(await assertPasskeyForLogin(challenge([]), HINT)).toBeNull();
});
