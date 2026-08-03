// Mobile E2EE session: enrollment + unlock on top of @household/crypto.
//
// Phase 1 mirror of client/src/services/e2ee.js. On login/register we ensure the
// account has an identity keypair (enroll if not) and hold the unlocked keypair
// in memory for the session. The private key is NEVER persisted to disk here — a
// relaunch re-unlocks from the password (later phases add a passkey/biometric
// path). A tiny subscriber store surfaces the one-time recovery code to a modal,
// matching the pattern in lib/privacyPrefs.ts. See docs/E2EE-SYNC-PLAN.md §3.4.

import { createEnrollment, type StoredKeyMaterial, type IdentityKeyPair, type RecordEnvelope } from '@household/crypto';
import { loadHouseholdCrypto } from '@household/crypto/adapters/native';
import { keysApi, householdApi, customCalendarsApi, tripsApi, type HDKEnvelopePayload } from '../api';
import { saveDeviceKey, loadDeviceKey, clearDeviceKey, isDeviceKeyEnabled } from './deviceKey';

let enrollment: Awaited<ReturnType<typeof buildEnrollment>> | null = null;
let keyPair: IdentityKeyPair | null = null;
// Every HDK version this session can unwrap, keyed by version. Under lazy
// rotation (§5.2) records sealed before a rotation stay at their old version, so
// we must keep old HDKs to read them while writing new records under the current
// version. `hdkVersion` is the *current* (write) version.
const hdks = new Map<number, Uint8Array>();
let hdkVersion = 0; // the current HDK version (bound into new-record AAD)
let hdkHouseholdId: string | null = null; // the household the HDK belongs to (bound into record AAD)
// Born-encrypted activation is attempted once per unlocked session (see
// maybeActivateBornEncrypted). Reset on lock so the next session re-checks.
let bornEncryptedActivated = false;
// The recovery-code modal is re-surfaced at most once per unlocked session for an
// account that still hasn't confirmed a durable recovery factor — the soft
// recovery from force-quitting before saving the code (see maybeResurfaceRecovery).
// Reset on lock so the next session re-checks.
let recoveryResurfaced = false;

// Fired when a household flips to e2eeActive (born-encrypted activation lands).
// Activation runs in the background from several paths (register→recovery,
// leave-household, on-unlock), so the UI needs a signal to refetch the
// `['household']` query — otherwise the encryption status stays stale-false and
// looks unencrypted even though the drop already committed. See RecoveryCodeModal.
const activationListeners = new Set<() => void>();
export function subscribeE2eeActivated(cb: () => void): () => void {
  activationListeners.add(cb);
  return () => activationListeners.delete(cb);
}
function notifyActivated(): void {
  for (const cb of activationListeners) { try { cb(); } catch { /* listener isolation */ } }
}

// Fired when the household data key (HDK) first becomes available this session —
// the current-version key transitions from absent → held inside ensureHouseholdKey
// (a fresh login/relaunch unwrap, a just-minted owner key, or a household switch).
// Distinct from subscribeLockState (which flips the instant the *keypair* unlocks,
// BEFORE the HDK is loaded) and from subscribeE2eeActivated (born-encrypted drop):
// this is the "records are now decryptable" signal. The record-sync pull races
// ahead of unlock on sign-in — its first pass blocks every undecryptable row and
// parks the cursor — so the app-root subscriber re-pulls + refetches the replica-
// backed views here, otherwise the calendar/people/etc. stay empty until a manual
// mutation invalidates them. Fires only on a genuine transition (not on every
// ensureHouseholdKey call once the key is already held), so it can't loop.
const keysReadyListeners = new Set<() => void>();
export function subscribeKeysReady(cb: () => void): () => void {
  keysReadyListeners.add(cb);
  return () => keysReadyListeners.delete(cb);
}
function notifyKeysReady(): void {
  for (const cb of keysReadyListeners) { try { cb(); } catch { /* listener isolation */ } }
}

function currentHDK(): Uint8Array | null {
  return hdks.get(hdkVersion) ?? null;
}

// One-time recovery code + subscribers (so a root modal can display it once).
let pendingRecoveryCode: string | null = null;
// When held, enrollment stashes the recovery code but doesn't surface the modal
// yet. The register-with-passkey flow holds it across the passkey step so a
// passkey failure/rollback isn't buried under (or confusingly preceded by) the
// recovery modal — the code is released only once the passkey succeeds.
let recoveryHeld = false;
const subs = new Set<() => void>();
function emit() { subs.forEach((fn) => fn()); }

// Lock-state subscribers: notified whenever the session flips locked↔unlocked, so
// UI that reflects "is my data readable here" (the profile lock badge, the
// Profile-view unlock prompt) updates the instant an unlock happens on any
// screen — no focus re-read race. All keyPair writes go through setKeyPair.
const lockSubs = new Set<() => void>();
export function subscribeLockState(fn: () => void): () => void {
  lockSubs.add(fn);
  return () => lockSubs.delete(fn);
}
function setKeyPair(next: IdentityKeyPair | null): void {
  const was = keyPair != null;
  keyPair = next;
  if ((next != null) !== was) lockSubs.forEach((fn) => fn());
}

