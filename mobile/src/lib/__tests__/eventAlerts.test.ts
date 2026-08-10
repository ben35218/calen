// An event alert is stored as minutes-before, but WHAT it counts back from
// depends on the event: a timed event's start instant, or — for an all-day
// event, which has no start time — its own calendar day at the user's day-alert
// hour. These are the rules that keeps an all-day alert off the stored noon-UTC
// instant, whose local hour is whatever the reader's UTC offset makes it.

import {
  eventAlertAnchor, snapAlertToWholeDays, alertsForAllDay, allDayAlertLabel,
  parseDayAlertTime, ALL_DAY_ALERT_OFFSETS, DEFAULT_DAY_ALERT_TIME,
  canLeaveAnchor, effectiveAlertAnchor, inferAlertAnchor, leaveAlertBuffer,
  leaveAlertMinutes, promoteSecondAlert, rebaseLeaveAlert, timedAlertLabel,
  LEAVE_ALERT_BUFFERS,
} from '../calendar';

describe('eventAlertAnchor', () => {
  it('anchors a timed event on its start instant', () => {
    const start = new Date(2026, 7, 10, 14, 30).toISOString();
    expect(eventAlertAnchor({ startDate: start, allDay: false }, '09:00').toISOString()).toBe(start);
  });

  it('anchors an all-day event on its own date at the day-alert hour, in local time', () => {
    // Stored the way all-day events are: noon UTC on 2026-08-10.
    const at = eventAlertAnchor({ startDate: '2026-08-10T12:00:00.000Z', allDay: true }, '09:00');
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(7); // August
    expect(at.getDate()).toBe(10);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(0);
  });

  it('honors the account-level day-alert time, and falls back to 9am without one', () => {
    const withPref = eventAlertAnchor({ startDate: '2026-08-10T12:00:00.000Z', allDay: true }, '07:45');
    expect([withPref.getHours(), withPref.getMinutes()]).toEqual([7, 45]);

    for (const unset of [null, undefined, '', 'nonsense', '99:99']) {
      const at = eventAlertAnchor({ startDate: '2026-08-10T12:00:00.000Z', allDay: true }, unset as string | null);
      expect([at.getHours(), at.getMinutes()]).toEqual([9, 0]);
    }
  });

  // The whole point of the anchor: the alert lands on the day the user sees on
  // the grid, at the hour they configured — not at noon-UTC-minus-the-offset,
  // which is 5am in Los Angeles, 8am in New York and 2pm in Berlin.
  it('puts a "1 day before" alert on the previous day at that same hour', () => {
    const anchor = eventAlertAnchor({ startDate: '2026-08-10T12:00:00.000Z', allDay: true }, '09:00');
    const at = new Date(anchor.getTime() - 1440 * 60000);
    expect(at.getDate()).toBe(9);
    expect(at.getHours()).toBe(9);
  });

  it('reads an all-day date in UTC, so the anchor is the same calendar day everywhere', () => {
    // The stored value is noon UTC precisely so no local zone can shift the
    // date; a local read would move it a day for anyone past ±12.
    expect(eventAlertAnchor({ startDate: '2026-01-01T12:00:00.000Z', allDay: true }).getDate()).toBe(1);
    expect(eventAlertAnchor({ startDate: '2026-12-31T12:00:00.000Z', allDay: true }).getDate()).toBe(31);
  });
});

describe('snapAlertToWholeDays', () => {
  it('collapses every sub-day offset onto the day itself', () => {
    expect(snapAlertToWholeDays(0)).toBe(0);
    expect(snapAlertToWholeDays(15)).toBe(0);
    expect(snapAlertToWholeDays(60)).toBe(0);
    expect(snapAlertToWholeDays(1439)).toBe(0);
  });

  it('keeps a whole-day offset at its own day count', () => {
    expect(snapAlertToWholeDays(1440)).toBe(1440);
    expect(snapAlertToWholeDays(2880)).toBe(2880);
    expect(snapAlertToWholeDays(10080)).toBe(10080);
  });

  it('rounds an off-grid multi-day offset to the nearest whole day', () => {
    expect(snapAlertToWholeDays(2000)).toBe(1440);  // 1d 9h → 1 day
    expect(snapAlertToWholeDays(2200)).toBe(2880);  // 1d 12h+ → 2 days
  });

  it('leaves an unset alert unset', () => {
    expect(snapAlertToWholeDays(null)).toBeNull();
    expect(snapAlertToWholeDays(undefined)).toBeNull();
  });
});

