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
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import { calendarApi } from '../api';
import { ymd } from './calendar';

export interface EventForDelete {
  _id: string;
  startDate: string;
  allDay?: boolean;
  recurrence?: ({ freq?: string } & Record<string, unknown>) | null;
  enc?: { ks?: string };
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
  // A one-off deletes outright. A repeating event on an outside-shared calendar
  // now scopes like any other: the occurrence primitives re-seal in whichever key
  // lane the event already lives under (api.resealInLane), so they no longer flip
  // it out from under its collaborators.
  if (!event.recurrence?.freq) {
    return {
      title: 'Are you sure you want to delete this event?',
      message: '',
      choices: [
        { text: 'Delete Event', style: 'destructive', perform: () => calendarApi.deleteEvent(event._id) },
        { text: 'Cancel', style: 'cancel' },
      ],
    };
  }

  const occ = occurrenceDate || seriesStartDay(event);
  // Ending the series before its own first occurrence would leave nothing —
  // delete the whole event instead of truncating it to empty.
  const isFirst = occ <= seriesStartDay(event);

  return {
    // Apple's own wording for this sheet.
    title: 'Are you sure you want to delete this event? This is a repeating event.',
    message: '',
    choices: [
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
      { text: 'Cancel', style: 'cancel' },
    ],
  };
}

// Present the choices above and run the one the user picks through `run` (the
// screen's own mutation, so Delete keeps its pending state). Cancelling does
// nothing.
//
// This is an action SHEET, not a centred alert: Apple anchors a destructive
// scope choice at the bottom of the screen, and both delete choices are
// destructive, so an alert's two-button shape can't express it. Android falls
// back to the equivalent alert, matching confirmDiscardChanges.
export function promptEventDelete(
  event: EventForDelete,
  occurrenceDate: string | undefined,
  run: (perform: () => Promise<unknown>) => void,
): void {
  const { title, choices } = eventDeletePrompt(event, occurrenceDate);
  const actions = choices.filter((c) => c.perform);
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...actions.map((c) => c.text), 'Cancel'],
        // Every action here deletes something, so all of them read as
        // destructive; iOS only tints one, so it goes on the narrowest choice.
        destructiveButtonIndex: actions.map((_, i) => i),
        cancelButtonIndex: actions.length,
      },
      (i) => {
        const picked = actions[i];
        if (picked?.perform) run(picked.perform);
      },
    );
  } else {
    Alert.alert(title, '', [
      ...actions.map((c) => ({
        text: c.text,
        style: c.style,
        onPress: () => c.perform && run(c.perform),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }
}