export function subscribeRecoveryCode(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function getPendingRecoveryCode(): string | null {
  return pendingRecoveryCode;
}
export function clearRecoveryCode() {
  pendingRecoveryCode = null;
  recoveryHeld = false;
  emit();
}

// Defer surfacing the recovery-code modal until releaseRecoveryCode() — used by
// the register-with-passkey flow so the recovery code only appears after the
// passkey step resolves (never alongside a passkey-failure popup).
export function holdRecoveryCode() {
  recoveryHeld = true;
}
// Surface a held recovery code now (if enrollment stashed one). Clears the hold.
export function releaseRecoveryCode() {
  recoveryHeld = false;
  if (pendingRecoveryCode) emit();
}

async function buildEnrollment() {
  const crypto = await loadHouseholdCrypto();
  return createEnrollment(crypto);
}
async function getEnrollment() {
  if (!enrollment) enrollment = await buildEnrollment();
  return enrollment;
}

export function isUnlocked(): boolean {
  return keyPair != null;
}
export function getKeyPair(): IdentityKeyPair | null {
  return keyPair;
}

// Signal-parity C4 (hide record authorship): the current user's id, sealed inside
// every HDK record's ciphertext as `author` so the household keeps the "who wrote
// this" fact while the server (which nulls the plaintext `userId` column) cannot
// see it. Set from the auth store on sign-in; null when signed out. NOT used for
// resource-scoped (cal/trip) records — those keep a plaintext routing userId.
let sealAuthorId: string | null = null;
export function setSealAuthor(userId: string | null): void {
  sealAuthorId = userId || null;
}
// The signed-in user's id (same value setSealAuthor holds). Exposed so non-hook
// libs (calendar assembly, reminders) can identify the self-Person without the
// server: post-C3b the unified store returns no `selfId`, so callers derive it
// from here + the decrypted roster. Returns null when signed out / pre-unlock.
export function currentUserId(): string | null {
  return sealAuthorId;
}
export function getHDK(): Uint8Array | null {
  return currentHDK();
}
export function lock() {
  setKeyPair(null);
  hdks.clear();
  hdkVersion = 0;
  hdkHouseholdId = null;
  bornEncryptedActivated = false;
  recoveryResurfaced = false;
  sessionPassword = null;
  clearCalendarKeys();
}

// ── The session's account password, in memory only ──────────────────────────
//
// A password reset changes the LOGIN password and re-wraps nothing, so the user
// lands signed-in-but-locked holding a password the server has just accepted
// and the envelope provably cannot open. Re-keying then needs a password to
// wrap the NEW private key under (`enroll` → `createPasswordFactor`) — and
// asking for the one they typed a minute ago, on a screen that exists because
// they lost access, is friction with no security value: the server already
// verified it, and the private key sitting in memory beside it is strictly more
// sensitive than the password.
//
// So the two places that verify a password and STILL end up locked hand it here
// (`resetPassword` in store/auth, `ensureEnrolledOnLogin` below), and
// `rekeyIdentity` uses it instead of prompting. Memory only: never persisted,
// never written to the keychain, and dropped by `lock()` — which sign-out
// calls, and which `rekeyIdentity` itself calls once the new key lands.
let sessionPassword: string | null = null;

// Called by the reset flow, which verifies a password server-side and then
// discovers the E2EE envelope is stale.
export function rememberSessionPassword(password: string) {
  sessionPassword = password || null;
}

// Whether a re-key can proceed without asking. Callers use this to decide
// between firing straight away and putting up a password sheet.
export function hasSessionPassword(): boolean {
  return sessionPassword != null;
}

// ── Biometric device-key cache (Face ID relaunch, no password) ───────────────
// After any successful unlock we stash the identity keypair behind the device's
// biometric gate (deviceKey.ts) so the next cold start unlocks with Face ID
// instead of the account password. The private key never changes across factor
// changes, so we cache once (guarded by the marker) and never re-write.
async function cacheKeyPairToDevice(): Promise<void> {
  if (!keyPair) return;
  const crypto = await loadHouseholdCrypto();
  const serialized = JSON.stringify({
    pub: crypto.b64(keyPair.publicKey),
    priv: crypto.b64(keyPair.privateKey),
  });
  // Clear-then-add so the write is always a fresh (silent) keychain insert. This
  // (a) avoids the biometric prompt an in-place update would trigger right after
  // the user just unlocked, and (b) self-heals an item the OS invalidated after
  // the enrolled biometrics changed (.biometryCurrentSet) — re-binding to the
  // current set instead of leaving a permanently unreadable cache.
  await clearDeviceKey();
  await saveDeviceKey(serialized);
}

// Unlock a locked session from the biometric device cache — a single Face ID /
// Touch ID prompt, no password. Returns false when the cache is empty, the user
// cancels, or the stored blob is unreadable (callers fall back to passkey /
// password / recovery code).
export async function unlockFromDeviceCache(): Promise<boolean> {
  if (keyPair) return true;
  if (!(await isDeviceKeyEnabled())) return false;
  const serialized = await loadDeviceKey();
  if (!serialized) return false;
  try {
    const crypto = await loadHouseholdCrypto();
    const { pub, priv } = JSON.parse(serialized) as { pub: string; priv: string };
    setKeyPair({ publicKey: crypto.unb64(pub), privateKey: crypto.unb64(priv) });
    return true;
  } catch {
    setKeyPair(null);
    return false;
  }
}

// Fresh biometric re-authentication for a sensitive change (e.g. changing the
// password on PrivacyDataScreen), used in place of re-typing the current
// password. Unlike unlockFromDeviceCache this always forces a Face ID / Touch ID
// prompt even when the key is already in memory — proof of presence, not an
// unlock. Returns false when the cache isn't armed, the user cancels, or the
// blob is unreadable (callers fall back to the typed current password).
export async function reauthWithBiometric(): Promise<boolean> {
  if (!(await isDeviceKeyEnabled())) return false;
  return (await loadDeviceKey()) != null;
}

// Whether this device has armed the biometric unlock cache (for a settings row
// and to decide whether to attempt a Face ID unlock on relaunch).
export { isDeviceKeyEnabled as hasDeviceKeyCache };

// Forget the biometric cache (logout, or a user turning it off). The account is
// still reachable via password / passkey / recovery code.
export async function forgetDeviceKey(): Promise<void> {
  await clearDeviceKey();
}

// ── Household Data Key (HDK) — Phase 2 ───────────────────────────────────────
// Mirrors client/src/services/e2ee.js ensureHouseholdKey: unwrap my envelope, or
// (if I own a keyless household) mint HDK v1 and self-wrap, or stay keyless until
// a family member approves me. See docs/E2EE-SYNC-PLAN.md §5.
export async function ensureHouseholdKey(): Promise<'locked' | 'ready' | 'pending'> {
  if (!keyPair) return 'locked';
  const crypto = await loadHouseholdCrypto();
  const { data } = await householdApi.getKey();
  const householdId = data.householdId || null;
  const current = data.currentKeyVersion || 0;

  // Household changed under us (left/joined/deleted) → drop every cached version
  // so we don't decrypt against an orphaned HDK or skip minting a fresh key. Also
  // re-arm born-encrypted activation: `bornEncryptedActivated` is a once-per-
  // session latch, and the household we just moved into (e.g. the fresh solo one
  // created by "leave household") is born unencrypted — without this reset the
  // latch from the previous household would suppress its auto-activation, leaving
  // it plaintext until the user manually turned encryption on.
  if (hdkHouseholdId !== householdId) {
    hdks.clear();
    hdkVersion = 0;
    hdkHouseholdId = householdId;
    bornEncryptedActivated = false;
  }

  // Whether we already held the current-version HDK on entry — so we only signal a
  // genuine absent → held transition below (not every ready re-check on focus).
  const hadCurrentHDK = current > 0 && hdks.has(current);

  // Unwrap every envelope we don't already hold — including older versions — so a
  // record sealed before a rotation stays decryptable.
  for (const e of data.envelopes || []) {
    if (!hdks.has(e.keyVersion)) {
      try { hdks.set(e.keyVersion, crypto.unwrapHDK(e.wrappedHDK, keyPair)); } catch { /* skip a bad envelope */ }
    }
  }

  if (current > 0 && hdks.has(current)) {
    hdkVersion = current;
    // A departed member left this household keyed for rotation (§5.2). Drive it
    // now, best-effort — a concurrent rotation by another member just 409s and
    // we pick up their new envelope on the next call.
    if (data.keyRotationPending) { try { await rotateHouseholdKey(); } catch { /* non-fatal */ } }
    // HDK just became available (sign-in/relaunch unwrap): tell the app to re-pull
    // + refetch the replica-backed views, whose first sync raced ahead of unlock.
    if (!hadCurrentHDK) notifyKeysReady();
    void maybeActivateBornEncrypted(); // fire-and-forget: drop plaintext if still pending
    return 'ready';
  }
  if (current === 0 && data.isOwner) {
    const fresh = crypto.generateHDK();
    await householdApi.mintKey({ wrappedHDK: crypto.wrapHDKForMember(fresh, keyPair.publicKey), keyVersion: 1 });
    hdks.set(1, fresh);
    hdkVersion = 1;
    notifyKeysReady(); // fresh owner key minted — records are now sealable/readable
    void maybeActivateBornEncrypted(); // fresh owner: finalize born-encrypted state
    return 'ready';
  }
  return 'pending';
}

// §5.2 lazy rotation: mint a fresh HDK for the next version and wrap it to every
// current member, so a removed/departed member can't read future writes. Old
// versions stay in the map for reading historical records. Self-healing —
// invoked from ensureHouseholdKey when the server flags keyRotationPending.
export async function rotateHouseholdKey(): Promise<boolean> {
  if (!keyPair || !hdkHouseholdId || !hdks.has(hdkVersion)) return false;
  const crypto = await loadHouseholdCrypto();
  const nextVersion = hdkVersion + 1;
  const { data: members } = await householdApi.memberKeys();
  if (!members.length) return false;
  const fresh = crypto.generateHDK();
  const envelopes = members.map((m) => ({
    userId: m.userId,
    wrappedHDK: crypto.wrapHDKForMember(fresh, crypto.unb64(m.identityPublicKey)),
  }));
  try {
    const { data } = await householdApi.rotateKey({ keyVersion: nextVersion, envelopes });
    hdks.set(data.keyVersion, fresh);
    hdkVersion = data.keyVersion;
    return true;
  } catch {
    return false;
  }
}

// ── Per-resource content keys (Signal-parity D1 calendars / D2 trips) ─────────
// An outside-shared calendar's events (D1) and a shared trip's Trip + TripItems +
// attachments (D2) seal under a per-resource key (CalendarKey / TripKey), not the
// HDK, so cross-household collaborators can read them without a plaintext feed.
// This session caches every version it can unwrap, keyed by the globally-unique
// resource id (a calendar's `custom-<slug>` key, or a Trip `_id`) → (version →
// key bytes) — one cache, since the two id spaces never collide. Populated lazily
// from `GET /calendars/:key/keys` or `GET /trips/:id/keys` (household wrap via the
// HDK, or a member wrap via the identity key). See §D1/§D2.
type ResourceKind = 'calendar' | 'trip';
const resourceKeys = new Map<string, Map<number, Uint8Array>>();
const resourceKeyCurrent = new Map<string, number>(); // resource → current version

function cacheResourceKey(resource: string, version: number, key: Uint8Array): void {
  let byVersion = resourceKeys.get(resource);
  if (!byVersion) { byVersion = new Map(); resourceKeys.set(resource, byVersion); }
  byVersion.set(version, key);
}
export function getResourceKey(resource: string, version: number): Uint8Array | null {
  return resourceKeys.get(resource)?.get(version) ?? null;
}
export function currentResourceKeyVersion(resource: string): number {
  return resourceKeyCurrent.get(resource) ?? 0;
}

// Fetch the resource's key envelopes from the right endpoint (calendar vs trip).
async function fetchResourceKeys(kind: ResourceKind, resource: string) {
  if (kind === 'trip') { const { data } = await tripsApi.keys(resource); return data; }
  const { data } = await customCalendarsApi.keys(resource); return data;
}

// Fetch + unwrap every version we can for one resource, caching them. Returns the
// current version (0 = none / not readable). Best-effort: an un-unwrappable
// envelope (locked, or not yet wrapped to us) is skipped.
export async function loadResourceKeys(kind: ResourceKind, resource: string): Promise<number> {
  if (!keyPair) return 0;
  const crypto = await loadHouseholdCrypto();
  let data;
  try { data = await fetchResourceKeys(kind, resource); } catch { return 0; }
  resourceKeyCurrent.set(resource, data.currentKeyVersion || 0);
  for (const e of data.household || []) {
    if (getResourceKey(resource, e.keyVersion)) continue;
    const hdk = hdks.get(e.hdkVersion);
    if (!hdk || !hdkHouseholdId) continue;
    try {
      cacheResourceKey(resource, e.keyVersion,
        crypto.unwrapResourceKeyFromHousehold(hdk, JSON.parse(e.wrappedKey), resource, e.keyVersion, String(hdkHouseholdId), e.hdkVersion));
    } catch { /* skip a bad/foreign envelope */ }
  }
  for (const e of data.member || []) {
    if (getResourceKey(resource, e.keyVersion)) continue;
    try {
      cacheResourceKey(resource, e.keyVersion, crypto.unwrapResourceKeyForMember(e.wrappedKey, keyPair));
    } catch { /* skip */ }
  }
  return data.currentKeyVersion || 0;
}

// Seal a record under a resource key (current version). Returns { enc, keyVersion }
// with `enc.ks === 'cal' | 'trip'`, or null if the key isn't held.
export async function sealForResource(
  kind: ResourceKind, collection: string, id: string, resource: string, fields: unknown,
): Promise<{ enc: RecordEnvelope; keyVersion: number } | null> {
  const version = currentResourceKeyVersion(resource);
  const key = version ? getResourceKey(resource, version) : null;
  if (!key || !hdkHouseholdId) return null;
  const crypto = await loadHouseholdCrypto();
  const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: version, scope: { kind, resource, version } };
  return { enc: crypto.encryptRecord(key, loc, fields), keyVersion: version };
}

