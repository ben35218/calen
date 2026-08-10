// Signal-parity C3b — the client CRUD chokepoint over the unified opaque store.
//
// Pre-C3b every content screen called a per-collection api group (tasksApi,
// choresApi, …) that POSTed to a per-collection route (/tasks, /chores, …) — and
// the request LINE itself leaked the collection type. The screens already SEAL
// their content (sealNew/sealUpdate return `{ _id?, ...plaintextPayload, enc,
// keyVersion }`), so the only thing that has to change is where that sealed
// payload goes: this module routes it through the opaque `/records` API and
// mirrors the decrypted copy into the per-collection replica, so the screens keep
// calling the same api groups and reading the same replica buckets unchanged.
//
// Reads come from the replica (populated by lib/records.syncRecords → the unified
// `/records/sync` feed). The server is fully content-blind: it stores only the
// opaque `enc` + routing, and this client filters/sorts over the decrypted rows.
// See docs/SIGNAL-PARITY-PLAN.md §C3 (C3b).

import * as replica from './replica';

type Rec = Record<string, any>;
type StoredRec = Rec & { _id: string };

// Lazily reach the api/records singletons so this lib never forms an import cycle
// with api/index.ts (which delegates its content groups here).
const recordsApi = () => require('../api').recordsApi;
const runSync = () => require('./records').syncRecords as () => Promise<unknown>;

// ── Calendar cache invalidation ──────────────────────────────────────────────
// The calendar views assemble from the REPLICA (lib/calendarData), not from a
// per-screen query — so a write mirrored below is already the new truth on
// device, and the only thing standing between it and the grid is the cached
// ['calendar'] query data (30s staleTime, no refetch-on-focus; the grid is a
// mounted tab, so nothing re-runs on its own). Invalidating here, at the one
// CRUD chokepoint, is what keeps a contact/chore/event editor from having to
// remember it: editing a contact's occasion dates repainted the Occasions list
// (it reads ['people']) but left the month grid showing the old dates until the
// next sync pass, because the person form only invalidated ['people'].
// `Recipe` is in the set even though no recipe is itself a calendar item: the
// calendar joins each scheduled meal's title out of the Recipe replica
// (lib/calendarData), so renaming a recipe changes what the grid renders.
const CALENDAR_COLLECTIONS = new Set([
  'CalendarEvent', 'MaintenanceTask', 'Chore', 'Person', 'RecipeSchedule', 'EventRsvp', 'Recipe',
]);

// Coalesce bursts (a bulk contact import writes one record per contact) into a
// single invalidation rather than a refetch per row.
let calendarInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

function invalidateCalendar(collection: string): void {
  if (!CALENDAR_COLLECTIONS.has(collection) || calendarInvalidateTimer) return;
  calendarInvalidateTimer = setTimeout(() => {
    calendarInvalidateTimer = null;
    try {
      require('./queryClient').queryClient.invalidateQueries({ queryKey: ['calendar'] });
    } catch {
      // no query client in this context (scripts/tests) — nothing to refresh
    }
  }, 50);
}

// A screen-built sealed payload carries BOTH the plaintext content (for the local
// replica copy) and the ciphertext. Split them: only the ciphertext + routing
// (`enc`/`keyVersion`/`scope`) may reach the opaque store; everything else is the
// decrypted copy kept on-device.
function splitSealed(sealed: Rec): { wire: Rec; plain: Rec } {
  const { enc, keyVersion, scope, _id, updatedAt, ...plain } = sealed;
  const wire: Rec = { enc, keyVersion };
  if (scope) wire.scope = scope;
  return { wire, plain };
}

// Ensure the replica reflects the latest server state (best-effort incremental
// pull; offline reads the cache).
export async function refresh(): Promise<void> {
  await runSync()().catch(() => {});
}

