// Local record replica (mobile) — Phase 4b foundation.
//
// Mirrors client/src/services/replica.js: an offline cache of household records
// so the app can paint instantly and query/sort/filter client-side. Sync is
// last-write-wins on the server's `updatedAt` (decision D6).
//
// Backend note (Decision D5): the real store is expo-sqlite (lib/sqliteReplica).
// We prefer it when its native module is linked, and fall back to AsyncStorage
// otherwise — so this runs on the current dev client with no rebuild, and
// automatically upgrades to SQLite once a dev-client build adds the module. Both
// backends satisfy the same interface below. See docs/E2EE-SYNC-PLAN.md §6 / P7.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as sqlite from './sqliteReplica';

// The minimal shape the replica needs from any record; concrete model types
// (Recipe, Item, …) satisfy it structurally without an index signature.
type Row = { _id: string; updatedAt?: string };
type StoredRow = Row & Record<string, unknown>;

// Decide once whether the SQLite backend is usable (native module present).
let useSqlite: boolean | null = null;
function sqliteReady(): boolean {
  if (useSqlite === null) {
    try { useSqlite = sqlite.isAvailable(); } catch { useSqlite = false; }
  }
  return useSqlite;
}

const key = (collection: string) => `hc_replica:${collection}`;

async function readMap(collection: string): Promise<Record<string, StoredRow>> {
  try {
    const raw = await AsyncStorage.getItem(key(collection));
    return raw ? (JSON.parse(raw) as Record<string, StoredRow>) : {};
  } catch {
    return {};
  }
}

// Upsert full records, last-write-wins on `updatedAt` (a stale row never
// overwrites a fresher one).
export async function upsert(collection: string, rows: Row[]): Promise<void> {
  if (!rows?.length) return;
  if (sqliteReady()) return sqlite.upsert(collection, rows);
  const map = await readMap(collection);
  for (const row of rows) {
    const existing = map[row._id];
    if (existing && new Date(existing.updatedAt || 0) > new Date(row.updatedAt || 0)) continue;
    map[row._id] = row as StoredRow;
  }
  await AsyncStorage.setItem(key(collection), JSON.stringify(map));
}

export async function getAll<T = Row>(collection: string): Promise<T[]> {
  if (sqliteReady()) return sqlite.getAll<T>(collection);
  return Object.values(await readMap(collection)) as unknown as T[];
}

// Client-side query: fetch a collection, then filter/sort in memory.
export async function query<T = Row>(
  collection: string,
  opts: { filter?: (r: T) => boolean; sort?: (a: T, b: T) => number } = {},
): Promise<T[]> {
  let rows = await getAll<T>(collection);
  if (opts.filter) rows = rows.filter(opts.filter);
  if (opts.sort) rows = [...rows].sort(opts.sort);
  return rows;
}

// Offline-first list fetch: run `fetcher` (returns full records), sync into the
// replica, and return it — falling back to the cached copy when the fetch fails.
export async function syncedList<T extends Row>(
  collection: string,
  fetcher: () => Promise<T[]>,
): Promise<T[]> {
  try {
    const rows = await fetcher();
    upsert(collection, rows).catch(() => {});
    return rows;
  } catch (e) {
    const cached = await getAll<T>(collection);
    if (cached.length) return cached;
    throw e;
  }
}

// Remove one row (a C3 tombstone from the unified sync — the server soft-deletes
// and the client drops it from the replica so a deleted record stops appearing).
export async function remove(collection: string, id: string): Promise<void> {
  if (sqliteReady()) return sqlite.remove(collection, id);
  const map = await readMap(collection);
  if (map[id]) {
    delete map[id];
    await AsyncStorage.setItem(key(collection), JSON.stringify(map));
  }
}

export async function clear(collection: string): Promise<void> {
  if (sqliteReady()) return sqlite.clear(collection);
  await AsyncStorage.removeItem(key(collection));
}

// Move a whole bucket to a new collection name, for a collection RENAME (the
// Person→Contact rename). Rows already synced sit under the old name and the
// sync cursor will never resend them, so without this an upgraded install shows
// an empty roster until something forces a full resync. Backend-agnostic (it
// goes through the same getAll/upsert/clear the two backends both implement)
// and idempotent: once the old bucket is drained, later calls are a no-op.
// Returns how many rows moved.
export async function migrateCollection(from: string, to: string): Promise<number> {
  const rows = await getAll<StoredRow>(from);
  if (rows.length) await upsert(to, rows);
  await clear(from);
  return rows.length;
}

// Wipe every replicated collection (both backends) — a signed-out device must
// not keep another household's records.
export async function clearAll(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('hc_replica:'));
  if (keys.length) await AsyncStorage.multiRemove(keys);
  if (sqliteReady()) await sqlite.clearAll();
}