// Decrypt a resource-sealed record (`enc.ks` set) back to its fields, or null if
// we hold no key for its version. `resource` = the calendar's calendarType (D1)
// or the record's Trip id (D2).
export async function decryptResourceRecord<T = Record<string, unknown>>(
  kind: ResourceKind, collection: string, id: string, resource: string, keyVersion: number | undefined,
  enc: { alg: string; nonce: string; ct: string } | undefined | null,
): Promise<T | null> {
  if (!enc || !hdkHouseholdId) return null;
  const version = keyVersion ?? currentResourceKeyVersion(resource);
  let key = getResourceKey(resource, version);
  if (!key) { await loadResourceKeys(kind, resource).catch(() => {}); key = getResourceKey(resource, version); }
  if (!key) return null;
  const crypto = await loadHouseholdCrypto();
  const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: version, scope: { kind, resource, version } };
  try {
    return crypto.decryptRecord<T>(key, loc, enc as RecordEnvelope);
  } catch {
    return null;
  }
}

// ── Resource-key provisioning (owner device) ─────────────────────────────────
// Mint a fresh resource key and wrap it to the owning household (via the HDK). The
// owner posts this at first-share (v1) and on revoke-rotation (vN+1). Returns the
// generated key + the household wrap payload, or null if locked.
export async function mintResourceKey(
  resource: string, keyVersion: number,
): Promise<{ key: Uint8Array; household: { hdkVersion: number; wrappedKey: string } } | null> {
  const hdk = currentHDK();
  if (!hdk || !hdkHouseholdId) return null;
  const crypto = await loadHouseholdCrypto();
  const key = crypto.generateResourceKey();
  const wrapped = crypto.wrapResourceKeyForHousehold(hdk, key, resource, keyVersion, String(hdkHouseholdId), hdkVersion);
  cacheResourceKey(resource, keyVersion, key);
  resourceKeyCurrent.set(resource, keyVersion);
  return { key, household: { hdkVersion, wrappedKey: JSON.stringify(wrapped) } };
}

