// Round-trip test of the dual-control guardian recovery flow
// (lib/guardianRecovery.ts, spec: features/guardian-recovery.md) over the REAL
// crypto: arm → request → guardian approve → PIN finish. The API is an
// in-memory blind relay (it only ever holds `outer` and the re-sealed inner as
// opaque strings), and the e2ee session is faked to whichever device the step
// runs on — so the test proves neither leg alone recovers the key and the
// wrong PIN fails without burning the request.
jest.mock('@household/crypto/adapters/native', () => require('@household/crypto/adapters/web'));

type KP = { publicKey: Uint8Array; privateKey: Uint8Array };
let mockActiveKeyPair: KP | null = null; // whose device is "unlocked" right now
const mockImported: { pub: string; priv: string }[] = [];
jest.mock('../e2ee', () => ({
  getKeyPair: () => mockActiveKeyPair,
  currentUserId: () => 'user-1',
  importLinkedKeyPair: async (pub: string, priv: string) => {
    mockImported.push({ pub, priv });
    return 'ready';
  },
}));

// In-memory keychain: shared across jest.isolateModules re-requires, so it can
// play the part of storage that outlives a module (app) restart.
const mockKeychain = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  setItemAsync: async (k: string, v: string) => { mockKeychain.set(k, v); },
  getItemAsync: async (k: string) => mockKeychain.get(k) ?? null,
  deleteItemAsync: async (k: string) => { mockKeychain.delete(k); },
}));

// The blind relay: stores opaque strings, never opens them.
const mockRelay = {
  guardianPub: '' as string, // /keys/public/:userId
  userPub: '' as string, // /keys/me → identityPublicKey
  outer: null as string | null,
  ephemeralPublicKey: null as string | null,
  sealedPayload: null as string | null,
  // Opt-in real-server semantics: delivering the sealed payload burns the slot,
  // and any later poll 404s (for the two-poller race test).
  burnOnDelivery: false,
  slotBurned: false,
};
jest.mock('../../api', () => ({
  keysApi: {
    publicKey: async () => ({ data: { identityPublicKey: mockRelay.guardianPub } }),
    guardianArm: async ({ outer }: { outer: string }) => { mockRelay.outer = outer; return { data: { ok: true } }; },
    guardianDisarm: async () => { mockRelay.outer = null; return { data: { ok: true } }; },
    guardianRequest: async ({ ephemeralPublicKey }: { ephemeralPublicKey: string }) => {
      mockRelay.ephemeralPublicKey = ephemeralPublicKey;
      return { data: { requestId: 'req-1', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } };
    },
    guardianPoll: async () => {
      if (mockRelay.slotBurned) {
        const e: any = new Error('That recovery request has expired');
        e.response = { status: 404 };
        throw e;
      }
      if (!mockRelay.sealedPayload) return { data: { status: 'pending' } };
      const sealedPayload = mockRelay.sealedPayload;
      if (mockRelay.burnOnDelivery) {
        mockRelay.sealedPayload = null;
        mockRelay.slotBurned = true;
      }
      return { data: { status: 'sealed', sealedPayload } };
    },
    guardianApprove: async ({ sealedPayload }: { sealedPayload: string }) => {
      mockRelay.sealedPayload = sealedPayload;
      return { data: { ok: true } };
    },
    me: async () => ({ data: { identityPublicKey: mockRelay.userPub } }),
  },
}));

import { loadHouseholdCrypto } from '@household/crypto/adapters/web';
import {
  armGuardian, startGuardianRecovery, pollGuardianRecovery,
  finishGuardianRecovery, approveGuardianRecovery, getRecoveryProgress,
} from '../guardianRecovery';

const PIN = '4321';
let user: KP;
let guardian: KP;

beforeAll(async () => {
  const crypto = await loadHouseholdCrypto();
  user = crypto.generateIdentityKeyPair();
  guardian = crypto.generateIdentityKeyPair();
  mockRelay.guardianPub = crypto.b64(guardian.publicKey);
  mockRelay.userPub = crypto.b64(user.publicKey);
});

test('the full dual-control journey recovers the original identity key', async () => {
  const crypto = await loadHouseholdCrypto();

  // Arm, on the user's unlocked device. The server receives only `outer`.
  mockActiveKeyPair = user;
  const { fingerprint } = await armGuardian('guardian-1', PIN);
  expect(fingerprint).toBe(crypto.publicKeyFingerprint(mockRelay.guardianPub));
  expect(mockRelay.outer).toBeTruthy();
  expect(mockRelay.outer).not.toContain(crypto.b64(user.privateKey));

  // Recovery request, on a fresh locked device (no keypair).
  mockActiveKeyPair = null;
  const started = await startGuardianRecovery();
  expect(started.requestId).toBe('req-1');
  expect(started.fingerprint).toBe(crypto.publicKeyFingerprint(mockRelay.ephemeralPublicKey!));
  expect(await pollGuardianRecovery('req-1')).toBe('pending');

  // Guardian leg: their unlocked device re-seals the inner to the ephemeral
  // key. The re-sealed payload differs from `outer` (it is NOT a passthrough —
  // and still never contains the private key).
  mockActiveKeyPair = guardian;
  await approveGuardianRecovery({
    requestId: 'req-1',
    outer: mockRelay.outer!,
    ephemeralPublicKey: mockRelay.ephemeralPublicKey!,
  } as never);
  expect(mockRelay.sealedPayload).toBeTruthy();
  expect(mockRelay.sealedPayload).not.toBe(mockRelay.outer);

  // User leg: poll picks it up; the wrong PIN fails WITHOUT burning the slot;
  // the right PIN recovers the exact original private key.
  mockActiveKeyPair = null;
  expect(await pollGuardianRecovery('req-1')).toBe('ready');
  expect(await finishGuardianRecovery('0000')).toBe(false);
  expect(mockImported).toHaveLength(0);

  expect(await finishGuardianRecovery(PIN)).toBe(true);
  expect(mockImported).toHaveLength(1);
  expect(mockImported[0].pub).toBe(crypto.b64(user.publicKey));
  expect(mockImported[0].priv).toBe(crypto.b64(user.privateKey));
});

