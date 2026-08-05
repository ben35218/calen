// An event alert is stored as minutes-before, but WHAT it counts back from
// depends on the event: a timed event's start instant, or — for an all-day
// event, which has no start time — its own calendar day at the user's day-alert
// hour. These are the rules that keeps an all-day alert off the stored noon-UTC
// instant, whose local hour is whatever the reader's UTC offset makes it.

import {
  eventAlertAnchor, snapAlertToWholeDays, alertsForAllDay, allDayAlertLabel,
  parseDayAlertTime, ALL_DAY_ALERT_OFFSETS, DEFAULT_DAY_ALERT_TIME,
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

describe('parseDayAlertTime', () => {
  it('parses HH:mm and rejects out-of-range values', () => {
    expect(parseDayAlertTime('07:45')).toEqual({ hour: 7, minute: 45 });
    expect(parseDayAlertTime('0:05')).toEqual({ hour: 0, minute: 5 });
    expect(parseDayAlertTime('24:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseDayAlertTime('12:75')).toEqual({ hour: 9, minute: 0 });
  });
});
