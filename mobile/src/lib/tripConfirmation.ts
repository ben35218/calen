import { TRIP_TYPES } from './tripTypes';
import type { TripConfirmationDraft, TripItemType } from '../api';

// Turning the confirmation parser's draft into a booking-form patch.
//
// `POST /trips/:id/items/from-confirmation` (server/src/routes/trips.js →
// buildDraft) answers with a nested draft: a journey carries
// departure/arrival place blocks (each already resolved to a placeId + IANA
// timezone), a standard booking carries start/end. The form is flat, so the
// shapes have to be reconciled somewhere — here, as pure functions, because
// the interesting rules (all-day inference, the end-date normalization,
// throwing away values the model malformed) are exactly the ones worth
// testing without a screen around them.
//
// The patch is fed to the form's `applyPatch`, which is also what the AI form
// assistant writes through: it keeps only keys the form actually holds, snaps
// alerts onto the whole-day grid when the patch turns all-day on, and marks
// every key it changed so the field lights up. That shared path is why this
// module returns a patch and never touches form state itself.

// The draft comes out of a language model, so nothing in it is trusted to be
// shaped right. A malformed date reaching a DateField is worse than an empty
// one — the field renders it back as the booking's real date and the user
// saves a lie — so anything that isn't strictly YYYY-MM-DD / HH:mm is dropped
// and the form keeps its own default.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function date(v?: string): string | null {
  if (!v || !DATE_RE.test(v)) return null;
  // Guards the shapes the regex can't: 2026-02-31, 2026-13-01.
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? v : null;
}

function time(v?: string): string | null {
  return v && TIME_RE.test(v) ? v : null;
}

function text(v?: string): string | null {
  const s = v?.trim();
  return s ? s : null;
}

const TYPE_VALUES = TRIP_TYPES.map((t) => t.value);

export function draftType(draft: TripConfirmationDraft): TripItemType {
  return (TYPE_VALUES as string[]).includes(draft.type || '') ? (draft.type as TripItemType) : 'other';
}

export function isJourneyType(t: string): boolean {
  return t === 'flight' || t === 'transit';
}

/**
 * Flatten a parser draft onto the booking form's keys.
 *
 * Only fields the confirmation actually yielded are included: a key the parser
 * left null is omitted entirely rather than sent as '', so a blank in the
 * confirmation can never wipe something already on the form (the assistant
 * card can run over a half-typed booking, and so can a second import).
 */
export function confirmationDraftToPatch(draft: TripConfirmationDraft): Record<string, unknown> {
  const type = draftType(draft);
  const patch: Record<string, unknown> = { type };
  const d = draft.details || {};

  const put = (key: string, value: string | number | null) => {
    if (value !== null && value !== '') patch[key] = value;
  };

  put('title', text(draft.title));
  put('confirmation', text(draft.confirmation));
  put('currency', text(draft.currency));
  put('url', text(draft.url));
  put('phone', text(draft.phone));
  put('notes', text(draft.notes));
  if (typeof draft.cost === 'number' && Number.isFinite(draft.cost)) patch.cost = draft.cost;

  if (isJourneyType(type)) {
    // The server resolved each airport/station through the Places lane, so the
    // leg arrives with a description and its IANA timezone already attached —
    // the part of a flight that is most tedious to enter and easiest to get
    // wrong by hand. `placeId` has nowhere to land: a journey leg is stored by
    // name + tz (see the form's save → details.departureName/departureTz).
    put('depName', text(draft.departure?.name));
    put('departureTz', text(draft.departure?.tz));
    put('depDate', date(draft.departure?.date));
    put('depTime', time(draft.departure?.time));
    put('arrName', text(draft.arrival?.name));
    put('arrivalTz', text(draft.arrival?.tz));
    put('arrDate', date(draft.arrival?.date));
    put('arrTime', time(draft.arrival?.time));
    if (type === 'flight') {
      put('airline', text(d.airline));
      put('flightNumber', text(d.flightNumber));
      put('seat', text(d.seat));
    } else {
      put('mode', text(d.mode));
    }
    return patch;
  }

  put('location', text(draft.location));

  const startDate = date(draft.start?.date);
  const startTime = time(draft.start?.time);
  const endDate = date(draft.end?.date);
  const endTime = time(draft.end?.time);

  // A confirmation that names no clock at either end describes a date-only
  // booking, which is what All day means here (a hotel quoting only check-in
  // and check-out dates, a museum pass good for the day). One clock anywhere
  // makes it timed — the form's 9–10 AM defaults stand in for the end the
  // confirmation didn't state.
  if (startDate) {
    patch.startDate = startDate;
    patch.allDay = !startTime && !endTime;
  }
  if (startTime) patch.startTime = startTime;
  if (endTime) patch.endTime = endTime;
  // The form stores '' for an end that lands on the start's own day (its
  // normalization — the Ends date field shows the start date back), so a
  // same-day end has to be written as the empty string, not skipped: skipping
  // it would leave a stale end date from an earlier import in place.
  if (endDate) patch.endDate = endDate === (startDate ?? '') ? '' : endDate;

  return patch;
}
