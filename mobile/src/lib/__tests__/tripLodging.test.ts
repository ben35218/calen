import { lodgingCoveringDate, overnightLodging, lodgingCheckins, lodgingCheckouts } from '../tripLodging';
import type { TripItem } from '../../api';

const TZ = 'America/Toronto';

const hotel = (over: Partial<TripItem> = {}): TripItem =>
  ({
    _id: 'h1',
    type: 'hotel',
    title: 'Fairmont Royal York',
    location: '100 Front St W, Toronto',
    // Check in Aug 21 3 PM, check out Aug 24 11 AM (Toronto local).
    start: '2026-08-21T19:00:00.000Z',
    end: '2026-08-24T15:00:00.000Z',
    ...over,
  }) as TripItem;

describe('lodgingCoveringDate', () => {
  it('covers check-in through check-out date inclusive', () => {
    const items = [hotel()];
    expect(lodgingCoveringDate(items, '2026-08-20', TZ)).toHaveLength(0);
    expect(lodgingCoveringDate(items, '2026-08-21', TZ)).toHaveLength(1);
    expect(lodgingCoveringDate(items, '2026-08-23', TZ)).toHaveLength(1);
    expect(lodgingCoveringDate(items, '2026-08-24', TZ)).toHaveLength(1);
    expect(lodgingCoveringDate(items, '2026-08-25', TZ)).toHaveLength(0);
  });

  it('ignores non-hotel items', () => {
    const items = [hotel({ type: 'activity' } as Partial<TripItem>)];
    expect(lodgingCoveringDate(items, '2026-08-22', TZ)).toHaveLength(0);
  });
});

describe('overnightLodging', () => {
  it('returns the hotel on mornings after a night there', () => {
    expect(overnightLodging([hotel()], '2026-08-22', TZ)?._id).toBe('h1');
  });

  it('returns nothing on the check-in day — the night has not happened yet', () => {
    expect(overnightLodging([hotel()], '2026-08-21', TZ)).toBeNull();
  });

  it('still counts on the check-out day', () => {
    expect(overnightLodging([hotel()], '2026-08-24', TZ)?._id).toBe('h1');
  });

  it('never matches a hotel with no end date', () => {
    expect(overnightLodging([hotel({ end: undefined })], '2026-08-22', TZ)).toBeNull();
  });

  it('skips a hotel without an address in favor of a later one that has one', () => {
    const noAddr = hotel({ _id: 'h0', location: '' });
    expect(overnightLodging([noAddr, hotel()], '2026-08-22', TZ)?._id).toBe('h1');
    expect(overnightLodging([noAddr], '2026-08-22', TZ)).toBeNull();
  });

  it('compares dates in the trip timezone, not UTC', () => {
    // Check-in at 11 PM Aug 21 Toronto time is already Aug 22 in UTC. Locally
    // the night of the 21st was spent there, so the morning of the 22nd counts;
    // a UTC compare would call the 22nd the check-in day and skip it.
    const late = hotel({ start: '2026-08-22T03:00:00.000Z' });
    expect(overnightLodging([late], '2026-08-22', TZ)?._id).toBe('h1');
  });
});

describe('lodgingCheckins', () => {
  it('skips an all-day hotel — no check-in clock to place on the grid', () => {
    const items = [hotel({ allDay: true })];
    expect(lodgingCheckins(items, '2026-08-21', TZ)).toHaveLength(0);
    expect(lodgingCheckouts(items, '2026-08-24', TZ)).toHaveLength(0);
    // The banner and morning-leg predicates compare dates alone, so they keep it.
    expect(lodgingCoveringDate(items, '2026-08-22', TZ)).toHaveLength(1);
    expect(overnightLodging(items, '2026-08-22', TZ)?._id).toBe('h1');
  });

  it('returns the hotel only on its check-in day', () => {
    expect(lodgingCheckins([hotel()], '2026-08-21', TZ)).toHaveLength(1);
    expect(lodgingCheckins([hotel()], '2026-08-22', TZ)).toHaveLength(0);
  });

  it('keeps a hotel without an address — the block still belongs on the grid', () => {
    expect(lodgingCheckins([hotel({ location: '' })], '2026-08-21', TZ)).toHaveLength(1);
  });
});

describe('lodgingCheckouts', () => {
  it('returns the hotel only on its check-out day', () => {
    expect(lodgingCheckouts([hotel()], '2026-08-24', TZ)).toHaveLength(1);
    expect(lodgingCheckouts([hotel()], '2026-08-23', TZ)).toHaveLength(0);
  });

  it('needs an end — no end date means no check-out clock to place', () => {
    expect(lodgingCheckouts([hotel({ end: undefined })], '2026-08-21', TZ)).toHaveLength(0);
  });

  it('keeps a hotel without an address — the block still belongs on the grid', () => {
    expect(lodgingCheckouts([hotel({ location: '' })], '2026-08-24', TZ)).toHaveLength(1);
  });
});
