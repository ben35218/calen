// Owner-device reconciliation of per-resource TripKeys (Signal-parity D2).
//
// A shared trip's Trip + TripItems (+ shared_shared attachments) seal under a
// TripKey instead of the household HDK, so cross-household collaborators can read
// them without a plaintext feed. The server only ferries opaque envelopes; the
// actual crypto (mint, wrap-to-collaborator, rotate-on-revoke, re-seal the
// records) happens on an owning-household member's unlocked device. This module
// is the background pass that does it, driven off `GET /trips/keys/pending`. Runs
// from maintainKeyHygiene after unlock. Mirrors lib/calendarKeys.ts. See §D2.

import { tripsApi, type TripKeyPending } from '../api';
import {
  getHDK, mintResourceKey, wrapResourceKeyForCollaborator, loadResourceKeys,
  sealForResource, openRecord, currentResourceKeyVersion,
} from './e2ee';

// Wrap the (held) TripKey to a set of collaborators, returning the member
// envelopes the server will store. Skips anyone we can't seal to.
async function wrapFor(
  resource: string, version: number,
  contacts: { userId: string; identityPublicKey: string }[],
): Promise<{ userId: string; wrappedKey: string }[]> {
  const out: { userId: string; wrappedKey: string }[] = [];
  for (const p of contacts) {
    if (!p.identityPublicKey) continue;
    const wrapped = await wrapResourceKeyForCollaborator(resource, version, p.identityPublicKey);
    if (wrapped) out.push({ userId: p.userId, wrappedKey: wrapped });
  }
  return out;
}

// Re-seal a trip's Trip record + its items under `version` of the TripKey.
// openRecord decrypts each (via the HDK for a migrating record, or the old TripKey
// version for a rotation), then sealForResource re-seals under the current key.
// PUTs only the ciphertext (the routes strip the now-sealed plaintext columns).
async function reSealTrip(tripId: string): Promise<void> {
  let detail: { trip?: Record<string, unknown>; items?: Record<string, unknown>[] };
  try { ({ data: detail } = await tripsApi.get(tripId) as unknown as { data: typeof detail }); } catch { return; }

  // The Trip record itself (resource = its own _id).
  if (detail.trip) {
    try {
      const t = await openRecord('Trip', detail.trip as { _id: string; tripId?: string; enc?: { alg: string; nonce: string; ct: string; ks?: string } }) as Record<string, unknown>;
      const content = { name: t.name, destination: t.destination, notes: t.notes };
      if (content.name !== undefined || content.notes !== undefined || content.destination !== undefined) {
        const sealed = await sealForResource('trip', 'Trip', tripId, tripId, content);
        if (sealed) await tripsApi.update(tripId, { ...sealed });
      }
    } catch { /* best-effort; retried on the next pass */ }
  }

  for (const raw of detail.items || []) {
    try {
      const opened = await openRecord('TripItem', raw as { _id: string; tripId?: string; enc?: { alg: string; nonce: string; ct: string; ks?: string } });
      const o = opened as Record<string, unknown>;
      const content = {
        title: o.title, location: o.location, url: o.url,
        phone: o.phone, notes: o.notes, details: o.details,
      };
      if (content.title === undefined && content.notes === undefined && content.details === undefined) continue;
      const sealed = await sealForResource('trip', 'TripItem', String(o._id), tripId, content);
      if (!sealed) continue;
      await tripsApi.updateItem(tripId, String(o._id), { ...sealed });
    } catch { /* best-effort; retried on the next pass */ }
  }
}

// Provision/rotate one trip's TripKey per its pending entry.
async function reconcileOne(p: TripKeyPending): Promise<void> {
  const resource = p.tripId;
  await loadResourceKeys('trip', resource).catch(() => {}); // hold the current key first

  if (p.needsMint) {
    // First-share: mint v1, wrap to every collaborator, then migrate the trip's
    // existing HDK-sealed (or plaintext-lane) records onto the TripKey.
    const minted = await mintResourceKey(resource, 1);
    if (!minted) return;
    const members = await wrapFor(resource, 1, p.collaborators);
    await tripsApi.mintKey(resource, { keyVersion: 1, household: minted.household, members });
    await reSealTrip(resource);
    return;
  }

  if (p.rotationPending) {
    // Revoke/un-share: fresh key at the next version, re-wrapped to the REMAINING
    // collaborators only, then re-seal so the removed party's old key opens nothing.
    const next = p.currentKeyVersion + 1;
    const minted = await mintResourceKey(resource, next);
    if (!minted) return;
    const members = await wrapFor(resource, next, p.collaborators);
    await tripsApi.mintKey(resource, { keyVersion: next, household: minted.household, members });
    await reSealTrip(resource);
    return;
  }

  // Steady state: a newly-accepted collaborator needs the current key wrapped to
  // them (the async approve-on-device step). No rotation, no re-seal.
  if (p.missingMembers.length) {
    const version = p.currentKeyVersion || currentResourceKeyVersion(resource);
    const members = await wrapFor(resource, version, p.missingMembers);
    if (members.length) await tripsApi.wrapMembers(resource, { keyVersion: version, members });
  }
}

// Run the full reconciliation. Needs an unlocked session (HDK held); a no-op
// otherwise. Best-effort and idempotent — safe to call on every unlock.
export async function reconcileTripKeys(): Promise<void> {
  if (!getHDK()) return;
  let pending: TripKeyPending[];
  try { ({ data: pending } = await tripsApi.pendingKeys()); } catch { return; }
  for (const p of pending) {
    await reconcileOne(p).catch(() => {});
  }
}
