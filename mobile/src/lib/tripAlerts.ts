// Booking alerts — the trip itinerary's version of an event's Alert / Second
// alert pair (calendar.md → Alerts; the option builder note in
// lib/eventAlertOptions applies here too: the booking FORM and the booking VIEW
// must offer the same rows, so the list is built once, here).
//
// Every booking type carries the pair. What varies by type is only the anchor
// the offsets count back from — and the data model already collapses that: a
// journey's departure, a hotel's check-in and a standard booking's start are
// all the stored `start` (a real UTC instant, entered as wall-clock in the
// relevant zone). So a timed booking's alert is always `start − minutes`. An
// ALL-DAY booking (the sealed `allDay` flag) has no clock for minutes to count
// back from — it gets the calendar's whole-day grid instead, anchored at the
// user's day-alert hour on the booking's own destination-local date, exactly as
// an all-day event's alerts are (lib/calendar's alert note).
// Anchors ('leave') don't apply either way — travel legs between bookings are
// derived from PAIRS of bookings and re-derive as the itinerary changes, so
// there is no stable departure instant to promise an alert against.
//
// The fields are SEALED content (inside `enc`, beside the title), like an
// event's — the server never reads them; scheduling happens on-device over the
// decrypted items (lib/notifications).

import { fetchTripDetail } from './tripData';
import { getOwnedAddonIds } from './addons';
import * as replica from './replica';
import { formatDuration } from './format';
import { zonedParts } from './tz';
import { ALL_DAY_ALERT_OFFSETS, allDayAlertLabel } from './calendar';
import { AlertItem, CUSTOM_ALERT, NONE_ALERT, alertKey } from './eventAlertOptions';

// What a zero-minute alert is AT, by booking type — the one place the anchor's
// name (not its instant) differs per type.
export function bookingAlertZeroLabel(type?: string): string {
  if (type === 'flight' || type === 'transit') return 'At departure';
  if (type === 'hotel') return 'At check-in';
  return 'At start time';
}

// Minute offsets a booking's pickers offer. Journeys add the airport lead times
// (2–3 hours before departure) the event list never needed; everything else
// keeps the event grid.
const BASE_OFFSETS = [0, 15, 30, 60];
const JOURNEY_OFFSETS = [120, 180];
const DAY_OFFSET = 1440;

function bookingAlertLabel(minutes: number, type?: string): string {
  return minutes <= 0 ? bookingAlertZeroLabel(type) : `${formatDuration(minutes)} before`;
}

// The flat option list the AI form assistant's schema offers for the booking
// form's Alert field — the same grid the pickers show (journey leads included;
// the schema is static while the type is the model's to choose, and an
// off-grid or off-type value just gets a synthesized picker row), plus the
// schema's own `-1` None row, mirroring the event form's ALERT_OPTIONS shape.
export const BOOKING_ALERT_ASSIST_OPTIONS = [
  { label: 'None', value: -1 },
  ...[...BASE_OFFSETS, ...JOURNEY_OFFSETS, DAY_OFFSET].map((v) => ({
    label: bookingAlertLabel(v),
    value: v,
  })),
];

// Every row a booking's two alert pickers offer. Saved values without a canned
// row (the Custom… sheet's output) get one synthesized, so the field reads the
// setting back instead of its placeholder — same rule as `buildAlertItems`.
//
// An ALL-DAY booking gets the calendar's whole-day grid (labelled with the hour
// it fires at), never the minute list — a minute offset would be counting back
// from a start time the booking doesn't have.
export function buildBookingAlertItems({
  type,
  allDay,
  dayAlertTime,
  reminderMinutes,
  alert2Minutes,
}: {
  type?: string;
  allDay?: boolean;
  dayAlertTime?: string | null;
  reminderMinutes: number | null;
  alert2Minutes: number | null;
}): AlertItem[] {
  const none: AlertItem = { value: NONE_ALERT, label: 'None', minutes: null, anchor: 'event' };
  const custom: AlertItem = { value: CUSTOM_ALERT, label: 'Custom…', minutes: null, anchor: 'event' };
  if (allDay) {
    const items: AlertItem[] = [
      none,
      ...ALL_DAY_ALERT_OFFSETS.map((v) => ({
        value: alertKey(v, 'event'),
        label: allDayAlertLabel(v, dayAlertTime),
        minutes: v,
        anchor: 'event' as const,
      })),
    ];
    for (const v of [reminderMinutes, alert2Minutes]) {
      if (v == null || items.some((i) => i.minutes === v)) continue;
      items.push({ value: alertKey(v, 'event'), label: allDayAlertLabel(v, dayAlertTime), minutes: v, anchor: 'event' });
    }
    items.push(custom);
    return items;
  }
  const journey = type === 'flight' || type === 'transit';
  const offsets = [...BASE_OFFSETS, ...(journey ? JOURNEY_OFFSETS : []), DAY_OFFSET];
  const items: AlertItem[] = [
    none,
    ...offsets.map((v) => ({
      value: alertKey(v, 'event'),
      label: bookingAlertLabel(v, type),
      minutes: v,
      anchor: 'event' as const,
    })),
  ];
  for (const v of [reminderMinutes, alert2Minutes]) {
    if (v == null || items.some((i) => i.minutes === v)) continue;
    items.push({ value: alertKey(v, 'event'), label: bookingAlertLabel(v, type), minutes: v, anchor: 'event' });
  }
  items.push(custom);
  return items;
}

