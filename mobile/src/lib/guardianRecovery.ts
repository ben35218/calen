// Guardian recovery, dual-control (specs/features/guardian-recovery.md).
//
// Opt-in backstop: a household member helps the user back in, but neither party
// alone can open the identity key. The key is wrapped under TWO locks — an INNER
// 4-digit PIN (Argon2id) then an OUTER anonymous sealed box to the guardian's
// identity key. Recovery needs BOTH the guardian (unseals the outer box) and the
// user's PIN (opens the inner). Reuses the audited @household/crypto primitives
// and the same blind-relay shape as device linking (lib/deviceLink.ts).
//
// NB: a 4-digit PIN is a speed bump, not a wall against a *determined* guardian
// — they hold the PIN-locked inner and could brute-force it offline. The model
// rests on nominating a member you already trust with your data.

import * as SecureStore from 'expo-secure-store';
import { loadHouseholdCrypto } from '@household/crypto/adapters/native';
import type { IdentityKeyPair } from '@household/crypto';
import { keysApi, type GuardianRequest } from '../api';
import { currentUserId, getKeyPair, importLinkedKeyPair } from './e2ee';

// ── Arm / disarm (user, unlocked) ───────────────────────────────────────────

// Wrap this (unlocked) account's private key under a household member + a 4-digit
// PIN and store it. Returns the guardian's safety number so the UI can show what
// was verified. Throws if the vault is locked.
export async function armGuardian(guardianUserId: string, pin: string): Promise<{ fingerprint: string }> {
  const kp = getKeyPair();
  if (!kp) throw new Error('Unlock your encryption before setting up a guardian.');
  const crypto = await loadHouseholdCrypto();
  const { data } = await keysApi.publicKey(guardianUserId);
  const guardianPub = crypto.unb64(data.identityPublicKey);
  const fingerprint = crypto.publicKeyFingerprint(data.identityPublicKey);
  const outer = crypto.createGuardianEnvelope(kp.privateKey, pin, guardianPub);
  await keysApi.guardianArm({ guardianUserId, guardianFingerprint: fingerprint, outer });
  return { fingerprint };
}

export async function disarmGuardian(): Promise<void> {
  await keysApi.guardianDisarm();
}

// ── Recovery (recovering device, locked) ────────────────────────────────────

// The one-shot ephemeral keypair + the sealed handoff, held across the poll loop.
let ephemeral: IdentityKeyPair | null = null;
let ephemeralRequestId: string | null = null;
let sealedInner: string | null = null; // stashed until the user enters their PIN

// The in-flight recovery ALSO persists to the keychain, keyed per user, because
// approval can take a while and only THIS ephemeral secret can open it: losing
// the module state — app killed while waiting, or (shared-device flow) signing
// out so the guardian can sign in and approve — used to orphan the approval
// unrecoverably. The sealed handoff joins the slot once polled (the server
// burns it on delivery, so the device copy is the only one after that). It all
// stays PIN-locked (the same offline-brute-force residual the guardian
// already holds); WHEN_UNLOCKED_THIS_DEVICE_ONLY, no biometric gate — resume
// must run silently on a locked account. Cleared on finish and on expiry.
type StoredRecovery = {
  requestId: string;
  fingerprint: string;
  expiresAt: string;
  publicKey: string; // b64
  privateKey: string; // b64 (the ephemeral secret — never leaves the device)
  sealedInner?: string;
};

const STORE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const storeKey = (userId: string) => `hc_guardian_recovery_${userId}`;

async function saveStored(userId: string, s: StoredRecovery): Promise<void> {
  try { await SecureStore.setItemAsync(storeKey(userId), JSON.stringify(s), STORE_OPTS); } catch { /* best-effort */ }
}
async function loadStored(userId: string): Promise<StoredRecovery | null> {
  try {
    const raw = await SecureStore.getItemAsync(storeKey(userId), STORE_OPTS);
    return raw ? (JSON.parse(raw) as StoredRecovery) : null;
  } catch {
    return null;
  }
}
async function clearStored(userId: string | null): Promise<void> {
  if (!userId) return;
  await SecureStore.deleteItemAsync(storeKey(userId)).catch(() => {});
}

export interface StartedRecovery {
  requestId: string;
  fingerprint: string; // shown on both screens; the guardian confirms it matches
  expiresAt: string;
}

