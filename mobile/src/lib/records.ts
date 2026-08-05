// Signal-parity C3 (opaque record envelopes) — the client half of the unified
// store. The server serves every content record through ONE householdId +
// updatedAt sync cursor with no plaintext type; this module pulls that feed,
// decrypts each row (recovering its collection from inside the v2 ciphertext via
// openOpaqueRecord), and buckets the decrypted record into its per-collection
// replica so the existing screens/query helpers keep reading the replica exactly
// as they do today. Writes go opaque through /records.
//
// This is the client counterpart to server/src/{models/Record.js,routes/records.js}.
// It is the load-bearing brick the C3b cutover flips the screens onto; until then
// it is additive (nothing calls it in the render path yet). Sync is last-write-
// wins on the server's `updatedAt` (decision D6), so it composes with the replica's
// own LWW upsert. See docs/SIGNAL-PARITY-PLAN.md §C3 (decision doc).

import type { RecordRow, RecordSyncResponse } from '../api';

const CURSOR_KEY = 'hc_records_cursor';

// Injectable seams so the sync loop is unit-testable without the crypto/network/
// storage singletons. Production defaults wire the real api/e2ee/replica — lazily
// required inside each closure so importing this module never loads the native
// AsyncStorage / libsodium modules (the tests inject fakes and never touch them).
export interface RecordSyncDeps {
  fetch: (since: string | null) => Promise<RecordSyncResponse>;
  decrypt: (row: RecordRow) => Promise<{ collection: string; record: Record<string, unknown> } | null>;
  upsert: (collection: string, rows: Record<string, unknown>[]) => Promise<void>;
  remove: (collection: string, id: string) => Promise<void>;
  getCursor: () => Promise<string | null>;
  setCursor: (cursor: string) => Promise<void>;
  // This session's household, to classify an undecryptable row as retryable
  // (ours) or permanently foreign (see the cursor-safety note on syncRecords).
  myHouseholdId: () => string | null;
}

const store = () => require('@react-native-async-storage/async-storage').default;

const defaultDeps: RecordSyncDeps = {
  fetch: (since) => require('../api').recordsApi.sync(since).then((r: { data: RecordSyncResponse }) => r.data),
  decrypt: (row) => require('./e2ee').openOpaqueRecord(row),
  upsert: (collection, rows) => require('./replica').upsert(collection, rows),
  remove: (collection, id) => require('./replica').remove(collection, id),
  getCursor: () => store().getItem(CURSOR_KEY),
  setCursor: (cursor) => store().setItem(CURSOR_KEY, cursor),
  myHouseholdId: () => require('./e2ee').currentHouseholdId(),
};

export interface RecordSyncResult {
  upserted: number;
  removed: number;
  // Rows the session couldn't decrypt yet (no key held, or a v1 row that needs its
  // collection) — left for a later pass; the cursor does NOT advance past them so
  // they're retried, unless every row in the batch was undecryptable-and-skipped.
  skipped: number;
}