// Wrap a held resource key to a collaborator's identity public key (approve-on-
// device). Returns the sealed box, or null if the key isn't held.
export async function wrapResourceKeyForCollaborator(
  resource: string, keyVersion: number, memberPublicKeyB64: string,
): Promise<string | null> {
  const key = getResourceKey(resource, keyVersion);
  if (!key) return null;
  const crypto = await loadHouseholdCrypto();
  return crypto.wrapResourceKeyForMember(key, crypto.unb64(memberPublicKeyB64));
}

// ── Event-invitation sealed snapshots (Signal-parity D3) ──────────────────────
// A one-shot anonymous sealed box of the event snapshot to ONE recipient's
// identity key (no versioned key / rotation — unlike the resource keys above).
// The organizer seals to the invitee's key at invite time; the recipient's
// device seals to its own key on the lazy upgrade. Sealing needs only the
// recipient's PUBLIC key, so it works even while our own vault is locked.
export async function sealInvitationSnapshot(
  snapshot: unknown, recipientPublicKeyB64: string,
): Promise<string> {
  const crypto = await loadHouseholdCrypto();
  return crypto.sealJsonToMember(snapshot, crypto.unb64(recipientPublicKeyB64));
}

// Open a sealed invitation snapshot with our identity key, or null if we're
// locked / it wasn't sealed to us.
export async function openInvitationSnapshot<T = Record<string, unknown>>(
  sealed: string,
): Promise<T | null> {
  if (!keyPair) return null;
  const crypto = await loadHouseholdCrypto();
  try {
    return crypto.openJsonFromMember<T>(sealed, keyPair);
  } catch {
    return null;
  }
}

// Our own identity public key (b64), so the recipient can re-seal a claimed
// plaintext invite to itself on the D3 lazy upgrade. Null while locked.
export async function myIdentityPublicKey(): Promise<string | null> {
  if (!keyPair) return null;
  const crypto = await loadHouseholdCrypto();
  return crypto.b64(keyPair.publicKey);
}

// Drop cached resource keys (called on lock).
function clearCalendarKeys(): void {
  resourceKeys.clear();
  resourceKeyCurrent.clear();
}

// ── D1 calendar-named wrappers (kept so D1 callers stay untouched) ────────────
export const getCalendarKey = getResourceKey;
export const currentCalendarKeyVersion = currentResourceKeyVersion;
export const loadCalendarKeys = (resource: string) => loadResourceKeys('calendar', resource);
export const mintCalendarKey = mintResourceKey;
export const wrapCalendarKeyForMember = wrapResourceKeyForCollaborator;
export const sealForCalendar = (collection: string, id: string, resource: string, fields: unknown) =>
  sealForResource('calendar', collection, id, resource, fields);
export const decryptCalendarRecord = <T = Record<string, unknown>>(
  collection: string, id: string, resource: string, keyVersion: number | undefined,
  enc: { alg: string; nonce: string; ct: string } | undefined | null,
) => decryptResourceRecord<T>('calendar', collection, id, resource, keyVersion, enc);

// ── Born-encrypted activation (mandatory E2EE) ───────────────────────────────
// After a fresh solo owner enrolls → mints the HDK → seeds their self-Person, a
// mandated household flips itself E2EE-live on first login: the server drops its
// plaintext (§9) so the boundary is live from day one. Idempotent and best-
// effort — a not-yet-ready or exempt household is simply left as-is. On the first
// login the register-seeded self-Person is still plaintext, so a `stragglers`
// result triggers the re-encrypt pass (which seals it) and one retry.
export async function activateBornEncryptedHousehold(): Promise<boolean> {
  if (!currentHDK()) return false; // no key held → nothing to activate yet
  let { data } = await householdApi.activate();
  if (data.status === 'stragglers') {
    // Seal any server-seeded plaintext (e.g. the self-Person), then retry once.
    const { reencryptStragglers } = await import('./dropMigration');
    await reencryptStragglers().catch(() => {});
    ({ data } = await householdApi.activate());
  }
  const active = !!data.e2eeActive;
  if (active) notifyActivated(); // let the UI refetch the household's encryption status
  return active;
}

