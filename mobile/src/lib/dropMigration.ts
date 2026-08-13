// §9 client-driven migration helpers (mobile). Mirrors
// client/src/services/dropMigration.js: the owner's unlocked device re-encrypts
// any stragglers (records lacking an `enc` blob) so nothing is lost at the drop.

import { householdApi, recordsApi, settingsApi, type E2eeReadiness } from '../api';
import { getHDK, encryptRecord, openRecord, openOpaqueRecord } from './e2ee';
import { HOUSEHOLD_ENC } from './encSubsets';

// C3b: strip the unified-store routing keys from a decrypted opaque record, so
// what re-seals is exactly the sealed content (+ the C4 author) — never the
// plaintext routing the Record row carries.
function contentOf(record: Record<string, unknown>): Record<string, unknown> {
  const { _id, householdId, userId, keyVersion, enc, scope, deleted, updatedAt, createdAt, ...content } = record;
  return content;
}

function pickFields(record: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (record[f] !== undefined) out[f] = record[f];
  return out;
}

// Seal the household settings blob (name + homeAddress — P5a/C2). The Household
// isn't a userId-scoped row, so the stragglers endpoint never lists it, but the
// drop's readiness check refuses to commit while its plaintext content lacks a
// sealed blob — and every household HAS a name, so a born-encrypted activation
// depends on this running. Merges any already-decryptable blob over the served
// plaintext so a re-seal never loses fields.
async function sealHouseholdBlob(): Promise<void> {
  const { data: hh } = await householdApi.get();
  if (!hh?._id) return;
  const opened = (await openRecord('Household', hh)) as unknown as Record<string, unknown>;
  const { data: settings } = await settingsApi.get().catch(() => ({ data: {} as Record<string, unknown> }));
  const content = HOUSEHOLD_ENC({
    name: opened.name ?? hh.name,
    homeAddress: opened.homeAddress ?? (settings as Record<string, unknown>).homeAddress,
  });
  const sealed = await encryptRecord('Household', String(hh._id), content);
  if (!sealed) return;
  await settingsApi.update({ ...sealed });
}

// Re-encrypt every straggler under the current HDK and seal it back. Requires an
// unlocked session (HDK held) — throws otherwise. `onProgress` fires per record.
export async function reencryptStragglers(
  onProgress?: (p: { sealed: number; total: number }) => void,
): Promise<{ total: number; sealed: number; failed: number }> {
  if (!getHDK()) throw new Error('Unlock your account first (the household key is needed to encrypt).');
  await sealHouseholdBlob().catch(() => {}); // name/location blob (not a listed straggler)
  const { data } = await householdApi.stragglers();
  const total = data.total || 0;
  let sealed = 0;
  let failed = 0;
  for (const group of data.collections || []) {
    for (const record of group.records) {
      try {
        const content = pickFields(record, group.fields);
        const enc = await encryptRecord(group.collection, String(record._id), content);
        if (!enc) throw new Error('encryption returned null (no HDK)');
        await householdApi.seal({ collection: group.collection, _id: String(record._id), ...enc });
        sealed++;
      } catch {
        failed++;
      }
      onProgress?.({ sealed, total });
    }
  }
  return { total, sealed, failed };
}

export async function getReadiness(): Promise<E2eeReadiness> {
  return (await householdApi.readiness()).data;
}

// ── Re-seal + re-drop backfill (Signal-parity pass-2) ───────────────────────
// A household dropped under an OLDER DROP_FIELDS version still holds the columns
// added since (nextDueDate, odometer reading/notes, meal notes, category names,
// household name) in plaintext, and its old `enc` blobs predate them. This pass
// decrypts each flagged record, merges the still-plaintext fields over the
// decrypted content, and re-seals under the current subset — folding the new
// fields into `enc`. On ZERO failures it stamps the server (reseal-complete),
// which is the interlock scripts/reDropPlaintext.js requires before it may null
// the plaintext. Needs an unlocked session (HDK held).
export async function reencryptForReDrop(
  onProgress?: (p: { sealed: number; total: number }) => void,
): Promise<{ total: number; sealed: number; failed: number; completed: boolean }> {
  if (!getHDK()) throw new Error('Unlock your account first (the household key is needed to encrypt).');
  await sealHouseholdBlob().catch(() => {}); // fold the name into the settings blob (C2)
  const { data } = await householdApi.resealAll();
  const total = data.total || 0;
  let sealed = 0;
  let failed = 0;
  for (const group of data.collections || []) {
    for (const record of group.records) {
      try {
        // Decrypt the existing ciphertext (if any), then overlay the columns
        // still in plaintext so old fields survive and the new ones fold in.
        let decrypted: Record<string, unknown> = {};
        const enc = (record as { enc?: { ct?: string } }).enc;
        if (enc?.ct) {
          const opened = await openRecord(group.collection, { ...record, _id: String(record._id) });
          const { _id, enc: _e, keyVersion, ...rest } = opened as Record<string, unknown>;
          decrypted = rest;
        }
        const merged: Record<string, unknown> = { ...decrypted };
        for (const f of group.fields) {
          const v = (record as Record<string, unknown>)[f];
          if (v !== null && v !== undefined) merged[f] = v;
        }
        const sealedEnc = await encryptRecord(group.collection, String(record._id), pickFields(merged, group.fields));
        if (!sealedEnc) throw new Error('encryption returned null (no HDK)');
        await householdApi.seal({ collection: group.collection, _id: String(record._id), ...sealedEnc });
        sealed++;
      } catch {
        failed++;
      }
      onProgress?.({ sealed, total });
    }
  }
  const completed = failed === 0;
  // Only stamp on a clean pass: a partial re-seal must NOT unblock the null.
  if (completed) await householdApi.resealComplete().catch(() => {});
  return { total, sealed, failed, completed };
}