// ── The reminder scheduler's view of the itinerary ──────────────────────────
//
// Bookings never reach the calendar data (trips.md records that deliberately),
// so the on-device reminder pass (lib/notifications) can't find these alerts in
// `loadCalendarData` — it loads them here instead. The slim decrypted rows are
// cached in their own replica bucket so an OFFLINE reschedule (which cancels
// everything before rearming) keeps the booking alerts it armed last time
// instead of silently dropping them.

export interface BookingAlert {
  _id: string;
  tripId: string;
  type?: string;
  title?: string;
  start: string;
  // All-day booking: alerts anchor at the day-alert hour on `startDate` — the
  // booking's own DESTINATION-local calendar day, resolved here at load time
  // (the slim row doesn't carry the trip's sealed timezone, and the reader's
  // UTC offset must not decide which day a midnight-tz instant falls on).
  allDay?: boolean;
  startDate?: string;
  reminderMinutes: number | null;
  alert2Minutes: number | null;
}

const CACHE = 'TripItemAlert';

const hasAlert = (it: { reminderMinutes?: number | null; alert2Minutes?: number | null }) =>
  it.reminderMinutes != null || it.alert2Minutes != null;

// Alert-bearing bookings across the household's active trips, decrypted.
// Never throws: a trip whose fetch fails (offline, transient) falls back to its
// cached rows, so this degrades per-trip rather than taking the whole reminder
// pass — events included — down with it. Gated on the trips add-on the same way
// the calendar assembly gates trip spans: a locked feature shouldn't keep
// notifying.
export async function loadBookingAlerts(): Promise<BookingAlert[]> {
  try {
    if (!(await getOwnedAddonIds()).has('trips')) return [];
    // The replica's Trip bucket is reconciled (decrypted) by every calendar
    // load — the reminder pass runs right after one, so this is fresh. A trip
    // whose last day has passed is done notifying (every booking alert anchors
    // inside the trip's range), so it isn't fetched; an undated trip stays in.
    const today = new Date().toISOString().slice(0, 10);
    const trips = await replica.getAll<{ _id: string; startDate?: string; endDate?: string }>('Trip');
    const active = trips.filter((t) => {
      if (!t) return false;
      const end = t.endDate || t.startDate;
      return !end || String(end).slice(0, 10) >= today;
    });
    const cached = await replica.getAll<BookingAlert>(CACHE).catch(() => [] as BookingAlert[]);
    const out: BookingAlert[] = [];
    for (const t of active) {
      try {
        const { trip, items } = await fetchTripDetail(String(t._id));
        for (const it of items ?? []) {
          if (!hasAlert(it)) continue;
          out.push({
            _id: String(it._id),
            tripId: String(t._id),
            type: it.type,
            title: it.title,
            start: String(it.start),
            allDay: it.allDay || undefined,
            startDate: it.allDay ? zonedParts(it.start, trip?.destinationTz || undefined).dateStr : undefined,
            reminderMinutes: it.reminderMinutes ?? null,
            alert2Minutes: it.alert2Minutes ?? null,
          });
        }
      } catch {
        out.push(...cached.filter((c) => c.tripId === String(t._id)));
      }
    }
    // Reconcile the cache to what this pass resolved: rows of deleted bookings,
    // finished trips and cleared alerts go, so they can't come back on the
    // next offline pass.
    const keep = new Set(out.map((r) => r._id));
    await replica.upsert(CACHE, out as any).catch(() => {});
    await Promise.all(
      cached.filter((c) => !keep.has(c._id)).map((c) => replica.remove(CACHE, c._id).catch(() => {})),
    );
    return out;
  } catch {
    return [];
  }
}
