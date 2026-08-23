import { tripsApi, Trip, TripItem } from '../api';
import {
  currentResourceKeyVersion, getHDK, loadResourceKeys, openRecord,
  sealForResource, sealNew, sealUpdate,
} from './e2ee';

// One decrypting fetcher for `GET /trips/:id`, shared by every screen that
// reads a trip's detail (`['trips', id]`).
//
// A trip's content — the trip's own name/destination/notes, and each booking's
// title/location/url/phone/notes/details — lives inside `enc`; the server's
// plaintext columns for those were nulled at the drop (`DROP_FIELDS`). A screen
// that renders the fetched row as-is therefore shows the routing columns only
// (dates, type, cost), which is what a booking with no title and no location
// looks like on the itinerary timeline.
//
// It's one function rather than three because the screens share the query key:
// with per-screen `queryFn`s, whichever observer mounted last decided whether
// the cached trip was decrypted, so returning from the booking form could blank
// out the detail screen behind it.
//
// Signal-parity D2: a shared trip's records are sealed under its TripKey, so
// that key is loaded before opening. `openRecord` hands back the plaintext row
// unchanged when a key isn't held, so a viewer without the TripKey degrades to
// today's contentless view instead of failing.
export type TripDetail = { trip: Trip; items: TripItem[]; isOwner?: boolean };

export async function fetchTripDetail(id: string): Promise<TripDetail> {
  const { data } = await tripsApi.get(id);
  const raw = data as unknown as TripDetail;
  if (getHDK()) await loadResourceKeys('trip', id).catch(() => {});
  const [trip, items] = await Promise.all([
    openRecord('Trip', raw.trip as any) as Promise<Trip>,
    Promise.all((raw.items ?? []).map((it) => openRecord('TripItem', it as any))) as Promise<TripItem[]>,
  ]);
  return { ...raw, trip, items };
}

// Encrypted trip-item content (cost/sharing/confirmation/dates stay plaintext).
// The alert pair rides in here beside the title: the server never schedules a
// booking alert (delivery is the on-device reminder pass), so it never needs to
// read one. Shared by the booking form and the booking view's live alert
// pickers — a second private copy of this list is how a reseal on one surface
// would silently drop a field the other one sealed.
export const TRIP_ITEM_ENC = (p: Record<string, unknown>) => ({
  title: p.title, location: p.location, placeId: p.placeId, url: p.url, phone: p.phone, notes: p.notes, details: p.details,
  reminderMinutes: p.reminderMinutes ?? null, alert2Minutes: p.alert2Minutes ?? null,
  // The All day flag rides beside the title: the server's start/end columns
  // stay ordinary instants (midnight, destination tz), so nothing plaintext
  // says whether the user entered times. Absent (legacy rows) = timed.
  allDay: p.allDay || undefined,
});

// Seal a trip-item payload for the wire. Signal-parity D2: a shared trip's
// items seal under the TripKey (when this device holds it), else the HDK
// dual-write (the owner's reconcile migrates them later). One function for the
// form's save and the booking view's alert patch, so the lane choice can't
// drift between them. `id` is the item's id (pre-generated for a create).
export async function sealTripItemPayload(
  tripId: string,
  tripShared: boolean,
  id: string,
  payload: Record<string, unknown>,
  isNew: boolean,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null;
  if (tripShared && getHDK()) {
    await loadResourceKeys('trip', tripId).catch(() => {});
    if (currentResourceKeyVersion(tripId) > 0) {
      const sealed = await sealForResource('trip', 'TripItem', id, tripId, TRIP_ITEM_ENC(payload));
      if (sealed) body = isNew ? { _id: id, ...payload, ...sealed } : { ...payload, ...sealed };
    }
  }
  if (!body) {
    body = isNew
      ? await sealNew('TripItem', payload, TRIP_ITEM_ENC(payload))
      : await sealUpdate('TripItem', id, payload, TRIP_ITEM_ENC(payload));
  }
  // `placeId` seals beside the location, but unlike the other content fields the
  // item route has no plaintext strip for it (TripItem's drop list predates the
  // field) and the server never reads it — so a sealed write must not send the
  // plaintext copy. The degraded plaintext lane (no key held) keeps it, exactly
  // as it keeps the location string.
  if (body.enc) delete body.placeId;
  return body;
}

// The sharing-branch fields a partial edit must send BACK unchanged. The item
// update route (`applyItemBody`) is not patch-safe: it rebuilds the whole
// cost-sharing branch from the body on every PUT — omitted `participants` drops
// the other families, omitted `shares`/`cost` wipes a shared bill — so a write
// that only means to touch the sealed content (the booking view's live alert
// pickers) has to echo the current sharing state, exactly as an untouched edit
// form's save does. Built from the decrypted item as the server shaped it for
// this household (`myData`, `participants`).
export function tripItemSharingEcho(item: TripItem): Record<string, unknown> {
  const sharing = item.sharing || 'private';
  if (sharing === 'shared_separate') {
    return {
      sharing, participants: item.participants ?? [],
      myData: {
        cost: item.myData?.cost ?? null, currency: item.myData?.currency || undefined,
        confirmation: item.myData?.confirmation || undefined, partySize: item.myData?.partySize ?? undefined,
        confirmed: !!item.myData?.confirmed,
      },
    };
  }
  if (sharing === 'shared_one_separate') {
    return {
      sharing, participants: item.participants ?? [],
      confirmation: item.confirmation || undefined, confirmed: !!item.confirmed,
      myData: { cost: item.myData?.cost ?? null, currency: item.myData?.currency || undefined },
    };
  }
  if (sharing === 'shared_shared') {
    return {
      sharing, cost: item.cost ?? undefined, currency: item.currency || undefined,
      confirmation: item.confirmation || undefined, confirmed: !!item.confirmed,
      shares: (item.shares ?? []).map((s) => ({ householdId: String(s.householdId), amount: s.amount ?? undefined })),
      paidByHouseholdId: item.paidByHouseholdId ? String(item.paidByHouseholdId) : undefined,
    };
  }
  return {
    sharing: 'private', cost: item.cost ?? undefined, currency: item.currency || undefined,
    confirmation: item.confirmation || undefined, confirmed: !!item.confirmed,
  };
}
