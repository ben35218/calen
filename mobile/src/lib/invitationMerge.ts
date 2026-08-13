// Invitation merge — reconcile cross-household event invitations once the two
// people end up in the SAME household.
//
// An EventInvitation is a contract between two households: the organizer keeps
// their event, the recipient owns an INDEPENDENT copy (sealed under their own
// HDK, with `invitationId` folded inside so it reads as read-only + "Leave
// event"), and neither side ever syncs the other's record. Joining households
// dissolves that premise — both now hold one HDK and sync one set of rows — and
// nothing used to notice:
//
//   - join carry-over (lib/joinCarryover) moves the recipient's copy into the
//     shared household, so the SAME event lands on the calendar twice, one of
//     them permanently read-only;
//   - the recipient is absent from the organizer's sealed `householdInvitees`,
//     so they appear on no invitee chip and the accept/decline they already gave
//     is stranded on a server row the calendar never reads;
//   - "Leave event" and the organizer's "uninvite" would tombstone a record the
//     household now jointly owns (the server refuses both once the parties share
//     a household — see routes/invitations.js — but that only stops the damage,
//     it doesn't converge anything).
//
// This pass converges it, deterministically. No content matching is involved:
// the invitation row already carries the exact correlation key — `eventId` (the
// organizer's original) and `acceptedEventId` (our copy) — so "which two rows are
// the same event" is a lookup, not a title/time heuristic. The result is the
// in-household representation the calendar already understands: the recipient
// joins the event's sealed `householdInvitees`, their standing answer becomes a
// first-class `EventRsvp`, the duplicate copy is tombstoned, and the invitation
// retires to the terminal `merged` status.
//
// The RECIPIENT's device drives it, for two reasons: it is the same actor that
// drives carry-over (the server holds no HDK and can re-seal nothing), and an
// EventRsvp's responder identity is the C4 `author` folded inside the ciphertext,
// so only that person's device can author their own answer.
//
// Runs from maintainKeyHygiene on every unlock, AFTER carry-over, and is
// idempotent + resumable at every step: the invitee union is a set-add, the RSVP
// is absent-only, the detach is a no-op once cleared, and `POST /:id/merge`
// reports success on an already-merged row. The sealed work happens BEFORE the
// row is retired, so a pass that dies halfway is simply redone next unlock.
//
// See specs/features/calendar.md § Invitees & sharing.

import { invitationsApi, calendarApi, InvitationToMerge } from '../api';
import * as recordStore from './recordStore';
import * as replica from './replica';
import { currentUserId, getHDK } from './e2ee';
import { recordExistingAnswer, RsvpEvent, RsvpStatus } from './householdRsvp';

// What one invitation's reconciliation consists of. Split out as a pure function
// so the decision table (which is the whole substance of this module) is unit
// tested without a vault, a replica, or a server.
export interface MergePlan {
  // Union me into the source event's householdInvitees (skipped when I left the
  // event deliberately, or when I'm somehow already on it).
  addInvitee: boolean;
  // The resulting invitee list, when addInvitee.
  invitees: string[];
  // Carry the answer I already gave across as an EventRsvp on the source event.
  recordAnswer: RsvpStatus | null;
  // Clear `invitationId` on my copy, promoting it to an ordinary household event.
  // Only when the organizer's original is gone, so my copy is the only survivor.
  detachCopy: boolean;
  // Nothing can be done safely yet — the record this plan needs hasn't reached
  // the replica. Leave the invitation alone and retry on a later unlock.
  defer: boolean;
}

const DEFER: MergePlan = { addInvitee: false, invitees: [], recordAnswer: null, detachCopy: false, defer: true };