// ── Key hygiene (Signal-parity plan B1/B3) ──────────────────────────────────
// After a rotation, records sealed under old HDK versions stay readable by
// anyone still holding an old envelope (the accepted §5.2 limitation). This
// pass upgrades that: decrypt each old-version record via the version→HDK map,
// re-seal it under the CURRENT version, and once none remain, retire the old
// envelopes server-side — a removed member's key then opens nothing at all.

// Re-seal every record still on an old key version. Needs an unlocked session
// with the current HDK; quietly does nothing without one.
export async function reencryptOldVersions(
  onProgress?: (p: { sealed: number; total: number }) => void,
): Promise<{ total: number; sealed: number; failed: number }> {
  if (!getHDK()) return { total: 0, sealed: 0, failed: 0 };
  const { data } = await householdApi.oldVersions();
  const total = data.total || 0;
  let sealed = 0;
  let failed = 0;
  for (const group of data.collections || []) {
    for (const record of group.records) {
      try {
        const id = String(record._id);
        if (group.collection === 'Record') {
          // C3b: a unified-store row — decrypt OPAQUELY (openOpaqueRecord recovers
          // the real collection from the v2 ciphertext via the OLD version's HDK),
          // re-seal that collection's content under the current version, and write
          // it back through /records (the opaque store, not /e2ee/seal).
          const dec = await openOpaqueRecord({ ...record, _id: id });
          if (!dec) throw new Error('opaque old-version record failed to decrypt');
          const sealedEnc = await encryptRecord(dec.collection, id, contentOf(dec.record));
          if (!sealedEnc) throw new Error('encryption returned null (no HDK)');
          await recordsApi.update(id, { enc: sealedEnc.enc, keyVersion: sealedEnc.keyVersion });
        } else {
          // Trip/TripItem stay per-collection: decrypt by collection and re-seal via
          // /e2ee/seal (which routes them back in place).
          const opened = await openRecord(group.collection, { ...record, _id: id });
          const { enc } = opened as Record<string, unknown>;
          if (enc === record.enc) throw new Error('old-version record failed to decrypt');
          const sealedEnc = await encryptRecord(group.collection, id, contentOf(opened as Record<string, unknown>));
          if (!sealedEnc) throw new Error('encryption returned null (no HDK)');
          await householdApi.seal({ collection: group.collection, _id: id, ...sealedEnc });
        }
        sealed++;
      } catch {
        failed++;
      }
      onProgress?.({ sealed, total });
    }
  }
  return { total, sealed, failed };
}

// Best-effort background pass: re-seal old-version records, then ask the server
// to retire the drained envelopes. The retire call 409s harmlessly while
// anything (records or attachment file keys) still needs an old version.
export async function maintainKeyHygiene(): Promise<void> {
  // Join carry-over FIRST: records stranded in a household we left are sealed
  // under its old HDK, so every pass below (which works in current-household key
  // versions) would only skip them. Moving them in first means they're ordinary
  // current-household records by the time key hygiene runs. Repairs joins that
  // already happened, not just new ones — see lib/joinCarryover.
  try {
    const { carryOverStrandedRecords } = await import('./joinCarryover');
    await carryOverStrandedRecords();
  } catch { /* offline / locked / nothing stranded — retried on a later unlock */ }
  // Then invitation merge: cross-household event invitations between two people
  // who now share a household. It runs AFTER carry-over on purpose — the copy it
  // resolves is one of the records carry-over just moved, and the organizer's
  // event it converges onto has to be readable under the CURRENT household's key
  // before anything can be re-sealed onto it. See lib/invitationMerge.
  try {
    const { reconcileMergedInvitations } = await import('./invitationMerge');
    await reconcileMergedInvitations();
  } catch { /* offline / locked / nothing to merge — retried on a later unlock */ }
  try {
    const res = await reencryptOldVersions();
    if (res.failed === 0) await householdApi.retireKey().catch(() => {});
  } catch { /* offline / locked — retried on a later unlock */ }
  // Re-seal + re-drop backfill for households dropped before pass 2. Gated on the
  // server's `resealNeeded` flag so migrated/born-encrypted households skip it.
  try {
    const { data: hh } = await householdApi.get();
    if (hh?.resealNeeded) await reencryptForReDrop();
  } catch { /* offline / locked / nothing to do — retried on a later unlock */ }
  // Signal-parity D1/D2: provision/rotate resource keys for outside-shared
  // calendars (CalendarKeys) and shared trips (TripKeys) this household owns, wrap
  // them to accepted collaborators, and re-seal the records — the owner-device
  // half of the approve-on-device sharing flow.
  try {
    const { reconcileCalendarKeys, repairCalendarLaneEvents } = await import('./calendarKeys');
    await reconcileCalendarKeys();
    // Separate call, not folded into the reconcile: that pass early-returns
    // when the server reports no pending key work, which is exactly the state
    // a calendar damaged by the old truncating re-seal sits in.
    await repairCalendarLaneEvents();
  } catch { /* offline / locked / nothing to do — retried on a later unlock */ }
  // (Shared-lane CalendarKey loading — ensureSharedCalendarKeys — runs directly
  // from the auth store's keys-ready hook, ordered BEFORE this pass so the
  // replica decrypts first; this whole pass also runs from that hook, on every
  // unlock — fresh login included — so a newly accepted collaborator gets their
  // wrap the next time the owner opens Calen, however the owner signed in.)
  try {
    const { reconcileTripKeys } = await import('./tripKeys');
    await reconcileTripKeys();
  } catch { /* offline / locked / nothing to do — retried on a later unlock */ }
}
