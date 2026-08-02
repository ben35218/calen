// Owner-device reconciliation of per-resource CalendarKeys (Signal-parity D1).
//
// An outside-shared calendar's events seal under a CalendarKey instead of the
// household HDK, so cross-household collaborators can read them without a
// plaintext feed. The server only ferries opaque envelopes; the actual crypto
// (mint, wrap-to-collaborator, rotate-on-revoke, re-seal the events) happens on
// the OWNER's unlocked device. This module is the background pass that does it,
// driven off `GET /calendars/keys/pending`. Runs from maintainKeyHygiene after
// unlock. See docs/SIGNAL-PARITY-PLAN.md §D1.

import { customCalendarsApi, calendarApi, type CalendarKeyPending, type CalendarEvent } from '../api';
import {
  getHDK, mintCalendarKey, wrapCalendarKeyForMember, loadCalendarKeys,
  sealForCalendar, currentCalendarKeyVersion, getResourceKey,
} from './e2ee';
import * as replica from './replica';
import { syncRecords, resetRecordCursor } from './records';

// Wrap the (held) CalendarKey to a set of collaborators, returning the member
// envelopes the server will store. Skips anyone we can't seal to.
async function wrapFor(
  resource: string, version: number,
  people: { userId: string; identityPublicKey: string }[],
): Promise<{ userId: string; wrappedKey: string }[]> {
  const out: { userId: string; wrappedKey: string }[] = [];
  for (const p of people) {
    if (!p.identityPublicKey) continue;
    const wrapped = await wrapCalendarKeyForMember(resource, version, p.identityPublicKey);
    if (wrapped) out.push({ userId: p.userId, wrappedKey: wrapped });
  }
  return out;
}

// Re-seal a calendar's events under the CURRENT version of its CalendarKey. The
// events arrive already-decrypted from the replica (C3b: syncRecords decrypted
// each opaque row — a migrating event via the HDK, a rotating one via the old
// CalendarKey version — so their plaintext content is in hand). sealForCalendar
// re-seals under the current key; the update carries `calendarType` so the store
// stamps the D1 resource `scope` (via withCalScope) and routes it to the cal lane.
async function reSealEvents(resource: string, events: CalendarEvent[]): Promise<void> {
  for (const ev of events) {
    try {
      const o = ev as unknown as Record<string, unknown>;
      const content = {
        title: o.title, description: o.description, location: o.location,
        phone: o.phone, startDate: o.startDate, endDate: o.endDate,
      };
      // Nothing decryptable (locked / no key) → skip rather than seal garbage.
      if (content.title === undefined && content.startDate === undefined) continue;
      const sealed = await sealForCalendar('CalendarEvent', String(ev._id), resource, content);
      if (!sealed) continue;
      await calendarApi.updateEvent(String(ev._id), { ...sealed, calendarType: resource });
    } catch { /* best-effort; retried on the next pass */ }
  }
}

// Provision/rotate one calendar's CalendarKey per its pending entry.
async function reconcileOne(p: CalendarKeyPending, events: CalendarEvent[]): Promise<void> {
  const resource = p.calendarKey;
  await loadCalendarKeys(resource).catch(() => {}); // hold the current key first

  if (p.needsMint) {
    // First-share: mint v1, wrap to every collaborator, then migrate the
    // calendar's existing HDK-sealed events onto the CalendarKey.
    const minted = await mintCalendarKey(resource, 1);
    if (!minted) return;
    const members = await wrapFor(resource, 1, p.collaborators);
    await customCalendarsApi.mintKey(resource, { keyVersion: 1, household: minted.household, members });
    await reSealEvents(resource, events);
    return;
  }

  if (p.rotationPending) {
    // Revoke/un-share: fresh key at the next version, re-wrapped to the REMAINING
    // collaborators only (the removed party gets nothing), then re-seal events so
    // their old key opens nothing.
    const next = p.currentKeyVersion + 1;
    const minted = await mintCalendarKey(resource, next);
    if (!minted) return;
    const members = await wrapFor(resource, next, p.collaborators);
    await customCalendarsApi.mintKey(resource, { keyVersion: next, household: minted.household, members });
    await reSealEvents(resource, events);
    return;
  }

  // Steady state: a newly-accepted collaborator needs the current key wrapped
  // to them (the async approve-on-device step). No rotation, no re-seal.
  if (p.missingMembers.length) {
    const version = p.currentKeyVersion || currentCalendarKeyVersion(resource);
    const members = await wrapFor(resource, version, p.missingMembers);
    if (members.length) await customCalendarsApi.wrapMembers(resource, { keyVersion: version, members });
  }
}

