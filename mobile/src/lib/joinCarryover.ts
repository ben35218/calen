// Join carry-over — bring a joiner's own records into the household they joined.
//
// Joining used to be a bare `User.householdId` flip, on the premise that a
// member's data travelled with them. Signal-parity C4 ended that: an e2eeActive
// household stamps its own `householdId` on every record and drops the plaintext
// `userId`, so after a move the joiner's records sit in a household nobody is a
// member of, sealed under an HDK the destination doesn't hold. Both sides then
// see only what their local replica already cached — the household looks merged
// but the calendars never converge.
//
// The server can't fix this: it never holds an HDK, so it cannot re-seal. This
// module is the device half. On an unlocked session it asks for anything stranded
// (`GET /household/carryover`, authorized by our still-held key envelope for the
// old household), decrypts each row under that household's key, re-seals it under
// the CURRENT household's HDK, and hands it back to be re-stamped. Once a
// household is drained it's reaped along with its key material.
//
// Runs from maintainKeyHygiene on every unlock, so it repairs joins that already
// happened as well as any future one, and it is idempotent + resumable: a record
// already moved reports `moved: false`, and a failed row is simply retried next
// unlock. See specs/features/households-sharing.md.

import { householdApi } from '../api';
import { getHDK, encryptRecord, unwrapForeignHDKs, openForeignRecord } from './e2ee';

// The routing/plaintext columns of a `Record` row, stripped before re-sealing so
// what goes back into `enc` is exactly the content that came out of it — never the
// envelope's own routing (which the destination household restamps). Mirrors
// dropMigration.contentOf.
function contentOf(record: Record<string, unknown>): Record<string, unknown> {
  const { _id, householdId, userId, keyVersion, enc, scope, deleted, updatedAt, createdAt, ...content } = record;
  return content;
}

export interface CarryoverResult {
  total: number;
  moved: number;
  failed: number;
  reaped: number;
}

// Move every stranded record into the current household. Requires an unlocked
// session holding the destination HDK — without it there's nothing to re-seal
// under, so the pass no-ops and retries on the next unlock.
export async function carryOverStrandedRecords(
  onProgress?: (p: { moved: number; total: number }) => void,
): Promise<CarryoverResult> {
  if (!getHDK()) return { total: 0, moved: 0, failed: 0, reaped: 0 };

  const { data } = await householdApi.carryover();
  const total = data.total || 0;
  if (!total) return { total: 0, moved: 0, failed: 0, reaped: 0 };

  let moved = 0;
  let failed = 0;
  for (const household of data.households || []) {
    // The old household's key material, unwrapped with our identity key. Without
    // it nothing in this household is readable — count the rows as failed so the
    // drain/reap below correctly leaves the household standing.
    const oldHDKs = await unwrapForeignHDKs(household.envelopes || []);
    if (!oldHDKs.size) { failed += household.records.length; continue; }

    for (const row of household.records) {
      try {
        const dec = await openForeignRecord(
          { _id: String(row._id), keyVersion: row.keyVersion, enc: row.enc },
          household.householdId,
          oldHDKs,
        );
        if (!dec) throw new Error('stranded record failed to decrypt');
        // Re-seal under the CURRENT household + key version. The record AAD binds
        // householdId, so this is a genuine re-encryption, not a re-stamp — which
        // is exactly why the server can't do it.
        const sealed = await encryptRecord(dec.collection, String(row._id), contentOf(dec.record));
        if (!sealed) throw new Error('encryption returned null (no HDK)');
        await householdApi.carryoverMove(String(row._id), { enc: sealed.enc, keyVersion: sealed.keyVersion });
        moved += 1;
      } catch {
        failed += 1;
      }
      onProgress?.({ moved, total });
    }
  }

  // Drain + reap the emptied households. Attempted whenever anything moved; a
  // household with failures left behind simply isn't reaped (the server re-checks
  // that it's genuinely empty), and the next unlock retries the stragglers.
  let reaped = 0;
  if (moved > 0) {
    try { reaped = (await householdApi.carryoverComplete()).data.reaped || 0; } catch { /* retried next unlock */ }
  }
  return { total, moved, failed, reaped };
}
