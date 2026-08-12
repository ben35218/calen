// Cross-platform crypto core tests. Uses the built-in node:test runner (matching
// server/) and libsodium-wrappers as the injected Sodium instance — the same
// core that runs on web and mobile.
//
// Run: npm test   (from shared/crypto)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHouseholdCrypto } from './core.ts';
import type { Sodium, RecordLocation } from './index.ts';

// libsodium-wrappers ships a broken ESM subpath; the CJS build is fine under
// Node's test runner. Bundlers (Vite/Metro) consume the ESM entry in the
// adapters without this shim.
const require = createRequire(import.meta.url);
const _sodium = require('libsodium-wrappers-sumo');
await _sodium.ready;
const crypto = createHouseholdCrypto(_sodium as unknown as Sodium);

const bytesEqual = (a: Uint8Array, b: Uint8Array) => assert.deepEqual([...a], [...b]);

const loc: RecordLocation = {
  collection: 'CalendarEvent',
  id: '507f1f77bcf86cd799439011',
  householdId: '507f191e810c19729de860ea',
  keyVersion: 1,
};

test('record encrypt/decrypt roundtrip preserves content (incl. dates)', () => {
  const hdk = crypto.generateHDK();
  const record = { title: 'Dentist', startDate: '2026-07-10T14:00:00Z', location: '123 Main St' };
  const env = crypto.encryptRecord(hdk, loc, record);
  assert.equal(env.alg, 'xchacha20poly1305-ietf-v2'); // C3: new writes are opaque
  assert.deepEqual(crypto.decryptRecord(hdk, loc, env), record);
});

test('C1 padding: same-bucket records have identical ciphertext length; roundtrip intact', () => {
  const hdk = crypto.generateHDK();
  // A short and a medium record land in the same 256-byte bucket → equal ct
  // length (nonce is random, ct length = padded length + tag).
  const short = crypto.encryptRecord(hdk, loc, { title: 'Milk' });
  const medium = crypto.encryptRecord(hdk, loc, { title: 'Pick up the dry cleaning before the party', notes: 'ask about the stain' });
  assert.equal(crypto.unb64(short.ct).length, crypto.unb64(medium.ct).length);
  // Content still roundtrips exactly (JSON.parse ignores the trailing pad).
  assert.deepEqual(crypto.decryptRecord(hdk, loc, short), { title: 'Milk' });
  // A record past 256 chars lands in the next bucket, not an exact-size leak.
  const long = crypto.encryptRecord(hdk, loc, { notes: 'x'.repeat(400) });
  assert.equal(crypto.unb64(long.ct).length, 512 + (crypto.unb64(short.ct).length - 256));
});

test('AAD binds ciphertext to its record slot — wrong location fails', () => {
  const hdk = crypto.generateHDK();
  const env = crypto.encryptRecord(hdk, loc, { title: 'secret' });
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, id: 'other-id' }, env));
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, keyVersion: 2 }, env));
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, householdId: 'elsewhere' }, env));
});

test('wrong HDK cannot decrypt', () => {
  const env = crypto.encryptRecord(crypto.generateHDK(), loc, { title: 'x' });
  assert.throws(() => crypto.decryptRecord(crypto.generateHDK(), loc, env));
});