// Finalize born-encrypted activation opportunistically, whenever the key becomes
// available — not just on a password login. A household created under the mandate
// stays dual-stored (encrypted + a plaintext copy the server still serves) until
// its plaintext is dropped; that drop only runs here. Previously it was tied to
// initE2EE (password/register), so an account that only ever signed in with email
// codes or a passkey never dropped its plaintext. Called from ensureHouseholdKey
// (the one chokepoint every unlock path funnels through once the HDK is ready).
//
// Attempted once per unlocked session; a network failure re-arms it for the next
// unlock, and an exempt/not-required household simply no-ops after one attempt.
async function maybeActivateBornEncrypted(): Promise<void> {
  if (bornEncryptedActivated || !currentHDK()) return;
  // Don't drop the server's plaintext fallback until the account can durably get
  // back in. Until a non-password recovery factor is confirmed (the recovery code
  // saved, or a passkey enrolled — recoverySetupAt), a user who force-quit the
  // recovery modal, skipped saving the code, or lost their only device would be
  // permanently, unrecoverably locked out with no plaintext to fall back on. Stay
  // dual-stored until then; re-checked on every unlock, so the drop lands as soon
  // as recovery is set up (and immediately when the recovery modal completes).
  try {
    if (await recoveryNeedsSetup()) {
      // No durable factor yet — keep the plaintext fallback, and re-prompt the
      // user to save a recovery code instead of silently leaving them stranded on
      // the "you set one up but never confirmed it" cliff (see below).
      await maybeResurfaceRecovery();
      return;
    }
  } catch {
    return; // couldn't confirm recovery state — err toward keeping the fallback
  }
  bornEncryptedActivated = true;
  try {
    await activateBornEncryptedHousehold();
  } catch {
    bornEncryptedActivated = false; // transient — retry on the next unlock
  }
}

// Soft recovery from force-quitting the recovery-code modal before saving the
// code. The one-time code lives only in memory (`pendingRecoveryCode`) and is
// never stored server-side, so closing the app before confirming loses the
// *display* — though the account itself is unharmed (still dual-stored with a
// plaintext fallback until recovery is confirmed; see maybeActivateBornEncrypted).
// Rather than make the user hunt through Privacy & data to mint a new one, we
// re-surface the one-time modal on the next unlock with a FRESH code (the unsaved
// one is invalidated). At most once per session; skipped when a code is already
// pending (the first-enrollment modal is up) or deliberately held (the
// register-with-passkey flow surfaces it after the passkey step).
async function maybeResurfaceRecovery(): Promise<void> {
  if (recoveryResurfaced || recoveryHeld || pendingRecoveryCode || !keyPair) return;
  recoveryResurfaced = true;
  try {
    await regenerateRecoveryCode(); // mints, persists the new factor, surfaces the modal
  } catch {
    recoveryResurfaced = false; // transient (e.g. offline) — retry on the next unlock
  }
}

// ── Record encryption (Phase 3 dual-write) ───────────────────────────────────
// A client-minted Mongo ObjectId so a new encrypted record's AAD can bind to its
// _id before the server round-trip. 4-byte time + 8 random bytes as hex.
export async function newObjectId(): Promise<string> {
  const crypto = await loadHouseholdCrypto();
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const rand = Array.from(crypto.randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
  return ts + rand;
}

// A high-entropy secret minted on-device to bootstrap the E2EE envelope at
// registration, standing in for the retired signup password. The user never
// sees or types it — durability comes from the mandatory recovery code + passkey
// enrolled during onboarding. See docs/PASSWORDLESS-E2EE-PLAN.md §5c (this keeps
// the register KEK password-derived internally while the UI is passwordless).
export async function generateAccountSecret(): Promise<string> {
  const crypto = await loadHouseholdCrypto();
  return crypto.b64(crypto.randomBytes(32));
}

// Encrypt a record's content. Returns { enc, keyVersion } to send alongside the
// plaintext payload, or null if this session holds no HDK. See §3.2.
export async function encryptRecord(
  collection: string,
  id: string,
  fields: unknown,
): Promise<{ enc: RecordEnvelope; keyVersion: number } | null> {
  const hdk = currentHDK();
  if (!hdk || !hdkHouseholdId) return null;
  const crypto = await loadHouseholdCrypto();
  const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: hdkVersion };
  return { enc: crypto.encryptRecord(hdk, loc, fields), keyVersion: hdkVersion };
}

// Decrypt a record's `enc` blob back to its fields, or null if we can't (no HDK,
// no blob, or an AAD/version mismatch — the caller falls back to plaintext).
export async function decryptRecord<T = Record<string, unknown>>(
  collection: string,
  id: string,
  keyVersion: number | undefined,
  enc: { alg: string; nonce: string; ct: string } | undefined | null,
): Promise<T | null> {
  if (!hdkHouseholdId || !enc) return null;
  const version = keyVersion ?? hdkVersion;
  const hdk = hdks.get(version);
  if (!hdk) return null;
  const crypto = await loadHouseholdCrypto();
  const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: version };
  try {
    return crypto.decryptRecord<T>(hdk, loc, enc as RecordEnvelope);
  } catch {
    return null;
  }
}

// ── Dual-write convenience wrappers (one-liners for content forms) ────────────
type Rec = Record<string, unknown>;
// `fields` is the content subset to encrypt (defaults to the whole payload). Pass
// a subset for records whose plaintext carries populated refs or server-scheduled
// dates, so decrypt-on-load can safely merge without clobbering them.
// Augment a create payload with a client-minted _id + ciphertext, or return it
// unchanged when this session holds no HDK (so saving is never blocked).
export async function sealNew(collection: string, payload: Rec, fields?: Rec): Promise<Rec> {
  const _id = await newObjectId();
  const sealed = await encryptRecord(collection, _id, withAuthor(fields ?? payload));
  return sealed ? { _id, ...payload, ...sealed } : payload;
}
// Augment an update payload with re-encrypted ciphertext at the current version.
export async function sealUpdate(collection: string, id: string, payload: Rec, fields?: Rec): Promise<Rec> {
  const sealed = await encryptRecord(collection, id, withAuthor(fields ?? payload));
  return sealed ? { ...payload, ...sealed } : payload;
}
// Signal-parity C4: fold the author into the sealed HDK payload, so the household
// retains it while the server's plaintext `userId` column is nulled. Omitted when
// unknown (never blocks a seal); harmless extra JSON field on decrypt.
function withAuthor(fields: Rec): Rec {
  return sealAuthorId ? { author: sealAuthorId, ...fields } : fields;
}
// Return a fetched record with its decrypted content merged over the plaintext
// (falls back to the plaintext the server returned when we can't decrypt).
export async function openRecord<T extends { _id: string; keyVersion?: number; calendarType?: string; tripId?: string; enc?: { alg: string; nonce: string; ct: string; ks?: string } }>(
  collection: string,
  record: T,
): Promise<T> {
  if (!record) return record;
  // Signal-parity D1/D2: a resource-sealed record decrypts with its resource key,
  // not the HDK — a CalendarKey for `enc.ks === 'cal'` (resource = its
  // calendarType), a TripKey for `enc.ks === 'trip'` (resource = its Trip id: the
  // record's own tripId for a TripItem, or its _id for the Trip record itself).
  let dec: Partial<T> | null;
  if (record.enc?.ks === 'cal' && record.calendarType) {
    dec = await decryptResourceRecord<Partial<T>>('calendar', collection, record._id, record.calendarType, record.keyVersion, record.enc);
  } else if (record.enc?.ks === 'trip') {
    dec = await decryptResourceRecord<Partial<T>>('trip', collection, record._id, record.tripId ?? record._id, record.keyVersion, record.enc);
  } else {
    dec = await decryptRecord<Partial<T>>(collection, record._id, record.keyVersion, record.enc);
  }
  return dec ? ({ ...record, ...dec } as T) : record;
}

