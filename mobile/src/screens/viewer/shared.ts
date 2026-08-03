import type { CalendarEvent } from '../../api';
import type { CustomCalendar } from '../../lib/calendarPrefs';
import type { ViewerEventSnapshot } from '../../navigation/types';
import { ymd } from '../../lib/calendar';
import { colors } from '../../theme';

// Shared helpers for the free-viewer shell's two layers (month grid + agenda
// list) and its print sheet. See billing-plans.md → "Free viewer mode".

// The decrypted event content the shell hands ViewerEventScreen. Narrowed to
// the snapshot fields on purpose — a viewer never sees the owner machinery
// (reminders, invitees, recurrence, call state) a full CalendarEvent carries.
export function snapshotOf(e: CalendarEvent): ViewerEventSnapshot {
  return {
    _id: e._id,
    title: e.title,
    startDate: e.startDate,
    endDate: e.endDate,
    allDay: e.allDay,
    location: e.location,
    description: e.description,
    calendarType: e.calendarType,
  };
}

// A shared calendar's colour, resolved from the shell's OWN calendar list
// rather than lib/calendar's colorOf — the viewer only ever draws these
// calendars, and reading their colour directly keeps the grid independent of
// the prefs module's override seeding.
export function calendarColor(calendars: CustomCalendar[], id?: string): string {
  return calendars.find((c) => c.id === id)?.color || colors.primary;
}

// Date-only / all-day records are stored at noon UTC, so read them in UTC;
// timed events are real instants and read in the device's local zone.
export const storedDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);
export const eventDate = (e: { allDay?: boolean }, iso: string) =>
  e.allDay ? storedDate(iso) : ymd(new Date(iso));

// The yyyy-MM-dd span an event covers (inclusive).
export function eventSpan(e: CalendarEvent): { start: string; end: string } {
  const start = eventDate(e, e.startDate);
  const end = e.endDate ? eventDate(e, e.endDate) : start;
  return { start, end: end < start ? start : end };
}

// Every shared-calendar event that lands on `date`, multi-day spans included,
// ordered the way a day reads: all-day first, then by start instant.
export function eventsOnDate(events: CalendarEvent[], date: string): CalendarEvent[] {
  return events
    .filter((e) => {
      const { start, end } = eventSpan(e);
      return start <= date && date <= end;
    })
    .sort((a, b) => {
      if (Boolean(a.allDay) !== Boolean(b.allDay)) return a.allDay ? -1 : 1;
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    });
}
