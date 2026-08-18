// The shopping session's sync layer (spec: features/kitchen.md, "Encryption
// boundary" + the shopping-session bullet): the household-shared per-week
// `ShoppingSession` is a SEALED blob with an optimistic-concurrency version.
//
// - Sealing: the whole `GrocerySessionState` encrypts under the household key
//   (lib/e2ee.encryptRecord) as collection 'ShoppingSession' with AAD id = the
//   weekStart string — the session has no client-minted _id, and one row per
//   household × week makes weekStart the stable identity. Reads fall back to
//   the legacy plaintext top-level fields while `enc` is absent; the first
//   sealed write clears the plaintext server-side.
// - Concurrency: every save carries the version it read (`baseVersion`); the
//   server 409s on mismatch. The server can't merge what it can't read, so the
//   conflict is resolved HERE: re-fetch, merge on-device (mergeGrocerySession),
//   retry — bounded. Two shoppers checking items and adding extras at once both
//   survive; before this, the whole blob was last-write-wins.
//
// A session sealed by another device that this session can't open (no HDK yet)
// is surfaced as `locked` — the caller must not write, since it could only
// write blindly over state it can't see.

import {
  recipeScheduleApi,
  GroceryExtra,
  GrocerySessionEnvelope,
  GrocerySessionState,
} from '../api';
import { extraKey } from './groceryExtras';

// e2ee is loaded lazily at the two call sites that need it: it drags the
// native crypto adapter into the module graph, and this module is imported by
// screens whose tests (and merge-only callers) never touch a sealed blob.
const e2ee = () => require('./e2ee') as typeof import('./e2ee');

// How many times one logical save will retry through 409-merge cycles before
// giving up (the next state change tries again anyway).
const MAX_SAVE_ATTEMPTS = 3;

const SESSION_COLLECTION = 'ShoppingSession';

// Merge two divergent copies of the week's shopping state — ours (about to be
// saved) and the server's (written by another shopper since we read). Simple
// and safe over clever:
// - checked / not-found / have-at-home: union of set flags — both shoppers'
//   ticks survive. (An uncheck racing a check loses to the check; re-unchecking
//   is cheap, a lost tick mid-store is not.)
// - extras: union by cleaned name, local order first — both sides' additions
//   survive. An extra deleted locally but present remotely comes back
//   (accepted: resurrection beats losing the other shopper's addition).
// - substitutions: union by key, local value winning per-key.
// - organizedList/organizedFor: one side's wins whole (a list is not mergeable
//   row-by-row): the local one when it exists — the merging device is
//   performing the later action — else the remote one. Last organize wins.
export function mergeGrocerySession(
  local: GrocerySessionState,
  remote: GrocerySessionState,
): GrocerySessionState {
  const unionFlags = (a?: Record<string, boolean>, b?: Record<string, boolean>) => {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(b ?? {})) if (v) out[k] = true;
    for (const [k, v] of Object.entries(a ?? {})) if (v) out[k] = true;
    return out;
  };
  const extras: GroceryExtra[] = [...(local.extras ?? [])];
  const seen = new Set(extras.map((e) => extraKey(e.name)));
  for (const e of remote.extras ?? []) {
    if (!seen.has(extraKey(e.name))) extras.push(e);
  }
  const organizedSrc = local.organizedList != null ? local : remote;
  return {
    checked: unionFlags(local.checked, remote.checked),
    notFound: unionFlags(local.notFound, remote.notFound),
    haveHome: unionFlags(local.haveHome, remote.haveHome),
    substitutions: { ...(remote.substitutions ?? {}), ...(local.substitutions ?? {}) },
    extras,
    organizedList: organizedSrc.organizedList ?? null,
    organizedFor: organizedSrc.organizedFor ?? null,
  };
}

// A fetched session opened for use: the decrypted (or legacy plaintext) state,
// the version to save against, and whether it was sealed by a key this device
// doesn't hold (`locked` — read-only until the key arrives).
export interface OpenedGrocerySession {
  state: GrocerySessionState;
  version: number;
  locked: boolean;
}

export async function openGrocerySession(
  weekStart: string,
  data: GrocerySessionEnvelope | null | undefined,
): Promise<OpenedGrocerySession> {
  const version = data?.version ?? 0;
  if (data?.enc) {
    const { decryptRecord } = e2ee();
    const state = await decryptRecord<GrocerySessionState>(
      SESSION_COLLECTION, weekStart, data.keyVersion, data.enc,
    );
    return { state: state ?? {}, version, locked: state == null };
  }
  const { enc: _enc, keyVersion: _kv, version: _v, ...state } = data ?? {};
  return { state, version, locked: false };
}

// One versioned write: seal when the household key is held, else the legacy
// plaintext lane (a session is never blocked on the key — same posture as
// sealNew). Resolves to the server's new version; rejects with the axios error
// (409 included) for the caller to handle.
async function putGrocerySession(
  weekStart: string,
  state: GrocerySessionState,
  baseVersion: number,
): Promise<number> {
  const { encryptRecord } = e2ee();
  const sealed = await encryptRecord(SESSION_COLLECTION, weekStart, state);
  const body = sealed
    ? { enc: sealed.enc, keyVersion: sealed.keyVersion, baseVersion }
    : { state, baseVersion };
  const res = await recipeScheduleApi.sessionPut(weekStart, body);
  return res.data?.version ?? baseVersion + 1;
}

export interface GrocerySessionSaveResult {
  state: GrocerySessionState; // what actually persisted (merged on conflict)
  version: number;
  merged: boolean; // true when a 409 pulled in another shopper's changes
}

// Save with bounded 409-merge-retry. Throws when the server stays unreachable
// or the conflict can't be resolved (a remote blob we can't open) — callers
// treat that as "try again on the next change".
export async function saveGrocerySession(
  weekStart: string,
  state: GrocerySessionState,
  baseVersion: number,
): Promise<GrocerySessionSaveResult> {
  let current = state;
  let version = baseVersion;
  let merged = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await putGrocerySession(weekStart, current, version);
      return { state: current, version: saved, merged };
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 409 || attempt >= MAX_SAVE_ATTEMPTS - 1) throw err;
      const remote = await recipeScheduleApi.sessionGet(weekStart);
      const opened = await openGrocerySession(weekStart, remote.data);
      if (opened.locked) throw err; // can't merge what we can't read
      current = mergeGrocerySession(current, opened.state);
      version = opened.version;
      merged = true;
    }
  }
}