test('guard rails: a locked guardian cannot approve; an unknown request reads as expired', async () => {
  mockActiveKeyPair = null;
  await expect(
    approveGuardianRecovery({ requestId: 'req-x', outer: 'x', ephemeralPublicKey: 'y' } as never),
  ).rejects.toThrow(/unlock/i);

  expect(await pollGuardianRecovery('some-other-request')).toBe('expired');
});

test('arming requires an unlocked vault', async () => {
  mockActiveKeyPair = null;
  await expect(armGuardian('guardian-1', PIN)).rejects.toThrow(/unlock/i);
});

// The shared-device / app-restart journey: the requester's module state (the
// ephemeral secret) is gone by the time the approval lands — signing out so the
// guardian could sign in and approve, or the app killed during the wait. A
// fresh module instance must resume from the keychain slot and finish.
test('an in-flight recovery survives losing module state (sign-out / restart)', async () => {
  const crypto = await loadHouseholdCrypto();

  mockActiveKeyPair = user;
  await armGuardian('guardian-1', PIN);

  mockRelay.sealedPayload = null;
  mockActiveKeyPair = null;
  await startGuardianRecovery();

  // Guardian approves while the requester's module state no longer exists.
  mockActiveKeyPair = guardian;
  await approveGuardianRecovery({
    requestId: 'req-1',
    outer: mockRelay.outer!,
    ephemeralPublicKey: mockRelay.ephemeralPublicKey!,
  } as never);

  // "Relaunch": a brand-new module instance, empty memory, same keychain.
  let fresh!: typeof import('../guardianRecovery');
  jest.isolateModules(() => { fresh = require('../guardianRecovery'); });
  mockActiveKeyPair = null;
  const importsBefore = mockImported.length;

  const resumed = await fresh.resumeGuardianRecovery();
  expect(resumed?.requestId).toBe('req-1');
  expect(await fresh.pollGuardianRecovery('req-1')).toBe('ready');
  expect(await fresh.finishGuardianRecovery(PIN)).toBe(true);
  expect(mockImported).toHaveLength(importsBefore + 1);
  expect(mockImported[mockImported.length - 1].priv).toBe(crypto.b64(user.privateKey));

  // Finishing cleared the slot — the next visit starts a fresh request.
  expect(await fresh.resumeGuardianRecovery()).toBeNull();
});

// The pop-up lane and the Privacy & Security banner read the requester's state
// through getRecoveryProgress: 'none' without a keychain slot, 'waiting'
// before the guardian acts, 'ready' after — and reaching 'ready' claims and
// persists the sealed handoff exactly like the recover screen's poll would.
test('getRecoveryProgress: none → waiting → ready across the journey', async () => {
  mockKeychain.clear();
  mockRelay.sealedPayload = null;
  mockRelay.slotBurned = false;
  expect(await getRecoveryProgress()).toEqual({ status: 'none', requestId: null });

  mockActiveKeyPair = user;
  await armGuardian('guardian-1', PIN);
  mockActiveKeyPair = null;
  await startGuardianRecovery();
  expect(await getRecoveryProgress()).toEqual({ status: 'waiting', requestId: 'req-1' });

  mockActiveKeyPair = guardian;
  await approveGuardianRecovery({
    requestId: 'req-1',
    outer: mockRelay.outer!,
    ephemeralPublicKey: mockRelay.ephemeralPublicKey!,
  } as never);
  mockActiveKeyPair = null;
  expect(await getRecoveryProgress()).toEqual({ status: 'ready', requestId: 'req-1' });

  // The handoff it claimed still finishes with the PIN.
  expect(await finishGuardianRecovery(PIN)).toBe(true);
});

// Two pollers race the burn-on-delivery slot in real life: the recover
// screen's 2.5s interval and the pop-up lane's check. The winner claims the
// handoff and the server burns it; the loser's 404 must re-check the local
// stash instead of clearing the slot and reporting the recovery expired.
test('the burn-on-delivery race: a losing 404 poll never kills a claimed recovery', async () => {
  mockKeychain.clear();
  mockRelay.sealedPayload = null;
  mockRelay.slotBurned = false;
  mockRelay.burnOnDelivery = true;

  mockActiveKeyPair = user;
  await armGuardian('guardian-1', PIN);
  mockActiveKeyPair = null;
  await startGuardianRecovery();

  mockActiveKeyPair = guardian;
  await approveGuardianRecovery({
    requestId: 'req-1',
    outer: mockRelay.outer!,
    ephemeralPublicKey: mockRelay.ephemeralPublicKey!,
  } as never);
  mockActiveKeyPair = null;

  // Both polls pass the local stash check before either response lands; the
  // first delivery burns the server slot, so the second poll 404s.
  const results = await Promise.all([
    pollGuardianRecovery('req-1'),
    pollGuardianRecovery('req-1'),
  ]);
  expect(results).toEqual(['ready', 'ready']);

  // Nothing was cleared: the persisted slot still resumes and the PIN finishes.
  expect(await getRecoveryProgress()).toEqual({ status: 'ready', requestId: 'req-1' });
  expect(await finishGuardianRecovery(PIN)).toBe(true);
  mockRelay.burnOnDelivery = false;
});
