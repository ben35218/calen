// Household event invites: a creator stamps `householdInvitees` (userIds) into
// the sealed event; each invited member answers with their OWN sealed EventRsvp
// record `{ eventId, status, respondedAt }` (+ the C4 `author` fold-in naming
// the responder). One record per responder means a single writer each — two
// members answering at once never contend on the event record, and a response
// never risks reverting a concurrent event edit (the whole-record LWW hazard).
//
// Notification is a separate, transient concern: the server relays client-chosen
// push strings to housemates (notificationsApi.eventRequest/eventResponse) and
// stores nothing. The durable surface is the Invitations inbox, derived from
// the replica by deriveHouseholdRequests below.

import * as recordStore from './recordStore';
import * as replica from './replica';
import { currentUserId, getHDK, sealNew, sealUpdate } from './e2ee';
import { EVENT_RSVP_ENC } from './encSubsets';
import { notificationsApi } from '../api';

export type RsvpStatus = 'accepted' | 'declined';

export interface EventRsvp {
  _id: string;
  eventId: string;
  status: RsvpStatus;
  respondedAt: string;
  // Responder userId (C4 fold-in).
  author?: string;
}

// A decrypted event row, as the replica holds it (only the fields we read).
export interface RsvpEvent {
  _id: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  allDay?: boolean;
  calendarType?: string;
  cancelled?: boolean;
  householdInvitees?: string[];
  author?: string;
  // Set on a copy accepted from a cross-household invitation — read by the merge
  // pass (lib/invitationMerge) to tell a copy that still needs unlinking from one
  // it has already promoted to an ordinary event.
  invitationId?: string;
}

export interface HouseholdEventRequest {
  eventId: string;
  title: string;
  startDate?: string;
  endDate?: string;
  allDay?: boolean;
  calendarType?: string;
  creatorId?: string;
  myStatus: 'pending' | RsvpStatus;
  respondedAt?: string;
}

export type RsvpMap = Record<string, { status: RsvpStatus; respondedAt?: string }>;

// Pure derivation (unit-tested): the requests aimed at ME. An event qualifies
// when I'm in its householdInvitees and I'm not its author; cancelled events
// drop out entirely, and past events only surface once replied (a stale
// "accept?" for yesterday is noise, but a reply I gave stays visible under
// Replied). `now` is injectable for tests.
export function deriveHouseholdRequests(
  events: RsvpEvent[],
  rsvps: EventRsvp[],
  myUserId: string,
  now: Date = new Date(),
): HouseholdEventRequest[] {
  const mine = new Map<string, EventRsvp>();
  for (const r of rsvps) {
    if (r.author === myUserId && r.eventId) mine.set(r.eventId, r);
  }
  const out: HouseholdEventRequest[] = [];
  for (const e of events) {
    if (!e?.householdInvitees?.includes(myUserId)) continue;
    if (e.author === myUserId) continue;
    if (e.cancelled) continue;
    const my = mine.get(e._id);
    const end = e.endDate || e.startDate;
    const past = end ? new Date(end).getTime() < now.getTime() - (e.allDay ? 24 * 3600_000 : 0) : false;
    if (past && !my) continue;
    out.push({
      eventId: e._id,
      title: e.title || 'Untitled event',
      startDate: e.startDate,
      endDate: e.endDate,
      allDay: e.allDay,
      calendarType: e.calendarType,
      creatorId: e.author,
      myStatus: my?.status ?? 'pending',
      respondedAt: my?.respondedAt,
    });
  }
  // Soonest event first; pending sorts naturally via the caller's tab split.
  out.sort((a, b) => String(a.startDate ?? '').localeCompare(String(b.startDate ?? '')));
  return out;
}

// Inbox feed: pull the latest records, then derive my requests from the replica.
export async function listMyHouseholdEventRequests(): Promise<HouseholdEventRequest[]> {
  const me = currentUserId();
  if (!me) return [];
  await recordStore.refresh();
  const events = await replica.getAll<RsvpEvent>('CalendarEvent');
  const rsvps = await replica.getAll<EventRsvp>('EventRsvp');
  return deriveHouseholdRequests(events, rsvps, me);
}

