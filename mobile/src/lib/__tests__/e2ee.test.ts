// Round-trip tests for the mobile E2EE session (lib/e2ee.ts) — the crypto
// boundary every content record crosses on device. The REAL @household/crypto
// core runs (Jest routes the native adapter to the web/libsodium build); only
// the API relay and the device keychain are in-memory fakes, so enrollment,
// HDK envelopes, rotation, and resource keys exercise the same bytes-in/
// bytes-out paths as production. Spec: platform/crypto-e2ee.md +
// features/auth-identity.md.
jest.mock('@household/crypto/adapters/native', () => require('@household/crypto/adapters/web'));

// In-memory device keychain (the Face-ID biometric cache). `mockDeviceEnabled`
// stands in for whether the cache is armed; `loadDeviceKey` returning non-null
// stands in for a successful Face ID prompt (null = the user canceled).
let mockDeviceKey: string | null = null;
let mockDeviceEnabled = false;
jest.mock('../deviceKey', () => ({
  saveDeviceKey: async (v: string) => { mockDeviceKey = v; },
  loadDeviceKey: async () => mockDeviceKey,
  clearDeviceKey: async () => { mockDeviceKey = null; },
  isDeviceKeyEnabled: async () => mockDeviceEnabled,
}));

// In-memory "server": stores whatever the client uploads, hands it back —
// exactly the blind-relay contract the real API provides.
const mockServer = {
  enrollment: null as null | { identityPublicKey: string; factors: unknown[] },
  householdId: 'hh-test-1',
  currentKeyVersion: 0,
  hdkEnvelopes: [] as { keyVersion: number; wrappedHDK: string }[],
  keyRotationPending: false,
  // null keeps born-encrypted activation parked (recovery not confirmed); a date
  // marks a durable recovery factor confirmed. Drives the re-surface path below.
  recoverySetupAt: null as string | null,
  calendarKeys: new Map<string, { currentKeyVersion: number; household: unknown[]; member: unknown[] }>(),
};

jest.mock('../../api', () => ({
  keysApi: {
    me: async () => ({
      data: mockServer.enrollment
        ? {
            enrolled: true,
            identityPublicKey: mockServer.enrollment.identityPublicKey,
            wrappedPrivateKey: mockServer.enrollment.factors,
            recoverySetupAt: mockServer.recoverySetupAt,
          }
        : { enrolled: false },
    }),
    enroll: async (payload: { identityPublicKey: string; factors: unknown[] }) => {
      mockServer.enrollment = payload;
      return { data: { ok: true } };
    },
    recoveryComplete: async () => ({ data: { ok: true } }),
    putFactor: async () => ({ data: { ok: true } }),
    // Lost-every-factor recovery. The real endpoint also deletes the caller's
    // envelopes; this fake mirrors that so the test can prove the old HDK
    // envelope stops opening anything under the new identity.
    rekey: async (payload: { identityPublicKey: string; factors: unknown[] }) => {
      mockServer.enrollment = { identityPublicKey: payload.identityPublicKey, factors: payload.factors };
      mockServer.hdkEnvelopes = [];
      mockServer.currentKeyVersion = 0;
      mockServer.recoverySetupAt = null;
      return { data: { enrolled: true, envelopesCleared: 1 } };
    },
  },
  householdApi: {
    getKey: async () => ({
      data: {
        householdId: mockServer.householdId,
        currentKeyVersion: mockServer.currentKeyVersion,
        envelopes: mockServer.hdkEnvelopes,
        isOwner: true,
        keyRotationPending: mockServer.keyRotationPending,
      },
    }),
    mintKey: async ({ wrappedHDK, keyVersion }: { wrappedHDK: string; keyVersion: number }) => {
      mockServer.hdkEnvelopes.push({ keyVersion, wrappedHDK });
      mockServer.currentKeyVersion = keyVersion;
      return { data: { keyVersion } };
    },
    memberKeys: async () => ({
      data: mockServer.enrollment
        ? [{ userId: 'me', identityPublicKey: mockServer.enrollment.identityPublicKey }]
        : [],
    }),
    rotateKey: async ({ keyVersion, envelopes }: { keyVersion: number; envelopes: { userId: string; wrappedHDK: string }[] }) => {
      mockServer.hdkEnvelopes.push({ keyVersion, wrappedHDK: envelopes[0].wrappedHDK });
      mockServer.currentKeyVersion = keyVersion;
      mockServer.keyRotationPending = false;
      return { data: { keyVersion } };
    },
    activate: async () => ({ data: { status: 'not-required', e2eeActive: false } }),
  },
  customCalendarsApi: {
    keys: async (resource: string) => ({
      data: mockServer.calendarKeys.get(resource) ?? { currentKeyVersion: 0, household: [], member: [] },
    }),
  },
  tripsApi: {
    keys: async () => ({ data: { currentKeyVersion: 0, household: [], member: [] } }),
  },
}));

