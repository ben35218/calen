// Which hotel booking anchors a given day of a trip. Both predicates compare
// local calendar dates (YYYY-MM-DD in the trip's destination tz), the same way
// the day list itself is built.
import { TripItem } from '../api';
import { zonedParts } from './tz';

const span = (it: TripItem, tz: string) => ({
  checkIn: zonedParts(it.start, tz).dateStr,
  checkOut: zonedParts(it.end || it.start, tz).dateStr,
});

// Hotels whose check-in..check-out date span covers the day — the lodging
// banner and the grid's bed marker ("where are we staying around this day").
export function lodgingCoveringDate(items: TripItem[], dateStr: string, tz: string): TripItem[] {
  return items.filter((it) => {
    if (it.type !== 'hotel') return false;
    const { checkIn, checkOut } = span(it, tz);
    return dateStr >= checkIn && dateStr <= checkOut;
  });
}

// The hotel the user woke up at on the day: check-in strictly before it,
// check-out on or after it — so the check-in day itself doesn't count (the
// night there hasn't happened yet), through the check-out day inclusive.
// First such hotel with an address wins; null when no lodging covered the
// previous night (or none has one).
export function overnightLodging(items: TripItem[], dateStr: string, tz: string): TripItem | null {
  return (
    items.find((it) => {
      if (it.type !== 'hotel' || !it.location) return false;
      const { checkIn, checkOut } = span(it, tz);
      return checkIn < dateStr && dateStr <= checkOut;
    }) ?? null
  );
}

// Hotels whose check-in lands on the day — each earns a block on the day grid
// at its check-in time. An all-day hotel has no check-in clock to place, so it
// stays off the grid (the lodging banner still names it).
export function lodgingCheckins(items: TripItem[], dateStr: string, tz: string): TripItem[] {
  return items.filter(
    (it) => it.type === 'hotel' && !it.allDay && zonedParts(it.start, tz).dateStr === dateStr,
  );
}

// Hotels whose check-out lands on the day — each earns a block on the day grid
// at its check-out time. Needs an end, or there is no check-out clock to place;
// all-day hotels have no clock either way.
export function lodgingCheckouts(items: TripItem[], dateStr: string, tz: string): TripItem[] {
  return items.filter(
    (it) => it.type === 'hotel' && !it.allDay && !!it.end && zonedParts(it.end, tz).dateStr === dateStr,
  );
}