// Pure decision table. `source` is the organizer's event and `copy` is mine, each
// as the replica holds them (undefined = not present locally).
//
// Deferring on a missing record is not a nicety: `resealInLane` rebuilds the
// whole sealed subset from the replica's copy, so re-sealing a record we can't
// read would write an EMPTY event over a real one. A record that never becomes
// readable (e.g. the organizer's event lives on an outside-shared calendar lane
// we hold no key for) simply defers forever, which is inert — the server-side
// guards already stop the destructive lanes.
export function planInvitationMerge(
  inv: InvitationToMerge,
  source: RsvpEvent | undefined,
  copy: RsvpEvent | undefined,
  myUserId: string,
): MergePlan {
  // The organizer's event is gone (they deleted it after we accepted). There is
  // no duplicate to resolve and nothing to be invited to — but our copy is now a
  // standalone event that must stop pretending to be someone else's invitation.
  if (!inv.sourceExists || !inv.eventId) {
    if (!inv.acceptedEventId) return { ...DEFER, defer: false };
    if (!copy) return DEFER;
    return { addInvitee: false, invitees: [], recordAnswer: null, detachCopy: !!copy.invitationId, defer: false };
  }

  if (!source) return DEFER;

  const current = source.householdInvitees ?? [];
  // 'left' means they accepted and then deliberately left — re-adding them as a
  // household invitee would undo that choice, so the merge only retires the row.
  const wanted = inv.status !== 'left' && source.author !== myUserId && !current.includes(myUserId);

  return {
    addInvitee: wanted,
    invitees: wanted ? [...current, myUserId] : current,
    // A pending invitation carries no answer to preserve; it becomes an ordinary
    // in-household request, and the inbox derives the Accept/Decline card from
    // the event itself (lib/householdRsvp.deriveHouseholdRequests).
    recordAnswer: inv.status === 'accepted' || inv.status === 'declined' ? inv.status : null,
    detachCopy: false,
    defer: false,
  };
}

export interface MergeResult {
  total: number;
  merged: number;
  deferred: number;
  failed: number;
}

const NOTHING: MergeResult = { total: 0, merged: 0, deferred: 0, failed: 0 };

// Reconcile every invitation whose organizer has since become a housemate.
// Best-effort and silent: a locked vault, an offline device, or a single failing
// row all just leave work for the next unlock.
export async function reconcileMergedInvitations(): Promise<MergeResult> {
  if (!getHDK()) return NOTHING;
  const me = currentUserId();
  if (!me) return NOTHING;

  const rows = (await invitationsApi.toMerge()).data?.invitations ?? [];
  if (!rows.length) return NOTHING;

  // Pull before planning: right after a join, the organizer's event — the record
  // every plan converges onto — may never have reached this device, and carry-over
  // (which runs just before this pass) has just moved our own rows across.
  await recordStore.refresh();
  const events = await replica.getAll<RsvpEvent>('CalendarEvent');
  const byId = new Map(events.map((e) => [e._id, e]));

  let merged = 0;
  let deferred = 0;
  let failed = 0;
  for (const inv of rows) {
    const plan = planInvitationMerge(
      inv,
      inv.eventId ? byId.get(inv.eventId) : undefined,
      inv.acceptedEventId ? byId.get(inv.acceptedEventId) : undefined,
      me,
    );
    if (plan.defer) { deferred += 1; continue; }
    try {
      // Sealed work first, retirement last — every step is idempotent, so a pass
      // interrupted anywhere in here is simply repeated, whereas retiring first
      // would strand the row with its sealed half undone.
      if (plan.addInvitee) await calendarApi.setHouseholdInvitees(inv.eventId!, plan.invitees);
      if (plan.recordAnswer) {
        await recordExistingAnswer({
          eventId: inv.eventId!,
          status: plan.recordAnswer,
          respondedAt: inv.respondedAt,
        });
      }
      if (plan.detachCopy) await calendarApi.detachInvitationCopy(inv.acceptedEventId!);
      // The server drops the now-duplicate copy and marks the row terminal.
      await invitationsApi.merge(inv._id);
      merged += 1;
    } catch {
      failed += 1;
    }
  }
  return { total: rows.length, merged, deferred, failed };
}