describe('alertsForAllDay', () => {
  it('re-bases configured alerts when All day is switched on', () => {
    expect(alertsForAllDay(true, { reminderMinutes: 15, alert2Minutes: 1440 })).toEqual({
      reminderMinutes: 0,
      alert2Minutes: 1440,
    });
  });

  // Losing the alert entirely is worse than moving it: the user configured one
  // and must still have one after the toggle.
  it('never drops the first alert', () => {
    expect(alertsForAllDay(true, { reminderMinutes: 60, alert2Minutes: null }).reminderMinutes).toBe(0);
  });

  it('drops the second alert when it collapses onto the first', () => {
    // 15 min and 1 hour before both become "on the day" — two identical alerts
    // would fire the same notification twice.
    expect(alertsForAllDay(true, { reminderMinutes: 15, alert2Minutes: 60 })).toEqual({
      reminderMinutes: 0,
      alert2Minutes: null,
    });
  });

  it('drops a second alert left without a first', () => {
    expect(alertsForAllDay(true, { reminderMinutes: null, alert2Minutes: 60 })).toEqual({
      reminderMinutes: null,
      alert2Minutes: null,
    });
  });

  it('changes nothing when All day is switched off — every day offset is a legal timed one', () => {
    const alerts = { reminderMinutes: 15, alert2Minutes: 1440 };
    expect(alertsForAllDay(false, alerts)).toEqual(alerts);
  });

  // The switch spreads this result over `{ allDay: v, … }`. Returning the
  // caller's own object (the whole form) put a stale `allDay: true` back on top
  // of the patch, so All day could never be switched off.
  it('returns only the two alert keys, never the object it was handed', () => {
    const form = { allDay: true, title: 'Dentist', reminderMinutes: 1440, alert2Minutes: null };
    for (const allDay of [false, true]) {
      const out = alertsForAllDay(allDay, form);
      expect(out).not.toBe(form);
      expect(Object.keys(out).sort()).toEqual(['alert2Minutes', 'reminderMinutes']);
      expect({ allDay: !allDay, ...out }).toMatchObject({ allDay: !allDay });
    }
  });
});