// Open a recovery request: mint the ephemeral keypair, register the relay slot,
// and return the fingerprint to compare with the guardian out-of-band.
export async function startGuardianRecovery(): Promise<StartedRecovery> {
  const crypto = await loadHouseholdCrypto();
  ephemeral = crypto.generateLinkKeyPair();
  sealedInner = null;
  const ephemeralPublicKey = crypto.b64(ephemeral.publicKey);
  const fingerprint = crypto.publicKeyFingerprint(ephemeralPublicKey);
  const { data } = await keysApi.guardianRequest({ ephemeralPublicKey, fingerprint });
  ephemeralRequestId = data.requestId;
  const userId = currentUserId();
  if (userId) {
    await saveStored(userId, {
      requestId: data.requestId,
      fingerprint,
      expiresAt: data.expiresAt,
      publicKey: ephemeralPublicKey,
      privateKey: crypto.b64(ephemeral.privateKey),
    });
  }
  return { requestId: data.requestId, fingerprint, expiresAt: data.expiresAt };
}

// Restore a persisted in-flight recovery for the signed-in user, or null when
// there is none worth resuming. An expired, still-unapproved slot is cleared; a
// slot already holding the sealed handoff never expires client-side (PIN entry
// is offline from here).
export async function resumeGuardianRecovery(): Promise<StartedRecovery | null> {
  const userId = currentUserId();
  if (!userId) return null;
  const s = await loadStored(userId);
  if (!s) return null;
  if (!s.sealedInner && new Date(s.expiresAt).getTime() < Date.now()) {
    await clearStored(userId);
    return null;
  }
  const crypto = await loadHouseholdCrypto();
  ephemeral = { publicKey: crypto.unb64(s.publicKey), privateKey: crypto.unb64(s.privateKey) };
  ephemeralRequestId = s.requestId;
  sealedInner = s.sealedInner ?? null;
  return { requestId: s.requestId, fingerprint: s.fingerprint, expiresAt: s.expiresAt };
}

// Poll once. 'ready' means the guardian approved and the sealed inner is stashed
// locally — call finishGuardianRecovery(pin) next. Safe to call on an interval.
export async function pollGuardianRecovery(requestId: string): Promise<'pending' | 'ready' | 'expired'> {
  if (!ephemeral || ephemeralRequestId !== requestId) return 'expired';
  if (sealedInner) return 'ready';
  let res;
  try {
    res = await keysApi.guardianPoll(requestId);
  } catch (e: any) {
    if (e?.response?.status === 404) {
      await clearStored(currentUserId());
      return 'expired';
    }
    return 'pending'; // transient network error — keep polling
  }
  if (res.data.status !== 'sealed' || !res.data.sealedPayload) return 'pending';
  sealedInner = res.data.sealedPayload;
  // The server just burned its copy — persist ours before anything can lose it.
  const userId = currentUserId();
  if (userId) {
    const s = await loadStored(userId);
    if (s && s.requestId === requestId) await saveStored(userId, { ...s, sealedInner });
  }
  return 'ready';
}

// Open the stashed handoff with the ephemeral key + the user's 4-digit PIN →
// unlock the account with the recovered identity key. Returns false on a wrong
// PIN (the user can retry without re-requesting). The public half comes from
// /keys/me; importLinkedKeyPair caches to biometrics and unwraps the HDK.
export async function finishGuardianRecovery(pin: string): Promise<boolean> {
  if (!ephemeral || !sealedInner) return false;
  const crypto = await loadHouseholdCrypto();
  let privateKey: Uint8Array;
  try {
    privateKey = crypto.recoverWithGuardian(sealedInner, ephemeral, pin);
  } catch {
    return false; // wrong PIN — inner secretbox MAC failed
  }
  const { data } = await keysApi.me();
  if (!data.identityPublicKey) return false;
  await importLinkedKeyPair(data.identityPublicKey, crypto.b64(privateKey));
  ephemeral = null;
  ephemeralRequestId = null;
  sealedInner = null;
  await clearStored(currentUserId());
  return true;
}

// ── Approve (guardian, unlocked) ────────────────────────────────────────────

// Unseal the requester's outer blob with this device's key and re-seal the
// still-PIN-locked inner to their ephemeral key. The guardian never learns the
// requester's key (no PIN). Throws if the guardian's vault is locked.
export async function approveGuardianRecovery(request: GuardianRequest): Promise<void> {
  const kp = getKeyPair();
  if (!kp) throw new Error('Unlock your encryption before approving a recovery.');
  const crypto = await loadHouseholdCrypto();
  const inner = crypto.unsealGuardianOuter(request.outer, kp);
  const sealedPayload = crypto.resealGuardianInner(inner, crypto.unb64(request.ephemeralPublicKey));
  await keysApi.guardianApprove({ requestId: request.requestId, sealedPayload });
}