// Signal-parity C3 (opaque record envelopes / unified store): decrypt a row from
// the unified `/records/sync` feed WITHOUT knowing its collection up front — the
// v2 envelope carries the type inside the ciphertext, so `decryptRecordTagged`
// recovers it. Routes to the right key by `enc.ks` (HDK / CalendarKey / TripKey),
// exactly like openRecord, but returns `{ collection, record }` so the caller can
// bucket the decrypted record into its per-collection replica. Returns null when
// the key isn't held or the blob won't open (a v1 row needs its collection, so it
// can't be read opaquely — the flip re-seals those to v2 first).
export async function openOpaqueRecord<T extends Rec = Rec>(
  row: {
    _id: string; householdId?: string; keyVersion?: number; deleted?: boolean;
    enc?: { alg: string; nonce: string; ct: string; ks?: string };
    scope?: { kind: 'calendar' | 'trip'; resource: string; version: number };
  },
): Promise<{ collection: string; record: T } | null> {
  if (!row?.enc) return null;
  const crypto = await loadHouseholdCrypto();
  try {
    if (row.enc.ks === 'cal' || row.enc.ks === 'trip') {
      const kind: 'calendar' | 'trip' = row.enc.ks === 'cal' ? 'calendar' : 'trip';
      const resource = row.scope?.resource;
      if (!resource) return null;
      const version = row.scope?.version ?? row.keyVersion ?? currentResourceKeyVersion(resource);
      const key = getResourceKey(resource, version);
      if (!key) return null;
      const loc = { collection: '', id: row._id, householdId: String(hdkHouseholdId ?? ''), keyVersion: version, scope: { kind, resource, version } };
      const { collection, record } = crypto.decryptRecordTagged<T>(key, loc, row.enc as RecordEnvelope);
      return { collection, record: { ...(row as Rec), ...(record as Rec) } as T };
    }
    const version = row.keyVersion ?? hdkVersion;
    const hdk = hdks.get(version);
    if (!hdk) return null;
    const loc = { collection: '', id: row._id, householdId: String(hdkHouseholdId ?? ''), keyVersion: version };
    const { collection, record } = crypto.decryptRecordTagged<T>(hdk, loc, row.enc as RecordEnvelope);
    return { collection, record: { ...(row as Rec), ...(record as Rec) } as T };
  } catch {
    return null;
  }
}

// ── Attachment encryption (Phase 4c) ─────────────────────────────────────────
// Encrypt file bytes for `collection`/`id`: a fresh per-file key encrypts the
// bytes (chunked AEAD), and that key is HDK-wrapped bound to the record. Returns
// the serialized ciphertext to upload + the wrapped key (JSON string) + version,
// or null if this session holds no HDK. Mirrors the web `encryptAttachment`.
const ATTACH_CHUNK = 1024 * 1024; // 1 MiB chunks

export async function encryptAttachment(
  collection: string,
  id: string,
  bytes: Uint8Array,
): Promise<{ ciphertext: Uint8Array; wrappedFileKey: string; keyVersion: number } | null> {
  const hdk = currentHDK();
  if (!hdk || !hdkHouseholdId) return null;
  const crypto = await loadHouseholdCrypto();
  const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: hdkVersion };
  const fileKey = crypto.generateFileKey();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += ATTACH_CHUNK) chunks.push(bytes.subarray(i, i + ATTACH_CHUNK));
  const enc = crypto.encryptFile(fileKey, chunks);
  const wrapped = crypto.wrapFileKey(hdk, fileKey, loc);
  return {
    ciphertext: new TextEncoder().encode(JSON.stringify(enc)),
    wrappedFileKey: JSON.stringify(wrapped),
    keyVersion: hdkVersion,
  };
}

// Signal-parity D2: encrypt an attachment whose per-file key wraps under a
// RESOURCE key (a TripKey) instead of the HDK — for a shared_shared trip booking's
// one shared receipt, which every participant (holding the TripKey, not the
// owner's HDK) must open. The file bytes are the same random-Kf chunked AEAD; only
// the Kf wrap differs (its envelope carries ks='trip'). `resource` = the Trip id;
// null if the resource key isn't held (caller falls back to HDK / plaintext).
export async function encryptAttachmentForResource(
  kind: ResourceKind,
  collection: string,
  id: string,
  resource: string,
  bytes: Uint8Array,
): Promise<{ ciphertext: Uint8Array; wrappedFileKey: string; keyVersion: number } | null> {
  const version = currentResourceKeyVersion(resource);
  const key = version ? getResourceKey(resource, version) : null;
  if (!key || !hdkHouseholdId) return null;
  const crypto = await loadHouseholdCrypto();
  const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: version, scope: { kind, resource, version } };
  const fileKey = crypto.generateFileKey();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += ATTACH_CHUNK) chunks.push(bytes.subarray(i, i + ATTACH_CHUNK));
  const enc = crypto.encryptFile(fileKey, chunks);
  const wrapped = crypto.wrapFileKey(key, fileKey, loc);
  return {
    ciphertext: new TextEncoder().encode(JSON.stringify(enc)),
    wrappedFileKey: JSON.stringify(wrapped),
    keyVersion: version,
  };
}