// List a collection from the replica, applying any equality filters passed as
// query params (itemId/categoryId/active/type/…): the server no longer filters by
// content, so the client does. Undefined/null params are ignored.
//
// **Equality only.** A param naming a field no record carries — the pre-C3b
// `{ start, end }` date range the meal planner still passed — matches NOTHING
// and the caller silently gets an empty list. Range/predicate selection is the
// caller's job, over the decrypted rows (see lib/mealSchedule); the dev warning
// below is there so the next one surfaces instead of reading as "no data".
export async function list<T = Rec>(
  collection: string,
  params?: Record<string, unknown>,
): Promise<{ data: T[] }> {
  await refresh();
  let rows = await replica.getAll<T>(collection);
  if (params) {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length) {
      if (__DEV__ && rows.length) {
        for (const [k] of entries) {
          if (!rows.some((r) => (r as Rec)[k] !== undefined)) {
            console.warn(`[recordStore] list('${collection}') filtered on '${k}', a field no record carries — this yields an empty list.`);
          }
        }
      }
      rows = rows.filter((r) => entries.every(([k, v]) => String((r as Rec)[k] ?? '') === String(v)));
    }
  }
  return { data: rows };
}

// One decrypted record from the replica (offline-first). Mirrors the pre-C3b
// per-collection GET :id contract: returns `{ data: T }`, and throws (like a 404)
// when the id isn't present — so callers keep their non-null typing. Syncs once
// if the row isn't cached yet (e.g. deep-linked before the first list).
export async function get<T = Rec>(collection: string, id: string): Promise<{ data: T }> {
  let row = (await replica.getAll<Rec>(collection)).find((r) => r._id === id);
  if (!row) {
    await refresh();
    row = (await replica.getAll<Rec>(collection)).find((r) => r._id === id);
  }
  if (!row) throw new Error('Not found');
  return { data: row as T };
}

// Create: POST the opaque ciphertext to /records (the server stamps householdId +
// author routing), then mirror the decrypted copy into the replica so the screen's
// next read paints it. `sealed` is the sealNew() result (carries the client-minted
// _id).
export async function create<T = Rec>(collection: string, sealed: Rec): Promise<{ data: T }> {
  const { wire, plain } = splitSealed(sealed);
  const { data: row } = await recordsApi().create({ _id: sealed._id, ...wire });
  // Ciphertext included for the same reason as `update` below: the replica row
  // must decrypt to what it displays, not to whatever it held before.
  const full: StoredRec = { ...plain, ...wire, _id: row._id, updatedAt: row.updatedAt };
  await replica.upsert(collection, [full]);
  invalidateCalendar(collection);
  return { data: full as T };
}

// Update: PUT the re-sealed ciphertext to /records/:id, then merge the decrypted
// copy over the replica row (sealUpdate already merged the decrypted record under
// the update, so `plain` is the full new content).
//
// The **ciphertext must travel with it**. `splitSealed` moves `enc`/`keyVersion`
// into the wire payload, so `plain` carries none — and merging over `existing`
// would therefore leave the row holding fresh plaintext beside the PREVIOUS
// ciphertext. That row decrypts to the old content, and `openRecord` spreads the
// decrypted fields *over* the plaintext, so every reader saw the pre-update
// record until a background sync happened to replace the whole row. The symptom
// is an edit that "doesn't take" until you do it a second time (reported against
// Resume schedule, and against an ended chore staying in the chores list).
export async function update<T = Rec>(collection: string, id: string, sealed: Rec): Promise<{ data: T }> {
  const { wire, plain } = splitSealed(sealed);
  const { data: row } = await recordsApi().update(id, wire);
  const existing = (await replica.getAll<Rec>(collection)).find((r) => r._id === id) ?? {};
  const full: StoredRec = { ...existing, ...plain, ...wire, _id: id, updatedAt: row.updatedAt };
  await replica.upsert(collection, [full]);
  invalidateCalendar(collection);
  return { data: full as T };
}

// Delete: tombstone on the server (propagates to every replica via the sync
// cursor) + drop from this device's replica immediately.
export async function remove(collection: string, id: string): Promise<{ data: { message: string } }> {
  await recordsApi().remove(id);
  await replica.remove(collection, id);
  invalidateCalendar(collection);
  return { data: { message: 'Deleted' } };
}
