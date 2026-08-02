// Apple-style event deletion, shared by the event detail and edit screens so
// both offer the exact same choices. A one-off event is a plain confirm; a
// recurring occurrence offers "Delete This Event Only" (exclude just this day)
// and "Delete All Future Events" (end the series here, or drop it entirely when
// this is the first occurrence).
//
// Each choice's `perform` returns the api promise; the calling screen runs it
// through its own mutation so it keeps a pending/spinner state. The occurrence's
// day is the calendar cell the user tapped through from (the screens' `date`
// route param); with none (e.g. opened from search) it falls back to the series
// start.
import { calendarApi } from '../api';
import { ymd } from './calendar';

export interface EventForDelete {
  _id: string;
  startDate: string;
  allDay?: boolean;
  recurrence?: ({ freq?: string } & Record<string, unknown>) | null;
}

export interface DeleteChoice {
  text: string;
  style?: 'cancel' | 'destructive';
  perform?: () => Promise<unknown>;
}

// The series' first calendar day, keyed the same way the calendar buckets an
// occurrence into a cell (all-day = UTC date, timed = local date).
function seriesStartDay(event: EventForDelete): string {
  return event.allDay ? new Date(event.startDate).toISOString().slice(0, 10) : ymd(new Date(event.startDate));
}

// Run the delete the calendar assistant staged (delete_event → confirm chip),
// mapping the model's scope onto the same api calls the native prompt uses — so
// a chat-driven "clear my calendar" behaves exactly like tapping Delete in the
// form. A one-off event is a plain delete regardless of scope; a recurring one
// removes just the tapped occurrence ('occurrence', the default — the natural
// meaning of "clear this week") or the whole repeating event ('series').
export function assistantDeletePerform(
  event: EventForDelete,
  occurrenceDate: string | undefined,
  scope: 'occurrence' | 'series' = 'occurrence',
): Promise<unknown> {
  if (!event.recurrence?.freq || scope === 'series') {
    return calendarApi.deleteEvent(event._id);
  }
  return calendarApi.excludeOccurrence(event._id, occurrenceDate || seriesStartDay(event));
}

export function eventDeletePrompt(
  event: EventForDelete,
  occurrenceDate: string | undefined,
): { title: string; message: string; choices: DeleteChoice[] } {
  if (!event.recurrence?.freq) {
    return {
      title: 'Delete event?',
      message: '',
      choices: [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', perform: () => calendarApi.deleteEvent(event._id) },
      ],
    };
  }

  const occ = occurrenceDate || seriesStartDay(event);
  // Ending the series before its own first occurrence would leave nothing —
  // delete the whole event instead of truncating it to empty.
  const isFirst = occ <= seriesStartDay(event);

  return {
    title: 'Delete repeating event',
    message: 'This is a repeating event.',
    choices: [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete This Event Only',
        style: 'destructive',
        perform: () => calendarApi.excludeOccurrence(event._id, occ),
      },
      {
        text: 'Delete All Future Events',
        style: 'destructive',
        perform: () => (isFirst ? calendarApi.deleteEvent(event._id) : calendarApi.truncateSeries(event._id, occ)),
      },
    ],
  };
}