// Reverse of encryptAttachment / encryptAttachmentForResource: unwrap the file key
// (routing by the wrap envelope's ks — the HDK for an HDK-wrapped key, else the
// resource key named by `resource`) and decrypt the ciphertext back to the
// original bytes, or null if we can't (no key for that version, malformed blob).
export async function decryptAttachment(
  collection: string,
  id: string,
  keyVersion: number | undefined,
  wrappedFileKey: string,
  ciphertext: Uint8Array,
  resource?: string,
): Promise<Uint8Array | null> {
  if (!hdkHouseholdId) return null;
  const crypto = await loadHouseholdCrypto();
  let wrapped: { ks?: string };
  try { wrapped = JSON.parse(wrappedFileKey); } catch { return null; }
  try {
    // Resource-wrapped Kf (D1 'cal' / D2 'trip'): unwrap with the resource key.
    if (wrapped.ks && resource) {
      const kind: ResourceKind = wrapped.ks === 'trip' ? 'trip' : 'calendar';
      const version = keyVersion ?? currentResourceKeyVersion(resource);
      let key = getResourceKey(resource, version);
      if (!key) { await loadResourceKeys(kind, resource).catch(() => {}); key = getResourceKey(resource, version); }
      if (!key) return null;
      const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: version, scope: { kind, resource, version } };
      const fileKey = crypto.unwrapFileKey(key, wrapped as never, loc);
      return crypto.decryptFile(fileKey, JSON.parse(new TextDecoder().decode(ciphertext)));
    }
    // HDK-wrapped Kf: pick the right HDK version.
    const version = keyVersion ?? hdkVersion;
    const hdk = hdks.get(version);
    if (!hdk) return null;
    const loc = { collection, id, householdId: String(hdkHouseholdId), keyVersion: version };
    const fileKey = crypto.unwrapFileKey(hdk, wrapped as never, loc);
    return crypto.decryptFile(fileKey, JSON.parse(new TextDecoder().decode(ciphertext)));
  } catch {
    return null;
  }
}

// Human-comparable fingerprint of a public key, for out-of-band verification.
export async function publicKeyFingerprint(publicKeyB64: string): Promise<string> {
  const crypto = await loadHouseholdCrypto();
  return crypto.publicKeyFingerprint(publicKeyB64);
}

// Wrap this session's HDK to a join requester's public key (approver path).
export async function wrapHDKForJoiner(
  requesterPublicKeyB64: string,
  keyVersion: number,
): Promise<HDKEnvelopePayload | null> {
  const hdk = currentHDK();
  if (!hdk) return null;
  const crypto = await loadHouseholdCrypto();
  return {
    wrappedHDK: crypto.wrapHDKForMember(hdk, crypto.unb64(requesterPublicKeyB64)),
    keyVersion,
  };
}

// Called after a successful login/register. Enrolls on first use (raising the
// one-time recovery code) or unlocks the existing keypair with the password.
// Returns the resulting status; 'locked' means the password didn't unlock it and
// the user must use another factor.
export async function ensureEnrolledOnLogin(
  password: string,
): Promise<'enrolled' | 'unlocked' | 'locked'> {
  const enroll = await getEnrollment();
  const { data } = await keysApi.me();

  if (!data.enrolled) {
    const result = enroll.enroll(password);
    await keysApi.enroll(result.payload);
    setKeyPair(result.keyPair);
    pendingRecoveryCode = result.recoveryCodeDisplay;
    if (!recoveryHeld) emit(); // held → surfaced later via releaseRecoveryCode()
    await cacheKeyPairToDevice();
    return 'enrolled';
  }

  const material = data as unknown as StoredKeyMaterial;
  try {
    setKeyPair(enroll.unlockWithPassword(material, password));
    await cacheKeyPairToDevice();
    return 'unlocked';
  } catch {
    setKeyPair(null);
    // Sign-in succeeded but the envelope didn't open — the post-reset case.
    // Hold the password so a re-key doesn't have to ask for it again.
    sessionPassword = password;
    return 'locked';
  }
}

// ── Lost-every-factor recovery: mint a NEW identity ─────────────────────────
//
// The escape hatch behind the viewer shell's "Request access" button (see
// specs/platform/crypto-e2ee.md "Re-key" and billing-plans.md "Free viewer
// mode"). Generates a fresh identity keypair — wrapped under the CURRENT
// password, plus a fresh one-time recovery code — and replaces the account's
// key material outright.
//
// It recovers ACCESS, never DATA. Everything sealed to the old identity stays
// sealed forever; there is still no server-side override. That costs a viewer
// nothing (the shared events belong to the calendar's owner, who re-wraps the
// CalendarKey to the new key once they approve), and costs an account with
// records of its own all of them — hence the server's `confirm_data_loss` gate,
// surfaced here as a `needsConfirm` result rather than a thrown error so the
// caller can put the real numbers in front of the user before retrying.
//
// Re-keying grants nothing by itself: it makes every collaboration pending the
// owner's approval.
//
// The password is the WRAPPING KEY for the new private half, not a checkpoint —
// pass `null` to use the one this session already verified at sign-in (see
// `sessionPassword` above), which is what spares a user who just reset their
// password from typing it again. With neither, there is nothing to wrap under
// and the call fails loudly rather than minting an identity nobody can open.
export type RekeyResult =
  | { ok: true }
  | { ok: false; needsConfirm: true; recordCount: number; recoverableByHousehold: boolean };

export async function rekeyIdentity(
  password: string | null,
  opts: { confirmDataLoss?: boolean } = {},
): Promise<RekeyResult> {
  const secret = password || sessionPassword;
  if (!secret) throw new Error('Enter your password to set this phone up again.');
  const enroll = await getEnrollment();
  const result = enroll.enroll(secret);
  try {
    await keysApi.rekey({ ...result.payload, confirmDataLoss: opts.confirmDataLoss });
  } catch (e) {
    const res = (e as { response?: { status?: number; data?: Record<string, unknown> } }).response;
    if (res?.status === 409 && res.data?.code === 'confirm_data_loss') {
      return {
        ok: false,
        needsConfirm: true,
        recordCount: Number(res.data.recordCount) || 0,
        recoverableByHousehold: !!res.data.recoverableByHousehold,
      };
    }
    throw e;
  }
  // Every key this session held was wrapped to the identity we just abandoned —
  // the HDK, the CalendarKeys, the biometric cache. Drop them all before the new
  // keypair lands so nothing stale is mistaken for readable.
  lock();
  await clearDeviceKey().catch(() => {});
  setKeyPair(result.keyPair);
  await cacheKeyPairToDevice();
  // The account has no confirmed recovery factor again — surface the new
  // one-time code through the same mandatory modal registration uses.
  pendingRecoveryCode = result.recoveryCodeDisplay;
  emit();
  return { ok: true };
}

// Unlock a locked session with the account password (e.g. after a relaunch
// restored only the token) — no re-login required. Mirrors unlockWithPasskey.
export async function unlockWithPassword(password: string): Promise<boolean> {
  if (keyPair) return true;
  const enroll = await getEnrollment();
  const { data } = await keysApi.me();
  if (!data.enrolled) return false;
  try {
    setKeyPair(enroll.unlockWithPassword(data as unknown as StoredKeyMaterial, password));
    await cacheKeyPairToDevice();
    return true;
  } catch {
    setKeyPair(null);
    return false;
  }
}

