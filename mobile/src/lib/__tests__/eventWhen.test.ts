// Pinned before anything constructs a Date: the bug these tests guard only
// reproduces west of UTC, where a late-evening local time has already rolled
// over to the next UTC calendar day.
process.env.TZ = 'America/New_York';

import { eventWhenFromStored, eventStoredFromWhen, EventWhen } from '../calendar';

// If the runner ignores the TZ pin, the "west of UTC" cases prove nothing.
const pinned = new Date(2026, 7, 3, 23, 5).toISOString() === '2026-08-04T03:05:00.000Z';

describe('event form ⇄ stored instants', () => {
  it('pins the test timezone to America/New_York', () => {
    expect(pinned).toBe(true);
  });

  it('reads a timed event back on its LOCAL start day, not the UTC one', () => {
    // Aug 3 11:05pm–Aug 4 12:05am EDT — stored as Aug 4 03:05Z–04:05Z.
    const when = eventWhenFromStored({
      startDate: '2026-08-04T03:05:00.000Z',
      endDate: '2026-08-04T04:05:00.000Z',
      allDay: false,
    });
    expect(when.date).toBe('2026-08-03');
    expect(when.startTime).toBe('23:05');
    expect(when.endDate).toBe('2026-08-04');
    expect(when.endTime).toBe('00:05');
  });

  it('does not walk the start forward on repeated edit→save cycles', () => {
    let stored: { startDate: string; endDate?: string } = {
      startDate: '2026-08-04T03:05:00.000Z',
      endDate: '2026-08-04T04:05:00.000Z',
    };
    for (let i = 0; i < 5; i++) {
      const when = eventWhenFromStored({ ...stored, allDay: false });
      expect(when.date).toBe('2026-08-03');
      stored = eventStoredFromWhen(when) as typeof stored;
      expect(stored.startDate).toBe('2026-08-04T03:05:00.000Z');
      expect(stored.endDate).toBe('2026-08-04T04:05:00.000Z');
    }
  });

  it('leaves the end date unset for an evening event that stays on one local day', () => {
    // 9–10pm EDT ends at 02:00Z the NEXT UTC day, but it is not multi-day.
    const when = eventWhenFromStored({
      startDate: '2026-08-04T01:00:00.000Z',
      endDate: '2026-08-04T02:00:00.000Z',
      allDay: false,
    });
    expect(when.date).toBe('2026-08-03');
    expect(when.endDate).toBe('');
    expect(when.startTime).toBe('21:00');
    expect(when.endTime).toBe('22:00');
  });

  it('reads all-day events in UTC, where they are stored at noon', () => {
    const when = eventWhenFromStored({
      startDate: '2026-08-03T12:00:00.000Z',
      endDate: '2026-08-05T12:00:00.000Z',
      allDay: true,
    });
    expect(when).toMatchObject({ allDay: true, date: '2026-08-03', endDate: '2026-08-05' });
    expect(eventStoredFromWhen(when)).toEqual({
      startDate: '2026-08-03T12:00:00.000Z',
      endDate: '2026-08-05T12:00:00.000Z',
    });
  });

  it('round-trips a single-day all-day event with no end', () => {
    const when = eventWhenFromStored({ startDate: '2026-08-03T12:00:00.000Z', allDay: true });
    expect(when.endDate).toBe('');
    expect(eventStoredFromWhen(when)).toEqual({
      startDate: '2026-08-03T12:00:00.000Z',
      endDate: undefined,
    });
  });

  it('round-trips every stored shape as a fixed point', () => {
    const cases: EventWhen[] = [
      { allDay: false, date: '2026-08-03', startTime: '23:05', endDate: '2026-08-04', endTime: '00:05' },
      { allDay: false, date: '2026-08-03', startTime: '00:00', endDate: '', endTime: '01:00' },
      { allDay: false, date: '2026-03-08', startTime: '23:30', endDate: '2026-03-09', endTime: '00:30' }, // spring forward
      { allDay: false, date: '2026-11-01', startTime: '22:00', endDate: '', endTime: '23:00' }, // fall back
      { allDay: false, date: '2026-12-31', startTime: '23:00', endDate: '2027-01-01', endTime: '01:00' }, // year boundary
      { allDay: true, date: '2026-08-03', startTime: '09:00', endDate: '', endTime: '10:00' },
      { allDay: true, date: '2026-08-03', startTime: '09:00', endDate: '2026-08-06', endTime: '10:00' },
    ];
    for (const when of cases) {
      const stored = eventStoredFromWhen(when);
      expect(eventWhenFromStored({ ...stored, allDay: when.allDay })).toEqual(when);
    }
  });
});