import { loadHouseholdCrypto } from '@household/crypto/adapters/web';
import {
  ensureEnrolledOnLogin, ensureHouseholdKey, isUnlocked, lock,
  rememberSessionPassword, hasSessionPassword,
  unlockWithPassword, unlockWithRecoveryCode, getPendingRecoveryCode, clearRecoveryCode,
  sealNew, openRecord, openOpaqueRecord, decryptRecord,
  mintResourceKey, wrapResourceKeyForCollaborator, sealForResource, decryptResourceRecord,
  publicKeyFingerprint, reauthWithBiometric, subscribeKeysReady, rekeyIdentity,
} from '../e2ee';

const PASSWORD = 'correct horse battery staple';
let recoveryCode: string;
let sealedEvent: Record<string, unknown>; // the v1-sealed record, reused across tests

// The tests are one sequential story over the module's session state, mirroring
// a device's life: enroll → seal → lock → unlock → rotate → share.

test('enrollment mints an identity, surfaces the one-time recovery code, and the owner mints HDK v1', async () => {
  const status = await ensureEnrolledOnLogin(PASSWORD);
  expect(status).toBe('enrolled');
  expect(isUnlocked()).toBe(true);
  recoveryCode = getPendingRecoveryCode()!;
  expect(recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/);

  expect(await ensureHouseholdKey()).toBe('ready');
  expect(mockServer.currentKeyVersion).toBe(1);
  expect(mockServer.hdkEnvelopes).toHaveLength(1);
});

test('a sealed record round-trips through the HDK, tagged and untagged', async () => {
  sealedEvent = await sealNew('CalendarEvent', { title: 'Dentist', startDate: '2026-08-01' });
  expect(sealedEvent.enc).toBeTruthy();
  expect(sealedEvent.keyVersion).toBe(1);

  // Typed read (openRecord merges the decrypted fields over the row).
  const open = await openRecord('CalendarEvent', sealedEvent as never);
  expect(open).toMatchObject({ title: 'Dentist', startDate: '2026-08-01' });

  // Opaque read (the v2 envelope carries the collection inside the ciphertext).
  const opaque = await openOpaqueRecord(sealedEvent as never);
  expect(opaque?.collection).toBe('CalendarEvent');
  expect(opaque?.record).toMatchObject({ title: 'Dentist' });
});

test('lock clears the session; the wrong password stays locked; the right one restores decryption', async () => {
  lock();
  expect(isUnlocked()).toBe(false);
  expect(await decryptRecord('CalendarEvent', String(sealedEvent._id), 1, sealedEvent.enc as never)).toBeNull();

  expect(await unlockWithPassword('nope')).toBe(false);
  expect(isUnlocked()).toBe(false);

  expect(await unlockWithPassword(PASSWORD)).toBe(true);
  expect(await ensureHouseholdKey()).toBe('ready'); // re-unwraps the stored HDK envelope
  const dec = await decryptRecord<{ title: string }>('CalendarEvent', String(sealedEvent._id), 1, sealedEvent.enc as never);
  expect(dec?.title).toBe('Dentist');
});

test('the recovery code (reformatted, as a user would type it) also unlocks', async () => {
  lock();
  const reentered = recoveryCode.replace(/-/g, ' ').toLowerCase();
  expect(await unlockWithRecoveryCode(reentered)).toBe(true);
  expect(await unlockWithRecoveryCode.call(null, recoveryCode)).toBe(true); // canonical form too
  expect(await ensureHouseholdKey()).toBe('ready');
});

test('lazy rotation: a pending flag mints v2, new seals use it, v1 records stay readable', async () => {
  mockServer.keyRotationPending = true;
  expect(await ensureHouseholdKey()).toBe('ready');
  expect(mockServer.currentKeyVersion).toBe(2);

  const v2 = await sealNew('Chore', { title: 'Dishes' });
  expect(v2.keyVersion).toBe(2);
  expect((await openRecord('Chore', v2 as never)) as never).toMatchObject({ title: 'Dishes' });

  // The pre-rotation record still opens (old HDK versions are kept for reads).
  const oldRead = await decryptRecord<{ title: string }>('CalendarEvent', String(sealedEvent._id), 1, sealedEvent.enc as never);
  expect(oldRead?.title).toBe('Dentist');
});