export async function unlockWithRecoveryCode(code: string): Promise<boolean> {
  const enroll = await getEnrollment();
  const { data } = await keysApi.me();
  if (!data.enrolled) return false;
  try {
    setKeyPair(enroll.unlockWithRecovery(data as unknown as StoredKeyMaterial, code));
    await cacheKeyPairToDevice();
    return true;
  } catch {
    return false;
  }
}

// Signal-parity F4 (QR device linking): adopt an identity keypair handed over by
// an existing unlocked device. The keypair arrived sealed to this device's
// one-shot ephemeral key (opened in lib/deviceLink.ts), so it never touched the
// server in the clear. Arm the biometric cache so future launches unlock with
// Face ID (no password/recovery code needed on this device — the whole point of
// F4), then unwrap the HDK. Returns the household-key status.
export async function importLinkedKeyPair(pub: string, priv: string): Promise<'locked' | 'ready' | 'pending'> {
  const crypto = await loadHouseholdCrypto();
  setKeyPair({ publicKey: crypto.unb64(pub), privateKey: crypto.unb64(priv) });
  await cacheKeyPairToDevice().catch(() => { /* biometric cache best-effort */ });
  try {
    return await ensureHouseholdKey();
  } catch {
    return 'locked';
  }
}

// ── Passkey factor (Face ID / Touch ID unlock) ──────────────────────────────

// Add a passkey as an unlock factor: register a credential (server-verified,
// so the same passkey also becomes a SIGN-IN credential), evaluate its PRF,
// wrap the private key under the PRF output, and store the envelope. Requires
// an unlocked session (we need the private key to wrap). Throws with a
// user-facing message when the platform can't evaluate a PRF.
export async function addPasskeyFactor(): Promise<boolean> {
  if (!keyPair) return false;
  const { createPasskeyWithPrf, getPrfForCredentials } = await import('./passkeys');
  const crypto = await loadHouseholdCrypto();
  const enroll = await getEnrollment();

  const prfSalt = crypto.b64(crypto.randomBytes(32));
  const created = await createPasskeyWithPrf({ prfSalt });
  if (!created) return false; // user canceled the sheet

  // Some authenticators only evaluate the PRF on assertion, not registration —
  // run one immediately so we get the output while the user is still engaged.
  let prf = created.prfOutput;
  if (!prf) {
    const got = await getPrfForCredentials([{ credentialId: created.credentialId, prfSalt }]);
    prf = got?.prfOutput ?? null;
  }
  if (!prf) {
    throw new Error(
      "This device's passkeys don't support encryption (PRF), so the passkey can't unlock your data. You can delete it from your device's password settings.",
    );
  }

  const factor = enroll.addPasskey(keyPair.privateKey, crypto.unb64(prf), created.credentialId, prfSalt);
  await keysApi.putFactor(factor);
  return true;
}

// Unlock a locked session with a passkey assertion (e.g. after an app relaunch,
// where no password is available). Returns false on cancel/failure — the
// password and recovery-code paths still work.
export async function unlockWithPasskey(): Promise<boolean> {
  if (keyPair) return true;
  const { getPrfForCredentials } = await import('./passkeys');
  const crypto = await loadHouseholdCrypto();
  const enroll = await getEnrollment();

  const { data } = await keysApi.me();
  if (!data.enrolled) return false;
  const material = data as unknown as StoredKeyMaterial;
  const creds = material.wrappedPrivateKey
    .filter((f): f is Extract<typeof f, { factor: 'passkey' | 'recovery' }> => f.factor === 'passkey')
    .filter((f) => f.credentialId && f.prfSalt)
    .map((f) => ({ credentialId: f.credentialId as string, prfSalt: f.prfSalt as string }));
  if (!creds.length) return false;

  const got = await getPrfForCredentials(creds);
  if (!got) return false;
  try {
    setKeyPair(enroll.unlockWithPasskeyPrf(material, got.credentialId, crypto.unb64(got.prfOutput)));
    await cacheKeyPairToDevice();
    return true;
  } catch {
    return false;
  }
}

// Unlock with a PRF output already in hand — the passkey SIGN-IN assertion
// evaluates the PRF in the same gesture, so no second Face ID sheet is needed.
export async function unlockWithPasskeyPrfOutput(credentialId: string, prfOutputB64: string): Promise<boolean> {
  if (keyPair) return true;
  const crypto = await loadHouseholdCrypto();
  const enroll = await getEnrollment();
  const { data } = await keysApi.me();
  if (!data.enrolled) return false;
  try {
    setKeyPair(enroll.unlockWithPasskeyPrf(data as unknown as StoredKeyMaterial, credentialId, crypto.unb64(prfOutputB64)));
    await cacheKeyPairToDevice();
    return true;
  } catch {
    setKeyPair(null);
    return false;
  }
}

// Whether the account has any passkey factor enrolled (for the settings row).
export async function hasPasskeyFactor(): Promise<boolean> {
  const { data } = await keysApi.me();
  const material = data as unknown as StoredKeyMaterial;
  return (material.wrappedPrivateKey || []).some((f) => f.factor === 'passkey');
}

// Re-wrap under a new password (call right after a password change).
export async function rewrapForNewPassword(newPassword: string): Promise<boolean> {
  if (!keyPair) return false;
  const enroll = await getEnrollment();
  await keysApi.putFactor(enroll.rewrapPassword(keyPair.privateKey, newPassword));
  return true;
}

// Mint a fresh recovery code (invalidates the previous one) and surface it via
// the one-time modal (subscriber store). Returns the code, or null if locked.
export async function regenerateRecoveryCode(): Promise<string | null> {
  if (!keyPair) return null;
  const enroll = await getEnrollment();
  const { factor, display } = enroll.regenerateRecoveryCode(keyPair.privateKey);
  await keysApi.putFactor(factor);
  pendingRecoveryCode = display;
  emit();
  return display;
}

// ── Recovery mandate (docs/PASSWORDLESS-E2EE-PLAN.md §2) ─────────────────────
// Confirm the account holds a non-password recovery factor (recovery code saved
// and/or a passkey enrolled). Best-effort — on failure the flag stays unset and
// the mandate simply re-prompts next time. Gates password retirement (§5).
export async function markRecoverySetup(): Promise<void> {
  try { await keysApi.recoveryComplete(); } catch { /* best-effort */ }
}

// Whether the account still needs to confirm account recovery — true for an
// enrolled account that predates the mandate (used to re-prompt on unlock).
export async function recoveryNeedsSetup(): Promise<boolean> {
  try {
    const { data } = await keysApi.me();
    return !!data.enrolled && !data.recoverySetupAt;
  } catch {
    return false;
  }
}
