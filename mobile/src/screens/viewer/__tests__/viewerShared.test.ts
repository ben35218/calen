import { calendarColor, eventSpan, eventsOnDate, snapshotOf } from '../shared';
import type { CalendarEvent } from '../../../api';
import type { CustomCalendar } from '../../../lib/calendarPrefs';

// The free-viewer shell's event shaping (billing-plans.md → Free viewer mode).
// The grid's cells and its day sheet are built from these, so their date maths
// decides what a viewer actually sees on a day.

const ev = (o: Partial<CalendarEvent> & { _id: string; startDate: string }): CalendarEvent =>
  ({ title: 'Event', calendarType: 'custom-shared', ...o }) as CalendarEvent;

describe('viewer shell helpers', () => {
  describe('eventSpan', () => {
    it('reads an all-day record in UTC (stored at noon UTC — timezone stable)', () => {
      const span = eventSpan(ev({ _id: 'a', allDay: true, startDate: '2026-08-05T12:00:00.000Z', endDate: '2026-08-07T12:00:00.000Z' }));
      expect(span).toEqual({ start: '2026-08-05', end: '2026-08-07' });
    });

    it('a single-day event spans one date', () => {
      const span = eventSpan(ev({ _id: 'b', allDay: true, startDate: '2026-08-05T12:00:00.000Z' }));
      expect(span.start).toBe('2026-08-05');
      expect(span.end).toBe(span.start);
    });

    it('never returns an end before its start', () => {
      const span = eventSpan(ev({ _id: 'c', allDay: true, startDate: '2026-08-05T12:00:00.000Z', endDate: '2026-08-01T12:00:00.000Z' }));
      expect(span.end).toBe('2026-08-05');
    });
  });

  describe('eventsOnDate', () => {
    const spanning = ev({ _id: 'span', title: 'Camp', allDay: true, startDate: '2026-08-04T12:00:00.000Z', endDate: '2026-08-08T12:00:00.000Z' });
    const sameDay = ev({ _id: 'one', title: 'Game', allDay: true, startDate: '2026-08-06T12:00:00.000Z' });
    const elsewhere = ev({ _id: 'other', title: 'Later', allDay: true, startDate: '2026-08-20T12:00:00.000Z' });

    it('includes multi-day spans on every date they cover', () => {
      const titles = eventsOnDate([spanning, sameDay, elsewhere], '2026-08-06').map((e) => e.title);
      expect(titles).toEqual(expect.arrayContaining(['Camp', 'Game']));
      expect(titles).not.toContain('Later');
    });

    it('excludes a span the day after it ends', () => {
      expect(eventsOnDate([spanning], '2026-08-09')).toEqual([]);
    });

    it('orders all-day items before timed ones, then by start instant', () => {
      const timedLate = ev({ _id: 't2', title: 'Evening', allDay: false, startDate: '2026-08-06T23:30:00.000Z' });
      const timedEarly = ev({ _id: 't1', title: 'Morning', allDay: false, startDate: '2026-08-06T13:00:00.000Z' });
      const order = eventsOnDate([timedLate, timedEarly, sameDay], '2026-08-06').map((e) => e.title);
      expect(order).toEqual(['Game', 'Morning', 'Evening']);
    });
  });

  describe('snapshotOf', () => {
    it('narrows to the read-only fields ViewerEventScreen shows — owner machinery is dropped', () => {
      const snap = snapshotOf(ev({
        _id: 'e1',
        title: 'Practice',
        startDate: '2026-08-06T13:00:00.000Z',
        allDay: false,
        location: 'Field 3',
        description: 'Bring cleats',
        reminderMinutes: 30,
        recurrence: { freq: 'weekly' },
      } as Partial<CalendarEvent> as any));
      expect(snap).toEqual({
        _id: 'e1',
        title: 'Practice',
        startDate: '2026-08-06T13:00:00.000Z',
        endDate: undefined,
        allDay: false,
        location: 'Field 3',
        description: 'Bring cleats',
        calendarType: 'custom-shared',
      });
      expect(Object.keys(snap)).not.toContain('reminderMinutes');
      expect(Object.keys(snap)).not.toContain('recurrence');
    });
  });

  describe('calendarColor', () => {
    const cals = [{ id: 'custom-shared', name: 'Soccer', color: '#123456' }] as CustomCalendar[];

    it('resolves a shared calendar’s own colour', () => {
      expect(calendarColor(cals, 'custom-shared')).toBe('#123456');
    });

    it('falls back to the app primary for anything unknown', () => {
      expect(calendarColor(cals, 'chores')).toBe(require('../../../theme').colors.primary);
      expect(calendarColor(cals, undefined)).toBe(require('../../../theme').colors.primary);
    });
  });
});