test('resource keys: mint, seal, decrypt — and a collaborator can unwrap their member wrap', async () => {
  const resource = 'custom-family';
  const minted = await mintResourceKey(resource, 1);
  expect(minted).toBeTruthy();
  expect(minted!.household.hdkVersion).toBe(2);

  const sealed = await sealForResource('calendar', 'CalendarEvent', 'ev-1', resource, { title: 'Recital' });
  expect(sealed?.enc.ks).toBe('cal');
  const dec = await decryptResourceRecord<{ title: string }>('calendar', 'CalendarEvent', 'ev-1', resource, 1, sealed!.enc);
  expect(dec?.title).toBe('Recital');

  // Wrap to an outside collaborator; their device (their keypair) unwraps the
  // same key bytes via the shared core — no HDK involved.
  const crypto = await loadHouseholdCrypto();
  const collaborator = crypto.generateIdentityKeyPair();
  const wrapped = await wrapResourceKeyForCollaborator(resource, 1, crypto.b64(collaborator.publicKey));
  expect(wrapped).toBeTruthy();
  const unwrapped = crypto.unwrapResourceKeyForMember(wrapped!, collaborator);
  expect([...unwrapped]).toEqual([...minted!.key]);
});

// subscribeKeysReady is the signal the app-root re-pull hangs off (store/auth):
// it must fire the moment the current HDK first becomes held — the transition the
// first post-sign-in record sync raced ahead of — and NOT re-fire on every ready
// re-check, or the re-pull/invalidate would loop. Mirrors a relock→unlock relaunch.
test('subscribeKeysReady fires once when the HDK first lands, not on repeat ready checks', async () => {
  let fired = 0;
  const unsub = subscribeKeysReady(() => { fired += 1; });
  try {
    lock(); // drops the keypair + every cached HDK, as a relaunch/app-lock would
    expect(await unlockWithPassword(PASSWORD)).toBe(true);
    expect(fired).toBe(0); // keypair unlock alone is not "keys ready"

    expect(await ensureHouseholdKey()).toBe('ready'); // absent → held: signal fires
    expect(fired).toBe(1);

    expect(await ensureHouseholdKey()).toBe('ready'); // already held: no re-fire
    expect(fired).toBe(1);
  } finally {
    unsub();
  }
});

test('fingerprints are stable per key and differ across keys', async () => {
  const crypto = await loadHouseholdCrypto();
  const pub = mockServer.enrollment!.identityPublicKey;
  const fp1 = await publicKeyFingerprint(pub);
  expect(fp1).toBe(await publicKeyFingerprint(pub));
  const other = crypto.b64(crypto.generateIdentityKeyPair().publicKey);
  expect(await publicKeyFingerprint(other)).not.toBe(fp1);
});

// reauthWithBiometric backs the biometric-first password change (PrivacyDataScreen):
// a fresh Face ID prompt in place of re-typing the current password. It always
// forces the keychain read (proof of presence), independent of the in-memory
// session, and only succeeds when the cache is armed AND the prompt returns a key.
describe('reauthWithBiometric', () => {
  test('false when the biometric cache is not armed', async () => {
    mockDeviceEnabled = false;
    mockDeviceKey = 'cached';
    expect(await reauthWithBiometric()).toBe(false);
  });

  test('false when armed but the prompt is canceled (no key returned)', async () => {
    mockDeviceEnabled = true;
    mockDeviceKey = null;
    expect(await reauthWithBiometric()).toBe(false);
  });

  test('true when armed and the Face ID prompt succeeds', async () => {
    mockDeviceEnabled = true;
    mockDeviceKey = 'cached';
    expect(await reauthWithBiometric()).toBe(true);
  });
});

// Force-quitting the recovery-code modal before saving the code loses the display
// (the one-time code is memory-only, never stored server-side). Rather than
// stranding the user, the next unlock re-surfaces the modal with a FRESH code, at
// most once per session — but only while recovery is still unconfirmed. Spec:
// platform/crypto-e2ee.md → "Recovery-code confirmation gate".
describe('recovery-code re-surface on next unlock', () => {
  // Activation/re-surface runs fire-and-forget off ensureHouseholdKey (`void
  // maybeActivateBornEncrypted()`), so the modal appears a tick later — as in
  // production. Flush the queue before asserting on the surfaced code.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('an unconfirmed account gets a fresh code minted and surfaced on unlock', async () => {
    mockServer.recoverySetupAt = null; // never confirmed (force-quit before saving)
    lock();
    clearRecoveryCode(); // the in-memory code is gone, as after an app restart
    expect(getPendingRecoveryCode()).toBeNull();

    expect(await unlockWithPassword(PASSWORD)).toBe(true);
    expect(await ensureHouseholdKey()).toBe('ready');
    await flush();

    const resurfaced = getPendingRecoveryCode();
    expect(resurfaced).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/);
    expect(resurfaced).not.toBe(recoveryCode); // a fresh code — the unsaved one is invalidated

    // Once per session: a second ensureHouseholdKey doesn't churn another code.
    clearRecoveryCode();
    expect(await ensureHouseholdKey()).toBe('ready');
    await flush();
    expect(getPendingRecoveryCode()).toBeNull();
  });

  test('a confirmed account is not re-prompted (born-encrypted drop proceeds)', async () => {
    mockServer.recoverySetupAt = '2026-07-30T00:00:00.000Z'; // recovery confirmed
    lock();
    clearRecoveryCode();

    expect(await unlockWithPassword(PASSWORD)).toBe(true);
    expect(await ensureHouseholdKey()).toBe('ready');
    await flush();
    expect(getPendingRecoveryCode()).toBeNull(); // no modal — recovery is durable
  });
});