// Load the shared-lane CalendarKeys this device is entitled to but doesn't
// hold, both directions of D1:
//   - calendars shared TO this user (`mine:false`) — the member wrap, unwrapped
//     with the identity keyPair;
//   - the user's OWN calendars that ever minted a CalendarKey
//     (`calKeyVersion > 0`) — the household wrap, unwrapped with the HDK.
// Then re-pull the record feed so rows an earlier keyless sync skipped decrypt
// into the replica. Neither side is covered elsewhere: the owner reconcile
// pass above only touches calendars with PENDING work (keys/pending is empty
// in steady state), and openOpaqueRecord doesn't lazy-load resource keys — so
// after a sign-out wipes the replica and the in-memory keys, the owner's own
// cal-scoped events (and a collaborator's shared events) would never decrypt
// back in. The owner arm keys off `calKeyVersion`, not the outside-share list,
// so a fully-un-shared calendar whose rows are still sealed under an old
// CalendarKey keeps decrypting too. Best-effort and idempotent; a locked
// session is a harmless no-op (loadCalendarKeys unwraps nothing). Runs from
// the keys-ready hook on every unlock (auth store), the viewer shell, and on
// accepting a calendar invitation.
export async function ensureSharedCalendarKeys(): Promise<void> {
  let shared: { key: string }[];
  try {
    const { data } = await customCalendarsApi.list();
    shared = data.filter(
      (c) => !c.feedUrl && !c.holiday && (!c.mine || (c.calKeyVersion ?? 0) > 0),
    );
  } catch { return; }
  if (!shared.length) return;

  const missing = shared.filter((c) => {
    const version = currentCalendarKeyVersion(c.key);
    return !version || !getResourceKey(c.key, version);
  });
  if (!missing.length) return;

  const loaded = await Promise.all(
    missing.map((c) => loadCalendarKeys(c.key).catch(() => 0)),
  );
  if (!loaded.some((v) => v > 0)) return;

  // The sync cursor sits at the first undecryptable row (lib/records), so an
  // incremental pull re-reads the skipped shared events now the keys are held.
  await syncRecords().catch(() => {});
}

// Run the full reconciliation. Needs an unlocked session (HDK held); a no-op
// otherwise. Best-effort and idempotent — safe to call on every unlock.
export async function reconcileCalendarKeys(): Promise<void> {
  if (!getHDK()) return;
  let pending: CalendarKeyPending[];
  try { ({ data: pending } = await customCalendarsApi.pendingKeys()); } catch { return; }
  if (!pending.length) return;

  // Hold each pending calendar's existing key BEFORE the sync so the unified
  // feed's resource lane decrypts that calendar's already-sealed events into the
  // replica: a rotation must re-seal events currently under the OLD CalendarKey
  // version, and openOpaqueRecord only decrypts a cal-scoped row when its key is
  // already held (needsMint calendars have no key yet — their events are still
  // HDK-sealed and always decrypt). Then force a FULL pull (resetRecordCursor)
  // so events skipped by an earlier keyless incremental sync are re-decrypted now
  // that the keys are loaded. C3b moved these events into the opaque /records
  // store, so this replaces the retired /calendar/raw feed.
  await Promise.all(pending.map((p) => loadCalendarKeys(p.calendarKey).catch(() => {})));
  await resetRecordCursor().catch(() => {});
  await syncRecords().catch(() => {});

  // One replica read, grouped by calendar, feeds every calendar's re-seal. The
  // rows are already-decrypted content (reSealEvents reads their plaintext).
  const byCalendar = new Map<string, CalendarEvent[]>();
  try {
    const events = await replica.getAll<CalendarEvent>('CalendarEvent');
    for (const ev of events) {
      const k = ev.calendarType;
      if (!k) continue;
      const arr = byCalendar.get(k) || [];
      arr.push(ev);
      byCalendar.set(k, arr);
    }
  } catch { /* re-seal is skipped if the read fails; wraps still proceed */ }

  for (const p of pending) {
    await reconcileOne(p, byCalendar.get(p.calendarKey) || []).catch(() => {});
  }
}