describe('allDayAlertLabel', () => {
  it('names the hour the alert fires at', () => {
    const at = allDayAlertLabel(0, '09:00');
    expect(at).toContain('On the day');
    expect(at).toMatch(/9:00/);
    expect(allDayAlertLabel(1440, '09:00')).toMatch(/^1 day before \(/);
    expect(allDayAlertLabel(2880, '09:00')).toMatch(/^2 days before \(/);
    expect(allDayAlertLabel(10080, '09:00')).toMatch(/^1 week before \(/);
    expect(allDayAlertLabel(20160, '09:00')).toMatch(/^2 weeks before \(/);
  });

  it('labels every offset the picker offers', () => {
    for (const v of ALL_DAY_ALERT_OFFSETS) {
      expect(allDayAlertLabel(v, DEFAULT_DAY_ALERT_TIME)).toBeTruthy();
    }
  });

  // A value saved before all-day alerts were day-based still has to render, or
  // the picker falls back to its placeholder and looks like "no alert set".
  it('keeps timed phrasing for a legacy sub-day value', () => {
    expect(allDayAlertLabel(15, '09:00')).toBe('15 min before');
  });
});

// The Second Alert field only renders while a first alert exists, so clearing
// the first has to move the second up — leaving it set behind the hidden row is
// an alert the user can neither see nor edit.
describe('promoteSecondAlert', () => {
  it('moves the second alert into the first slot when the first is cleared', () => {
    expect(promoteSecondAlert({
      reminderMinutes: null, alert2Minutes: 60, alertAnchor: 'event', alert2Anchor: 'event',
    })).toEqual({
      reminderMinutes: 60, alert2Minutes: null, alertAnchor: 'event', alert2Anchor: 'event',
    });
  });

  it('carries the survivor’s own framing up with it', () => {
    expect(promoteSecondAlert({
      reminderMinutes: null, alert2Minutes: 53, alertAnchor: 'event', alert2Anchor: 'leave',
    })).toEqual({
      reminderMinutes: 53, alert2Minutes: null, alertAnchor: 'leave', alert2Anchor: 'event',
    });
  });

  it('leaves a configured pair alone', () => {
    const pair = { reminderMinutes: 15, alert2Minutes: 60, alertAnchor: 'event' as const, alert2Anchor: 'leave' as const };
    expect(promoteSecondAlert(pair)).toEqual(pair);
  });

  it('is a no-op when there is nothing to promote', () => {
    expect(promoteSecondAlert({ reminderMinutes: null, alert2Minutes: null })).toEqual({
      reminderMinutes: null, alert2Minutes: null, alertAnchor: 'event', alert2Anchor: 'event',
    });
  });

  // Spread over the form patch, exactly like `alertsForAllDay` — a wider object
  // handed back would put the caller's own stale fields on top of the patch.
  it('returns only the four alert keys, never the object it was handed', () => {
    const form = { allDay: false, title: 'Dentist', reminderMinutes: null, alert2Minutes: 30 };
    const out = promoteSecondAlert(form);
    expect(out).not.toBe(form);
    expect(Object.keys(out).sort()).toEqual(['alert2Anchor', 'alert2Minutes', 'alertAnchor', 'reminderMinutes']);
    expect({ ...form, ...out }).toMatchObject({ title: 'Dentist', reminderMinutes: 30, alert2Minutes: null });
  });
});

// An alert's lead time can be set against the event's start or against
// DEPARTURE, and with a drive time in play both framings can name the same
// instant — so which one the user chose is stored, never re-derived from the
// number. Guessing it back (any value past the drive time = departure-relative)
// re-worded a plain "2 hours before" as "1 hr 37 min before leaving".
describe('alert anchors', () => {
  const TRAVEL = 23;

  it('offers a departure anchor only on a timed event with a drive time', () => {
    expect(canLeaveAnchor(false, TRAVEL)).toBe(true);
    expect(canLeaveAnchor(true, TRAVEL)).toBe(false);   // all-day: no start to leave for
    expect(canLeaveAnchor(false, null)).toBe(false);    // no drive time: no departure
    expect(canLeaveAnchor(false, 0)).toBe(false);
  });

  it('degrades a departure anchor the event can no longer honour', () => {
    expect(effectiveAlertAnchor('leave', false, TRAVEL)).toBe('leave');
    expect(effectiveAlertAnchor('leave', true, TRAVEL)).toBe('event');
    expect(effectiveAlertAnchor('leave', false, null)).toBe('event');
    expect(effectiveAlertAnchor(null, false, TRAVEL)).toBe('event');
    expect(effectiveAlertAnchor(undefined, false, TRAVEL)).toBe('event');
  });

  it('converts between a departure buffer and the stored minutes-before-event', () => {
    expect(leaveAlertMinutes(30, TRAVEL)).toBe(53);
    expect(leaveAlertBuffer(53, TRAVEL)).toBe(30);
    expect(leaveAlertMinutes(0, TRAVEL)).toBe(TRAVEL);  // "Time to leave"
    expect(leaveAlertBuffer(TRAVEL, TRAVEL)).toBe(0);
    // An alert inside the drive time isn't a negative buffer, it's departure.
    expect(leaveAlertBuffer(10, TRAVEL)).toBe(0);
  });

  // The reported bug: with a 23-minute drive, a custom "2 hours before" was
  // re-worded as "1 hr 37 min before leaving" purely because 120 ≥ 23.
  it('words a lead time in the framing it was set in, not the other one', () => {
    expect(timedAlertLabel(120, 'event', TRAVEL)).toBe('2 hr before');
    expect(timedAlertLabel(90, 'event', TRAVEL)).toBe('1 hr 30 min before');
    expect(timedAlertLabel(0, 'event', TRAVEL)).toBe('At time of event');
    // The same numbers, set against departure, read as departure.
    expect(timedAlertLabel(113, 'leave', TRAVEL)).toBe('1 hr 30 min before leaving');
    expect(timedAlertLabel(TRAVEL, 'leave', TRAVEL, '8:37 AM')).toBe('Time to leave (8:37 AM)');
    expect(timedAlertLabel(TRAVEL, 'leave', TRAVEL)).toBe('Time to leave');
  });

  it('falls back to plain event wording when the drive time is gone', () => {
    expect(timedAlertLabel(120, 'leave', null)).toBe('2 hr before');
  });

  // Events saved before the anchor existed carry only a number. The canned
  // departure rows keep reading the way they always did; everything else reads
  // as what it literally is.
  it('infers a legacy anchor only for the canned departure rows', () => {
    for (const buf of LEAVE_ALERT_BUFFERS) {
      expect(inferAlertAnchor(TRAVEL + buf, false, TRAVEL)).toBe('leave');
    }
    expect(inferAlertAnchor(120, false, TRAVEL)).toBe('event');
    expect(inferAlertAnchor(60, false, TRAVEL)).toBe('event');
    expect(inferAlertAnchor(TRAVEL, true, TRAVEL)).toBe('event');   // all-day
    expect(inferAlertAnchor(TRAVEL, false, null)).toBe('event');
    expect(inferAlertAnchor(null, false, TRAVEL)).toBe('event');
  });

  // "30 min before leaving" has to stay 30 minutes before the NEW departure
  // when the drive time changes; an event-anchored alert never moves.
  it('moves a departure-anchored alert with the drive time', () => {
    expect(rebaseLeaveAlert(53, 'leave', 23, 40)).toBe(70);   // still 30 min before leaving
    expect(rebaseLeaveAlert(53, 'leave', 23, 10)).toBe(40);
    expect(rebaseLeaveAlert(53, 'event', 23, 40)).toBe(53);
    expect(rebaseLeaveAlert(null, 'leave', 23, 40)).toBeNull();
    // Nothing to re-base against: the stored lead time is left exactly as it is.
    expect(rebaseLeaveAlert(53, 'leave', null, 40)).toBe(53);
    expect(rebaseLeaveAlert(53, 'leave', 23, null)).toBe(53);
  });
});

describe('parseDayAlertTime', () => {
  it('parses HH:mm and rejects out-of-range values', () => {
    expect(parseDayAlertTime('07:45')).toEqual({ hour: 7, minute: 45 });
    expect(parseDayAlertTime('0:05')).toEqual({ hour: 0, minute: 5 });
    expect(parseDayAlertTime('24:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseDayAlertTime('12:75')).toEqual({ hour: 9, minute: 0 });
  });
});