test('guardian recovery (dual-control): both legs required; wrong PIN/device/guardian fail', () => {
  const user = crypto.generateIdentityKeyPair();
  const guardian = crypto.generateIdentityKeyPair();
  const pin = '4821';

  // Arm: wrap the user's private key under the guardian's key + the PIN.
  const outer = crypto.createGuardianEnvelope(user.privateKey, pin, guardian.publicKey);

  // Guardian leg: only the guardian can unseal the outer box.
  const stranger = crypto.generateIdentityKeyPair();
  assert.throws(() => crypto.unsealGuardianOuter(outer, stranger));
  const inner = crypto.unsealGuardianOuter(outer, guardian);

  // The guardian holds only the PIN-locked inner — it is NOT the raw key, and
  // without the PIN they cannot open it (this is what "can't read it" means).
  assert.notEqual(inner, crypto.b64(user.privateKey));

  // Return leg: guardian re-seals inner to the requesting device's ephemeral key.
  const ephemeral = crypto.generateIdentityKeyPair();
  const resealed = crypto.resealGuardianInner(inner, ephemeral.publicKey);

  // User leg: correct device + correct PIN → the original private key.
  bytesEqual(crypto.recoverWithGuardian(resealed, ephemeral, pin), user.privateKey);

  // Wrong PIN fails (inner secretbox MAC).
  assert.throws(() => crypto.recoverWithGuardian(resealed, ephemeral, '0000'));
  // An interceptor of the resealed blob (wrong ephemeral key) fails.
  const wrongDevice = crypto.generateIdentityKeyPair();
  assert.throws(() => crypto.recoverWithGuardian(resealed, wrongDevice, pin));
});

test('tampered ciphertext is rejected', () => {
  const hdk = crypto.generateHDK();
  const env = crypto.encryptRecord(hdk, loc, { title: 'x' });
  const bad = crypto.b64(crypto.unb64(env.ct).map((b, i) => (i === 0 ? b ^ 1 : b)));
  assert.throws(() => crypto.decryptRecord(hdk, loc, { ...env, ct: bad }));
});

test('HDK sealed-box envelope: wrap to a member, member unwraps', () => {
  const hdk = crypto.generateHDK();
  const member = crypto.generateIdentityKeyPair();
  const wrapped = crypto.wrapHDKForMember(hdk, member.publicKey);
  bytesEqual(crypto.unwrapHDK(wrapped, member), hdk);
});

test('a non-member keypair cannot unwrap the HDK envelope', () => {
  const hdk = crypto.generateHDK();
  const member = crypto.generateIdentityKeyPair();
  const outsider = crypto.generateIdentityKeyPair();
  const wrapped = crypto.wrapHDKForMember(hdk, member.publicKey);
  assert.throws(() => crypto.unwrapHDK(wrapped, outsider));
});

