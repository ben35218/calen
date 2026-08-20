// The rows an event's Alert picker offers, built once for every surface that
// offers them.
//
// Two screens set an event's alerts: the edit form (while composing the event)
// and the event detail view (managing them in place, without opening the form).
// They MUST offer the same rows for the same event — a second, private copy of
// this logic is how the invitee picker ended up quietly offering each contact's
// first email while the shared matcher offered every address. So the option
// list, its keying, and the "the other slot already used this" filter live here,
// and both screens read them from this module.
import {
  AlertAnchor,
  ALL_DAY_ALERT_OFFSETS,
  LEAVE_ALERT_BUFFERS,
  allDayAlertLabel,
  leaveAlertMinutes,
  timedAlertLabel,
} from './calendar';

// Alert offsets for a TIMED event — minutes before its start. An all-day event
// has no start time, so it gets the whole-day grid instead (ALL_DAY_ALERT_OFFSETS
// in lib/calendar, labelled with the hour they fire at); see `buildAlertItems`.
// The `-1` None row is here for the AI assist schema, which describes the field
// as a flat list of numbers; the picker builds its own None row below.
export const ALERT_OPTIONS = [
  { label: 'None', value: -1 },
  { label: 'At time of event', value: 0 },
  { label: '15 min before', value: 15 },
  { label: '30 min before', value: 30 },
  { label: '1 hour before', value: 60 },
  { label: '1 day before', value: 1440 },
];

// The alert pickers are keyed by "<anchor>:<minutes>", not by the minute count:
// the same number means two different settings depending on its anchor (with a
// 45-minute drive, 60 minutes before the event and 15 minutes before leaving are
// both "60"), and they diverge the moment the drive time changes. Two sentinel
// keys sit alongside: no alert, and the row that opens the custom sheet.
export const NONE_ALERT = 'none';
export const CUSTOM_ALERT = 'custom';

export type AlertItem = { value: string; label: string; minutes: number | null; anchor: AlertAnchor };

export const alertKey = (minutes: number | null, anchor: AlertAnchor): string =>
  minutes == null ? NONE_ALERT : `${anchor === 'leave' ? 'l' : 'e'}:${minutes}`;

// The other slot's alert, dropped from this slot's list — two alerts on the same
// instant would just fire the same notification twice. Sentinels and the slot's
// own current selection always stay (compares by minutes rather than by key, so
// the two framings of one instant can't both be picked).
export function excludeUsedAlertKey(options: AlertItem[], used: number | null, self: number | null): AlertItem[] {
  if (used == null) return options;
  return options.filter((o) => o.minutes == null || o.minutes === self || o.minutes !== used);
}

// Every row an event's two alert pickers should offer.
//
// An ALL-DAY event has no start time, so minute offsets have nothing to count
// back from: its alerts are whole days off the day-alert hour (see the alert
// note in lib/calendar), and that is the only list it may be offered — the
// minute list would be describing a time the event doesn't have. Travel time is
// meaningless there too, which is why the departure options are all-day-gated.
//
// On a TIMED event, when a drive time is available, prepend a set of
// departure-anchored choices so the user can be alerted when it's time to leave
// — or a chosen number of minutes before that. Every row carries the anchor it
// was built with, so picking one records the framing the user chose instead of
// leaving it to be guessed back out of the number later.
//
// `reminderMinutes`/`alert2Minutes` (with the anchor each is being READ in) are
// passed so a saved value with no canned row still gets one; without it the
// field falls back to its placeholder and shows the user no setting at all.
export function buildAlertItems({
  allDay,
  travelMinutes,
  leaveByTime,
  dayAlertTime,
  reminderMinutes,
  alertAnchor,
  alert2Minutes,
  alert2Anchor,
}: {
  allDay: boolean;
  travelMinutes: number | null;
  // The clock time the user must leave by ("8:45 AM"), or null when it can't be
  // computed. Only labels the departure rows — never gates them except for the
  // "Time to leave" row, which IS that clock time.
  leaveByTime: string | null;
  dayAlertTime: string;
  reminderMinutes: number | null;
  alertAnchor: AlertAnchor;
  alert2Minutes: number | null;
  alert2Anchor: AlertAnchor;
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
        anchor: 'event' as AlertAnchor,
      })),
    ];
    // A saved value off the grid — a custom day count, or a minute offset
    // carried by an event saved before all-day alerts became day-based — still
    // needs a row, or the field would fall back to its placeholder.
    for (const v of [reminderMinutes, alert2Minutes]) {
      if (v == null || items.some((i) => i.minutes === v)) continue;
      items.push({ value: alertKey(v, 'event'), label: allDayAlertLabel(v, dayAlertTime), minutes: v, anchor: 'event' });
    }
    items.push(custom);
    return items;
  }

  const leaveItems: AlertItem[] = [];
  if (travelMinutes) {
    for (const buf of LEAVE_ALERT_BUFFERS) {
      // No computable departure time (e.g. no start time yet) — omit "Time to leave".
      if (buf === 0 && !leaveByTime) continue;
      const minutes = leaveAlertMinutes(buf, travelMinutes);
      leaveItems.push({
        value: alertKey(minutes, 'leave'),
        label: timedAlertLabel(minutes, 'leave', travelMinutes, leaveByTime),
        minutes,
        anchor: 'leave',
      });
    }
  }
  const base: AlertItem[] = ALERT_OPTIONS.filter((o) => o.value >= 0).map((o) => ({
    value: alertKey(o.value, 'event'),
    label: o.label,
    minutes: o.value,
    anchor: 'event' as AlertAnchor,
  }));
  // "None" stays first; departure-anchored options follow it so they're visible
  // without scrolling (the option sheet caps at 70% screen height).
  const items: AlertItem[] = [none, ...leaveItems, ...base];
  // A saved custom value has no canned row — synthesize one in its own framing,
  // so the field shows the setting back rather than its placeholder.
  for (const [v, anchor] of [
    [reminderMinutes, alertAnchor],
    [alert2Minutes, alert2Anchor],
  ] as const) {
    if (v == null || items.some((i) => i.value === alertKey(v, anchor))) continue;
    items.push({
      value: alertKey(v, anchor),
      label: timedAlertLabel(v, anchor, travelMinutes, leaveByTime),
      minutes: v,
      anchor,
    });
  }
  items.push(custom);
  return items;
}