// Deliberately LAST in the file: re-keying abandons the identity every test
// above built on, so anything after it would be testing a different account.
describe('re-key (lost every unlock factor)', () => {
  test('mints a new identity, orphans the old data, and re-arms the recovery modal', async () => {
    expect(await unlockWithPassword(PASSWORD)).toBe(true);
    const oldPublicKey = mockServer.enrollment!.identityPublicKey;
    // A record sealed under the identity we're about to abandon.
    const doomed = await sealNew('CalendarEvent', { title: 'Old world', startDate: '2026-08-01' });

    clearRecoveryCode();
    const result = await rekeyIdentity(PASSWORD);
    expect(result.ok).toBe(true);

    // A genuinely new identity — not a re-wrap of the old private key.
    expect(mockServer.enrollment!.identityPublicKey).not.toBe(oldPublicKey);
    // Unlocked immediately (the caller just proved the password), but holding
    // nothing yet: the old HDK envelope was sealed to a key that no longer
    // exists, so what it protected is gone for good. This is the whole point —
    // re-keying recovers ACCESS to what others re-share, never DATA.
    expect(isUnlocked()).toBe(true);
    expect(
      await decryptRecord('CalendarEvent', String(doomed._id), 1, doomed.enc as never),
    ).toBeNull();

    // Recovery is unconfirmed again, so the one-time code is surfaced for the
    // mandatory modal — a fresh one, never the old account's.
    const fresh = getPendingRecoveryCode();
    expect(fresh).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/);
    expect(fresh).not.toBe(recoveryCode);
    // And the NEW code is what opens the new identity from a locked session.
    lock();
    expect(await unlockWithRecoveryCode(fresh!)).toBe(true);
  });

  test('surfaces the server’s data-loss guard instead of throwing', async () => {
    const { keysApi } = require('../../api');
    const real = keysApi.rekey;
    keysApi.rekey = async () => {
      const err: any = new Error('Request failed with status code 409');
      err.response = { status: 409, data: { code: 'confirm_data_loss', recordCount: 7, recoverableByHousehold: true } };
      throw err;
    };
    try {
      const result = await rekeyIdentity(PASSWORD);
      // A recoverable result, not an exception: the caller has to be able to
      // put the real numbers in front of the user before retrying.
      expect(result).toEqual({
        ok: false, needsConfirm: true, recordCount: 7, recoverableByHousehold: true,
      });
    } finally {
      keysApi.rekey = real;
    }
  });
});

// The memory-only hold that lets a re-key skip the password prompt
// (platform/crypto-e2ee.md "Re-key"). A reset changes the login password and
// re-wraps nothing, so the user lands signed-in-but-locked holding a password
// the server has just verified — asking them to retype it on the screen they
// reached BECAUSE they lost access is friction with no security value. The
// password stays load-bearing either way: it is what the new private half gets
// sealed under, so with nothing held the call must fail rather than mint an
// identity carrying no password factor.
describe('the session password held for re-key', () => {
  afterEach(() => { lock(); });

  test('a failed unlock at sign-in holds the password; lock drops it', async () => {
    lock();
    expect(hasSessionPassword()).toBe(false);

    // Right password → unlocked, nothing to hold (the re-key path is moot).
    expect(await ensureEnrolledOnLogin(PASSWORD)).toBe('unlocked');
    expect(hasSessionPassword()).toBe(false);

    // Sign-in the server accepted, envelope that won't open — the post-reset
    // shape. THIS is what gets held.
    lock();
    expect(await ensureEnrolledOnLogin('the-new-password')).toBe('locked');
    expect(hasSessionPassword()).toBe(true);

    // Sign-out calls lock(), so the password never outlives the session.
    lock();
    expect(hasSessionPassword()).toBe(false);
  });

  test('rekeyIdentity(null) uses the held password, and refuses without one', async () => {
    lock();
    // Nothing held: minting an identity with no password factor would re-lock
    // the user on their next relaunch, so this fails loudly instead.
    await expect(rekeyIdentity(null)).rejects.toThrow(/password/i);

    rememberSessionPassword('reset-me-123');
    clearRecoveryCode();
    expect((await rekeyIdentity(null)).ok).toBe(true);

    // The held password really is the new wrapping key: it opens the new
    // identity from a cold, locked session.
    lock();
    expect(await unlockWithPassword('reset-me-123')).toBe(true);
  });
});