test('public-key fingerprint is stable, key-specific, and human-formatted', () => {
  const a = crypto.generateIdentityKeyPair();
  const b = crypto.generateIdentityKeyPair();
  const fpA = crypto.publicKeyFingerprint(crypto.b64(a.publicKey));
  // Deterministic for the same key, distinct for different keys.
  assert.equal(fpA, crypto.publicKeyFingerprint(crypto.b64(a.publicKey)));
  assert.notEqual(fpA, crypto.publicKeyFingerprint(crypto.b64(b.publicKey)));
  // Six groups of four Crockford-base32 chars, e.g. "K7Q2-M9XR-4T…".
  assert.match(fpA, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
});

test('password factor: recover private key with correct password, reject wrong', () => {
  const kp = crypto.generateIdentityKeyPair();
  const env = crypto.createPasswordFactor(kp.privateKey, 'correct horse battery staple');
  bytesEqual(crypto.openPasswordFactor(env, 'correct horse battery staple'), kp.privateKey);
  assert.throws(() => crypto.openPasswordFactor(env, 'wrong password'));
});

test('recovery-code factor: canonicalization makes formatting irrelevant', () => {
  const kp = crypto.generateIdentityKeyPair();
  const { display, secret } = crypto.generateRecoveryCode();
  assert.match(display, /^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/);
  const env = crypto.createSecretFactor('recovery', kp.privateKey, secret);
  // User re-enters the code lowercased, spaced, without dashes → same key.
  const reentered = crypto.recoverySecretFromCode(display.replace(/-/g, ' ').toLowerCase());
  bytesEqual(crypto.openSecretFactor(env, reentered), kp.privateKey);
});

test('passkey-PRF factor: high-entropy secret wraps/unwraps the private key', () => {
  const kp = crypto.generateIdentityKeyPair();
  const prfOutput = _sodium.randombytes_buf(32); // simulated WebAuthn PRF result
  const env = crypto.createSecretFactor('passkey', kp.privateKey, prfOutput);
  bytesEqual(crypto.openSecretFactor(env, prfOutput), kp.privateKey);
  assert.throws(() => crypto.openSecretFactor(env, _sodium.randombytes_buf(32)));
});

test('multiple factors independently recover the same private key', () => {
  const kp = crypto.generateIdentityKeyPair();
  const pw = crypto.createPasswordFactor(kp.privateKey, 'hunter2hunter2');
  const rc = crypto.generateRecoveryCode();
  const rcEnv = crypto.createSecretFactor('recovery', kp.privateKey, rc.secret);
  bytesEqual(crypto.openPasswordFactor(pw, 'hunter2hunter2'), kp.privateKey);
  bytesEqual(crypto.openSecretFactor(rcEnv, rc.secret), kp.privateKey);
  // End-to-end: unlock via a factor, then decrypt a household record.
  const hdk = crypto.generateHDK();
  const wrapped = crypto.wrapHDKForMember(hdk, kp.publicKey);
  const recovered = crypto.openPasswordFactor(pw, 'hunter2hunter2');
  const hdkBack = crypto.unwrapHDK(wrapped, { publicKey: kp.publicKey, privateKey: recovered });
  const env = crypto.encryptRecord(hdk, loc, { title: 'end to end' });
  assert.deepEqual(crypto.decryptRecord(hdkBack, loc, env), { title: 'end to end' });
});

test('file encryption roundtrips multi-chunk content', () => {
  const fileKey = crypto.generateFileKey();
  const chunks = [_sodium.randombytes_buf(4096), _sodium.randombytes_buf(4096), _sodium.randombytes_buf(37)];
  const enc = crypto.encryptFile(fileKey, chunks);
  const whole = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { whole.set(c, off); off += c.length; }
  bytesEqual(crypto.decryptFile(fileKey, enc), whole);
});

test('empty file still produces a verifiable stream', () => {
  const fileKey = crypto.generateFileKey();
  const enc = crypto.encryptFile(fileKey, []);
  assert.equal(crypto.decryptFile(fileKey, enc).length, 0);
});

test('truncated file is rejected (chunk-count bound in AAD)', () => {
  const fileKey = crypto.generateFileKey();
  const enc = crypto.encryptFile(fileKey, [_sodium.randombytes_buf(64), _sodium.randombytes_buf(64)]);
  const truncated = { v: enc.v, chunks: enc.chunks.slice(0, 1) };
  assert.throws(() => crypto.decryptFile(fileKey, truncated));
});

test('reordered file chunks are rejected (chunk-index bound in AAD)', () => {
  const fileKey = crypto.generateFileKey();
  const enc = crypto.encryptFile(fileKey, [_sodium.randombytes_buf(64), _sodium.randombytes_buf(64)]);
  const swapped = { v: enc.v, chunks: [enc.chunks[1], enc.chunks[0]] };
  assert.throws(() => crypto.decryptFile(fileKey, swapped));
});

test('per-file content key wraps/unwraps under the HDK', () => {
  const hdk = crypto.generateHDK();
  const fileKey = crypto.generateFileKey();
  const fileLoc: RecordLocation = { ...loc, collection: 'Manual' };
  const wrapped = crypto.wrapFileKey(hdk, fileKey, fileLoc);
  bytesEqual(crypto.unwrapFileKey(hdk, wrapped, fileLoc), fileKey);
});

// End-to-end attachment flow (Phase 4c): the exact composition upload/download
// wiring must use. Uploader encrypts the bytes under a fresh per-file key, wraps
// that key to the household HDK, and stores {file, wrappedKey}; a different
// member (holding the same HDK) unwraps the key and recovers the bytes.
test('attachment flow: encrypt+wrap on upload, unwrap+decrypt on another device', () => {
  const hdk = crypto.generateHDK();
  const fileLoc: RecordLocation = { ...loc, collection: 'Manual', id: 'manual-1' };
  const plaintext = _sodium.randombytes_buf(5000); // stand-in for a PDF/photo

  // Uploader side.
  const fileKey = crypto.generateFileKey();
  const stored = {
    file: crypto.encryptFile(fileKey, [plaintext.subarray(0, 4096), plaintext.subarray(4096)]),
    wrappedKey: crypto.wrapFileKey(hdk, fileKey, fileLoc),
  };

  // Downloader side (same household HDK, fresh crypto state).
  const recoveredKey = crypto.unwrapFileKey(hdk, stored.wrappedKey, fileLoc);
  bytesEqual(crypto.decryptFile(recoveredKey, stored.file), plaintext);

  // The wrapped key is AAD-bound to its record: a wrong attachment id fails.
  assert.throws(() => crypto.unwrapFileKey(hdk, stored.wrappedKey, { ...fileLoc, id: 'manual-2' }));
});

// ── Per-resource content keys: shared calendars (Signal-parity D1) ────────────

// A calendar-scoped location, mirroring how the client reconstructs it from an
// event's own routing (its calendarType key = the resource, + the CalendarKey
// version stored plaintext alongside the ciphertext).
const calLoc: RecordLocation = {
  collection: 'CalendarEvent',
  id: '507f1f77bcf86cd799439099',
  householdId: '507f191e810c19729de860ea',
  keyVersion: 1,
  scope: { kind: 'calendar', resource: 'custom-carpool', version: 1 },
};

test('D1: calendar-scoped record roundtrips under a CalendarKey and marks ks=cal', () => {
  const calKey = crypto.generateResourceKey();
  const record = { title: 'Pickup', startDate: '2026-09-02T15:00:00Z' };
  const env = crypto.encryptRecord(calKey, calLoc, record);
  assert.equal(env.ks, 'cal'); // self-describing discriminator
  assert.deepEqual(crypto.decryptRecord(calKey, calLoc, env), record);
  // A household record carries no ks (unchanged, backward compatible).
  assert.equal(crypto.encryptRecord(crypto.generateHDK(), loc, record).ks, undefined);
});

test('D1: scoped AAD binds to the calendar + CalendarKey version, not householdId', () => {
  const calKey = crypto.generateResourceKey();
  const env = crypto.encryptRecord(calKey, calLoc, { title: 'x' });
  // The owner's householdId is NOT bound — a collaborator decrypts without it.
  assert.deepEqual(
    crypto.decryptRecord(calKey, { ...calLoc, householdId: 'a-different-household' }, env),
    { title: 'x' },
  );
  // But the calendar identity and its key version ARE bound.
  assert.throws(() => crypto.decryptRecord(calKey, { ...calLoc, scope: { kind: 'calendar', resource: 'custom-other', version: 1 } }, env));
  assert.throws(() => crypto.decryptRecord(calKey, { ...calLoc, scope: { kind: 'calendar', resource: 'custom-carpool', version: 2 } }, env));
  // The wrong key (e.g. the HDK) cannot open a CalendarKey-sealed record.
  assert.throws(() => crypto.decryptRecord(crypto.generateHDK(), calLoc, env));
});

test('D1: CalendarKey wraps to the household (HDK) and to a collaborator (sealed box)', () => {
  const calKey = crypto.generateResourceKey();
  const hdk = crypto.generateHDK();
  const collaborator = crypto.generateIdentityKeyPair();

  // Household wrap — any member holding the HDK recovers the CalendarKey.
  const hhWrap = crypto.wrapResourceKeyForHousehold(hdk, calKey, 'custom-carpool', 1, calLoc.householdId, 1);
  bytesEqual(crypto.unwrapResourceKeyFromHousehold(hdk, hhWrap, 'custom-carpool', 1, calLoc.householdId, 1), calKey);
  // Bound to the resource + versions: a mismatched wrap slot fails.
  assert.throws(() => crypto.unwrapResourceKeyFromHousehold(hdk, hhWrap, 'custom-other', 1, calLoc.householdId, 1));
  assert.throws(() => crypto.unwrapResourceKeyFromHousehold(hdk, hhWrap, 'custom-carpool', 2, calLoc.householdId, 1));

  // Collaborator wrap — only the recipient's private key opens it.
  const memberWrap = crypto.wrapResourceKeyForMember(calKey, collaborator.publicKey);
  bytesEqual(crypto.unwrapResourceKeyForMember(memberWrap, collaborator), calKey);
  assert.throws(() => crypto.unwrapResourceKeyForMember(memberWrap, crypto.generateIdentityKeyPair()));

  // A collaborator who recovered the CalendarKey can read the owner's event.
  const env = crypto.encryptRecord(calKey, calLoc, { title: 'Pickup' });
  const recovered = crypto.unwrapResourceKeyForMember(memberWrap, collaborator);
  assert.deepEqual(crypto.decryptRecord(recovered, calLoc, env), { title: 'Pickup' });
});

test('D1: rotating the CalendarKey (revoke) locks out the old-version ciphertext', () => {
  const oldKey = crypto.generateResourceKey();
  const env = crypto.encryptRecord(oldKey, calLoc, { title: 'was shared' });
  // Revoke = fresh key at the next version + re-seal. The removed collaborator
  // holds only the old key and the (now superseded) old-version ciphertext.
  const newKey = crypto.generateResourceKey();
  const reSealed = crypto.encryptRecord(newKey, { ...calLoc, scope: { kind: 'calendar', resource: 'custom-carpool', version: 2 } }, { title: 'was shared' });
  assert.notEqual(env.ct, reSealed.ct);
  assert.throws(() => crypto.decryptRecord(oldKey, { ...calLoc, scope: { kind: 'calendar', resource: 'custom-carpool', version: 2 } }, reSealed));
});

// ── Per-resource content keys: shared trips (Signal-parity D2) ────────────────

// A trip-scoped location: the resource is the Trip `_id` (a plaintext routing
// field on the Trip and — as tripId — on every TripItem), so one TripKey seals
// the Trip + all its items. Mirrors the D1 CalendarKey shape with kind 'trip'.
const tripLoc: RecordLocation = {
  collection: 'TripItem',
  id: '507f1f77bcf86cd7994390aa',
  householdId: '507f191e810c19729de860ea',
  keyVersion: 1,
  scope: { kind: 'trip', resource: '507f1f77bcf86cd799439bbb', version: 1 },
};

test('D2: trip-scoped record roundtrips under a TripKey and marks ks=trip', () => {
  const tripKey = crypto.generateResourceKey();
  const record = { title: 'Hotel Roma', location: 'Via del Corso' };
  const env = crypto.encryptRecord(tripKey, tripLoc, record);
  assert.equal(env.ks, 'trip'); // distinct from D1's 'cal', not a generic 'res'
  assert.deepEqual(crypto.decryptRecord(tripKey, tripLoc, env), record);
});

test('D2: trip-scoped AAD binds to the trip + TripKey version, not householdId; the kind prefix isolates cal vs trip', () => {
  const tripKey = crypto.generateResourceKey();
  const env = crypto.encryptRecord(tripKey, tripLoc, { title: 'x' });
  // The owner's householdId is NOT bound — a collaborator decrypts without it.
  assert.deepEqual(crypto.decryptRecord(tripKey, { ...tripLoc, householdId: 'other' }, env), { title: 'x' });
  // The trip identity and its key version ARE bound.
  assert.throws(() => crypto.decryptRecord(tripKey, { ...tripLoc, scope: { kind: 'trip', resource: 'other-trip', version: 1 } }, env));
  assert.throws(() => crypto.decryptRecord(tripKey, { ...tripLoc, scope: { kind: 'trip', resource: tripLoc.scope!.resource, version: 2 } }, env));
  // A same-resource-id calendar scope must NOT open a trip-scoped record: the AAD
  // prefix (cal: vs trip:) is bound, so the kinds are cryptographically distinct.
  assert.throws(() => crypto.decryptRecord(tripKey, { ...tripLoc, collection: 'CalendarEvent', scope: { kind: 'calendar', resource: tripLoc.scope!.resource, version: 1 } }, env));
});

test('D2: TripKey wraps to the household (HDK) and to a collaborator (sealed box), and wraps a per-file key (attachments)', () => {
  const tripKey = crypto.generateResourceKey();
  const hdk = crypto.generateHDK();
  const collaborator = crypto.generateIdentityKeyPair();
  const resource = tripLoc.scope!.resource;

  // The resource-key wrap surface is shared with D1 (generic over `resource`).
  const hhWrap = crypto.wrapResourceKeyForHousehold(hdk, tripKey, resource, 1, tripLoc.householdId, 1);
  bytesEqual(crypto.unwrapResourceKeyFromHousehold(hdk, hhWrap, resource, 1, tripLoc.householdId, 1), tripKey);
  const memberWrap = crypto.wrapResourceKeyForMember(tripKey, collaborator.publicKey);
  bytesEqual(crypto.unwrapResourceKeyForMember(memberWrap, collaborator), tripKey);

  // Trip attachments (the D2 win): a per-file key wrapped under the TripKey with a
  // trip-scoped location — the wrap envelope carries ks='trip' so the client
  // routes decryption to the TripKey (a shared_shared booking's shared receipt).
  const fileKey = crypto.generateFileKey();
  const attLoc: RecordLocation = { collection: 'TripItemAttachment', id: 'att1', householdId: tripLoc.householdId, keyVersion: 1, scope: { kind: 'trip', resource, version: 1 } };
  const wrappedFileKey = crypto.wrapFileKey(tripKey, fileKey, attLoc);
  assert.equal(wrappedFileKey.ks, 'trip');
  bytesEqual(crypto.unwrapFileKey(tripKey, wrappedFileKey, attLoc), fileKey);
  // A collaborator who recovered the TripKey opens the shared attachment's file key.
  bytesEqual(crypto.unwrapFileKey(crypto.unwrapResourceKeyForMember(memberWrap, collaborator), wrappedFileKey, attLoc), fileKey);
});

test('D2: rotating the TripKey (revoke) locks out the old-version ciphertext', () => {
  const oldKey = crypto.generateResourceKey();
  const env = crypto.encryptRecord(oldKey, tripLoc, { title: 'was shared' });
  const newKey = crypto.generateResourceKey();
  const reSealed = crypto.encryptRecord(newKey, { ...tripLoc, scope: { kind: 'trip', resource: tripLoc.scope!.resource, version: 2 } }, { title: 'was shared' });
  assert.notEqual(env.ct, reSealed.ct);
  assert.throws(() => crypto.decryptRecord(oldKey, { ...tripLoc, scope: { kind: 'trip', resource: tripLoc.scope!.resource, version: 2 } }, reSealed));
});

// ── One-shot sealed snapshot (Signal-parity D3) ───────────────────────────────

test('D3: an invitation snapshot seals to one recipient and only their key opens it', () => {
  const recipient = crypto.generateIdentityKeyPair();
  const snapshot = { title: 'Lake day', location: 'Sandbanks', startDate: '2026-08-15T12:00:00.000Z', allDay: true };

  const sealed = crypto.sealJsonToMember(snapshot, recipient.publicKey);
  assert.equal(typeof sealed, 'string');
  assert.deepEqual(crypto.openJsonFromMember(sealed, recipient), snapshot);
  // No versioned key, no envelope — just an opaque blob. Only the recipient opens it.
  assert.throws(() => crypto.openJsonFromMember(sealed, crypto.generateIdentityKeyPair()));
});

test('D3: the sealed blob is length-padded (C1) so it does not leak the snapshot size', () => {
  const recipient = crypto.generateIdentityKeyPair();
  const short = crypto.sealJsonToMember({ title: 'a', startDate: 'x' }, recipient.publicKey);
  const longer = crypto.sealJsonToMember({ title: 'a much longer event title here', startDate: 'x' }, recipient.publicKey);
  // Both small snapshots fall in the same 256 B bucket → identical ciphertext length.
  assert.equal(crypto.unb64(short).length, crypto.unb64(longer).length);
});

// ── Opaque record envelopes (Signal-parity C3) ────────────────────────────────

test('C3: opaque v2 envelope hides the collection from the AAD and carries it inside', () => {
  const hdk = crypto.generateHDK();
  const record = { title: 'Dentist', notes: 'bring insurance card' };
  const env = crypto.encryptRecord(hdk, loc, record);
  assert.equal(env.alg, 'xchacha20poly1305-ietf-v2');
  // The type is recoverable ONLY by decrypting — it rides inside the ciphertext.
  assert.deepEqual(crypto.decryptRecordTagged(hdk, loc, env), { collection: 'CalendarEvent', record });
  // The AAD no longer binds `collection`: decrypting with a DIFFERENT collection in
  // `loc` still succeeds (v2 uses the generic `record` tag), proving the record
  // type is not part of the authenticated metadata the server could ever see.
  assert.deepEqual(crypto.decryptRecord(hdk, { ...loc, collection: 'Contact' }, env), record);
  // id / householdId / keyVersion are STILL bound — the slot/replay protection holds.
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, id: 'other-id' }, env));
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, householdId: 'elsewhere' }, env));
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, keyVersion: 2 }, env));
});