// Pull the unified feed once and reconcile it into the per-collection replica.
// A tombstone (`deleted`) removes the row from its bucket; every other row is
// decrypted and upserted under its recovered collection.
//
// Cursor safety: we may only advance the cursor PAST rows we actually
// reconciled. A content row we couldn't decrypt yet — the household key wasn't
// held (a sync that raced ahead of unlock right after sign-in, or an
// account-switch mid-boot) — must be re-pulled next pass, or it's stranded out
// of the replica for good while it still lives on the server. `since` is
// exclusive server-side (updatedAt > since) and the feed ascends, so we park the
// cursor at the last reconciled row BEFORE the first undecryptable content row.
// (A tombstone whose ciphertext is already gone is expected-undecryptable and
// permanent — it does NOT hold the cursor back, or the pull would loop forever.)
//
// A FOREIGN row is the same kind of permanent: the record scope's
// `userId ∈ scopeIds` branch serves us rows still stamped to another household
// (a member who joined us with data left behind — see lib/joinCarryover), sealed
// under an HDK we do not and will never hold. Blocking on those wedges the cursor
// for good: every later row, including our own, stops reconciling and the replica
// silently freezes at the moment of the join. So they're skipped like a reaped
// tombstone. The carry-over migration re-stamps and re-seals them into this
// household, at which point they arrive decryptable through the normal lane.
export async function syncRecords(deps: Partial<RecordSyncDeps> = {}): Promise<RecordSyncResult> {
  const d = { ...defaultDeps, ...deps };
  const since = await d.getCursor();
  const { records, serverTime } = await d.fetch(since);
  const mine = d.myHouseholdId();
  // Only classify as foreign when we know our own household AND the row names a
  // different one. A resource-scoped row legitimately carries another household's
  // id (the D1/D2 shared lane) and IS readable via its resource key, so it stays
  // retryable — its key may simply not be loaded yet.
  const isForeign = (row: RecordRow): boolean =>
    !!mine && !!row.householdId && String(row.householdId) !== mine && !row.scope?.resource;

  // Group upserts by collection so each bucket is written once.
  const byCollection = new Map<string, Record<string, unknown>[]>();
  let removed = 0;
  let skipped = 0;
  let firstBlockedAt: string | null = null; // earliest content row we must retry
  let watermark: string | null = since;     // newest updatedAt safe to commit past

  for (const row of records) {
    const at = row.updatedAt ?? serverTime; // server always sends it; fall back for the type
    if (row.deleted) {
      // A tombstone: we don't know the collection without decrypting, and a
      // deleted row's ciphertext may be gone — so drop it from every bucket it
      // could live in. replica.remove is a no-op where the id isn't present.
      const dec = await d.decrypt(row).catch(() => null);
      if (dec) await d.remove(dec.collection, row._id);
      else skipped += 1; // ciphertext gone — expected, not a retryable block
      removed += 1;
      if (firstBlockedAt === null) watermark = at;
      continue;
    }
    const dec = await d.decrypt(row).catch(() => null);
    if (!dec) {
      // Couldn't decrypt a live content row. If it's ours, the key isn't ready —
      // block the cursor so this row (and everything after it) is re-pulled once
      // unlocked. If it's foreign, we never hold that key: skip it permanently
      // rather than wedging the whole feed behind it.
      skipped += 1;
      if (isForeign(row)) {
        if (firstBlockedAt === null) watermark = at;
        continue;
      }
      if (firstBlockedAt === null) firstBlockedAt = at;
      continue;
    }
    const list = byCollection.get(dec.collection) ?? [];
    list.push({ ...dec.record, _id: row._id, updatedAt: row.updatedAt });
    byCollection.set(dec.collection, list);
    if (firstBlockedAt === null) watermark = at;
  }

  let upserted = 0;
  for (const [collection, rows] of byCollection) {
    await d.upsert(collection, rows);
    upserted += rows.length;
  }

  // No blocked row → fully caught up. Otherwise commit only up to the last row
  // before the block, and only if it's strictly older than the blocked row (so a
  // same-timestamp block is still re-pulled); if nothing preceded it, leave the
  // cursor untouched so the whole window retries next pass.
  if (firstBlockedAt === null) {
    await d.setCursor(serverTime);
  } else if (watermark !== null && watermark < firstBlockedAt) {
    await d.setCursor(watermark);
  }
  return { upserted, removed, skipped };
}

// Reset the incremental cursor so the next syncRecords() does a full pull (used on
// unlock / account switch, mirroring replica.clearAll).
export async function resetRecordCursor(): Promise<void> {
  await store().removeItem(CURSOR_KEY);
}

// Whether this device has completed at least one sync pass (a cursor exists).
// While false the replica is empty (fresh install, or post-unlock/account-switch
// reset), so cache-first readers must fall back to an inline sync.
export async function hasSyncedRecords(): Promise<boolean> {
  return (await store().getItem(CURSOR_KEY)) != null;
}
