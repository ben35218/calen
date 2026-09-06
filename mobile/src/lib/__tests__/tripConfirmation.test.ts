import { confirmationDraftToPatch, draftType } from '../tripConfirmation';
import type { TripConfirmationDraft } from '../../api';

const flight: TripConfirmationDraft = {
  type: 'flight',
  title: 'Toronto to Rome',
  departure: { name: 'Toronto Pearson (YYZ)', placeId: 'p1', tz: 'America/Toronto', date: '2026-09-04', time: '21:35' },
  arrival: { name: 'Rome Fiumicino (FCO)', placeId: 'p2', tz: 'Europe/Rome', date: '2026-09-05', time: '12:10' },
  details: { airline: 'Air Canada', flightNumber: 'AC888', seat: '14C' },
  confirmation: 'XR4TQ9',
  cost: 1240.5,
  currency: 'CAD',
};

const hotel: TripConfirmationDraft = {
  type: 'hotel',
  title: 'Hotel Artemide',
  location: 'Via Nazionale 22, Rome',
  start: { date: '2026-09-05', time: '15:00' },
  end: { date: '2026-09-09', time: '11:00' },
  details: { roomType: 'Deluxe King' },
  confirmation: 'HZ-88120',
};

describe('confirmationDraftToPatch — journeys', () => {
  it('flattens both legs, keeping the resolved timezones', () => {
    expect(confirmationDraftToPatch(flight)).toEqual({
      type: 'flight',
      title: 'Toronto to Rome',
      depName: 'Toronto Pearson (YYZ)',
      departureTz: 'America/Toronto',
      depDate: '2026-09-04',
      depTime: '21:35',
      arrName: 'Rome Fiumicino (FCO)',
      arrivalTz: 'Europe/Rome',
      arrDate: '2026-09-05',
      arrTime: '12:10',
      airline: 'Air Canada',
      flightNumber: 'AC888',
      seat: '14C',
      confirmation: 'XR4TQ9',
      cost: 1240.5,
      currency: 'CAD',
    });
  });

  it('never sets all-day on a journey — the flag only exists on the standard card', () => {
    expect(confirmationDraftToPatch(flight)).not.toHaveProperty('allDay');
    expect(confirmationDraftToPatch({ ...flight, departure: { name: 'YYZ', date: '2026-09-04' } })).not.toHaveProperty('allDay');
  });

  it('takes mode on transit and drops the flight-only trio', () => {
    const patch = confirmationDraftToPatch({
      type: 'transit',
      details: { mode: 'train', airline: 'ignored', flightNumber: 'ignored', seat: '9A' },
    });
    expect(patch.mode).toBe('train');
    expect(patch).not.toHaveProperty('airline');
    expect(patch).not.toHaveProperty('seat');
  });
});

describe('confirmationDraftToPatch — standard bookings', () => {
  it('flattens start/end and stays timed when clocks are given', () => {
    expect(confirmationDraftToPatch(hotel)).toEqual({
      type: 'hotel',
      title: 'Hotel Artemide',
      location: 'Via Nazionale 22, Rome',
      allDay: false,
      startDate: '2026-09-05',
      startTime: '15:00',
      endDate: '2026-09-09',
      endTime: '11:00',
      confirmation: 'HZ-88120',
    });
  });

  it('infers all-day when the confirmation quotes no clock at either end', () => {
    const patch = confirmationDraftToPatch({
      type: 'hotel',
      start: { date: '2026-09-05' },
      end: { date: '2026-09-09' },
    });
    expect(patch.allDay).toBe(true);
    expect(patch).not.toHaveProperty('startTime');
  });

  it('a clock at either end alone makes it timed', () => {
    expect(confirmationDraftToPatch({ type: 'activity', start: { date: '2026-09-06' }, end: { date: '2026-09-06', time: '17:00' } }).allDay).toBe(false);
    expect(confirmationDraftToPatch({ type: 'activity', start: { date: '2026-09-06', time: '09:00' } }).allDay).toBe(false);
  });

  it("normalizes a same-day end to '' — the form's own convention", () => {
    const patch = confirmationDraftToPatch({
      type: 'restaurant',
      start: { date: '2026-09-06', time: '20:00' },
      end: { date: '2026-09-06', time: '22:00' },
    });
    expect(patch.endDate).toBe('');
    expect(patch.endTime).toBe('22:00');
  });
});

describe('confirmationDraftToPatch — trusting nothing', () => {
  it('drops dates and times the model malformed rather than seeding a field with them', () => {
    const patch = confirmationDraftToPatch({
      type: 'activity',
      title: 'Colosseum tour',
      start: { date: 'June 6, 2026', time: '9am' },
      end: { date: '2026-02-31', time: '25:00' },
    });
    expect(patch).toEqual({ type: 'activity', title: 'Colosseum tour' });
  });

  it('omits every field the confirmation left empty, so a blank cannot wipe the form', () => {
    const patch = confirmationDraftToPatch({ type: 'other', title: '  ', location: '', cost: null, notes: '   ' });
    expect(patch).toEqual({ type: 'other' });
  });

  it('falls back to the "other" type for anything off the list', () => {
    expect(draftType({ type: 'yacht' })).toBe('other');
    expect(draftType({})).toBe('other');
    expect(draftType({ type: 'car-rental' })).toBe('car-rental');
  });

  it('keeps a cost of zero (a comped booking is not a missing one)', () => {
    expect(confirmationDraftToPatch({ type: 'activity', cost: 0 }).cost).toBe(0);
    expect(confirmationDraftToPatch({ type: 'activity', cost: NaN })).not.toHaveProperty('cost');
  });
});