test('C3: reads still accept the pre-bump (v1) envelope format', () => {
  const hdk = crypto.generateHDK();
  const record = { title: 'legacy', notes: 'sealed before the C3 bump' };
  // Simulate a pre-C3 record: v1 alg, AAD binds `collection`, payload is the bare
  // record JSON (no { c, r } wrapper). encryptBytes is the frozen v1 primitive.
  const v1 = crypto.encryptBytes(hdk, loc, new TextEncoder().encode(JSON.stringify(record)));
  assert.equal(v1.alg, 'xchacha20poly1305-ietf');
  assert.deepEqual(crypto.decryptRecord(hdk, loc, v1), record);
  // Tagged decrypt of a v1 record echoes the caller-supplied collection.
  assert.deepEqual(crypto.decryptRecordTagged(hdk, loc, v1), { collection: loc.collection, record });
  // v1 STILL binds the collection: a wrong-collection loc fails (unlike v2).
  assert.throws(() => crypto.decryptRecord(hdk, { ...loc, collection: 'Contact' }, v1));
});

test('C3: resource-scoped (D1/D2) records survive the v2 bump — ks + scoped AAD intact', () => {
  const calKey = crypto.generateResourceKey();
  const env = crypto.encryptRecord(calKey, calLoc, { title: 'Pickup' });
  assert.equal(env.alg, 'xchacha20poly1305-ietf-v2');
  assert.equal(env.ks, 'cal'); // self-describing discriminator preserved
  assert.deepEqual(crypto.decryptRecordTagged(calKey, calLoc, env), { collection: 'CalendarEvent', record: { title: 'Pickup' } });
  // Scoped AAD still binds resource + version (+ kind prefix), just not collection.
  assert.throws(() => crypto.decryptRecord(calKey, { ...calLoc, scope: { kind: 'calendar', resource: 'custom-other', version: 1 } }, env));
  assert.throws(() => crypto.decryptRecord(calKey, { ...calLoc, scope: { kind: 'calendar', resource: 'custom-carpool', version: 2 } }, env));
  // A trip key of the same resource id can't open it (prefix bound); nor the HDK.
  const tripEnv = crypto.encryptRecord(crypto.generateResourceKey(), tripLoc, { title: 'Hotel' });
  assert.equal(tripEnv.ks, 'trip');
  assert.throws(() => crypto.decryptRecord(crypto.generateHDK(), calLoc, env));
});