// Per-member status map for one event (creator's detail chips / invitees rows).
// Latest response wins if a member somehow holds two records.
export async function rsvpsForEvent(eventId: string): Promise<RsvpMap> {
  const rsvps = await replica.getAll<EventRsvp>('EventRsvp');
  const map: RsvpMap = {};
  for (const r of rsvps) {
    if (r.eventId !== eventId || !r.author) continue;
    const prev = map[r.author];
    if (!prev || String(r.respondedAt ?? '') > String(prev.respondedAt ?? '')) {
      map[r.author] = { status: r.status, respondedAt: r.respondedAt };
    }
  }
  return map;
}

// Accept/decline: seal my own EventRsvp (update-in-place when I already
// answered), then fire-and-forget the reply push to the event's creator. The
// notify never blocks the response — the creator's inbox/chips read the synced
// record either way.
export async function respondToHouseholdEvent(opts: {
  eventId: string;
  status: RsvpStatus;
  eventTitle: string;
  creatorId?: string;
  myName: string;
}): Promise<void> {
  const { eventId, status, eventTitle, creatorId, myName } = opts;
  if (!getHDK()) throw new Error('Unlock your household data to respond.');
  const me = currentUserId();
  const payload = { eventId, status, respondedAt: new Date().toISOString() };
  const existing = (await replica.getAll<EventRsvp>('EventRsvp'))
    .find((r) => r.eventId === eventId && r.author === me);
  if (existing) {
    const sealed = await sealUpdate('EventRsvp', existing._id, payload, EVENT_RSVP_ENC(payload));
    await recordStore.update('EventRsvp', existing._id, sealed);
  } else {
    const sealed = await sealNew('EventRsvp', payload, EVENT_RSVP_ENC(payload));
    if (!sealed.enc) throw new Error('Unlock your household data to respond.');
    await recordStore.create('EventRsvp', sealed);
  }
  if (creatorId && creatorId !== me) {
    notificationsApi
      .eventResponse({
        toUserId: creatorId,
        title: `Invitation ${status}`,
        body: `${myName} ${status} “${eventTitle}”`,
        eventId,
      })
      .catch(() => {});
  }
}

// Carry an answer someone already gave into an EventRsvp, WITHOUT notifying —
// used by the merge pass (lib/invitationMerge) when a cross-household invitation
// the caller already accepted or declined becomes an in-household one. The reply
// isn't news (it was pushed when it was first given), and re-pushing it on a
// household join would be noise, so this deliberately skips the relay that
// respondToHouseholdEvent fires.
//
// Absent-only: if I've since answered this event through the household lane, that
// answer is newer and stands. Idempotent, so a retried merge pass is a no-op.
export async function recordExistingAnswer(opts: {
  eventId: string;
  status: RsvpStatus;
  respondedAt?: string;
}): Promise<void> {
  const { eventId, status, respondedAt } = opts;
  if (!getHDK()) throw new Error('Unlock your household data to record this response.');
  const me = currentUserId();
  const already = (await replica.getAll<EventRsvp>('EventRsvp'))
    .some((r) => r.eventId === eventId && r.author === me);
  if (already) return;
  const payload = { eventId, status, respondedAt: respondedAt || new Date().toISOString() };
  const sealed = await sealNew('EventRsvp', payload, EVENT_RSVP_ENC(payload));
  if (!sealed.enc) throw new Error('Unlock your household data to record this response.');
  await recordStore.create('EventRsvp', sealed);
}

// Instant notify to selected housemates (event create/edit). Best-effort by
// design — the inbox row is the durable channel.
export async function notifyHouseholdInvitees(
  eventId: string,
  toUserIds: string[],
  title: string,
  body?: string,
): Promise<void> {
  if (!toUserIds.length) return;
  await notificationsApi.eventRequest({ toUserIds, title, body, eventId });
}
